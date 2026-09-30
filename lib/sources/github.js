/**
 * 源适配器：GitHub 仓库检索。
 *
 * 为什么用它：代码仓库检索质量高（官方 API，合规），
 * 对技术查询能补上 Bing 给不出的「社区共识」信号（star 数）。
 *
 * ⚠️ 匿名限流仅 **10 次/小时**（实测）。额度管理在 provider 层
 * （撞 403/429 进入冷却），本文件只负责把限流信号显式抛出。
 */
import { formatDateShort, normalizeLimit } from '../text.js'

export const id = 'github'
export const label = 'GitHub'
export const kind = 'api'

/**
 * 低于此 star 数的仓库视为噪音，不返回。
 *
 * 依据（实测 star 分布，2026-09-30）：
 *   关键词型查询（react hooks / mcp server）→ 34466~95688
 *   中等查询（rust async runtime）        → 778~7410
 *   **自然语言长句（python asyncio best practices）→ 0~2**
 * 后者是纯噪音：GitHub 的仓库检索对自然语言长句匹配很差，
 * 按 star 排序也救不回来（排前面的仍是 ★1、★2 的玩具仓库）。
 * 阈值取 100：远高于噪音区（0~2），远低于正常查询的最低值（778），
 * 留出充足安全边界。
 */
const MIN_STARS = 100

export async function search(query, opts) {
  const { maxResults, signal } = opts

  const url = new URL('https://api.github.com/search/repositories')
  url.searchParams.set('q', query)
  url.searchParams.set('sort', 'stars')
  url.searchParams.set('per_page', String(normalizeLimit(maxResults)))

  const response = await fetch(url, {
    headers: { accept: 'application/vnd.github+json' },
    signal,
  })

  // 把限流信号显式抛出，交给上层状态机决定退避。
  if (response.status === 403 || response.status === 429) {
    const err = new Error(`GitHub rate limited (HTTP ${response.status})`)
    err.rateLimited = true
    err.status = response.status
    throw err
  }
  if (!response.ok) {
    const err = new Error(`GitHub HTTP ${response.status}`)
    err.status = response.status
    throw err
  }

  const data = await response.json()
  const sources = []
  for (const repo of data?.items ?? []) {
    if (!repo?.html_url) continue
    const stars = repo.stargazers_count ?? 0
    // 过滤低星噪音（见 MIN_STARS 的实测依据）。
    // 宁可这个源少给几条，也不要往结果里塞 ★0/★1 的玩具仓库 ——
    // 那会让模型把这个源判定为「质量差」而整体不信任。
    if (stars < MIN_STARS) continue
    const date = formatDateShort(repo.updated_at)

    const meta = [`★${stars}`]
    if (repo.language) meta.push(repo.language)
    if (date) meta.push(`更新 ${date}`)

    sources.push({
      url: repo.html_url,
      title: repo.full_name,
      snippet: `${meta.join(' · ')}${repo.description ? ` · ${repo.description}` : ''}`,
      ...(date ? { date } : {}),
      score: stars,
      ...(repo.language ? { language: String(repo.language) } : {}),
    })
  }
  return { sources, truncated: false }
}
