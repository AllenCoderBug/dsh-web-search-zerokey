/**
 * 源适配器：npm 包检索。
 *
 * 为什么用它：查「某库怎么用」时，包元数据（版本/描述/仓库）是最直接的一手信息，
 * 且是官方 registry API（合规、无 key）。
 */
import { cap, formatDateShort, normalizeLimit } from '../text.js'

export const id = 'npm'
export const label = 'npm'
export const kind = 'api'

export async function search(query, opts) {
  const { maxResults, signal } = opts

  const url = new URL('https://registry.npmjs.org/-/v1/search')
  url.searchParams.set('text', query)
  url.searchParams.set('size', String(normalizeLimit(maxResults)))

  const response = await fetch(url, { headers: { accept: 'application/json' }, signal })
  if (!response.ok) {
    const err = new Error(`npm HTTP ${response.status}`)
    err.status = response.status
    throw err
  }

  const data = await response.json()
  const sources = []
  for (const obj of data?.objects ?? []) {
    const pkg = obj?.package
    if (!pkg?.name) continue
    // 优先指向仓库（信息更全），否则指向 npm 页面
    const repoUrl =
      typeof pkg.links?.repository === 'string' && /^https?:\/\//.test(pkg.links.repository)
        ? pkg.links.repository
        : `https://www.npmjs.com/package/${pkg.name}`

    const date = formatDateShort(pkg.date)
    const meta = [pkg.version ? `v${pkg.version}` : '', date ? `发布 ${date}` : ''].filter(Boolean)

    sources.push({
      url: repoUrl,
      title: pkg.name,
      snippet: `${meta.join(' · ')}${pkg.description ? ` · ${cap(pkg.description, 200)}` : ''}`,
      ...(date ? { date } : {}),
    })

    if (sources.length >= maxResults) break
  }
  return { sources, truncated: false }
}
