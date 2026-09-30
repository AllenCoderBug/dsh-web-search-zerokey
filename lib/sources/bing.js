/**
 * 源适配器：Bing HTML 抓取（主源，唯一不可降级）。
 *
 * 变化理由：**随 Bing 页面改版而变**。这是本文件存在的唯一理由——
 * 上游改一次结构，只动这里，不碰路由/合并/其他源。
 *
 * ⚠️ 合规实况（已向用户披露并获知情承担，详见 UPGRADE-PLAN §4）：
 *   cn.bing.com/robots.txt 的 `User-agent: *` 段含 `Disallow: /search`，
 *   而本文件抓的正是 /search。这是**已知情承担的风险**，不是疏漏。
 *   降低暴露面的手段在 request-policy.js（缓存/限速）。
 */
import { normalizeLimit } from '../text.js'
import { parseBingHtml } from '../parse/bing.js'

export const id = 'bing'
export const label = 'Bing'
export const kind = 'scrape'

const BROWSER_HEADERS = {
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
}

/**
 * @param {string} query
 * @param {{maxResults: number, maxSnippetChars: number, signal?: AbortSignal}} opts
 */
export async function search(query, opts) {
  const { maxResults, maxSnippetChars, signal } = opts

  const url = new URL('https://cn.bing.com/search')
  url.searchParams.set('q', query)
  // 多取一些，抵消解析失败的损耗
  url.searchParams.set('count', String(normalizeLimit(maxResults, 15, 5) * 2))

  let response
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: BROWSER_HEADERS,
      // Bing 会 302 到 cn.bing.com；DSH 的 fetch 栈不跨源自动跟随，故直接请求 cn 域。
      redirect: 'follow',
      signal,
    })
  } catch (error) {
    const cause = error?.cause?.message ?? ''
    // CA 未注入是本机最容易撞上的失败，直接给出可执行的修复指引。
    if (String(cause).includes('certificate') || String(cause).includes('issuer')) {
      throw new Error(
        `zerokey 搜索 TLS 失败：${cause}。` +
          '这通常是 NODE_EXTRA_CA_CERTS 未注入到 DSH 进程；' +
          '修复见 handoff/README-CA修复说明.md',
      )
    }
    const wrapped = new Error(`zerokey 搜索请求失败：${String(error)}`)
    wrapped.cause = error
    throw wrapped
  }

  if (!response.ok) {
    const err = new Error(`zerokey 搜索返回 HTTP ${response.status}`)
    err.status = response.status
    throw err
  }

  const html = await response.text()
  const parsed = parseBingHtml(html, maxResults, maxSnippetChars)

  if (parsed.sources.length === 0 && !html.includes('b_algo')) {
    // 区分「真没结果」与「页面结构变了」——后者是代码问题，不该报成「无结果」。
    throw new Error(
      'zerokey 搜索未解析出结果：Bing 页面结构可能已变更（未找到 b_algo 结果块）',
    )
  }

  return { sources: parsed.sources, truncated: false }
}
