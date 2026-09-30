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
