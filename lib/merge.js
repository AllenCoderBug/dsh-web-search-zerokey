/**
 * 结果合并：主源与垂直源之间分配槽位。
 *
 * 为什么不做「跨引擎共识排序」（omp 的做法）：
 *   共识排序需要多个**通用** web 引擎（Google/Bing/DDG 查同一片网页）才有意义。
 *   而这里的增强源是**垂直源**（HN 是讨论、GitHub 是仓库、arXiv 是论文），
 *   与 Bing 的网页结果语义不同，共识度天然为 0，排序反而会把垂直结果全压到末尾。
 *   故采用「主源优先 + 垂直源预留槽位」——更朴素，但更符合语义。
 *
 * **预留槽位是关键**：若不预留，主源填满 maxResults 后垂直结果会被整体截断，
 * 表现为功能静默失效（实测踩到过）。
 */

/**
 * 把多个垂直源的结果**交错**合并（round-robin），保证每个源都有代表。
 *
 * 为什么不能直接 `flat()`：
 *   若某源返回条数多且排在前面，flat 后它会独占全部预留槽位，
 *   后面的源永远进不来 —— 表现为「配了 GitHub 却从来没出现过 GitHub 结果」。
 *   （实测踩到：HN 与 GitHub 各 2 条，reserve=2 时 GitHub 恒为 0。）
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
 * 合并主源与垂直源，按配额分配槽位并按 URL 去重。
 *
 * @param {Array} primary - 主源结果（有序）
 * @param {Array} extras - 垂直源结果（应为 interleave 后的顺序）
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
  /** 是否**真的有条目**因超出上限而被丢弃。 */
  let dropped = false

  const push = (item) => {
    if (!item?.url || seen.has(item.url)) return true // 跳过但不算满
    if (out.length >= maxResults) {
      dropped = true // 是「被上限挤掉」，不是「重复」或「非法」
      return false
    }
    seen.add(item.url)
    out.push(item)
    return true
  }

  for (const item of (primary ?? []).slice(0, primaryQuota)) push(item)
  for (const item of extraList) push(item)
  // 垂直源少于预留数时，用剩余主源回填，不浪费槽位。
  for (const item of primary ?? []) push(item)

  // 语义修正：`truncated` 应表示「**有内容被丢弃**」，而不是「结果刚好填满上限」。
  // 旧实现用 `out.length >= maxResults`，导致「主源恰好返回 maxResults 条」
  // 也被标成 truncated —— 但一条都没丢，这个标记是错的，
  // 会让消费者以为还有更多结果未展示。
  return { sources: out, truncated: dropped }
}

/**
 * 为垂直源计算预留槽位数。
 *
 * 关键：预留数必须容纳「**源数 × 每源请求条数**」，否则会有请求被白打。
 * 实测踩到：2 个源各请求 2 条（共 4 条），但只预留 2 个槽位 ——
 * 交错后只有前 2 条能进结果，**一半的请求被丢弃**。
 * 这不只是浪费：多发一次请求就多一分暴露面，而结果并没有变多。
 *
 * 上限 `MAX_RESERVE` 的存在是为了不让垂直源挤占主源 ——
 * 主源（Bing）覆盖最广，垂直源是补充。
 *
 * @param {number} maxResults - 结果总数上限
 * @param {number} sourceCount - 参与本次请求的垂直源个数
 * @param {number} [perSource] - 每个源请求几条（默认由配额函数决定）
 * @returns {{reserve: number, perSource: number}} 预留槽位与每源条数
 */
export const MAX_RESERVE = 4

export function planVerticalQuota(maxResults, sourceCount) {
  if (sourceCount <= 0 || maxResults <= 0) return { reserve: 0, perSource: 0 }

  // 主源至少要保住一半槽位（它是覆盖最广的那个）
  const maxForVertical = Math.max(1, Math.floor(maxResults / 2))

  // 预留值取「可用余量」与「上限」的较小者。
  // 注意**不要**再被 sourceCount 压小 —— 那样会让预留退化成「源数」，
  // 导致每源只能进 1 条（实测踩到：max=10/2 源时预留被压成 2）。
  const reserve = Math.min(MAX_RESERVE, maxForVertical)

  // 每源条数：向下取整，保证「生效源数 × 每源 ≤ 预留」。
  // 上限 3：单源请求过多没有意义（垂直源是补充，不是主力），
  // 且会拉长该源的响应时间（受它自己的限速约束）。
  const perSource = Math.max(1, Math.min(3, Math.floor(reserve / sourceCount)))

  return { reserve, perSource }
}

/**
 * 兼容旧签名：只问「预留几个槽位」时使用。
 *
 * @param {number} maxResults
 * @param {boolean} enabled
 * @param {number} [sourceCount] - 给出源数时按新算法（推荐）
 */
export function computeReserve(maxResults, enabled, sourceCount) {
  if (!enabled) return 0
  if (Number.isFinite(sourceCount)) {
    return planVerticalQuota(maxResults, sourceCount).reserve
  }
  // 旧行为：不知道源数时的保守估计
  return Math.min(3, Math.max(1, Math.floor(maxResults / 4)))
}
