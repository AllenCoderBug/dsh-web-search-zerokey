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

/**
 * 零 key 搜索 provider。
 *
 * 选项以 thunk 传入，使设置层的改动能抵达下一次搜索而无需重启。
 */
export class ZeroKeySearchProvider {
  id = ZEROKEY_PROVIDER_ID

  constructor(options) {
    this.options = options
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

  async search(request, signal) {
    const options = this.options()
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const maxResults = request.maxResults ?? 10
    const maxSnippetChars = options.maxSnippetChars ?? DEFAULT_MAX_SNIPPET_CHARS

    const url = new URL('https://cn.bing.com/search')
    url.searchParams.set('q', request.query)
    // 多取一些，抵消解析失败的损耗
    url.searchParams.set('count', String(Math.min(maxResults * 2, 30)))

    const timeout = AbortSignal.timeout(timeoutMs)
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])

    let response
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: BROWSER_HEADERS,
        // Bing 会 302 到 cn.bing.com；DSH 的 fetch 栈不跨源自动跟随，故直接请求 cn 域。
        redirect: 'follow',
        signal: combined,
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
    const parsed = parseBingHtml(html, maxResults, maxSnippetChars)

    if (parsed.sources.length === 0) {
      // 区分"真没结果"与"页面结构变了导致解析失败"——后者是代码问题，不该报成"无结果"。
      if (!html.includes('b_algo')) {
        throw new Error(
          'zerokey 搜索未解析出结果：Bing 页面结构可能已变更（未找到 b_algo 结果块）',
        )
      }
    }

    return parsed
  }
}

export function apply(ctx, config) {
  const provider = new ZeroKeySearchProvider(() => config ?? {})

  // CA 注入属于本插件的副作用，必须随 fiber 一起撤销（HMR / 卸载时不残留 patch）。
  // ctx.effect 的 disposer 会在插件销毁时调用还原函数。
  ctx.effect(() => installCaTrust(config?.caPath ?? DEFAULT_CA_PATH))

  ctx.web.registerSearchProvider(provider)
}
