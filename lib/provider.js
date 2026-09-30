/**
 * 搜索 provider 的编排层。
 *
 * 职责边界（单一理由）：**决定「这次查询该找哪些源、按什么顺序、失败怎么降级」**。
 * 它不知道任何源的具体协议（那是 lib/sources/* 的事），
 * 也不实现缓存/限速（那是 lib/request-policy.js 的事）。
 *
 * 三条硬约束（决定实现形态）：
 *   1. **主源不可降级** —— 主源失败即整体失败；垂直源失败只少几条。
 *   2. **垂直源失败不可静默** —— 必须留痕，否则「功能其实是假的」而无从发现。
 *      （教训：初版把返回的 {sources} 当数组用，垂直源全丢，主结果看起来完全正常。）
 *   3. **额度感知** —— 有额度的源撞限流后进入冷却，不连累后续查询。
 */
import { routeSources } from './route.js'
import { TtlCache, MinIntervalLimiter, SingleFlight, withRetry } from './request-policy.js'
import { interleave, mergeSources, computeReserve } from './merge.js'
import { enrichWithContent } from './enrich.js'
import { AdaptationStore } from './adapt.js'
import {
  SOURCES,
  PRIMARY_SOURCE_ID,
  ENHANCEMENT_SOURCE_IDS,
  SourceQuota,
} from './sources/registry.js'

const DEFAULT_TIMEOUT_MS = 12_000
const DEFAULT_MAX_SNIPPET_CHARS = 500
const ENHANCED_TIMEOUT_MS = 8_000

/**
 * 各源的默认最小请求间隔（毫秒）。
 *
 * ⚠️ arXiv 的 3000ms 不是保守取值，而是**官方硬性要求**（S 级依据）：
 *   arXiv API Terms of Use 原文：
 *     "When using the legacy APIs (including OAI-PMH, RSS, and the arXiv API),
 *      make no more than one request every three seconds, and limit requests to
 *      a single connection at a time."
 *   来源：https://info.arxiv.org/help/api/tou.html
 *   实测违反时返回 HTTP 429（本机已复现），且可能升级为整体不可达。
 *
 * 抓页类（bing/juejin/csdn）取保守值：降低暴露面，这也是「实用优先」路线下
 * 对已知情承担的 robots 风险的工程性缓解。
 */
const DEFAULT_MIN_INTERVALS = {
  bing: 1200,
  juejin: 800,
  csdn: 800,
  arxiv: 3000, // 官方要求，不可调低
}

/**
 * 各源撞限流后的冷却时长。
 *
 * - github：匿名额度 10/h，冷却 15 分钟
 * - arxiv：官方限速极严（3s/次），撞 429 后应显著退避，避免 IP 被整体封禁
 */
const DEFAULT_COOLDOWNS = {
  github: 15 * 60 * 1000,
  arxiv: 5 * 60 * 1000,
}

/** 可被 signal 打断的等待（用于并发收集带独立超时）。 */
function raceWithTimeout(promise, ms, signal) {
  const timeout = AbortSignal.timeout(ms)
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(combined.reason ?? new Error('aborted'))
    if (combined.aborted) return onAbort()
    combined.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (v) => {
        combined.removeEventListener('abort', onAbort)
        resolve(v)
      },
      (e) => {
        combined.removeEventListener('abort', onAbort)
        reject(e)
      },
    )
  })
}

export class ZeroKeySearchProvider {
  id = 'zerokey'

  /**
   * @param {() => object} options - 选项 thunk（使设置层改动能抵达下一次搜索而无需重启）
   * @param {{
   *   log?: (msg: string) => void,
   *   fetchText?: (url: string, signal?: AbortSignal) => Promise<string>,
   *   sources?: Map<string, {id:string, search: Function}>,
   *   adapt?: AdaptationStore,
   * }} [deps]
   *   `fetchText` 必须是宿主提供的取文函数（内部走 ctx.web.fetch），
   *   以便复用宿主的 SSRF 防护。未提供时正文增强自动不可用（P4 跳过）。
   *
   *   `sources` 是**测试接缝**：允许注入假源来验证编排逻辑（降级、配额、
   *   交错、冷却）而无需真实网络。默认走真实 registry。
   */
  constructor(options, deps = {}) {
    this.options = options
    this.log = deps.log ?? ((msg) => process.stderr.write(`[zerokey] ${msg}\n`))
    this.fetchText = deps.fetchText
    /** 源表：默认真实 registry，可注入假源用于测试编排。 */
    this.sources = deps.sources ?? SOURCES

    // 缓存与限速按 provider 实例持有：实例随插件生命周期，HMR 卸载即释放。
    // 限速器的间隔是**按源映射**、构造时一次传入 ——
    // 见 MinIntervalLimiter 注释：按源逐个赋值实例字段在并发下会互相覆盖，
    // 会让 arXiv 的 3000ms 官方限速失效（违反 ToU，有 IP 被封风险）。
    // 选项是 thunk（允许运行期改配置），故按需重建并在配置变化时替换。
    this.cache = new TtlCache()
    // 同键并发合并：TTL 缓存挡不住并发穿透（实测 10 并发 = 10 次上游请求）。
    this.singleFlight = new SingleFlight()
    this.limiter = null
    this.limiterSignature = ''
    this.quota = new SourceQuota(DEFAULT_COOLDOWNS)

    // 自适应：把已观测到的事实（成功率/延迟/限流率）转成下一次的调度决策。
    // 状态持久化到 $DSH_HOME/cache/，使「这次学到的」能带到下次运行 ——
    // 否则每次重启归零，那不叫进化。
    this.adapt = deps.adapt ?? new AdaptationStore()
    this.adapt.load()

    // 正文增强的延迟观测（用于「用数据决策」）。
    this.contentStats = { calls: 0, totalMs: 0, failures: 0 }
  }

  /**
   * 恒真：本 provider 不需要任何凭据或外部实例。
   *
   * 这正是它与商业后端（需要 key）和 SearXNG（需要实例）的根本区别——
   * 它把「能不能搜」从「配置对不对」变回「网络通不通」。
   */
  available() {
    return true
  }

  /** 取当前生效配置（含默认值）。 */
  #config() {
    const o = this.options() ?? {}
    return {
      timeoutMs: o.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxSnippetChars: o.maxSnippetChars ?? DEFAULT_MAX_SNIPPET_CHARS,
      multiSource: o.multiSource !== false,
      cacheTtlMs: o.cacheTtlMs ?? 5 * 60 * 1000,
      retries: o.retries ?? 2,
      minIntervals: { ...DEFAULT_MIN_INTERVALS, ...(o.minIntervals ?? {}) },
      // P4：默认关闭。理由见 lib/enrich.js 头部——代价真实（延迟+token），
      // 应由实测数据决定是否开启，而非默认打开。
      includeContent: o.includeContent === true,
      contentMaxFetch: o.contentMaxFetch ?? 2,
      contentMaxChars: o.contentMaxChars ?? 1200,
    }
  }

  /**
   * 跑一个源，带缓存 + 限速 + 重试。
   *
   * 缓存 key 必须包含**所有影响结果的参数**，否则会串味
   * （不同 maxResults/snippet 长度返回不同内容）。
   */
  async #runSource(sourceId, query, opts) {
    const source = this.sources.get(sourceId)
    if (!source) return []

    const cfg = this.#config()
    const cacheKey = JSON.stringify([
      sourceId,
      query,
      opts.maxResults,
      cfg.maxSnippetChars,
    ])

    const cached = this.cache.get(cacheKey)
    if (cached !== undefined) return cached

    // 同键合并：并发相同查询只打一次上游。
    // 为什么不能只靠 TTL 缓存：实测 10 个相同 query 并发时都查不到缓存，
    // 于是各自打一次上游（10 次请求）。这与「降低暴露面」冲突，
    // 而「同一查询短时高频重复」正是被风控盯上的典型形态。
    return this.singleFlight.run(cacheKey, async () => {
      // 双重检查：等锁期间可能已有同键请求完成并写入缓存。
      const recheck = this.cache.get(cacheKey)
      if (recheck !== undefined) return recheck

      const started = Date.now()
      const runOnce = () =>
        this.#limiter(cfg.minIntervals).run(sourceId, () =>
          withRetry(
            () =>
              source.search(query, {
                maxResults: opts.maxResults,
                maxSnippetChars: cfg.maxSnippetChars,
                signal: opts.signal,
              }),
            { retries: cfg.retries, signal: opts.signal },
          ),
        )

      try {
        const result = await runOnce()
        const sources = result?.sources ?? []
        // 自适应观测：只有真实打到上游才计入（缓存命中不算，否则会虚高成功率）。
        this.adapt.record(sourceId, { ok: true, latencyMs: Date.now() - started })
        this.cache.set(cacheKey, sources, cfg.cacheTtlMs)
        return sources
      } catch (error) {
        this.adapt.record(sourceId, {
          ok: false,
          latencyMs: Date.now() - started,
          rateLimited:
            error?.status === 429 || error?.status === 403 || error?.rateLimited === true,
        })
        throw error
      }
    })
  }

  /**
   * 取限速器；间隔配置变了就重建。
   *
   * 为什么要签名比对而不是每次新建：限速器持有 `lastAt` 状态，
   * 每次新建会丢掉「上次请求时间」，导致间隔约束形同虚设。
   */
  #limiter(minIntervals) {
    const signature = JSON.stringify(minIntervals)
    if (this.limiter === null || this.limiterSignature !== signature) {
      this.limiter = new MinIntervalLimiter(minIntervals)
      this.limiterSignature = signature
    }
    return this.limiter
  }

  /**
   * 按自适应的配额倍率缩放某源的请求条数。
   *
   * 安全边界：倍率被夹在 [0.5, 1.5]，且至少保留 1 条 ——
   * 自适应**只能让某源少要几条或多要一条**，不可能把它彻底关掉。
   * 这是刻意的：调度参数可自适应，能力开闭不可。
   */
  #quotaForSource(sourceId, base) {
    const factor = this.adapt.quotaFactor(sourceId)
    const scaled = Math.round(base * factor)
    return Math.max(1, Math.min(Math.max(base, 1) + 1, scaled))
  }

  /**
   * 并行请求垂直源。**任何失败都被吞掉**（不影响主结果），
   * 但必须留痕 —— 见文件头「教训」。
   */
  async #searchEnhanced(query, reservePerSource, signal, enabledIds) {
    const cfg = this.#config()
    const tasks = []

    for (const sourceId of enabledIds) {
      if (sourceId === PRIMARY_SOURCE_ID) continue
      if (!this.quota.isAvailable(sourceId)) {
        this.log(
          `${sourceId} 处于冷却（剩 ${Math.round(this.quota.cooldownRemaining(sourceId) / 1000)}s），本次跳过`,
        )
        continue
      }

      const task = this.#runSource(sourceId, query, {
        maxResults: this.#quotaForSource(sourceId, reservePerSource),
        signal,
      })
        .then((sources) => sources)
        .catch((error) => {
          // 失败分类必须统一在这里做，不能只依赖各源自己打标记。
          // 教训一：最初只有 GitHub 源设了 error.rateLimited，其余源（含 arXiv）
          //   只设了 error.status —— 导致 arXiv 的 429 不触发冷却，反复撞墙。
          //   而 arXiv 官方限速是「每 3 秒最多一次」，反复撞 429 有 IP 被封风险。
          // 教训二：arXiv 实测常以**超时**告终（TimeoutError，无 status），
          //   而超时同样说明该源当下不可用 —— 不退避就会每次白等 8 秒。
          const status = error?.status
          const isRateLimited = error?.rateLimited === true || status === 429 || status === 403
          const isTimeout = error?.name === 'TimeoutError' || /aborted due to timeout/i.test(String(error?.message))

          if (isRateLimited || isTimeout) {
            // 自适应：该源历史上退避越频繁，冷却拉得越长（上限 4 倍）。
            const factor = this.adapt.cooldownFactor(sourceId)
            const cooled = this.quota.markRateLimited(sourceId, factor)
            const remainMs = this.quota.cooldownRemaining(sourceId)
            const reason = isTimeout ? '超时' : `HTTP ${status ?? '?'}`
            this.log(
              `${sourceId} ${reason}` +
                (cooled
                  ? `，进入 ${Math.round(remainMs / 60000)} 分钟冷却` +
                    (factor > 1 ? `（自适应 ×${factor.toFixed(1)}）` : '')
                  : '（未配置冷却）'),
            )
          } else {
            this.log(`${sourceId} 增强源失败（已降级为仅主源）：${error?.message ?? error}`)
          }
          return []
        })

      tasks.push(task)
    }

    // 交错而非 flat：否则排前面的源会独占预留槽位，后面的源永不出现。
    return interleave(await Promise.all(tasks))
  }

  async search(request, signal) {
    const cfg = this.#config()
    const query = String(request?.query ?? '').trim()

    // 空查询直接返回空结果，不发请求。
    // 为什么必须显式处理：实测踩到 —— 空查询会真的请求 Bing，拿到无结果页后
    // 抛「页面结构可能已变更」的**误导性错误**，让排查方向完全跑偏。
    // 空查询是可预期的输入，不是异常。
    if (query.length === 0) {
      return { sources: [], truncated: false }
    }

    // 契约：maxResults 必须是有效的非负整数。
    // 实测踩到 —— maxResults=0 时仍返回 1 条（下游各层各自兜底成 1），违反契约。
    const rawMax = Number(request?.maxResults ?? 10)
    const maxResults = Number.isFinite(rawMax) ? Math.max(0, Math.floor(rawMax)) : 10
    if (maxResults === 0) {
      return { sources: [], truncated: false }
    }

    const timeout = AbortSignal.timeout(cfg.timeoutMs)
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])

    // 路由：决定启用哪些源。拿不准就不增强（宁可漏判，不可误判）。
    // 可用源按**注入的源表**计算（而非固定常量），使测试接缝对路由也生效。
    const availableIds = [...this.sources.keys()].filter((sid) => sid !== PRIMARY_SOURCE_ID)
    const routed = cfg.multiSource
      ? routeSources(query, { available: availableIds })
      : []

    const reserve = computeReserve(maxResults, routed.length > 0)
    const enhancedSignal = AbortSignal.any([
      combined,
      AbortSignal.timeout(ENHANCED_TIMEOUT_MS),
    ])

    const [primarySources, extraSources] = await Promise.all([
      this.#runSource(PRIMARY_SOURCE_ID, query, {
        maxResults,
        signal: combined,
      }),
      routed.length > 0
        ? this.#searchEnhanced(query, reserve, enhancedSignal, routed)
        : Promise.resolve([]),
    ])

    if (extraSources.length === 0) {
      const merged = {
        sources: primarySources,
        truncated: primarySources.length >= maxResults,
      }
      const out = await this.#maybeEnrich(merged, combined, cfg)
      this.adapt.save(this.log)
      return out
    }

    const merged = mergeSources(primarySources, extraSources, maxResults, reserve)
    const enriched = await this.#maybeEnrich(merged, combined, cfg)
    // 自适应状态落盘：放在最后且失败不影响结果（save 内部已吞异常）。
    // 这样「这次学到的」能带到下次运行，否则重启即归零。
    this.adapt.save(this.log)
    return enriched
  }

  /**
   * P4：按配置为结果补充正文片段。
   *
   * 默认关闭。开启时通过 `this.fetchText`（宿主 ctx.web.fetch）取文，
   * **绝不裸 fetch** —— 宿主的 fetchProvider 内含 SSRF 防护（公网 IP 校验、
   * DNS 重绑定防护、同源重定向检查），裸抓会绕过全部这些。
   */
  async #maybeEnrich(result, signal, cfg) {
    if (!cfg.includeContent || typeof this.fetchText !== 'function') return result

    const cacheKey = JSON.stringify([
      'enrich',
      result.sources.map((s) => s.url),
      cfg.contentMaxChars,
    ])
    const cached = this.cache.get(cacheKey)
    if (cached !== undefined) return { ...result, sources: cached }

    const started = Date.now()
    try {
      const sources = await enrichWithContent(result.sources, {
        fetchText: this.fetchText,
        maxFetch: cfg.contentMaxFetch,
        maxChars: cfg.contentMaxChars,
        signal,
        log: this.log,
      })
      const elapsed = Date.now() - started
      this.contentStats.calls++
      this.contentStats.totalMs += elapsed
      const got = sources.filter((s) => s.content).length
      this.log(`正文增强：${got}/${Math.min(cfg.contentMaxFetch, sources.length)} 条成功，耗时 ${elapsed}ms`)
      this.cache.set(cacheKey, sources, cfg.cacheTtlMs)
      return { ...result, sources }
    } catch (error) {
      // 正文增强失败绝不能影响搜索结果本身。
      this.contentStats.failures++
      this.log(`正文增强整体失败（不影响搜索结果）：${error?.message ?? error}`)
      return result
    }
  }

  /** 供测试与观测：缓存统计。 */
  get stats() {
    return { cache: this.cache.stats }
  }
}
