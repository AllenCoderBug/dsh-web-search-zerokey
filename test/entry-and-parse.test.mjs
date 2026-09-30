/**
 * 入口层与解析器的测试（此前是覆盖率盲区）。
 *
 * 两处盲区的风险都很实在：
 *   1. `lib/parse/bing.js` —— **主源的解析器**，Bing 改版是整套系统最大的风险点，
 *      而它此前没有直接测试（只被真机集成间接覆盖）。
 *   2. `index.js` 的 `adaptHostFetcher` + `apply` —— 宿主接口若变，
 *      适配层出错会导致正文增强静默失效。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseBingHtml } from '../lib/parse/bing.js'
import { adaptHostFetcher, apply } from '../index.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** 构造一个 Bing 结果块。 */
function block({ url, title, snippet, extra = '' }) {
  return (
    `<li class="b_algo" data-x="1">${extra}` +
    `<h2><a href="${url}" h="ID=SERP">${title}</a></h2>` +
    (snippet ? `<p>${snippet}</p>` : '') +
    `</li>`
  )
}

// ---------------------------------------------------------------------------
// Bing 解析器
// ---------------------------------------------------------------------------

test('parseBingHtml: 从结果块提取 url/title/snippet', () => {
  const html =
    '<html><body>' +
    block({ url: 'https://a.com/1', title: '标题一', snippet: '摘要一' }) +
    block({ url: 'https://b.com/2', title: '标题二', snippet: '摘要二' }) +
    '</body></html>'

  const r = parseBingHtml(html, 10, 300)
  assert.equal(r.sources.length, 2)
  assert.equal(r.sources[0].url, 'https://a.com/1')
  assert.equal(r.sources[0].title, '标题一')
  assert.equal(r.sources[0].snippet, '摘要一')
  assert.equal(r.sources[1].title, '标题二')
})

test('parseBingHtml: 块前的页头不计入结果', () => {
  const html =
    '<html><h2><a href="https://head.com">页头</a></h2>' +
    block({ url: 'https://a.com', title: 'A' }) +
    '</html>'
  const r = parseBingHtml(html, 10, 300)
  assert.equal(r.sources.length, 1, '页头（不在 b_algo 内）应被丢弃')
  assert.equal(r.sources[0].url, 'https://a.com')
})

test('parseBingHtml: 跳过空标题 / 非 http 链接（Bing 偶有内部锚点）', () => {
  const html =
    block({ url: 'javascript:void(0)', title: 'js 链接' }) +
    block({ url: '/relative', title: '相对链接' }) +
    block({ url: 'https://ok.com', title: '' }) +
    block({ url: 'https://good.com', title: '好的' })

  const r = parseBingHtml(html, 10, 300)
  assert.equal(r.sources.length, 1)
  assert.equal(r.sources[0].url, 'https://good.com')
})

test('parseBingHtml: 按 URL 去重（保留首次出现）', () => {
  const html =
    block({ url: 'https://dup.com', title: '第一次' }) +
    block({ url: 'https://dup.com', title: '第二次' })
  const r = parseBingHtml(html, 10, 300)
  assert.equal(r.sources.length, 1)
  assert.equal(r.sources[0].title, '第一次')
})

test('parseBingHtml: 遵守 maxResults', () => {
  let html = ''
  for (let i = 0; i < 20; i++) html += block({ url: `https://s${i}.com`, title: `T${i}` })
  assert.equal(parseBingHtml(html, 3, 300).sources.length, 3)
})

test('parseBingHtml: 摘要按 maxSnippetChars 截断', () => {
  const html = block({ url: 'https://a.com', title: 'T', snippet: 'x'.repeat(500) })
  const r = parseBingHtml(html, 10, 100)
  assert.equal(r.sources[0].snippet.length, 100)
})

test('parseBingHtml: 无摘要时不产生 snippet 字段', () => {
  const html = block({ url: 'https://a.com', title: 'T' })
  const r = parseBingHtml(html, 10, 300)
  assert.equal('snippet' in r.sources[0], false)
})

test('parseBingHtml: 提取页面已有的日期标记（免费时效信号）', () => {
  const html = block({
    url: 'https://a.com',
    title: 'T',
    snippet: '内容',
    extra: '<div class="news_dt">2026年8月27日</div>',
  })
  const r = parseBingHtml(html, 10, 300)
  assert.equal(r.sources[0].date, '2026-08-27')
})

test('parseBingHtml: 无日期时不产生 date 字段', () => {
  const html = block({ url: 'https://a.com', title: 'T', snippet: '内容' })
  assert.equal('date' in parseBingHtml(html, 10, 300).sources[0], false)
})

test('parseBingHtml: 畸形输入不崩（页面改版时的容错）', () => {
  for (const input of ['', null, undefined, 'plain text', '<li class="b_algo">no h2</li>']) {
    const r = parseBingHtml(input, 10, 300)
    assert.ok(Array.isArray(r.sources), `输入 ${JSON.stringify(input)} 应返回数组`)
    assert.equal(r.sources.length, 0)
  }
})

test('parseBingHtml: 真实 Bing HTML 快照（若存在）能解析出结果', (t) => {
  // 该快照由抓取脚本产出，用于防止「只在我编的数据上通过」。
  // 快照缺失则跳过，不作为失败。
  const snapshot = path.join(HERE, 'fixtures', 'bing-real.html')
  if (!fs.existsSync(snapshot)) {
    t.skip('未找到真实 HTML 快照')
    return
  }
  const html = fs.readFileSync(snapshot, 'utf8')
  const r = parseBingHtml(html, 10, 300)
  assert.ok(r.sources.length > 0, '真实 HTML 应能解析出结果')
  assert.ok(r.sources.every((s) => /^https?:\/\//.test(s.url)), '所有 url 应为 http(s)')
  assert.ok(r.sources.every((s) => s.title.length > 0), '所有结果应有标题')
})

// ---------------------------------------------------------------------------
// 宿主 fetch 适配层
// ---------------------------------------------------------------------------

test('adaptHostFetcher: 解析宿主真实返回结构 { body: { content } }', async () => {
  const web = {
    fetch: async () => ({
      url: 'https://x',
      statusCode: 200,
      body: { kind: 'html', content: '<p>hello</p>' },
      truncated: false,
    }),
  }
  const get = adaptHostFetcher(web)
  assert.equal(await get('https://x'), '<p>hello</p>')
})

test('adaptHostFetcher: 兼容 body 直接是字符串的版本', async () => {
  const get = adaptHostFetcher({ fetch: async () => ({ body: 'raw text' }) })
  assert.equal(await get('https://x'), 'raw text')
})

test('adaptHostFetcher: 兼容整体返回字符串的版本', async () => {
  const get = adaptHostFetcher({ fetch: async () => 'plain' })
  assert.equal(await get('https://x'), 'plain')
})

test('adaptHostFetcher: 结构不匹配时抛错（不静默返回空）', async () => {
  // 关键：返回空串会被上层当成「壳页」，把「宿主接口变了」伪装成
  // 「目标站是 SPA」—— 这是看起来正常的失败，必须改为显式抛错。
  const get = adaptHostFetcher({ fetch: async () => ({ unexpected: true }) })
  await assert.rejects(get('https://x'), /无法解析 ctx\.web\.fetch 的返回结构/)
})

test('adaptHostFetcher: ctx.web 缺失时给出可执行的错误信息', async () => {
  await assert.rejects(adaptHostFetcher(undefined)('https://x'), /ctx\.web\.fetch 不可用/)
  await assert.rejects(adaptHostFetcher({})('https://x'), /ctx\.web\.fetch 不可用/)
})

test('adaptHostFetcher: 错误信息含结构描述但不回显内容', async () => {
  const get = adaptHostFetcher({
    fetch: async () => ({ secret: 'SENSITIVE-DATA', body: { weird: 1 } }),
  })
  try {
    await get('https://x')
    assert.fail('应抛错')
  } catch (e) {
    assert.match(e.message, /secret/, '应说明有哪些字段')
    assert.ok(!e.message.includes('SENSITIVE-DATA'), '不应回显字段的值')
  }
})

// ---------------------------------------------------------------------------
// 插件入口 apply
// ---------------------------------------------------------------------------

/** 造一个最小的 mock ctx。 */
function makeCtx() {
  const registered = []
  const effects = []
  return {
    registered,
    effects,
    ctx: {
      effect: (fn) => {
        effects.push(fn)
        return () => {}
      },
      web: {
        registerSearchProvider: (p) => {
          registered.push(p)
          return () => {}
        },
        fetch: async () => ({ body: { kind: 'html', content: '<p>x</p>' } }),
      },
    },
  }
}

test('apply: 注册 provider 与 CA effect', () => {
  const { ctx, registered, effects } = makeCtx()
  apply(ctx, {})

  assert.equal(registered.length, 1, '应注册一个 search provider')
  assert.equal(registered[0].id, 'zerokey')
  assert.equal(registered[0].available(), true)
  assert.equal(effects.length, 1, '应注册 CA 注入 effect')
})

test('apply: CA effect 可执行且可撤销（HMR 不残留 patch）', () => {
  const { ctx, effects } = makeCtx()
  apply(ctx, {})
  const dispose = effects[0]()
  assert.equal(typeof dispose, 'function', 'effect 应返回 disposer')
  dispose() // 不应抛错
})

test('apply: 配置被传给 provider（观察行为而非内部字段）', async () => {
  const { ctx, registered } = makeCtx()
  apply(ctx, { multiSource: false })

  const provider = registered[0]
  // multiSource=false 时不应调用任何垂直源。
  // 注入假源表以离线验证（真源表会打网络）。
  let verticalCalled = false
  provider.sources = new Map([
    [
      'bing',
      {
        id: 'bing',
        search: async () => ({ sources: [{ url: 'https://b/1', title: 'B' }], truncated: false }),
      },
    ],
    [
      'hackernews',
      {
        id: 'hackernews',
        search: async () => {
          verticalCalled = true
          return { sources: [], truncated: false }
        },
      },
    ],
  ])

  const r = await provider.search({ query: 'rust async runtime', maxResults: 5 }, undefined)
  assert.equal(verticalCalled, false, 'multiSource=false 时不该调用垂直源')
  assert.ok(r.sources.length > 0)
})

test('apply: 未配置时也能正常工作（config 可省略）', () => {
  const { ctx, registered } = makeCtx()
  apply(ctx, undefined)
  assert.equal(registered[0].id, 'zerokey')
})

// ---------------------------------------------------------------------------
// Bing 抓取层（mock fetch，不碰网络）
// ---------------------------------------------------------------------------

test('bing.source: 正常响应 → 返回解析结果', async (t) => {
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => block({ url: 'https://a.com', title: 'A', snippet: 'S' }),
  })

  const { search } = await import('../lib/sources/bing.js')
  const r = await search('q', { maxResults: 5, maxSnippetChars: 300 })
  assert.equal(r.sources.length, 1)
  assert.equal(r.sources[0].url, 'https://a.com')
})

test('bing.source: 请求 URL 带 q 与 count 参数', async (t) => {
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  let captured
  globalThis.fetch = async (url) => {
    captured = url
    return { ok: true, status: 200, text: async () => block({ url: 'https://a.com', title: 'A' }) }
  }

  const { search } = await import('../lib/sources/bing.js')
  await search('测试查询', { maxResults: 10, maxSnippetChars: 300 })
  assert.equal(captured.host, 'cn.bing.com', '必须直接请求 cn 域（避免跨源重定向）')
  assert.equal(captured.searchParams.get('q'), '测试查询')
  assert.equal(captured.searchParams.get('count'), '20', 'count 应为 maxResults*2 以抵消解析损耗')
})

test('bing.source: TLS 失败 → 给出指向 CA 修复的错误（可执行）', async (t) => {
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  globalThis.fetch = async () => {
    const e = new Error('fetch failed')
    e.cause = { message: 'unable to get local issuer certificate' }
    throw e
  }

  const { search } = await import('../lib/sources/bing.js')
  await assert.rejects(
    search('q', { maxResults: 5, maxSnippetChars: 300 }),
    /TLS 失败.*README-CA修复说明/s,
    'CA 未注入是本机最常见的失败，错误信息必须直指修复文档',
  )
})

test('bing.source: 非 TLS 的网络错误 → 包装并保留原因', async (t) => {
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  globalThis.fetch = async () => {
    throw new Error('ECONNRESET')
  }

  const { search } = await import('../lib/sources/bing.js')
  try {
    await search('q', { maxResults: 5, maxSnippetChars: 300 })
    assert.fail('应抛错')
  } catch (e) {
    assert.match(e.message, /搜索请求失败/)
    assert.ok(e.cause instanceof Error, '应保留原始错误便于排查')
  }
})

test('bing.source: HTTP 非 200 → 携带 status 抛出（供上层判定限流）', async (t) => {
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  globalThis.fetch = async () => ({ ok: false, status: 429, text: async () => '' })

  const { search } = await import('../lib/sources/bing.js')
  try {
    await search('q', { maxResults: 5, maxSnippetChars: 300 })
    assert.fail('应抛错')
  } catch (e) {
    assert.equal(e.status, 429, 'status 必须透出，上层靠它判定是否进入冷却')
  }
})

test('bing.source: 页面改版（无 b_algo）→ 明确报结构变更，不报「无结果」', async (t) => {
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => '<html><body>全新的页面结构，没有任何结果块</body></html>',
  })

  const { search } = await import('../lib/sources/bing.js')
  await assert.rejects(
    search('q', { maxResults: 5, maxSnippetChars: 300 }),
    /页面结构可能已变更/,
    '解析失败与「真没结果」必须区分——否则排查方向会跑偏',
  )
})

test('bing.source: 有 b_algo 但无可解析条目 → 返回空（不误报改版）', async (t) => {
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => '<li class="b_algo">存在但没有 h2</li>',
  })

  const { search } = await import('../lib/sources/bing.js')
  const r = await search('q', { maxResults: 5, maxSnippetChars: 300 })
  assert.equal(r.sources.length, 0, '有 b_algo 说明结构没变，只是这批结果不可解析')
})
