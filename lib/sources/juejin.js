/**
 * 源适配器：掘金（中文技术社区）。
 *
 * 为什么用它：国内网络下中文技术内容的主力源之一，
 * 且提供站点 API（比抓搜索页合规）。
 *
 * 实现注意（实测）：
 *   - **必须 POST**（GET 不可用），Content-Type: application/json
 *   - 字段在 `data[].result_model.article_info.{title, brief_content, ctime}`
 *   - **响应里的 link_url 是空串**，链接必须自行拼 `https://juejin.cn/post/<article_id>`
 */
import { cap, unixSecondsToDate, normalizeLimit } from '../text.js'

export const id = 'juejin'
export const label = '掘金'
export const kind = 'api'

const ENDPOINT = 'https://api.juejin.cn/search_api/v1/search'

/** 从掘金响应中提取结果（独立出来便于直接测试解析，无需网络）。 */
export function parseJuejin(data, maxResults, maxSnippetChars = 300) {
  const sources = []
  for (const item of data?.data ?? []) {
    const info = item?.result_model?.article_info
    if (!info?.article_id || !info?.title) continue

    const url = `https://juejin.cn/post/${info.article_id}`
    const snippet = info.brief_content ? cap(String(info.brief_content), maxSnippetChars) : ''
    const date = unixSecondsToDate(info.ctime)

    sources.push({
      url,
      title: String(info.title),
      snippet: `掘金${date ? ` · ${date}` : ''}${snippet ? ` · ${snippet}` : ''}`,
      ...(date ? { date } : {}),
    })

    if (sources.length >= maxResults) break
  }
  return { sources, truncated: false }
}

export async function search(query, opts) {
  const { maxResults, maxSnippetChars, signal } = opts

  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      'user-agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
    body: JSON.stringify({
      key_word: query,
      id_type: 0,
      cursor: '0',
      limit: normalizeLimit(maxResults),
      search_type: 0,
    }),
    signal,
  })

  if (!response.ok) {
    const err = new Error(`掘金 HTTP ${response.status}`)
    err.status = response.status
    throw err
  }

  const data = await response.json()
  if (data?.err_no !== 0 && data?.err_no !== undefined) {
    throw new Error(`掘金 API 错误：${data?.err_msg ?? data.err_no}`)
  }
  return parseJuejin(data, maxResults, maxSnippetChars)
}
