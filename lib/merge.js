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
  const push = (item) => {
    if (out.length >= maxResults) return false
    if (!item?.url || seen.has(item.url)) return true // 跳过但不算满
    seen.add(item.url)
    out.push(item)
    return true
  }

  for (const item of (primary ?? []).slice(0, primaryQuota)) push(item)
  for (const item of extraList) push(item)
  // 垂直源少于预留数时，用剩余主源回填，不浪费槽位。
  for (const item of primary ?? []) push(item)

  return { sources: out, truncated: out.length >= maxResults }
}

/**
 * 为垂直源计算预留槽位数。
 *
 * 取 maxResults 的 1/4，夹在 [1,3] 之间：
 *   - 至少 1：否则垂直源永远进不来
 *   - 至多 3：否则主源（覆盖最广）被过度挤压
 */
export function computeReserve(maxResults, enabled) {
  if (!enabled) return 0
  return Math.min(3, Math.max(1, Math.floor(maxResults / 4)))
}
