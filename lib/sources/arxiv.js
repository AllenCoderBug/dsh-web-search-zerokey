/**
 * 源适配器：arXiv 论文检索。
 *
 * 为什么用它：学术查询用通用搜索引擎召回质量差（论文站点 SEO 弱），
 * 而 arXiv 提供官方 API（合规、无 key）。
 *
 * ⚠️ 必须用 **https**：http://export.arxiv.org 会 301，跟随失败会得到空响应（实测）。
 * 响应是 **Atom XML**，不是 JSON——这也是「每源一文件」的实证理由之一。
 */
import { stripTags, cap, formatDateShort, normalizeLimit } from '../text.js'

export const id = 'arxiv'
export const label = 'arXiv'
export const kind = 'api'

const MAX_SNIPPET = 300

/** 从 Atom XML 中提取条目。正则足够——结构是机器生成的、极规整。 */
export function parseArxivXml(xml, maxResults, maxSnippetChars = MAX_SNIPPET) {
  const entries = String(xml ?? '').split('<entry>').slice(1)
  const sources = []

  for (const entry of entries) {
    const idMatch = entry.match(/<id>([^<]+)<\/id>/)
    const titleMatch = entry.match(/<title>([\s\S]*?)<\/title>/)
    if (!idMatch || !titleMatch) continue

    const url = idMatch[1].trim()
    const title = stripTags(titleMatch[1])
    if (!title || !/^https?:\/\//.test(url)) continue

    const summaryMatch = entry.match(/<summary>([\s\S]*?)<\/summary>/)
    const summary = summaryMatch ? cap(stripTags(summaryMatch[1]), maxSnippetChars) : ''
    const date = formatDateShort(entry.match(/<published>([^<]+)<\/published>/)?.[1])

    const authors = [...entry.matchAll(/<name>([^<]+)<\/name>/g)]
      .slice(0, 3)
      .map((m) => m[1].trim())
    const authorText = authors.length ? ` · ${authors.join(', ')}${authors.length >= 3 ? ' 等' : ''}` : ''

    sources.push({
      url,
      title,
      snippet: `arXiv${date ? ` · ${date}` : ''}${authorText}${summary ? ` · ${summary}` : ''}`,
      ...(date ? { date } : {}),
    })

    if (sources.length >= maxResults) break
  }

  return { sources, truncated: false }
}

export async function search(query, opts) {
  const { maxResults, maxSnippetChars, signal } = opts

  const url = new URL('https://export.arxiv.org/api/query')
  // all: 覆盖标题/摘要/作者，适合自然语言技术查询
  url.searchParams.set('search_query', `all:${query}`)
  url.searchParams.set('max_results', String(normalizeLimit(maxResults)))
  url.searchParams.set('sortBy', 'relevance')

  const response = await fetch(url, {
    headers: { accept: 'application/atom+xml' },
    signal,
  })
  if (!response.ok) {
    const err = new Error(`arXiv HTTP ${response.status}`)
    err.status = response.status
    throw err
  }

  const xml = await response.text()
  return parseArxivXml(xml, maxResults, maxSnippetChars)
}
