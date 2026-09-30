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
import {
  TtlCache,
  MinIntervalLimiter,
  withRetry,
  sleep,
} from './request-policy.js'
import { interleave, mergeSources, computeReserve } from './merge.js'
import { enrichWithContent } from './enrich.js'
import {
  SOURCES,
  PRIMARY_SOURCE_ID,
  ENHANCEMENT_SOURCE_IDS,
  getSource,
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
   * }} [deps]
   *   `fetchText` 必须是宿主提供的取文函数（内部走 ctx.web.fetch），
   *   以便复用宿主的 SSRF 防护。未提供时正文增强自动不可用（P4 跳过）。
   */
  constructor(options, deps = {}) {
    this.options = options
    this.log = deps.log ?? ((msg) => process.stderr.write(`[zerokey] ${msg}\n`))
    this.fetchText = deps.fetchText

    // 缓存与限速按 provider 实例持有：实例随插件生命周期，HMR 卸载即释放。
    // 限速器的间隔是**按源映射**、构造时一次传入 ——
    // 见 MinIntervalLimiter 注释：按源逐个赋值实例字段在并发下会互相覆盖，
    // 会让 arXiv 的 3000ms 官方限速失效（违反 ToU，有 IP 被封风险）。
    // 选项是 thunk（允许运行期改配置），故按需重建并在配置变化时替换。
    this.cache = new TtlCache()
    this.limiter = null
    this.limiterSignature = ''
    this.quota = new SourceQuota(DEFAULT_COOLDOWNS)

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
    const source = getSource(sourceId)
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

    const result = await runOnce()
    const sources = result?.sources ?? []
    this.cache.set(cacheKey, sources, cfg.cacheTtlMs)
    return sources
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
        maxResults: reservePerSource,
        signal,
      })
        .then((sources) => sources)
        .catch((error) => {
          // 限流识别必须统一在这里做，不能只依赖各源自己打标记。
          // 教训：最初只有 GitHub 源设了 error.rateLimited，其余源（含 arXiv）
          // 只设了 error.status —— 导致 arXiv 的 429 不触发冷却，反复撞墙。
          // 而 arXiv 官方限速是「每 3 秒最多一次」，反复撞 429 有 IP 被封风险。
          const status = error?.status
          const isRateLimited = error?.rateLimited === true || status === 429 || status === 403

          if (isRateLimited) {
            const cooled = this.quota.markRateLimited(sourceId)
            const remainMs = this.quota.cooldownRemaining(sourceId)
            this.log(
              `${sourceId} 限流（HTTP ${status ?? '?'}）` +
                (cooled ? `，进入 ${Math.round(remainMs / 60000)} 分钟冷却` : '（未配置冷却）'),
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
    const maxResults = request.maxResults ?? 10

    const timeout = AbortSignal.timeout(cfg.timeoutMs)
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])

    // 路由：决定启用哪些源。拿不准就不增强（宁可漏判，不可误判）。
    const routed = cfg.multiSource
      ? routeSources(request.query, { available: ENHANCEMENT_SOURCE_IDS })
      : []

    const reserve = computeReserve(maxResults, routed.length > 0)
    const enhancedSignal = AbortSignal.any([
      combined,
      AbortSignal.timeout(ENHANCED_TIMEOUT_MS),
    ])

    const [primarySources, extraSources] = await Promise.all([
      this.#runSource(PRIMARY_SOURCE_ID, request.query, {
        maxResults,
        signal: combined,
      }),
      routed.length > 0
        ? this.#searchEnhanced(request.query, reserve, enhancedSignal, routed)
        : Promise.resolve([]),
    ])

    if (extraSources.length === 0) {
      const merged = {
        sources: primarySources,
        truncated: primarySources.length >= maxResults,
      }
      return this.#maybeEnrich(merged, combined, cfg)
    }

    const merged = mergeSources(primarySources, extraSources, maxResults, reserve)
    return this.#maybeEnrich(merged, combined, cfg)
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
