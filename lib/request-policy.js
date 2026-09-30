/**
 * 请求策略：缓存 / 限速 / 重试。
 *
 * 为什么这三样放在一起：它们共同回答同一个问题 —— **「在保证结果可用的前提下，
 * 怎样把对外请求次数与频率压到最低」**。三者变化同源（都随「上游有多敏感」调整），
 * 故同居一处；与具体搜索源的解析逻辑无关。
 *
 * 动机（合规实况见 UPGRADE-PLAN §4）：
 *   我们抓取的搜索结果路径（如 cn.bing.com/search）位于目标站 robots 的 Disallow 列表，
 *   用户已知情承担。既然承担，就更该**降低暴露面**：少发请求、拉开发送间隔。
 *   这既是「跑得稳」的工程需求，也客观降低被风控的概率。
 */

/** 进程内 TTL + LRU 缓存。 */
export class TtlCache {
  /**
   * @param {{maxEntries?: number, ttlMs?: number}} [opts]
   */
  constructor(opts = {}) {
    this.maxEntries = opts.maxEntries ?? 128
    this.ttlMs = opts.ttlMs ?? 5 * 60 * 1000
    /** @type {Map<string, {value: any, expiresAt: number}>} */
    this.map = new Map()
    this.hits = 0
    this.misses = 0
  }

  get(key) {
    const entry = this.map.get(key)
    if (!entry) {
      this.misses++
      return undefined
    }
    if (Date.now() > entry.expiresAt) {
      this.map.delete(key)
      this.misses++
      return undefined
    }
    // LRU：命中后重新插入到末尾（Map 保持插入序）
    this.map.delete(key)
    this.map.set(key, entry)
    this.hits++
    return entry.value
  }

  set(key, value, ttlMs = this.ttlMs) {
    if (ttlMs <= 0) return
    if (this.map.has(key)) this.map.delete(key)
    this.map.set(key, { value, expiresAt: Date.now() + ttlMs })
    // 超出容量则淘汰最旧的（Map 头部）
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next()
      if (oldest.done) break
      this.map.delete(oldest.value)
    }
  }

  clear() {
    this.map.clear()
    this.hits = 0
    this.misses = 0
  }

  get stats() {
    const total = this.hits + this.misses
    return {
      hits: this.hits,
      misses: this.misses,
      size: this.map.size,
      hitRate: total === 0 ? 0 : this.hits / total,
    }
  }
}

/**
 * 按 key 串行的最小间隔限速器。
 *
 * 为什么按 key 分开：不同上游的敏感度不同（Bing 抓页最敏感，公开 API 宽松；
 * arXiv 官方要求 3s/次），用全局间隔会让慢源拖累快源。
 *
 * ⚠️ 间隔值**必须按 key 存储**，不能放实例字段上。
 *   踩过的坑：初版用单一 `this.minIntervalMs`，而调用方在每次请求前按源设置它 ——
 *   多源并发时后设置的会覆盖先设置的，导致 arXiv 的 3000ms 官方限速被其他源的
 *   800ms 覆盖。这不只是快慢问题，而是**违反上游 ToU**，可能导致 IP 被封。
 *   故改为按 key 取值，构造时一次性传入。
 */
export class MinIntervalLimiter {
  /**
   * @param {number|Record<string, number>} [intervals]
   *        单一默认值，或 { sourceId: ms } 的按源映射（可含 `default` 键）
   */
  constructor(intervals = 800) {
    if (typeof intervals === 'number') {
      this.defaultIntervalMs = intervals
      this.intervals = {}
    } else {
      const { default: def, ...rest } = intervals ?? {}
      this.defaultIntervalMs = Number.isFinite(def) ? def : 800
      this.intervals = { ...rest }
    }
    /** @type {Map<string, number>} 上次发出的时间戳 */
    this.lastAt = new Map()
    /** @type {Map<string, Promise<void>>} 每个 key 的串行队列尾 */
    this.queues = new Map()
  }

  /** 该 key 的最小间隔（毫秒）。按 key 隔离，不受其他源设置影响。 */
  intervalFor(key) {
    const v = this.intervals[key]
    return Number.isFinite(v) ? v : this.defaultIntervalMs
  }

  /**
   * 等到「距该 key 上次请求」满足最小间隔后执行 fn。
   * 同 key 的调用串行化，避免并发突发。
   */
  async run(key, fn) {
    const prev = this.queues.get(key) ?? Promise.resolve()
    const next = prev.then(async () => {
      const interval = this.intervalFor(key)
      const last = this.lastAt.get(key) ?? 0
      const wait = interval - (Date.now() - last)
      if (wait > 0) await sleep(wait)
      this.lastAt.set(key, Date.now())
      return fn()
    })
    // 队列尾只保留「完成」信号，避免把结果透传给下一个调用者
    this.queues.set(
      key,
      next.then(
        () => undefined,
        () => undefined,
      ),
    )
    return next
  }

  /** 当前队列是否为空（供测试与观测用）。 */
  isIdle(key) {
    return !this.queues.has(key)
  }
}

/** 可被 signal 打断的 sleep。 */
export function sleep(ms, signal) {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason ?? new Error('aborted'))
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

/**
 * 该 HTTP 状态是否值得**在本次请求内重试**。
 *
 * ⚠️ 429（限流）**刻意不在此列**。
 *   被限流时立刻重试是有害的：只会加重限流，甚至触发 IP 封禁。
 *   实测踩到：`isRetryableStatus(429) === true` 导致同一查询把被限流的源
 *   连打 3 次（retries=2），而正确做法是**立刻放弃、交由冷却机制退避**
 *   （provider 层会把 429 记为限流并让该源冷却数分钟）。
 *
 * 5xx 与网络抖动是瞬时故障，重试有意义；408/425 同理。
 */
export function isRetryableStatus(status) {
  return status === 408 || status === 425 || (status >= 500 && status <= 599)
}

/**
 * 指数退避重试。
 *
 * 只用于**幂等 GET**；不对 POST（如掘金）重试，避免重复副作用。
 * 不重试的错误：
 *   - 4xx（除 408/425）—— 请求本身有问题，重试只是浪费请求、抬高暴露面
 *   - **429 限流** —— 立刻重试会加重限流；应交给冷却机制（见上方注释）
 */
export async function withRetry(fn, opts = {}) {
  const retries = opts.retries ?? 2
  const baseDelayMs = opts.baseDelayMs ?? 400
  const signal = opts.signal
  let lastError

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn(attempt)
    } catch (error) {
      lastError = error
      const status = error?.status
      // 限流是「明确要求你退开」的信号 —— 不在本次请求内重试。
      if (status === 429 || error?.rateLimited === true) break
      const retryable =
        status === undefined // 网络层错误（DNS/连接重置）默认可重试
          ? true
          : isRetryableStatus(status)
      if (attempt === retries || !retryable) break
      if (signal?.aborted) break
      // 退避 + 抖动，避免多个源同时重试形成尖峰
      const jitter = Math.random() * baseDelayMs * 0.3
      await sleep(baseDelayMs * 2 ** attempt + jitter, signal)
    }
  }
  throw lastError
}

/**
 * 带 TTL 的取值：命中缓存则直接返回，否则执行 producer 并写入。
 * 缓存 key 由调用方给出（须包含所有影响结果的参数，否则会串味）。
 */
export async function cached(cache, key, producer, ttlMs) {
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  const value = await producer()
  // 只缓存成功结果；空结果也缓存（避免反复请求确实无结果的 query）
  cache.set(key, value, ttlMs)
  return value
}
