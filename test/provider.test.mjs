/**
 * provider 编排层测试（此前是覆盖率盲区：行覆盖仅 53%，函数覆盖仅 31%）。
 *
 * 为什么这组测试值得单独写：
 *   编排层是「决定找哪些源、失败怎么降级、结果怎么合并」的地方 ——
 *   出错的后果不是崩溃，而是**静默降级**（主结果看起来正常，垂直源其实全丢了）。
 *   本机已踩过两次同类 bug，故必须用注入假源把行为钉死。
 *
 * 通过 `deps.sources` 注入假源，完全不碰网络，因此测试是确定性的。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ZeroKeySearchProvider } from '../lib/provider.js'
import { AdaptationStore } from '../lib/adapt.js'
import { SingleFlight } from '../lib/request-policy.js'

/** 构造一个假源表。 */
function makeSources(spec) {
  const map = new Map()
  for (const [id, fn] of Object.entries(spec)) {
    map.set(id, {
      id,
      label: id,
      kind: 'api',
      search: fn,
    })
  }
  return map
}

const ok = (n, prefix = 'r') => async () =>
  ({
    sources: Array.from({ length: n }, (_, i) => ({
      url: `https://${prefix}${i}.example/${Math.random()}`,
      title: `${prefix}${i}`,
      snippet: 'x'.repeat(20),
    })),
    truncated: false,
  })

const silent = () => ({ log: () => {} })

test('provider: 主源失败 → 整体失败（主源不可降级）', async () => {
  const sources = makeSources({
    bing: async () => {
      throw new Error('bing down')
    },
    hackernews: ok(2, 'hn'),
  })
  const p = new ZeroKeySearchProvider(() => ({}), { sources, ...silent() })
  await assert.rejects(
    p.search({ query: 'rust async runtime', maxResults: 5 }, undefined),
    /bing down/,
    '主源是唯一不可降级的源，失败必须抛出',
  )
})

test('provider: 垂直源失败 → 降级为仅主源，不影响结果', async () => {
  const sources = makeSources({
    bing: ok(6, 'b'),
    hackernews: async () => {
      throw new Error('hn down')
    },
  })
  const logs = []
  const p = new ZeroKeySearchProvider(() => ({}), {
    sources,
    log: (m) => logs.push(m),
  })
  const r = await p.search({ query: 'rust async runtime', maxResults: 6 }, undefined)
  assert.equal(r.sources.length, 6, '仍应返回主源结果')
  assert.ok(
    logs.some((l) => /hackernews/.test(l) && /失败/.test(l)),
    '降级必须留痕，不可静默',
  )
})

test('provider: 垂直源结果进入预留槽位（交错，不被主源挤掉）', async () => {
  const sources = makeSources({
    bing: ok(10, 'b'),
    hackernews: ok(3, 'hn'),
  })
  const p = new ZeroKeySearchProvider(() => ({}), { sources, ...silent() })
  const r = await p.search({ query: 'rust async runtime', maxResults: 8 }, undefined)

  const hnCount = r.sources.filter((s) => s.url.includes('hn')).length
  assert.ok(hnCount > 0, `垂直源必须出现在结果里，实际 ${hnCount} 条`)
  assert.equal(r.sources.length, 8)
})

test('provider: 多个垂直源都能出现（回归：曾因 flat 导致后排源恒为 0）', async () => {
  const sources = makeSources({
    bing: ok(10, 'b'),
    hackernews: ok(2, 'hn'),
    github: ok(2, 'gh'),
  })
  const p = new ZeroKeySearchProvider(() => ({}), { sources, ...silent() })
  const r = await p.search({ query: 'typescript mcp sdk', maxResults: 10 }, undefined)

  const hn = r.sources.filter((s) => s.url.includes('hn')).length
  const gh = r.sources.filter((s) => s.url.includes('gh')).length
  assert.ok(hn > 0 && gh > 0, `两个垂直源都应出现，实际 HN=${hn} GH=${gh}`)
})

test('provider: 限流（429）→ 该源进入冷却，后续查询跳过它', async () => {
  let calls = 0
  const sources = makeSources({
    bing: ok(5, 'b'),
    github: async () => {
      calls++
      const e = new Error('rate limited')
      e.status = 429
      throw e
    },
  })
  const logs = []
  const p = new ZeroKeySearchProvider(() => ({}), { sources, log: (m) => logs.push(m) })

  await p.search({ query: 'typescript sdk', maxResults: 5 }, undefined)
  // 429 不在本次请求内重试 —— 立刻交给冷却机制。
  // 实测踩到：允许重试 429 会把被限流的源连打 3 次（retries=2），加重限流。
  assert.equal(calls, 1, '429 不应在本次请求内重试（会加重限流）')
  assert.equal(p.quota.isAvailable('github'), false, '撞 429 后应进入冷却')

  await p.search({ query: 'typescript sdk v2', maxResults: 5 }, undefined)
  assert.equal(calls, 1, '冷却期内不应再调用该源')
  assert.ok(
    logs.some((l) => /处于冷却/.test(l)),
    '跳过冷却源应留痕',
  )
})

test('provider: 超时（TimeoutError）也进入冷却（回归）', async () => {
  const sources = makeSources({
    bing: ok(5, 'b'),
    arxiv: async () => {
      const e = new Error('The operation was aborted due to timeout')
      e.name = 'TimeoutError'
      throw e
    },
  })
  const p = new ZeroKeySearchProvider(() => ({}), { sources, ...silent() })
  await p.search({ query: 'transformer paper', maxResults: 5 }, undefined)
  assert.equal(
    p.quota.isAvailable('arxiv'),
    false,
    '超时同样说明源当下不可用，必须退避（否每次白等超时）',
  )
})

test('provider: 缓存命中不打上游（第二次零请求）', async () => {
  let calls = 0
  const sources = makeSources({
    bing: async () => {
      calls++
      return { sources: [{ url: 'https://b/1', title: 't' }], truncated: false }
    },
    hackernews: async () => {
      calls++
      return { sources: [{ url: 'https://hn/1', title: 'h' }], truncated: false }
    },
  })
  const p = new ZeroKeySearchProvider(() => ({}), { sources, ...silent() })

  await p.search({ query: 'rust async runtime', maxResults: 5 }, undefined)
  const afterFirst = calls
  assert.ok(afterFirst > 0)

  await p.search({ query: 'rust async runtime', maxResults: 5 }, undefined)
  assert.equal(calls, afterFirst, '第二次应全部命中缓存，零上游请求')
})

test('provider: multiSource=false 时只走主源', async () => {
  let hnCalled = false
  const sources = makeSources({
    bing: ok(5, 'b'),
    hackernews: async () => {
      hnCalled = true
      return { sources: [], truncated: false }
    },
  })
  const p = new ZeroKeySearchProvider(() => ({ multiSource: false }), { sources, ...silent() })
  const r = await p.search({ query: 'rust async runtime', maxResults: 5 }, undefined)
  assert.equal(hnCalled, false, '关闭多源后不应调用垂直源')
  assert.ok(r.sources.every((s) => s.url.includes('b')))
})

test('provider: 自适应记录真实调用（成功与失败都记）', async () => {
  const sources = makeSources({
    bing: ok(3, 'b'),
    hackernews: async () => {
      throw new Error('boom')
    },
  })
  const adapt = new AdaptationStore({ persist: false })
  const p = new ZeroKeySearchProvider(() => ({}), { sources, adapt, ...silent() })
  await p.search({ query: 'rust async runtime', maxResults: 3 }, undefined)

  assert.equal(adapt.summary('bing').successRate, 1, '主源成功应被记录')
  assert.equal(adapt.summary('hackernews').successRate, 0, '垂直源失败应被记录')
})

test('provider: 空结果也缓存（避免反复请求确实无结果的 query）', async () => {
  let calls = 0
  const sources = makeSources({
    bing: async () => {
      calls++
      return { sources: [], truncated: false }
    },
  })
  const p = new ZeroKeySearchProvider(() => ({}), { sources, ...silent() })
  await p.search({ query: 'zzzz no result', maxResults: 5 }, undefined)
  await p.search({ query: 'zzzz no result', maxResults: 5 }, undefined)
  assert.equal(calls, 1, '空结果应被缓存，不应反复打上游')
})

test('provider: 注入假源表也影响路由（不会路由到未注入的源）', async () => {
  // 只注入 bing + npm。用「npm install xxx」这种明确命中 package 标签的查询 ——
  // 单裸词（如 express）与普通英文词无法区分，路由会保守地不判定（设计如此）。
  const sources = makeSources({ bing: ok(3, 'b'), npm: ok(2, 'npm') })
  const p = new ZeroKeySearchProvider(() => ({}), { sources, ...silent() })
  const r = await p.search({ query: 'npm install express', maxResults: 6 }, undefined)
  // 不应崩溃，且 npm 结果应出现
  assert.ok(r.sources.length > 0)
  assert.ok(
    r.sources.some((s) => s.url.includes('npm')),
    'package 类查询应路由到已注入的 npm 源',
  )
})

// ---------------------------------------------------------------------------
// P4 正文增强的编排（默认关闭的路径也要可测）
// ---------------------------------------------------------------------------

test('provider: includeContent 默认关闭 → 不抓正文', async () => {
  let fetched = 0
  const sources = makeSources({ bing: ok(3, 'b') })
  const p = new ZeroKeySearchProvider(() => ({}), {
    sources,
    fetchText: async () => {
      fetched++
      return '<p>content</p>'
    },
    ...silent(),
  })
  const r = await p.search({ query: 'x', maxResults: 3 }, undefined)
  assert.equal(fetched, 0, '默认关闭时不该抓正文（延迟 +466%，代价真实）')
  assert.ok(r.sources.every((s) => s.content === undefined))
})

test('provider: includeContent=true → 为前 N 条补正文', async () => {
  const sources = makeSources({ bing: ok(5, 'b') })
  const p = new ZeroKeySearchProvider(
    () => ({ includeContent: true, contentMaxFetch: 2, contentMaxChars: 100 }),
    {
      sources,
      fetchText: async () => '<p>' + '正文'.repeat(80) + '</p>',
      ...silent(),
    },
  )
  const r = await p.search({ query: 'x', maxResults: 5 }, undefined)
  const withContent = r.sources.filter((s) => s.content)
  assert.equal(withContent.length, 2, '只抓前 N 条')
  assert.equal(p.contentStats.calls, 1, '应记录一次增强调用')
})

test('provider: 正文抓取失败不影响搜索结果', async () => {
  const sources = makeSources({ bing: ok(4, 'b') })
  const logs = []
  const p = new ZeroKeySearchProvider(
    () => ({ includeContent: true, contentMaxFetch: 2 }),
    {
      sources,
      fetchText: async () => {
        throw new Error('fetch failed')
      },
      log: (m) => logs.push(m),
    },
  )
  const r = await p.search({ query: 'x', maxResults: 4 }, undefined)
  assert.equal(r.sources.length, 4, '抓正文失败绝不能减少搜索结果')
  assert.ok(logs.some((l) => /失败/.test(l)), '失败必须留痕')
})

test('provider: 无 fetchText 时即使开启 includeContent 也安全跳过', async () => {
  const sources = makeSources({ bing: ok(3, 'b') })
  const p = new ZeroKeySearchProvider(() => ({ includeContent: true }), {
    sources,
    // 故意不提供 fetchText（模拟宿主未暴露 fetch 的场景）
    ...silent(),
  })
  const r = await p.search({ query: 'x', maxResults: 3 }, undefined)
  assert.equal(r.sources.length, 3)
  assert.ok(r.sources.every((s) => s.content === undefined))
})

// ---------------------------------------------------------------------------
// 并发（single-flight）
// ---------------------------------------------------------------------------

test('provider: 并发相同查询只打一次上游（回归：曾并发穿透缓存）', async () => {
  // 实测踩到：10 个相同 query 并发时都查不到 TTL 缓存，
  // 各自打一次上游（10 次请求）—— 这与「降低暴露面」直接冲突。
  let calls = 0
  const sources = makeSources({
    bing: async () => {
      calls++
      await new Promise((r) => setTimeout(r, 30)) // 让并发窗口真实存在
      return { sources: [{ url: 'https://b/1', title: 'B' }], truncated: false }
    },
  })
  const p = new ZeroKeySearchProvider(() => ({}), { sources, ...silent() })

  const rs = await Promise.all(
    Array.from({ length: 10 }, () => p.search({ query: 'same query', maxResults: 3 }, undefined)),
  )

  assert.equal(calls, 1, `10 个并发相同查询应只打 1 次上游，实际 ${calls} 次`)
  assert.ok(rs.every((r) => r.sources.length === 1), '所有调用者都应拿到结果')
  assert.ok(p.singleFlight.stats.coalesced >= 8, '应记录到合并次数')
})

test('provider: 并发不同查询各自独立（不被误合并）', async () => {
  let calls = 0
  const sources = makeSources({
    bing: async () => {
      calls++
      await new Promise((r) => setTimeout(r, 10))
      return { sources: [{ url: `https://b/${Math.random()}`, title: 'B' }], truncated: false }
    },
  })
  const p = new ZeroKeySearchProvider(() => ({}), { sources, ...silent() })

  await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      p.search({ query: `distinct-${i}`, maxResults: 3 }, undefined),
    ),
  )
  assert.equal(calls, 5, '不同查询必须各自请求，不能被 single-flight 误合并')
})

test('provider: single-flight 失败后不固化（下次会重新请求）', async () => {
  let calls = 0
  const sources = makeSources({
    bing: async () => {
      calls++
      throw new Error('transient')
    },
  })
  const p = new ZeroKeySearchProvider(() => ({}), { sources, ...silent() })

  await assert.rejects(p.search({ query: 'x', maxResults: 3 }, undefined))
  const afterFirst = calls
  await assert.rejects(p.search({ query: 'x', maxResults: 3 }, undefined))

  // 注意：单次 search 内部会按 retries 重试（网络错误默认可重试），
  // 故 calls 不是 1 —— 这里验证的是「第二次 search 仍会真的再打上游」，
  // 即失败没有被 single-flight 固化。
  assert.ok(afterFirst >= 1, '首次应真的调用上游')
  assert.equal(calls, afterFirst * 2, '第二次搜索应重新请求（失败不固化）')
  assert.equal(p.singleFlight.stats.inflight, 0, '失败后 in-flight 表应清空')
})

test('SingleFlight: 直接验证合并语义', async () => {
  const sf = new SingleFlight()
  let n = 0
  const produce = () =>
    sf.run('k', async () => {
      n++
      await new Promise((r) => setTimeout(r, 20))
      return n
    })

  const [a, b, c] = await Promise.all([produce(), produce(), produce()])
  assert.equal(n, 1)
  assert.equal(a, 1)
  assert.equal(b, 1)
  assert.equal(c, 1)
  assert.equal(sf.stats.coalesced, 2)
  assert.equal(sf.stats.inflight, 0, '结束后应清空 in-flight 表')
})

test('provider: 正文增强整体抛错时不降低搜索结果（回归）', async () => {
  // 触发 #maybeEnrich 的 catch 分支。
  // enrichWithContent 对**单条**失败是吞掉的，故要制造**整体**异常：
  // 让 cache.set 抛错（它在 try 块内、且不在单条 try 里）。
  const sources = makeSources({ bing: ok(4, 'b') })
  const logs = []
  const p = new ZeroKeySearchProvider(
    () => ({ includeContent: true, contentMaxFetch: 2 }),
    {
      sources,
      fetchText: async () => '<p>' + '正文'.repeat(80) + '</p>',
      log: (m) => logs.push(m),
    },
  )

  // cache.set 在增强成功后被调用；让它抛错即可进入 catch
  const realSet = p.cache.set.bind(p.cache)
  p.cache.set = (k, v, ttl) => {
    // 只让「增强结果」的写入失败，不影响搜索结果的缓存
    if (typeof k === 'string' && k.includes('enrich')) throw new Error('simulated cache failure')
    return realSet(k, v, ttl)
  }

  const r = await p.search({ query: 'x', maxResults: 4 }, undefined)
  assert.ok(Array.isArray(r.sources) && r.sources.length > 0, '增强失败不该影响搜索结果')
  assert.ok(
    logs.some((l) => /整体失败/.test(l)),
    `整体失败必须留痕，实际日志: ${JSON.stringify(logs)}`,
  )
  assert.ok(p.contentStats.failures >= 1, '应记录失败计数')
})

test('provider: stats 暴露缓存统计', async () => {
  const sources = makeSources({ bing: ok(2, 'b') })
  const p = new ZeroKeySearchProvider(() => ({}), { sources, ...silent() })
  await p.search({ query: 'x', maxResults: 2 }, undefined)
  const s = p.stats
  assert.ok(s.cache, 'stats 应含 cache')
  assert.equal(typeof s.cache.hits, 'number')
})

test('provider: 结果项带结构化来源标注（证据层）', async () => {
  // 此前来源只混在 snippet 文字里，且格式不一致（arXiv/CSDN 有、GitHub/npm 没有），
  // 模型只能靠读文字猜来源。加结构化字段后才能机器化判断可信度。
  const sources = new Map([
    [
      'bing',
      { id: 'bing', label: 'Bing', kind: 'scrape', search: ok(2, 'b') },
    ],
    [
      'hackernews',
      { id: 'hackernews', label: 'Hacker News', kind: 'api', search: ok(1, 'hn') },
    ],
  ])
  const p = new ZeroKeySearchProvider(() => ({}), { sources, ...silent() })
  const r = await p.search({ query: 'rust async runtime', maxResults: 6 }, undefined)

  assert.ok(r.sources.every((s) => s.source), '每条结果都应有 source')
  assert.ok(r.sources.every((s) => s.sourceKind), '每条结果都应有 sourceKind')

  const bing = r.sources.find((s) => s.source === 'Bing')
  assert.equal(bing.sourceKind, 'scrape', 'Bing 是抓页来源')

  const hn = r.sources.find((s) => s.source === 'Hacker News')
  assert.ok(hn, 'HN 结果应带自己的标签')
  assert.equal(hn.sourceKind, 'api', 'HN 是 API 来源')
})

test('provider: 来源标注在缓存命中也保留（不会丢字段）', async () => {
  const sources = makeSources({ bing: ok(2, 'b') })
  sources.get('bing').label = 'Bing'
  sources.get('bing').kind = 'scrape'
  const p = new ZeroKeySearchProvider(() => ({}), { sources, ...silent() })

  const r1 = await p.search({ query: 'x', maxResults: 2 }, undefined)
  const r2 = await p.search({ query: 'x', maxResults: 2 }, undefined) // 命中缓存
  assert.ok(r1.sources.every((s) => s.source === 'Bing'))
  assert.ok(r2.sources.every((s) => s.source === 'Bing'), '缓存结果也应带标注')
})
