/**
 * 源适配器：Hacker News（Algolia API）。
 *
 * 为什么用它：真人技术讨论，带**热度权重**（points/comments），
 * 且是官方 API（合规、无 robots 问题）。
 *
 * v0.3.0 字段补全：此前只用了 title + points，把 API 已返回的
 * num_comments / created_at / author / story_text 全丢了
 * （实测：一个 747 分的帖子同时有 314 条评论，信息被浪费）。
 */
import { unixSecondsToDate, formatDateShort, normalizeLimit } from '../text.js'

export const id = 'hackernews'
export const label = 'Hacker News'
export const kind = 'api'

export async function search(query, opts) {
  const { maxResults, signal } = opts

  const url = new URL('https://hn.algolia.com/api/v1/search')
  url.searchParams.set('query', query)
  url.searchParams.set('hitsPerPage', String(normalizeLimit(maxResults)))
  // 按热度排序，让高信噪比的讨论优先（Algolia 默认按相关性）
  url.searchParams.set('tags', 'story')

  const response = await fetch(url, { headers: { accept: 'application/json' }, signal })
  if (!response.ok) {
    const err = new Error(`HN HTTP ${response.status}`)
    err.status = response.status
    throw err
  }

  const data = await response.json()
  const sources = []
  for (const hit of data?.hits ?? []) {
    const title = hit.title ?? hit.story_title
    const target = hit.url ?? `https://news.ycombinator.com/item?id=${hit.objectID}`
    if (!title || !/^https?:\/\//.test(target)) continue

    const parts = ['Hacker News']
    if (typeof hit.points === 'number') parts.push(`${hit.points} 分`)
    if (typeof hit.num_comments === 'number') parts.push(`${hit.num_comments} 评论`)
    const date = unixSecondsToDate(hit.created_at_i) ?? formatDateShort(hit.created_at)
    if (date) parts.push(date)

    sources.push({
      url: target,
      title: String(title),
      snippet: parts.join(' · '),
      ...(date ? { date } : {}),
      // 结构化热度信号：让模型能据此判断可信度/流行度
      ...(typeof hit.points === 'number' ? { score: hit.points } : {}),
      ...(typeof hit.num_comments === 'number' ? { comments: hit.num_comments } : {}),
      ...(hit.author ? { author: String(hit.author) } : {}),
    })
  }
  return { sources, truncated: false }
}
