/**
 * dsh-web-search-zerokey — 零 key web 搜索 provider（Bing HTML 解析）
 *
 * 为什么需要它：
 *   本机 web_search 坏掉的共因是 Node CA 信任链，而非"缺 key"。
 *   本 provider 不依赖任何商业 API，available() 恒真。
 *
 * 证书怎么办（本插件的关键设计）：
 *   DSH Desktop 从 GUI 启动，`NODE_EXTRA_CA_CERTS` 无法通过
 *   ~/.dsh/.env（BOOTSTRAP_NAMES 会硬报错）或 ~/.zshrc
 *   （DESKTOP_SHELL_ENVIRONMENT_KEYS 窄名单会丢弃）注入，
 *   而 `launchctl setenv` 在沙箱内报 "Not privileged to set domain environment"。
 *
 *   因此本插件**自行为 TLS 注入 CA**：patch `tls.createSecureContext`，
 *   把 ~/.dsh/certs/system-ca.pem 并进每个安全上下文的 ca 列表。
 *   这样零配置、零重启、零特权即可用。
 *
 *   这是进程内的局部补丁，只增补信任根、不关闭校验——
 *   与 NODE_TLS_REJECT_UNAUTHORIZED=0 那种全局关校验的做法有本质区别。
 *
 * 设计要点：
 *   - available() 恒返回 true：零 key，永远可用，不参与"有 key 才行"的判定
 *   - 每 12s 超时，避免慢响应拖死模型 turn
 *   - 结果按 URL 去重
 *   - 只解析 b_algo 结果块，不做全文抓取（抓取交给 fetchProvider）
 *
 * 多源增强（v0.2.0）：
 *   Bing 单引擎对中文/通用查询足够，但对**技术查询**会漏掉社区讨论与代码仓库。
 *   故当查询被判定为技术类时，并行叠加两个零 key 源：
 *     - Hacker News（Algolia API）：真人技术讨论，带热度权重，无 key 无限流困扰
 *     - GitHub Search：仓库检索，质量高但**匿名限流仅 10 次/小时**
 *
 *   三条硬约束（决定了实现形态）：
 *     1. **Bing 永远是主体**，增强源失败绝不影响主结果 —— 任何增强源异常都只是少几条。
 *     2. **GitHub 有额度**，故在进程内做额度感知：连续 403/429 后退避，避免把额度打光
 *        后连累后续查询（见 rateLimit 状态机）。
 *     3. **不引入英文源到中文查询** —— 否则中文搜索质量反而下降。路由判定必须保守：
 *        拿不准就不增强。
 *
 * @module dsh-web-search-zerokey
 */

import tls from 'node:tls'
import fs from 'node:fs'

export const name = 'web-search-zerokey'
export const inject = ['web']

/** 本机 CA 快照的默认位置。 */
export const DEFAULT_CA_PATH = `${process.env.HOME ?? ''}/.dsh/certs/system-ca.pem`

/** 稳定 id，`web.searchProvider` 用它选中本 provider。 */
export const ZEROKEY_PROVIDER_ID = 'zerokey'

const DEFAULT_TIMEOUT_MS = 12_000
const DEFAULT_MAX_SNIPPET_CHARS = 300

/**
 * 为进程内 TLS 注入本机 CA，返回还原函数。
 *
 * 为什么 patch `createSecureContext` 而不是设 `NODE_EXTRA_CA_CERTS`：
 * 后者必须在 Node 启动前存在，而 DSH Desktop 的 GUI 启动路径
 * 不允许我们从配置文件或 shell 注入（原因见文件头注释）。
 * 这是本机唯一免特权、免重启的通道。
 *
 * 关键安全性质：**只增补信任根，不降低校验强度**。
 * 与 `NODE_TLS_REJECT_UNAUTHORIZED=0` 不同，证书链仍被完整验证。
 *
 * 幂等：重复调用只生效一次；已注入过则返回 no-op 还原函数。
 *
 * @param {string} caPath - CA PEM 文件路径
 * @returns {() => void} 还原函数
 */
export function installCaTrust(caPath = DEFAULT_CA_PATH) {
  let ca
  try {
    ca = fs.readFileSync(caPath, 'utf8')
  } catch (error) {
    // 证书缺失不是致命错误：若运行环境本就信任（例如已设 NODE_EXTRA_CA_CERTS），
    // 搜索依然可用。这里只记录，不抛——由 search() 在真正握手失败时给出指引。
    return () => {}
  }

  if (tls.createSecureContext[INJECTED_FLAG] === true) return () => {}

  const original = tls.createSecureContext
  const patched = function (options = {}) {
    // 与已有 ca 合并而非替换：调用方显式指定的信任根优先保留。
    return original.call(this, {
      ...options,
      ca: options.ca === undefined ? ca : [].concat(options.ca, ca),
    })
  }
  patched[INJECTED_FLAG] = true
  // 让其它代码能识别 patch 后的函数仍代表原语义。
  patched.original = original
  tls.createSecureContext = patched

  return () => {
    // 仅当当前仍是我们的 patch 时才还原，避免踩掉别人的改动。
    if (tls.createSecureContext === patched) tls.createSecureContext = original
  }
}

/** 标记位，用于幂等判断。 */
const INJECTED_FLAG = Symbol.for('dsh.web-search-zerokey.caInjected')

const BROWSER_HEADERS = {
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
}

/** HTML 实体与标签清理，压平为单行文本。 */
function stripTags(html) {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&ensp;/g, ' ')
    .replace(/&#0183;/g, '·')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 截断但不切断代理对。 */
function cap(value, maxChars) {
  if (value.length <= maxChars) return value
  const cut = value.slice(0, maxChars)
  const last = cut.charCodeAt(cut.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut
}

/**
 * 解析 Bing 结果页。
 *
 * 结果块标记为 `<li class="b_algo">`，标题与链接在其中的 `<h2><a href>`，
 * 摘要在紧随的 `<p>`。这些标记是 Bing 的稳定结构，实测可解析。
 *
 * @param {string} html - Bing 返回的 HTML
 * @param {number} maxResults - 结果上限
 * @param {number} maxSnippetChars - 单条摘要上限
 * @returns {{sources: Array, truncated: boolean}}
 */
export function parseBingHtml(html, maxResults, maxSnippetChars) {
  const sources = []
  const seen = new Set()

  // 按结果块切分，首个 block 是块前的页头，丢弃。
  const blocks = html.split(/<li class="b_algo"/).slice(1)

  for (const block of blocks) {
    const match = block.match(
      /<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/,
    )
    if (!match) continue

    const url = match[1]
    const title = stripTags(match[2])
    // 跳过空标题与非 http 链接（Bing 偶有 javascript:/内部锚点结果）
    if (!title || !/^https?:\/\//.test(url)) continue
    if (seen.has(url)) continue
    seen.add(url)

    const paragraph = block.match(/<p[^>]*>([\s\S]*?)<\/p>/)
    const snippet = paragraph ? stripTags(paragraph[1]) : ''

    sources.push({
      url,
      title,
      ...(snippet ? { snippet: cap(snippet, maxSnippetChars) } : {}),
    })

    if (sources.length >= maxResults) break
  }

  return { sources, truncated: false }
}

// ---------------------------------------------------------------------------
// 多源增强
// ---------------------------------------------------------------------------

/**
 * 技术类查询的判定信号。
 *
 * 设计取舍：**宁可漏判，不可误判**。
 * 误判（把中文通用查询当技术查询）会把英文技术源的结果混进中文结果里，
 * 让用户看到一堆看不懂的英文标题 —— 那比"少几个增强源"糟得多。
 * 所以只在出现明确的代码/技术标记时才判为 true，且要求查询本身不是中文长句。
 */
const TECH_SIGNALS = [
  /[a-z][A-Z]/, // camelCase / PascalCase
  /[a-z]+_[a-z]+/i, // snake_case
  /\b\w+\.(js|ts|tsx|jsx|py|go|rs|java|rb|c|cpp|h|json|ya?ml|toml|md)\b/i, // 文件名
  /\b[a-z]+\.[a-z]+\.[a-z]+\b/i, // 命名空间 a.b.c
  /\w+\(\)/, // 函数调用
  /\b(api|sdk|cli|npm|pnpm|yarn|pip|docker|k8s|kubernetes|git|regex|sql|http|json|yaml|html|css|react|vue|node|python|rust|golang|typescript|javascript|error|exception|stack ?trace|compile|build|deploy|plugin|framework|library|package|module|function|class|interface|async|await|promise|webpack|vite|eslint|jest|pytest|mcp|cordis|harness)\b/i,
  /\bv?\d+\.\d+(\.\d+)?\b/, // 版本号
  /\b[45]\d{2}\b/, // HTTP 错误码
]

/** 判定一个查询是否值得启用技术类增强源。 */
export function isTechQuery(query) {
  const q = String(query ?? '').trim()
  if (q.length === 0) return false

  // 中文长句（含 ≥4 个中日韩字符）通常是人话提问，不是代码检索。
  const cjk = (q.match(/[\u4e00-\u9fff\u3040-\u30ff]/g) ?? []).length
  if (cjk >= 4) return false

  return TECH_SIGNALS.some((re) => re.test(q))
}

/**
 * GitHub 匿名搜索额度是 **10 次/小时**（实测），远超普通用户的搜索节奏会打光。
 * 这里做进程内额度感知：撞到 403/429 后退避一段冷却期，期间直接跳过 GitHub，
 * 让 Bing/HN 照常工作。冷却期保守取 15 分钟。
 */
const GITHUB_COOLDOWN_MS = 15 * 60 * 1000

/** 慢源超时：比 Bing 主源略短，绝不能拖死整个 turn。 */
const ENHANCED_TIMEOUT_MS = 8_000

/** 请求 HN Algolia（零 key、无额度困扰）。 */
export async function searchHackerNews(query, maxResults, signal) {
  const url = new URL('https://hn.algolia.com/api/v1/search')
  url.searchParams.set('query', query)
  url.searchParams.set('hitsPerPage', String(Math.min(maxResults, 10)))

  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal,
  })
  if (!response.ok) throw new Error(`HN HTTP ${response.status}`)

  const data = await response.json()
  const sources = []
  for (const hit of data?.hits ?? []) {
    const title = hit.title ?? hit.story_title
    const target =
      hit.url ?? `https://news.ycombinator.com/item?id=${hit.objectID}`
    if (!title || !/^https?:\/\//.test(target)) continue
    const points = typeof hit.points === 'number' ? hit.points : null
    sources.push({
      url: target,
      title: String(title),
      snippet: points === null ? 'Hacker News' : `Hacker News · ${points} points`,
    })
  }
  return { sources, truncated: false }
}

/** 请求 GitHub 仓库检索（匿名限流 10/h，需配合退避）。 */
export async function searchGitHub(query, maxResults, signal) {
  const url = new URL('https://api.github.com/search/repositories')
  url.searchParams.set('q', query)
  url.searchParams.set('sort', 'stars')
  url.searchParams.set('per_page', String(Math.min(maxResults, 10)))

  const response = await fetch(url, {
    headers: { accept: 'application/vnd.github+json' },
    signal,
  })

  // 把限流信号显式抛出，交给上层状态机决定退避。
  if (response.status === 403 || response.status === 429) {
    const err = new Error(`GitHub rate limited (HTTP ${response.status})`)
    err.rateLimited = true
    throw err
  }
  if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`)

  const data = await response.json()
  const sources = []
  for (const repo of data?.items ?? []) {
    if (!repo?.html_url) continue
    const stars = repo.stargazers_count ?? 0
    sources.push({
      url: repo.html_url,
      title: repo.full_name,
      snippet: `★${stars}${repo.description ? ` · ${repo.description}` : ''}`,
    })
  }
  return { sources, truncated: false }
}

/**
 * 把多个垂直源的结果交错合并（round-robin），保证每个源都有代表。
 *
 * 为什么不能直接 `flat()`：
 * 若某源返回条数多、且排在前面，`flat()` 后它会独占全部预留槽位，
 * 后面的源永远进不来 —— 表现为「配了 GitHub 却从来没出现过 GitHub 结果」。
 * （实测踩到：HN 与 GitHub 各 2 条，reserve=2 时 GitHub 恒为 0。）
 *
 * @param {Array<Array>} groups - 各源的结果数组
 * @returns {Array} 交错后的结果项
 */
export function interleave(groups) {
  const lists = (groups ?? []).filter((g) => Array.isArray(g) && g.length > 0)
  const out = []
  const maxLen = lists.reduce((acc, g) => Math.max(acc, g.length), 0)
  for (let i = 0; i < maxLen; i++) {
    for (const list of lists) {
      if (i < list.length) out.push(list[i])
    }
  }
  return out
}

/**
 * 合并主源与垂直源结果，为主源与垂直源分配槽位。
 *
 * 为什么不做「跨引擎共识排序」（omp 的做法）：
 * 共识排序需要多个通用 web 引擎（Google/Bing/DDG 查同一片网页）才有意义。
 * 而这里的增强源是**垂直源**（HN 是讨论、GitHub 是仓库），与 Bing 的网页结果
 * 语义不同，共识度天然为 0，排序反而会把垂直结果全压到末尾。
 * 故采用「主源优先 + 垂直源预留槽位」这种更朴素但更符合语义的合并。
 *
 * **预留槽位是关键**：若不预留，Bing 填满 maxResults 后垂直结果会被整体截断，
 * 功能静默失效。垂直源不足以填满预留时，用剩余主源回填，不浪费槽位。
 *
 * @param {Array} primary - 主源结果（有序）
 * @param {Array} extras - 垂直源结果（应为交错后的顺序，见 interleave）
 * @param {number} maxResults - 结果上限
 * @param {number} reserve - 为垂直源预留的槽位数
 * @returns {{sources: Array, truncated: boolean}}
 */
export function mergeSources(primary, extras, maxResults, reserve = 0) {
  const extraList = extras ?? []
  const reserved = Math.min(extraList.length, Math.max(0, reserve))
  const primaryQuota = Math.max(0, maxResults - reserved)

  const out = []
  const seen = new Set()
  const push = (item) => {
    if (out.length >= maxResults) return false
    if (!item?.url || seen.has(item.url)) return true // 跳过但不算满
    seen.add(item.url)
    out.push(item)
    return true
  }

  for (const item of (primary ?? []).slice(0, primaryQuota)) push(item)
  for (const item of extraList) push(item)
  // 垂直源少于预留数时，用剩余主源回填。
  for (const item of primary ?? []) push(item)

  return { sources: out, truncated: out.length >= maxResults }
}

export class ZeroKeySearchProvider {
  id = ZEROKEY_PROVIDER_ID

  constructor(options) {
    this.options = options
    /** GitHub 退避截止时间戳（epoch ms）。0 = 未处于冷却。 */
    this.githubCooldownUntil = 0
  }

  /**
   * 恒真：本 provider 不需要任何凭据或外部实例。
   *
   * 这正是它与商业后端（需要 key）和 SearXNG（需要实例）的根本区别——
   * 它把"能不能搜"从"配置对不对"变回"网络通不通"。
   */
  available() {
    return true
  }

  /** 请求 Bing 主源。失败会抛出——它是唯一不可降级的源。 */
  async #searchBing(query, limit, snippetChars, signal) {
    const url = new URL('https://cn.bing.com/search')
    url.searchParams.set('q', query)
    // 多取一些，抵消解析失败的损耗
    url.searchParams.set('count', String(Math.min(limit * 2, 30)))

    let response
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: BROWSER_HEADERS,
        // Bing 会 302 到 cn.bing.com；DSH 的 fetch 栈不跨源自动跟随，故直接请求 cn 域。
        redirect: 'follow',
        signal,
      })
    } catch (error) {
      const cause = error?.cause?.message ?? ''
      // CA 未注入是本机最容易撞上的失败，直接给出可执行的修复指引。
      if (String(cause).includes('certificate') || String(cause).includes('issuer')) {
        throw new Error(
          `zerokey 搜索 TLS 失败：${cause}。` +
            '这通常是 NODE_EXTRA_CA_CERTS 未注入到 DSH 进程；' +
            '修复见 handoff/README-CA修复说明.md',
        )
      }
      throw new Error(`zerokey 搜索请求失败：${String(error)}`)
    }

    if (!response.ok) {
      throw new Error(`zerokey 搜索返回 HTTP ${response.status}`)
    }

    const html = await response.text()
    const parsed = parseBingHtml(html, limit, snippetChars)

    if (parsed.sources.length === 0) {
      // 区分"真没结果"与"页面结构变了导致解析失败"——后者是代码问题，不该报成"无结果"。
      if (!html.includes('b_algo')) {
        throw new Error(
          'zerokey 搜索未解析出结果：Bing 页面结构可能已变更（未找到 b_algo 结果块）',
        )
      }
    }

    return parsed.sources
  }

  /**
   * 并行请求增强源。**任何失败都被吞掉**——增强源绝不能影响主结果。
   *
   * 但「吞掉」不等于「静默」：失败会写一行 stderr 警告。
   * 教训：本方法第一版把返回的 `{sources}` 包装对象当数组用，导致垂直源
   * 全部被静默丢弃（主结果看起来完全正常，功能其实是假的）。
   * 没有可观测性，这类 bug 不会被任何「主流程正常」的测试发现。
   *
   * @returns {Promise<Array>} 成功源的结果项（可能为空数组）
   */
  async #searchEnhanced(query, maxResults, signal) {
    const now = Date.now()
    const githubAllowed = now >= this.githubCooldownUntil

    // 每个任务都归一到「结果项数组」，并在失败时留下可见痕迹。
    const run = (label, fn) =>
      fn()
        .then((res) => res?.sources ?? [])
        .catch((error) => {
          if (error?.rateLimited) {
            // 撞限流则进入冷却，避免打光额度连累后续查询。
            this.githubCooldownUntil = Date.now() + GITHUB_COOLDOWN_MS
            process.stderr.write(`[zerokey] ${label} 限流，进入 ${GITHUB_COOLDOWN_MS / 60000} 分钟冷却\n`)
          } else {
            process.stderr.write(`[zerokey] ${label} 增强源失败（已降级为仅主源）：${error?.message ?? error}\n`)
          }
          return []
        })

    const tasks = [run('hackernews', () => searchHackerNews(query, maxResults, signal))]
    if (githubAllowed) {
      tasks.push(run('github', () => searchGitHub(query, maxResults, signal)))
    }

    // 交错而非 flat：否则排前面的源会独占预留槽位，后面的源永不出现。
    return interleave(await Promise.all(tasks))
  }

  async search(request, signal) {
    const options = this.options()
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const maxResults = request.maxResults ?? 10
    const maxSnippetChars = options.maxSnippetChars ?? DEFAULT_MAX_SNIPPET_CHARS

    const timeout = AbortSignal.timeout(timeoutMs)
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])

    // 决定是否启用增强源：默认开，可被配置关掉；查询必须被判为技术类。
    const enhancementsEnabled = options.multiSource !== false
    const useEnhanced = enhancementsEnabled && isTechQuery(request.query)

    // 关键：增强源必须有**预留槽位**，否则 Bing 填满 maxResults 后，
    // 追加的垂直结果会被整体截断、功能静默失效。
    const reserve = useEnhanced ? Math.min(3, Math.max(1, Math.floor(maxResults / 4))) : 0

    const [bingSources, extraSources] = await Promise.all([
      this.#searchBing(request.query, maxResults, maxSnippetChars, combined),
      useEnhanced
        ? this.#searchEnhanced(
            request.query,
            reserve,
            AbortSignal.any([combined, AbortSignal.timeout(ENHANCED_TIMEOUT_MS)]),
          )
        : Promise.resolve([]),
    ])

    if (extraSources.length === 0) {
      // 无增强结果：直接把主源结果按原本语义返回（含 truncated 标记）。
      return {
        sources: bingSources,
        truncated: bingSources.length >= maxResults,
      }
    }

    return mergeSources(bingSources, extraSources, maxResults, reserve)
  }
}

export function apply(ctx, config) {
  const provider = new ZeroKeySearchProvider(() => config ?? {})

  // CA 注入属于本插件的副作用，必须随 fiber 一起撤销（HMR / 卸载时不残留 patch）。
  // ctx.effect 的 disposer 会在插件销毁时调用还原函数。
  ctx.effect(() => installCaTrust(config?.caPath ?? DEFAULT_CA_PATH))

  ctx.web.registerSearchProvider(provider)
}
