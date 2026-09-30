/**
 * Bing 结果页解析。
 *
 * 与抓取分离的理由：解析规则**随页面结构改版而变**，而抓取方式（URL/头/重定向）
 * 相对稳定。分开后，改版时只动本文件。
 *
 * 依赖的稳定标记（实测）：
 *   - 结果块 `<li class="b_algo">`
 *   - 标题/链接 `<h2 ...><a href="...">...</a>`
 *   - 摘要紧随的 `<p>`
 */
import { stripTags, cap, parseBingDate } from '../text.js'

/**
 * @param {string} html - Bing 返回的 HTML
 * @param {number} maxResults - 结果上限
 * @param {number} maxSnippetChars - 单条摘要上限
 * @returns {{sources: Array, truncated: boolean}}
 */
export function parseBingHtml(html, maxResults, maxSnippetChars) {
  const sources = []
  const seen = new Set()

  // 按结果块切分，首个 block 是块前的页头，丢弃。
  const blocks = String(html ?? '').split(/<li class="b_algo"/).slice(1)

  for (const block of blocks) {
    const match = block.match(
      /<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/,
    )
    if (!match) continue

    const url = match[1]
    const title = stripTags(match[2])
    // 跳过空标题与非 http 链接（Bing 偶有 javascript:/内部锚点结果）
    if (!title || !/^https?:\/\//.test(url)) continue
    if (seen.has(url)) continue
    seen.add(url)

    const paragraph = block.match(/<p[^>]*>([\s\S]*?)<\/p>/)
    const snippet = paragraph ? stripTags(paragraph[1]) : ''

    // 时效信号是**免费**的：页面已经给了日期，提取它不产生任何额外请求。
    const date = parseBingDate(block)

    sources.push({
      url,
      title,
      ...(snippet ? { snippet: cap(snippet, maxSnippetChars) } : {}),
      ...(date ? { date } : {}),
    })

    if (sources.length >= maxResults) break
  }

  return { sources, truncated: false }
}
