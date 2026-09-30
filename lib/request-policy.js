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
 * 按 key 串行的最小间隔限速器（令牌桶的简化版：只保证间隔，不预存令牌）。
 *
 * 为什么按 key 分开：不同上游的敏感度不同（Bing 抓页最敏感，公开 API 宽松），
 * 用一个全局间隔会让慢源拖累快源。
 */
export class MinIntervalLimiter {
  /** @param {number} minIntervalMs */
  constructor(minIntervalMs = 800) {
    this.minIntervalMs = minIntervalMs
    /** @type {Map<string, number>} 上次发出的时间戳 */
    this.lastAt = new Map()
    /** @type {Map<string, Promise<void>>} 每个 key 的串行队列尾 */
    this.queues = new Map()
  }

  /**
   * 等到「距该 key 上次请求」满足最小间隔后执行 fn。
   * 同 key 的调用串行化，避免并发突发。
   */
  async run(key, fn) {
    const prev = this.queues.get(key) ?? Promise.resolve()
    const next = prev.then(async () => {
      const last = this.lastAt.get(key) ?? 0
      const wait = this.minIntervalMs - (Date.now() - last)
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

/** 该 HTTP 状态/错误是否值得重试（仅幂等且瞬时的失败）。 */
export function isRetryableStatus(status) {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599)
}

/**
 * 指数退避重试。
 *
 * 只用于**幂等 GET**；不对 POST（如掘金）重试，避免重复副作用。
 * 4xx（除 408/425/429）不重试——那是请求本身有问题，重试只是浪费请求、抬高暴露面。
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
