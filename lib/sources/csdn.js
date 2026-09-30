/**
 * 源适配器：CSDN（中文技术社区）。
 *
 * 为什么用它：中文技术内容覆盖广，国内可达。
 *
 * ⚠️ 内容质量参差（这是中文技术站的普遍情况）。之所以仍然保留：
 *   它是「中文 + 具体实现细节」的常见唯一来源，噪声由合并层的来源标注暴露给模型判断。
 */
import { stripTags, cap, formatDateShort } from '../text.js'

export const id = 'csdn'
export const label = 'CSDN'
export const kind = 'api'

const ENDPOINT = 'https://so.csdn.net/api/v3/search'

/** 从 CSDN 响应提取结果（独立出来便于测试）。 */
export function parseCsdn(data, maxResults, maxSnippetChars = 300) {
  // CSDN 的响应形态在不同版本间有差异，两种都兼容
  const list =
    data?.result_vos ??
    data?.data ??
    (Array.isArray(data) ? data : [])

  const sources = []
  for (const item of list) {
    const url = item?.url ?? item?.url_location
    const rawTitle = item?.title
    if (!url || !rawTitle) continue
    if (!/^https?:\/\//.test(url)) continue

    const title = stripTags(rawTitle)
    const rawSnippet = item?.description ?? item?.digest ?? ''
    const snippet = rawSnippet ? cap(stripTags(rawSnippet), maxSnippetChars) : ''
    const date = formatDateShort(item?.created_at ?? item?.create_time)

    sources.push({
      url,
      title,
      snippet: `CSDN${date ? ` · ${date}` : ''}${snippet ? ` · ${snippet}` : ''}`,
      ...(date ? { date } : {}),
    })

    if (sources.length >= maxResults) break
  }
  return { sources, truncated: false }
}

export async function search(query, opts) {
  const { maxResults, maxSnippetChars, signal } = opts

  const url = new URL(ENDPOINT)
  url.searchParams.set('q', query)
  url.searchParams.set('t', 'all')
  url.searchParams.set('p', '1')
  url.searchParams.set('s', '0')
  url.searchParams.set('tm', '0')

  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
      'user-agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
    signal,
  })
  if (!response.ok) {
    const err = new Error(`CSDN HTTP ${response.status}`)
    err.status = response.status
    throw err
  }

  const data = await response.json()
  return parseCsdn(data, maxResults, maxSnippetChars)
}
