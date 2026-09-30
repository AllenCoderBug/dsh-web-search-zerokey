/**
 * 自适应：让 provider 根据**自身运行的真实信号**自动调整参数。
 *
 * ## 为什么做，以及不是什么
 *
 * 这不是「机器学习」也不是「自我修改代码」。它只做一件事：
 * **把已经观测到的事实，转成下一次的调度决策。**
 *
 * 判据（为什么这三个信号是可靠的，而不是猜的）：
 *   - **成功率**：源反复失败就该少用它 —— 这是可观测事实，不是偏好。
 *   - **延迟**：源太慢就该降低它在结果里的配额 —— 直接关系用户体验。
 *   - **限流率**：撞 429 说明额度吃紧，冷却时长应自动拉长 —— 已有实证
 *     （arXiv 官方要求 3s/次，违反后可达性从 429 恶化到 000）。
 *
 * ## 为什么必须持久化
 *
 * 进程内的统计每次重启就归零 —— 那**不叫进化，叫随机**。
 * 故状态写入 `$DSH_HOME/cache/dsh-web-search-zerokey/adapt.json`，
 * 让「这次学到的」能带到下次运行。
 *
 * ## 为什么采用保守收敛（而不是激进调参）
 *
 * 样本少时的统计不可信（1 次失败 ≠ 这源不可用）。
 * 故：
 *   - 有**最小样本数**门槛，不够就不调整
 *   - 调整有**上下限**，不会把某个源饿死或无限放大
 *   - 失败会随时间**衰减**，避免一次偶发故障永久影响调度
 *
 * ## 安全边界（最重要）
 *
 * 自适应**只能调整调度参数**（配额、冷却），
 * **绝不允许**开关安全机制、修改源清单、或触碰那张 pin。
 * 这是设计红线：可自适应的东西必须是「调错了也只是慢一点」的东西。
 */
import fs from 'node:fs'
import path from 'node:path'

/** 默认持久化位置（DSH_HOME 优先，回退到 ~/.dsh）。 */
export function defaultStatePath() {
  const home = process.env.DSH_HOME ?? path.join(process.env.HOME ?? '', '.dsh')
  return path.join(home, 'cache', 'dsh-web-search-zerokey', 'adapt.json')
}

/** 一个源的可调参数（全部都在安全范围内）。 */
const LIMITS = {
  /** 配额倍率：低于 1 表示减少该源的预留槽位。 */
  quotaFactor: { min: 0.5, max: 1.5, default: 1 },
  /** 冷却倍率：高于 1 表示撞限流后等更久。 */
  cooldownFactor: { min: 1, max: 4, default: 1 },
}

/** 统计窗口的衰减因子（0.9 = 每次记录让旧数据权重降 10%）。 */
const DECAY = 0.9

/** 触发调整所需的最小样本数（低于此不调整，避免小样本噪声）。 */
const MIN_SAMPLES = 3

/** 成功率的可接受下限：低于它就减少配额。 */
const SUCCESS_FLOOR = 0.6

/** 限流率上限：高于它就把冷却拉长。 */
const RATE_LIMIT_CEILING = 0.2

/** 把一个值夹到安全区间。 */
function clamp(value, { min, max, default: def }) {
  const n = Number(value)
  if (!Number.isFinite(n)) return def
  return Math.min(max, Math.max(min, n))
}

export class AdaptationStore {
  /**
   * @param {object} [opts]
   * @param {string} [opts.statePath] - 持久化路径
   * @param {boolean} [opts.enabled] - 总开关（默认开）
   * @param {boolean} [opts.persist] - 是否落盘（默认开；测试可关）
   */
  constructor(opts = {}) {
    this.statePath = opts.statePath ?? defaultStatePath()
    this.enabled = opts.enabled !== false
    this.persist = opts.persist !== false

    /**
     * 每源统计（指数衰减）。
     * @type {Map<string, {success:number, failure:number, rateLimited:number,
     *                     samples:number, latencyMs:number, quotaFactor:number,
     *                     cooldownFactor:number}>}
     */
    this.stats = new Map()
    this.loaded = false
    this.dirty = false
  }

  /** 取某源统计（不存在则建默认）。 */
  #ensure(sourceId) {
    let s = this.stats.get(sourceId)
    if (!s) {
      s = {
        success: 0,
        failure: 0,
        rateLimited: 0,
        samples: 0,
        latencyMs: 0,
        quotaFactor: LIMITS.quotaFactor.default,
        cooldownFactor: LIMITS.cooldownFactor.default,
      }
      this.stats.set(sourceId, s)
    }
    return s
  }

  /**
   * 记录一次源调用结果。
   *
   * 衰减的含义：旧观测的影响随时间下降，使系统能跟上上游状态的变化
   * （上游变好了，历史失败不该永久拖累它）。
   */
  record(sourceId, { ok, latencyMs = 0, rateLimited = false } = {}) {
    if (!this.enabled) return
    const s = this.#ensure(sourceId)

    // 衰减
    s.success *= DECAY
    s.failure *= DECAY
    s.rateLimited *= DECAY
    s.samples *= DECAY
    s.latencyMs = s.latencyMs * DECAY + Math.max(0, latencyMs) * (1 - DECAY)

    s.samples += 1
    if (ok) s.success += 1
    else s.failure += 1
    if (rateLimited) s.rateLimited += 1

    this.#reevaluate(sourceId, s)
    this.dirty = true
  }

  /** 依据统计重算可调参数（有门槛、有上下限）。 */
  #reevaluate(sourceId, s) {
    if (s.samples < MIN_SAMPLES) return

    const total = s.success + s.failure
    const successRate = total > 0 ? s.success / total : 1
    const rateLimitRate = total > 0 ? s.rateLimited / total : 0

    // 成功率低 → 减少配额（但不饿死：下限 0.5）
    const targetQuota =
      successRate < SUCCESS_FLOOR
        ? Math.max(LIMITS.quotaFactor.min, successRate / SUCCESS_FLOOR)
        : LIMITS.quotaFactor.default

    // 限流频繁 → 拉长冷却（上限 4 倍）
    const targetCooldown =
      rateLimitRate > RATE_LIMIT_CEILING
        ? Math.min(
            LIMITS.cooldownFactor.max,
            1 + (rateLimitRate - RATE_LIMIT_CEILING) * 4,
          )
        : LIMITS.cooldownFactor.default

    // 平滑过渡：一次只走一半，避免抖动
    s.quotaFactor = clamp(
      s.quotaFactor + (clamp(targetQuota, LIMITS.quotaFactor) - s.quotaFactor) * 0.5,
      LIMITS.quotaFactor,
    )
    s.cooldownFactor = clamp(
      s.cooldownFactor + (clamp(targetCooldown, LIMITS.cooldownFactor) - s.cooldownFactor) * 0.5,
      LIMITS.cooldownFactor,
    )
  }

  /** 该源的配额倍率（用于缩放预留槽位）。 */
  quotaFactor(sourceId) {
    if (!this.enabled) return LIMITS.quotaFactor.default
    return this.#ensure(sourceId).quotaFactor
  }

  /** 该源的冷却倍率（用于拉长冷却时间）。 */
  cooldownFactor(sourceId) {
    if (!this.enabled) return LIMITS.cooldownFactor.default
    return this.#ensure(sourceId).cooldownFactor
  }

  /** 供观测：某源的摘要。 */
  summary(sourceId) {
    const s = this.#ensure(sourceId)
    const total = s.success + s.failure
    return {
      samples: Math.round(s.samples),
      successRate: total > 0 ? Number((s.success / total).toFixed(2)) : null,
      rateLimitRate: total > 0 ? Number((s.rateLimited / total).toFixed(2)) : null,
      avgLatencyMs: Math.round(s.latencyMs),
      quotaFactor: Number(s.quotaFactor.toFixed(2)),
      cooldownFactor: Number(s.cooldownFactor.toFixed(2)),
    }
  }

  /** 全部源的摘要。 */
  summarizeAll() {
    const out = {}
    for (const id of this.stats.keys()) out[id] = this.summary(id)
    return out
  }

  // -------------------------------------------------------------------------
  // 持久化
  // -------------------------------------------------------------------------

  /** 从磁盘载入（幂等；失败不影响运行）。 */
  load() {
    if (this.loaded) return
    this.loaded = true
    if (!this.persist) return
    try {
      const raw = fs.readFileSync(this.statePath, 'utf8')
      const data = JSON.parse(raw)
      for (const [id, s] of Object.entries(data?.sources ?? {})) {
        this.stats.set(id, {
          success: Number(s.success) || 0,
          failure: Number(s.failure) || 0,
          rateLimited: Number(s.rateLimited) || 0,
          samples: Number(s.samples) || 0,
          latencyMs: Number(s.latencyMs) || 0,
          quotaFactor: clamp(s.quotaFactor, LIMITS.quotaFactor),
          cooldownFactor: clamp(s.cooldownFactor, LIMITS.cooldownFactor),
        })
      }
    } catch {
      // 首次运行没有文件、或文件损坏 —— 都从零开始，不是错误。
    }
  }

  /** 写回磁盘（尽力而为：失败只记日志，绝不影响搜索）。 */
  save(log = () => {}) {
    if (!this.persist || !this.dirty) return
    try {
      fs.mkdirSync(path.dirname(this.statePath), { recursive: true })
      // 数值取整后再落盘：指数衰减会产生 2.999999999999999 这类浮点长尾，
      // 语义上没有意义，却让状态文件难以人读与 diff。
      // 保留 4 位小数对倍率足够（其有效区间只有 [0.5,4]）。
      const round4 = (n) => Math.round(Number(n) * 1e4) / 1e4
      const sources = {}
      for (const [id, s] of this.stats) {
        sources[id] = {
          success: round4(s.success),
          failure: round4(s.failure),
          rateLimited: round4(s.rateLimited),
          samples: round4(s.samples),
          latencyMs: Math.round(s.latencyMs),
          quotaFactor: round4(s.quotaFactor),
          cooldownFactor: round4(s.cooldownFactor),
        }
      }
      const payload = {
        version: 1,
        updatedAt: new Date().toISOString(),
        // 安全说明：本文件只存调度参数。它被篡改的最坏后果是
        // 「某个源配额变小/冷却变长」——即性能下降，不会有安全影响。
        sources,
      }
      // 先写临时文件再改名：避免写到一半进程退出留下坏文件。
      const tmp = `${this.statePath}.tmp-${process.pid}`
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2))
      fs.renameSync(tmp, this.statePath)
      this.dirty = false
    } catch (error) {
      log(`自适应状态写入失败（不影响搜索）：${error?.message ?? error}`)
    }
  }

  /** 清空统计（供测试与人工重置）。 */
  reset() {
    this.stats.clear()
    this.dirty = true
  }
}
