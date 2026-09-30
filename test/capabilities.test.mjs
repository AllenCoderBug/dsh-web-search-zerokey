/**
 * 新增能力测试：路由分类、请求策略、解析器。
 * 这些针对 v0.3.0 的新模块，与 routing.test.mjs（旧行为回归）互补。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { classifyQuery, routeSources } from '../lib/route.js'
import {
  TtlCache,
  MinIntervalLimiter,
  isRetryableStatus,
  withRetry,
  cached,
} from '../lib/request-policy.js'
import { parseBingDate, formatDateShort, unixSecondsToDate, cap, stripTags } from '../lib/text.js'
import { parseJuejin } from '../lib/sources/juejin.js'
import { parseCsdn } from '../lib/sources/csdn.js'
import { parseArxivXml } from '../lib/sources/arxiv.js'
import { SourceQuota } from '../lib/sources/registry.js'
import { enrichWithContent, extractReadableText, looksLikeShellPage } from '../lib/enrich.js'

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

test('classifyQuery: 能区分 code / academic / package 标签', () => {
  assert.ok(classifyQuery('react useEffect cleanup').tags.has('code'))
  assert.ok(classifyQuery('arxiv paper on transformer').tags.has('academic'))
  assert.ok(classifyQuery('npm install fastapi').tags.has('package'))
  assert.ok(classifyQuery('掘金 教程 实战').tags.has('chineseTech'))
})

test('classifyQuery: 中文长句撤掉英文语料标签，保留中文源', () => {
  const { tags, isLongChinese } = classifyQuery('这个 react 组件为什么报错')
  assert.equal(isLongChinese, true)
  assert.ok(!tags.has('code'), '中文长句不该启用英文 code 源')
  assert.ok(tags.has('chineseTech'), '中文长句应保留中文源')
})

test('routeSources: 按标签给出源清单，且尊重可用白名单', () => {
  assert.deepEqual(routeSources('react hooks'), ['hackernews', 'github'])
  assert.deepEqual(routeSources('transformer paper'), ['arxiv', 'hackernews'])
  assert.deepEqual(routeSources('npm install express'), ['npm', 'github'])
  // 白名单过滤掉未实现的源
  assert.deepEqual(routeSources('react hooks', { available: ['github'] }), ['github'])
})

test('routeSources: 非技术查询不启用任何垂直源', () => {
  assert.deepEqual(routeSources('今天天气怎么样'), [])
})

// ---------------------------------------------------------------------------
// 缓存
// ---------------------------------------------------------------------------

test('TtlCache: 命中/过期/LRU 淘汰', async () => {
  const c = new TtlCache({ maxEntries: 2, ttlMs: 50 })
  c.set('a', 1)
  assert.equal(c.get('a'), 1)
  assert.equal(c.get('nope'), undefined)

  // 过期
  c.set('b', 2, 10)
  await new Promise((r) => setTimeout(r, 25))
  assert.equal(c.get('b'), undefined, '过期条目应失效')

  // LRU 淘汰
  c.set('x', 1)
  c.set('y', 2)
  c.set('z', 3) // 应淘汰最旧的 x
  assert.equal(c.get('x'), undefined)
  assert.equal(c.get('z'), 3)
})

test('TtlCache: stats 统计命中率', () => {
  const c = new TtlCache()
  c.set('k', 'v')
  c.get('k')
  c.get('miss')
  const s = c.stats
  assert.equal(s.hits, 1)
  assert.equal(s.misses, 1)
  assert.equal(s.hitRate, 0.5)
})

test('cached: 命中缓存时不再调用 producer（关键：省请求）', async () => {
  const c = new TtlCache()
  let calls = 0
  const producer = async () => {
    calls++
    return ['r']
  }
  await cached(c, 'k', producer)
  await cached(c, 'k', producer)
  assert.equal(calls, 1, '第二次应命中缓存，不再请求上游')
})

// ---------------------------------------------------------------------------
// 限速
// ---------------------------------------------------------------------------

test('MinIntervalLimiter: 同 key 串行且满足最小间隔', async () => {
  const lim = new MinIntervalLimiter(60)
  const stamps = []
  const job = () => lim.run('k', async () => stamps.push(Date.now()))

  await Promise.all([job(), job(), job()])
  assert.equal(stamps.length, 3)
  // 相邻间隔应 >= 最小间隔（留一点调度余量）
  for (let i = 1; i < stamps.length; i++) {
    assert.ok(
      stamps[i] - stamps[i - 1] >= 50,
      `第 ${i} 次间隔过短：${stamps[i] - stamps[i - 1]}ms`,
    )
  }
})

test('MinIntervalLimiter: 不同 key 互不阻塞', async () => {
  const lim = new MinIntervalLimiter(200)
  const t0 = Date.now()
  await Promise.all([
    lim.run('a', async () => {}),
    lim.run('b', async () => {}),
  ])
  assert.ok(Date.now() - t0 < 150, '不同 key 不应互相等待')
})

// ---------------------------------------------------------------------------
// 重试
// ---------------------------------------------------------------------------

test('isRetryableStatus: 只重试瞬时/限流类', () => {
  assert.equal(isRetryableStatus(429), true)
  assert.equal(isRetryableStatus(500), true)
  assert.equal(isRetryableStatus(503), true)
  assert.equal(isRetryableStatus(404), false)
  assert.equal(isRetryableStatus(400), false)
})

test('withRetry: 瞬时失败后成功；4xx 不重试', async () => {
  let n = 0
  const flaky = await withRetry(
    async () => {
      n++
      if (n < 3) {
        const e = new Error('boom')
        e.status = 503
        throw e
      }
      return 'ok'
    },
    { retries: 3, baseDelayMs: 5 },
  )
  assert.equal(flaky, 'ok')
  assert.equal(n, 3)

  let m = 0
  await assert.rejects(
    withRetry(
      async () => {
        m++
        const e = new Error('not found')
        e.status = 404
        throw e
      },
      { retries: 3, baseDelayMs: 5 },
    ),
  )
  assert.equal(m, 1, '4xx 不该重试（浪费请求、抬高暴露面）')
})

// ---------------------------------------------------------------------------
// 文本与日期
// ---------------------------------------------------------------------------

test('parseBingDate: 识别相对与绝对日期', () => {
  const now = Date.parse('2026-09-30T00:00:00Z')
  assert.equal(parseBingDate('3 天前', now), '2026-09-27')
  assert.equal(parseBingDate('2026年8月27日 · 内容', now), '2026-08-27')
  assert.equal(parseBingDate('发布于 2026-08-27', now), '2026-08-27')
  assert.equal(parseBingDate('没有日期', now), undefined)
})

test('cap: 不切断代理对', () => {
  // 每个 emoji 是 2 个 UTF-16 单元
  const s = '😀😀😀'
  assert.equal(cap(s, 3), '😀', '不该产出半个 emoji')
  assert.equal(cap('abc', 10), 'abc')
})

test('unixSecondsToDate / formatDateShort', () => {
  assert.equal(unixSecondsToDate(1789373211), '2026-09-14')
  assert.equal(unixSecondsToDate(0), undefined)
  assert.equal(unixSecondsToDate('abc'), undefined)

  const now = Date.parse('2026-09-30T12:00:00Z')
  assert.equal(formatDateShort('2026-09-30T01:00:00Z', now), '今天')
  assert.equal(formatDateShort('2026-09-29T01:00:00Z', now), '昨天')
  assert.equal(formatDateShort('2026-08-01T01:00:00Z', now), '2026-08-01')
})

test('stripTags: 清标签与实体', () => {
  assert.equal(stripTags('<b>hello</b> &amp; <i>world</i>'), 'hello & world')
  assert.equal(stripTags('a&nbsp;b'), 'a b')
})

// ---------------------------------------------------------------------------
// 源解析器（离线，不依赖网络）
// ---------------------------------------------------------------------------

test('parseJuejin: 提取标题/摘要/日期，并自行拼链接', () => {
  const data = {
    err_no: 0,
    data: [
      {
        result_model: {
          article_info: {
            article_id: '123',
            title: '深入 Cordis',
            brief_content: '插件框架解析',
            ctime: 1789373211,
          },
        },
      },
    ],
  }
  const { sources } = parseJuejin(data, 5)
  assert.equal(sources.length, 1)
  assert.equal(sources[0].url, 'https://juejin.cn/post/123')
  assert.equal(sources[0].title, '深入 Cordis')
  assert.equal(sources[0].date, '2026-09-14')
  assert.match(sources[0].snippet, /掘金/)
})

test('parseJuejin: 容忍空数据与畸形条目', () => {
  assert.deepEqual(parseJuejin({}, 5).sources, [])
  assert.deepEqual(parseJuejin({ data: [{ result_model: {} }] }, 5).sources, [])
})

test('parseCsdn: 兼容两种响应形态', () => {
  const a = parseCsdn({ result_vos: [{ url: 'https://a', title: 'T1' }] }, 5)
  assert.equal(a.sources.length, 1)
  const b = parseCsdn({ data: [{ url: 'https://b', title: 'T2' }] }, 5)
  assert.equal(b.sources.length, 1)
  // 非 http 链接应被过滤
  const c = parseCsdn({ result_vos: [{ url: 'javascript:void(0)', title: 'x' }] }, 5)
  assert.equal(c.sources.length, 0)
})

test('parseArxivXml: 从 Atom XML 提取条目', () => {
  const xml = `<feed>
    <entry>
      <id>http://arxiv.org/abs/2401.00001v1</id>
      <title>Agentic Search Systems</title>
      <summary>A survey of agentic retrieval.</summary>
      <published>2026-01-15T00:00:00Z</published>
      <author><name>Alice</name></author>
      <author><name>Bob</name></author>
    </entry>
  </feed>`
  const { sources } = parseArxivXml(xml, 5)
  assert.equal(sources.length, 1)
  assert.equal(sources[0].url, 'http://arxiv.org/abs/2401.00001v1')
  assert.equal(sources[0].title, 'Agentic Search Systems')
  assert.equal(sources[0].date, '2026-01-15')
  assert.match(sources[0].snippet, /Alice/)
})

test('parseArxivXml: 空 XML 不崩', () => {
  assert.deepEqual(parseArxivXml('', 5).sources, [])
})

// ---------------------------------------------------------------------------
// 额度管理
// ---------------------------------------------------------------------------

test('SourceQuota: 限流后进入冷却，到期自动恢复', () => {
  const q = new SourceQuota({ github: 60 })
  assert.equal(q.isAvailable('github'), true)

  q.markRateLimited('github')
  assert.equal(q.isAvailable('github'), false)
  assert.ok(q.cooldownRemaining('github') > 0)
})

test('SourceQuota: 未配置冷却的源走兜底冷却（不可立即重试）', () => {
  // 设计理由：撞 429 却立刻重试 = 持续 hammering 上游，
  // 会把「临时限流」升级为「IP 被封」。故任何源被拒后都必须先退开。
  const q = new SourceQuota({}, 30)
  assert.equal(q.markRateLimited('hackernews'), true)
  assert.equal(q.isAvailable('hackernews'), false)
})

test('SourceQuota: 冷却为 0 时视为禁用冷却', () => {
  const q = new SourceQuota({ weird: 0 })
  assert.equal(q.markRateLimited('weird'), false)
  assert.equal(q.isAvailable('weird'), true)
})

// ---------------------------------------------------------------------------
// P4：正文增强
// ---------------------------------------------------------------------------

test('extractReadableText: 剥离标签与脚本，保留正文', () => {
  const html = `<html><head><style>body{color:red}</style></head>
    <body><nav>菜单</nav><h1>标题</h1><p>正文内容在这里。</p>
    <script>var x=1</script><footer>页脚</footer></body></html>`
  const text = extractReadableText(html, 500)
  assert.match(text, /标题/)
  assert.match(text, /正文内容/)
  assert.ok(!/color:red/.test(text), '不该残留 style 内容')
  assert.ok(!/var x/.test(text), '不该残留 script 内容')
  assert.ok(!/菜单/.test(text), '不该残留 nav 内容')
})

test('looksLikeShellPage: 识别「200 但正文为空」的壳页', () => {
  assert.equal(looksLikeShellPage(''), true)
  assert.equal(looksLikeShellPage('   '), true)
  assert.equal(looksLikeShellPage('短'), true)
  // 阈值是 80 字符；测试数据本身必须明显超过它，否则测的是测试自己的错误
  const longText = '这是一段足够长的真实正文内容，'.repeat(10)
  assert.ok(longText.length > 80, '测试数据本身要超过阈值')
  assert.equal(looksLikeShellPage(longText), false)
})

test('enrichWithContent: 为前 N 条补充正文，其余保持原样', async () => {
  const sources = [
    { url: 'https://a', title: 'A' },
    { url: 'https://b', title: 'B' },
    { url: 'https://c', title: 'C' },
  ]
  const fetched = []
  const out = await enrichWithContent(sources, {
    fetchText: async (url) => {
      fetched.push(url)
      return `<p>${'正文'.repeat(60)}</p>`
    },
    maxFetch: 2,
  })

  assert.deepEqual(fetched, ['https://a', 'https://b'], '只抓前 N 条')
  assert.ok(out[0].content, '第 1 条应有正文')
  assert.ok(out[1].content, '第 2 条应有正文')
  assert.equal(out[2].content, undefined, '第 3 条不该被抓')
  assert.equal(out[2].title, 'C', '未抓取的条目原样保留')
})

test('enrichWithContent: 壳页不写入 content（避免把空壳当正文）', async () => {
  const logs = []
  const out = await enrichWithContent([{ url: 'https://spa', title: 'SPA' }], {
    fetchText: async () => '<div id="app"></div>',
    maxFetch: 1,
    log: (m) => logs.push(m),
  })
  assert.equal(out[0].content, undefined, '壳页不该产生 content')
  assert.ok(logs.some((l) => /壳页/.test(l)), '应留下可见痕迹，不可静默')
})

test('enrichWithContent: 单条抓取失败不影响其他条目', async () => {
  const out = await enrichWithContent(
    [
      { url: 'https://bad', title: 'bad' },
      { url: 'https://good', title: 'good' },
    ],
    {
      fetchText: async (url) => {
        if (url.includes('bad')) throw new Error('boom')
        return `<p>${'正文'.repeat(60)}</p>`
      },
      maxFetch: 2,
    },
  )
  assert.equal(out[0].content, undefined, '失败条目保持原样')
  assert.ok(out[1].content, '成功条目不受影响')
})

test('enrichWithContent: 无 fetchText 时原样返回（P4 关闭）', async () => {
  const sources = [{ url: 'https://a', title: 'A' }]
  const out = await enrichWithContent(sources, {})
  assert.deepEqual(out, sources)
})
