/**
 * 各源适配器的 mock 测试（不碰网络）。
 *
 * 为什么值得测：这 5 个源的函数覆盖此前是 0%。它们的风险不是崩溃，
 * 而是**字段映射写错**——上游改了字段名，代码静默返回空数组，
 * 表现为「这个源没结果」，与「真的没结果」无法区分。
 * 故重点验证：字段映射、请求参数、错误信号（status 透出）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

/** 用假的 fetch 跑一次源，然后恢复。 */
async function withFetch(fake, fn) {
  const original = globalThis.fetch
  globalThis.fetch = fake
  try {
    return await fn()
  } finally {
    globalThis.fetch = original
  }
}

const json = (data, status = 200) => async () => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => data,
  text: async () => JSON.stringify(data),
})

// ---------------------------------------------------------------------------
// Hacker News
// ---------------------------------------------------------------------------

test('hackernews: 字段映射（title/points/num_comments/created_at/author）', async () => {
  const hn = await import('../lib/sources/hackernews.js')
  const r = await withFetch(
    json({
      hits: [
        {
          title: 'DeepSeek Harness',
          url: 'https://deepseek.com',
          points: 747,
          num_comments: 314,
          created_at_i: 1789373211,
          author: 'bjin',
          objectID: '1',
        },
      ],
    }),
    () => hn.search('q', { maxResults: 5, signal: undefined }),
  )

  const s = r.sources[0]
  assert.equal(s.url, 'https://deepseek.com')
  assert.equal(s.title, 'DeepSeek Harness')
  assert.equal(s.score, 747, '分数应作为结构化字段')
  assert.equal(s.comments, 314, '评论数此前被丢弃，必须提取')
  assert.equal(s.author, 'bjin')
  assert.equal(s.date, '2026-09-14', 'created_at_i 是秒级时间戳')
  assert.match(s.snippet, /747 分/)
  assert.match(s.snippet, /314 评论/)
})

test('hackernews: 无 url 时回退到 HN 讨论页', async () => {
  const hn = await import('../lib/sources/hackernews.js')
  const r = await withFetch(
    json({ hits: [{ title: 'Ask HN', objectID: '42' }] }),
    () => hn.search('q', { maxResults: 5 }),
  )
  assert.equal(r.sources[0].url, 'https://news.ycombinator.com/item?id=42')
})

test('hackernews: 跳过无标题或非 http 的条目', async () => {
  const hn = await import('../lib/sources/hackernews.js')
  const r = await withFetch(
    json({
      hits: [
        { title: null, url: 'https://a.com' },
        { title: 'ok', url: 'ftp://x' },
        { title: 'good', url: 'https://good.com' },
      ],
    }),
    () => hn.search('q', { maxResults: 5 }),
  )
  assert.equal(r.sources.length, 1)
  assert.equal(r.sources[0].url, 'https://good.com')
})

test('hackernews: HTTP 非 200 → 抛出并带 status', async () => {
  const hn = await import('../lib/sources/hackernews.js')
  await assert.rejects(
    withFetch(json({}, 503), () => hn.search('q', { maxResults: 5 })),
    (e) => e.status === 503,
  )
})

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

test('github: 字段映射（full_name/stars/language/updated_at）', async () => {
  const gh = await import('../lib/sources/github.js')
  const r = await withFetch(
    json({
      items: [
        {
          full_name: 'owner/repo',
          html_url: 'https://github.com/owner/repo',
          stargazers_count: 1234,
          language: 'TypeScript',
          updated_at: new Date().toISOString(),
          description: '一个仓库',
        },
      ],
    }),
    () => gh.search('q', { maxResults: 5 }),
  )

  const s = r.sources[0]
  assert.equal(s.url, 'https://github.com/owner/repo')
  assert.equal(s.title, 'owner/repo')
  assert.equal(s.score, 1234)
  assert.equal(s.language, 'TypeScript', '语言此前未提取')
  assert.match(s.snippet, /★1234/)
  assert.match(s.snippet, /TypeScript/)
})

test('github: 429/403 标记 rateLimited（供上层冷却）', async () => {
  const gh = await import('../lib/sources/github.js')
  for (const status of [429, 403]) {
    await assert.rejects(
      withFetch(json({}, status), () => gh.search('q', { maxResults: 5 })),
      (e) => e.rateLimited === true && e.status === status,
      `${status} 必须标记 rateLimited`,
    )
  }
})

test('github: 忽略缺少 html_url 的条目', async () => {
  const gh = await import('../lib/sources/github.js')
  const r = await withFetch(
    // 注意给足 star：本测试的意图是「缺 html_url 被忽略」，
    // 不应被 MIN_STARS 过滤干扰（那是另一条测试的事）。
    json({
      items: [
        { full_name: 'x/y', stargazers_count: 500 },
        { full_name: 'a/b', html_url: 'https://github.com/a/b', stargazers_count: 500 },
      ],
    }),
    () => gh.search('q', { maxResults: 5 }),
  )
  assert.equal(r.sources.length, 1)
})

// ---------------------------------------------------------------------------
// npm
// ---------------------------------------------------------------------------

test('npm: 优先指向仓库，否则回退 npm 页面', async () => {
  const npm = await import('../lib/sources/npm.js')
  const r = await withFetch(
    json({
      objects: [
        {
          package: {
            name: 'express',
            version: '5.0.0',
            description: 'desc',
            date: '2025-12-01T00:00:00Z',
            links: { repository: 'https://github.com/expressjs/express' },
          },
        },
        { package: { name: 'norepo', version: '1.0.0', links: {} } },
      ],
    }),
    () => npm.search('q', { maxResults: 5 }),
  )

  assert.equal(r.sources[0].url, 'https://github.com/expressjs/express')
  assert.equal(r.sources[1].url, 'https://www.npmjs.com/package/norepo', '无仓库时回退')
  assert.match(r.sources[0].snippet, /v5\.0\.0/)
})

// ---------------------------------------------------------------------------
// 掘金（POST，字段在 result_model.article_info）
// ---------------------------------------------------------------------------

test('juejin: 字段映射 + 自行拼链接（响应里 link_url 为空）', async () => {
  const juejin = await import('../lib/sources/juejin.js')
  let captured
  const r = await withFetch(
    async (url, init) => {
      captured = { url, init }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          err_no: 0,
          data: [
            {
              result_model: {
                article_info: {
                  article_id: '7685188623412133898',
                  title: '深入 Cordis',
                  brief_content: '插件框架',
                  ctime: 1789373211,
                },
              },
            },
          ],
        }),
      }
    },
    () => juejin.search('q', { maxResults: 5, maxSnippetChars: 200 }),
  )

  assert.equal(captured.init.method, 'POST', '掘金必须 POST（实测 GET 不可用）')
  assert.match(captured.init.headers['content-type'], /application\/json/)
  assert.equal(r.sources[0].url, 'https://juejin.cn/post/7685188623412133898', '链接须自行拼接')
  assert.equal(r.sources[0].title, '深入 Cordis')
  assert.equal(r.sources[0].date, '2026-09-14')
})

test('juejin: API 层错误码 → 抛出', async () => {
  const juejin = await import('../lib/sources/juejin.js')
  await assert.rejects(
    withFetch(json({ err_no: 500, err_msg: '内部错误' }), () =>
      juejin.search('q', { maxResults: 5 }),
    ),
    /内部错误/,
  )
})

// ---------------------------------------------------------------------------
// CSDN
// ---------------------------------------------------------------------------

test('csdn: 兼容两种响应形态（result_vos / data）', async () => {
  const csdn = await import('../lib/sources/csdn.js')
  const a = await withFetch(
    json({ result_vos: [{ url: 'https://a', title: 'T1' }] }),
    () => csdn.search('q', { maxResults: 5 }),
  )
  assert.equal(a.sources.length, 1)

  const b = await withFetch(
    json({ data: [{ url: 'https://b', title: 'T2' }] }),
    () => csdn.search('q', { maxResults: 5 }),
  )
  assert.equal(b.sources.length, 1)
})

test('csdn: 过滤非 http 链接，剥离 HTML 标签', async () => {
  const csdn = await import('../lib/sources/csdn.js')
  const r = await withFetch(
    json({
      result_vos: [
        { url: 'javascript:void(0)', title: 'x' },
        { url: 'https://ok', title: '<em>高亮</em>标题', description: '<b>摘要</b>' },
      ],
    }),
    () => csdn.search('q', { maxResults: 5 }),
  )
  assert.equal(r.sources.length, 1)
  assert.equal(r.sources[0].title, '高亮标题', '标题里的 HTML 标签应被剥离')
  assert.match(r.sources[0].snippet, /摘要/)
})

// ---------------------------------------------------------------------------
// arXiv（XML）
// ---------------------------------------------------------------------------

test('arxiv: 必须使用 https（http 会 301 得到空响应）', async () => {
  const arxiv = await import('../lib/sources/arxiv.js')
  let captured
  await withFetch(
    async (url) => {
      captured = url
      return { ok: true, status: 200, text: async () => '<feed></feed>' }
    },
    () => arxiv.search('q', { maxResults: 5 }),
  )
  assert.equal(captured.protocol, 'https:', 'http://export.arxiv.org 会 301（实测）')
})

test('arxiv: 从 Atom XML 提取条目与日期', async () => {
  const arxiv = await import('../lib/sources/arxiv.js')
  const xml = `<feed><entry>
    <id>http://arxiv.org/abs/2401.1</id>
    <title>Agentic Search</title>
    <summary>A survey.</summary>
    <published>2026-01-15T00:00:00Z</published>
    <author><name>Alice</name></author>
  </entry></feed>`

  const r = await withFetch(
    async () => ({ ok: true, status: 200, text: async () => xml }),
    () => arxiv.search('q', { maxResults: 5 }),
  )
  assert.equal(r.sources.length, 1)
  assert.equal(r.sources[0].title, 'Agentic Search')
  assert.equal(r.sources[0].date, '2026-01-15')
  assert.match(r.sources[0].snippet, /Alice/)
})

test('arxiv: 429 抛出并带 status（供冷却）', async () => {
  const arxiv = await import('../lib/sources/arxiv.js')
  await assert.rejects(
    withFetch(json({}, 429), () => arxiv.search('q', { maxResults: 5 })),
    (e) => e.status === 429,
  )
})

test('github: 过滤低星噪音（回归：曾返回 ★0/★1 玩具仓库）', async () => {
  // 实测：查询「python asyncio best practices」时 GitHub 返回 ★2/★1/★0/★0，
  // 全是噪音 —— 会拖累整个源的可信度。
  const gh = await import('../lib/sources/github.js')
  const r = await withFetch(
    json({
      items: [
        { full_name: 'noise/a', html_url: 'https://github.com/noise/a', stargazers_count: 2 },
        { full_name: 'noise/b', html_url: 'https://github.com/noise/b', stargazers_count: 1 },
        { full_name: 'noise/c', html_url: 'https://github.com/noise/c', stargazers_count: 0 },
        {
          full_name: 'good/repo',
          html_url: 'https://github.com/good/repo',
          stargazers_count: 778,
        },
      ],
    }),
    () => gh.search('q', { maxResults: 5 }),
  )

  assert.equal(r.sources.length, 1, '只应保留高于阈值的仓库')
  assert.equal(r.sources[0].title, 'good/repo')
  assert.ok(r.sources.every((s) => s.score >= 100), '不应残留低星条目')
})

test('github: 阈值边界（恰好等于阈值应保留）', async () => {
  const gh = await import('../lib/sources/github.js')
  const r = await withFetch(
    json({
      items: [
        { full_name: 'edge/99', html_url: 'https://github.com/edge/99', stargazers_count: 99 },
        { full_name: 'edge/100', html_url: 'https://github.com/edge/100', stargazers_count: 100 },
      ],
    }),
    () => gh.search('q', { maxResults: 5 }),
  )
  assert.equal(r.sources.length, 1, '99 应被过滤，100 应保留')
  assert.equal(r.sources[0].title, 'edge/100')
})
