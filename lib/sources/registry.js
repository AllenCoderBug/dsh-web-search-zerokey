/**
 * 源注册表。
 *
 * 为什么单独一个文件：**新增一个源只该改这里 + 加一个适配器文件**，
 * 不该动编排、路由、合并。这是拆分的直接收益。
 *
 * 每个源的 `kind`：
 *   - `scrape`：抓页面（受 robots 约束，用户已知情承担）
 *   - `api`：官方/站点 API（合规）
 */
import * as bing from './bing.js'
import * as hackernews from './hackernews.js'
import * as github from './github.js'
import * as arxiv from './arxiv.js'
import * as npm from './npm.js'
import * as juejin from './juejin.js'
import * as csdn from './csdn.js'

/** 主源（唯一不可降级）。 */
export const PRIMARY_SOURCE_ID = 'bing'

/** 全部已实现的源，按 id 索引。 */
export const SOURCES = new Map(
  [bing, hackernews, github, arxiv, npm, juejin, csdn].map((m) => [m.id, m]),
)

/** 可作为垂直增强的源 id（即除主源外全部）。 */
export const ENHANCEMENT_SOURCE_IDS = [...SOURCES.keys()].filter(
  (sid) => sid !== PRIMARY_SOURCE_ID,
)

/**
 * 取源的实现；未知 id 返回 undefined（路由层可能给出未实现的源）。
 * @param {string} sourceId
 */
export function getSource(sourceId) {
  return SOURCES.get(sourceId)
}

/**
 * 限额管理：某些源有严格额度，撞限流后需冷却。
 * 状态放在这里而非源实现内 —— 源适配器应保持无状态、可并发。
 */
export class SourceQuota {
  /**
   * @param {Record<string, number>} [cooldownMsById] 各源冷却时长（毫秒）
   * @param {number} [defaultCooldownMs] 未单独配置的源的兜底冷却
   */
  constructor(cooldownMsById = {}, defaultCooldownMs = 2 * 60 * 1000) {
    this.cooldowns = { ...cooldownMsById }
    this.defaultCooldownMs = defaultCooldownMs
    /** @type {Map<string, number>} 冷却截止时间戳 */
    this.until = new Map()
  }

  /** 该源当前是否可用（未处于冷却）。 */
  isAvailable(sourceId) {
    const until = this.until.get(sourceId)
    if (until === undefined) return true
    if (Date.now() >= until) {
      this.until.delete(sourceId)
      return true
    }
    return false
  }

  /**
   * 记录一次限流，进入冷却。
   *
   * 未显式配置冷却的源使用兜底值 —— 而不是「不冷却」。
   * 理由：撞 429 却立刻重试，等于持续 hammering 上游，
   * 会从「临时限流」升级为「IP 被封」。兜底冷却让任何源在被拒后都先退开。
   *
   * @param {string} sourceId
   * @param {number} [factor] 冷却倍率（自适应用：频繁限流则自动拉长）
   */
  markRateLimited(sourceId, factor = 1) {
    const base = this.cooldowns[sourceId] ?? this.defaultCooldownMs
    const f = Number.isFinite(factor) && factor > 0 ? factor : 1
    const ms = base * f
    if (!(ms > 0)) return false
    this.until.set(sourceId, Date.now() + ms)
    return true
  }

  /** 剩余冷却毫秒数（0 = 可用）。 */
  cooldownRemaining(sourceId) {
    const until = this.until.get(sourceId) ?? 0
    return Math.max(0, until - Date.now())
  }
}
