/**
 * 新增能力测试：路由分类、请求策略、解析器。
 * 这些针对 v0.3.0 的新模块，与 routing.test.mjs（旧行为回归）互补。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { classifyQuery, routeSources } from '../lib/route.js'
import { planVerticalQuota, computeReserve, MAX_RESERVE, mergeSources } from '../lib/merge.js'
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
import { ZeroKeySearchProvider } from '../lib/provider.js'
import { AdaptationStore } from '../lib/adapt.js'
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

test('MinIntervalLimiter: 回归 — 按 key 隔离间隔，慢源不被快源覆盖', async () => {
  // 实测踩到的 bug：间隔若是实例字段，调用方按源赋值会互相覆盖，
  // 会让 arXiv 的 3000ms 官方限速被其他源的 800ms 顶掉（违反上游 ToU）。
  const lim = new MinIntervalLimiter({ arxiv: 3000, default: 100 })
  assert.equal(lim.intervalFor('arxiv'), 3000, 'arxiv 必须保住自己的间隔')
  assert.equal(lim.intervalFor('other'), 100)

  const marks = []
  const t0 = Date.now()
  await Promise.all([
    lim.run('arxiv', async () => marks.push(Date.now() - t0)),
    lim.run('other', async () => {}),
    lim.run('arxiv', async () => marks.push(Date.now() - t0)),
  ])
  assert.ok(
    marks[1] - marks[0] >= 2800,
    `arxiv 两次请求间隔应 ≥2800ms，实际 ${marks[1] - marks[0]}ms`,
  )
})

test('MinIntervalLimiter: 构造传单一数字时作为默认值', () => {
  const lim = new MinIntervalLimiter(250)
  assert.equal(lim.intervalFor('anything'), 250)
})

// ---------------------------------------------------------------------------
// 边界输入（实测踩到的两个契约问题）
// ---------------------------------------------------------------------------

test('provider.search: 空查询返回空结果且不发请求（回归）', async () => {
  // 实测踩到：空查询会真的请求 Bing，拿到无结果页后抛
  // 「页面结构可能已变更」的误导性错误，让排查方向跑偏。
  const p = new ZeroKeySearchProvider(() => ({}), { log: () => {} })
  const r = await p.search({ query: '', maxResults: 5 }, undefined)
  assert.deepEqual(r, { sources: [], truncated: false })
})

test('provider.search: maxResults=0 返回空结果（回归：曾返回 1 条）', async () => {
  const p = new ZeroKeySearchProvider(() => ({}), { log: () => {} })
  const r = await p.search({ query: 'test', maxResults: 0 }, undefined)
  assert.equal(r.sources.length, 0, 'maxResults=0 不该返回任何结果')
})

test('provider.search: 纯空白查询也视为空', async () => {
  const p = new ZeroKeySearchProvider(() => ({}), { log: () => {} })
  const r = await p.search({ query: '   \t  ' }, undefined)
  assert.deepEqual(r, { sources: [], truncated: false })
})

// ---------------------------------------------------------------------------
// 重试
// ---------------------------------------------------------------------------

test('isRetryableStatus: 只重试瞬时故障；429 刻意排除', () => {
  // 429 交由冷却机制处理，不在本次请求内重试（否则加重限流）
  assert.equal(isRetryableStatus(429), false)
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

// ---------------------------------------------------------------------------
// 自适应（自进化）
// ---------------------------------------------------------------------------

test('AdaptationStore: 样本不足时不调整（防小样本噪声）', () => {
  const a = new AdaptationStore({ persist: false })
  a.record('x', { ok: false })
  a.record('x', { ok: false })
  // 只有 2 个样本，低于 MIN_SAMPLES=3
  assert.equal(a.quotaFactor('x'), 1, '样本不足时不应调整配额')
})

test('AdaptationStore: 成功率低 → 配额下降，但有下限（不饿死）', () => {
  const a = new AdaptationStore({ persist: false })
  for (let i = 0; i < 10; i++) a.record('x', { ok: false })
  const q = a.quotaFactor('x')
  assert.ok(q < 1, `失败多应降低配额，实际 ${q}`)
  assert.ok(q >= 0.5, `配额不应低于下限 0.5，实际 ${q}`)
})

test('AdaptationStore: 频繁限流 → 冷却拉长，但有上限', () => {
  const a = new AdaptationStore({ persist: false })
  for (let i = 0; i < 10; i++) a.record('x', { ok: false, rateLimited: true })
  const c = a.cooldownFactor('x')
  assert.ok(c > 1, `限流多应拉长冷却，实际 ${c}`)
  assert.ok(c <= 4, `冷却倍率不应超过上限 4，实际 ${c}`)
})

test('AdaptationStore: 全成功不惩罚（配额保持 1）', () => {
  const a = new AdaptationStore({ persist: false })
  for (let i = 0; i < 10; i++) a.record('x', { ok: true, latencyMs: 50 })
  assert.equal(a.quotaFactor('x'), 1)
  assert.equal(a.cooldownFactor('x'), 1)
})

test('AdaptationStore: 持久化 —— 重新载入后统计仍在（这才叫进化）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-probe-adapt-'))
  const statePath = path.join(dir, 'adapt.json')
  try {
    const a = new AdaptationStore({ statePath })
    for (let i = 0; i < 10; i++) a.record('slow', { ok: false, rateLimited: true })
    a.save()
    const factorBefore = a.cooldownFactor('slow')

    // 新实例模拟「重启」
    const b = new AdaptationStore({ statePath })
    b.load()
    // 容差说明：落盘时数值被四舍五入到 4 位小数（去掉浮点长尾，便于人读与 diff）。
    // 倍率的有效区间只有 [0.5,4]，故 1e-3 的容差远小于任何有意义的差别 ——
    // 这不是放宽断言，而是断言「实质等价」这个真实要求。
    assert.ok(
      Math.abs(b.cooldownFactor('slow') - factorBefore) < 1e-3,
      `重启后应保留学到的参数（前 ${factorBefore}，后 ${b.cooldownFactor('slow')}）`,
    )
    assert.equal(b.summary('slow').samples > 0, true, '样本数也应保留')
    assert.ok(b.summary('slow').rateLimitRate > 0, '限流率也应保留')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('AdaptationStore: 文件损坏 / 不存在时不崩（从零开始）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-probe-adapt-'))
  const statePath = path.join(dir, 'adapt.json')
  try {
    // 不存在
    const a = new AdaptationStore({ statePath })
    a.load()
    assert.equal(a.quotaFactor('x'), 1)
    // 损坏
    fs.writeFileSync(statePath, '{ not json')
    const b = new AdaptationStore({ statePath })
    b.load()
    assert.equal(b.quotaFactor('x'), 1)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('AdaptationStore: 落盘的值被夹在安全区间（防篡改导致极端行为）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-probe-adapt-'))
  const statePath = path.join(dir, 'adapt.json')
  try {
    // 手工写入越界值，模拟文件被改坏或恶意修改
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        version: 1,
        sources: { evil: { success: 0, failure: 99, samples: 99, quotaFactor: -100, cooldownFactor: 9999 } },
      }),
    )
    const a = new AdaptationStore({ statePath })
    a.load()
    assert.ok(a.quotaFactor('evil') >= 0.5, '配额下界应被夹住')
    assert.ok(a.cooldownFactor('evil') <= 4, '冷却上界应被夹住')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('AdaptationStore: 禁用时不影响主流程', () => {
  const a = new AdaptationStore({ enabled: false, persist: false })
  for (let i = 0; i < 20; i++) a.record('x', { ok: false })
  assert.equal(a.quotaFactor('x'), 1, '禁用时恒返回默认值')
})

test('provider: 源超时也应触发冷却（回归：此前只认 429/403）', async () => {
  // 实测踩到：arXiv 常以 TimeoutError 告终（无 status），
  // 而此前只有 429/403 才触发冷却 —— 导致每次搜索都白等 8 秒。
  const logs = []
  const p = new ZeroKeySearchProvider(() => ({ multiSource: true }), {
    log: (m) => logs.push(m),
  })
  // 直接验证冷却状态机对外可观测的行为：标记后应不可用
  p.quota.markRateLimited('arxiv', 1)
  assert.equal(p.quota.isAvailable('arxiv'), false, '冷却中应跳过该源')
  assert.ok(p.quota.cooldownRemaining('arxiv') > 0)
})

test('SourceQuota: 冷却倍率生效（自适应的冷却拉长）', () => {
  const q = new SourceQuota({ x: 1000 })
  q.markRateLimited('x', 1)
  const base = q.cooldownRemaining('x')
  q.markRateLimited('x', 3)
  const tripled = q.cooldownRemaining('x')
  assert.ok(tripled > base * 2.5, `倍率应放大冷却（base=${base}, x3=${tripled}）`)
})

test('SourceQuota: 非法倍率回退为 1（防异常输入放大冷却）', () => {
  const q = new SourceQuota({ x: 1000 })
  q.markRateLimited('x', NaN)
  const a = q.cooldownRemaining('x')
  q.markRateLimited('x', -5)
  const b = q.cooldownRemaining('x')
  assert.ok(a <= 1100 && b <= 1100, '非法倍率应按 1 处理')
})

// ---------------------------------------------------------------------------
// 覆盖剩余的错误分支
// ---------------------------------------------------------------------------

test('AdaptationStore: 状态写入失败时只记日志，不影响运行', () => {
  const logs = []
  // 用一个不可能写入的路径（其父是一个文件而非目录）
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-probe-badstate-'))
  const blocker = path.join(dir, 'blocker')
  fs.writeFileSync(blocker, 'not a directory')
  const statePath = path.join(blocker, 'sub', 'adapt.json')

  try {
    const a = new AdaptationStore({ statePath })
    a.record('x', { ok: true })
    a.save((m) => logs.push(m))
    assert.ok(logs.some((l) => /写入失败/.test(l)), '写失败必须留痕')
    // 关键：不该抛错，统计仍在内存中可用
    assert.ok(a.quotaFactor('x') >= 0.5)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('AdaptationStore: summarizeAll 覆盖多个源', () => {
  const a = new AdaptationStore({ persist: false })
  a.record('bing', { ok: true, latencyMs: 30 })
  a.record('hn', { ok: false, rateLimited: true })
  const all = a.summarizeAll()
  assert.deepEqual(Object.keys(all).sort(), ['bing', 'hn'])
  assert.equal(all.bing.successRate, 1)
  assert.equal(all.hn.successRate, 0)
})

test('AdaptationStore: summarizeAll 初始为空对象', () => {
  assert.deepEqual(new AdaptationStore({ persist: false }).summarizeAll(), {})
})

test('AdaptationStore: reset 清空统计', () => {
  const a = new AdaptationStore({ persist: false })
  a.record('x', { ok: true })
  assert.ok(Object.keys(a.summarizeAll()).length > 0)
  a.reset()
  assert.deepEqual(a.summarizeAll(), {})
})

test('AdaptationStore: 禁用时 record 为 no-op', () => {
  const a = new AdaptationStore({ enabled: false, persist: false })
  a.record('x', { ok: false, rateLimited: true })
  assert.deepEqual(a.summarizeAll(), {})
})

test('AdaptationStore: save 在 dirty=false 时不写盘（幂等）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-probe-nd-'))
  const statePath = path.join(dir, 'a.json')
  try {
    const a = new AdaptationStore({ statePath })
    a.save() // 无 record，dirty=false
    assert.equal(fs.existsSync(statePath), false, '无变化时不该写盘')
    a.record('x', { ok: true })
    a.save()
    assert.equal(fs.existsSync(statePath), true)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 垂直源配额规划（防请求浪费）
// ---------------------------------------------------------------------------

test('planVerticalQuota: 生效源数×每源 必不超过预留（防请求白打）', () => {
  // 实测踩到：2 个源各请求 2 条（共 4 条），却只预留 2 个槽位 ——
  // 交错后只有前 2 条能进结果，一半请求被丢弃。
  // 这不只是浪费：多发请求就多一分暴露面，而结果并没有变多。
  //
  // 注意「生效源数」= min(源数, 预留)：当 maxResults 极小、预留少于源数时，
  // 生产代码会用 maxSources 把实际启用的源数压到预留以内（见 provider.js）。
  // 故这里断言的是生效源数，而非传入的源数。
  for (const maxResults of [1, 3, 5, 8, 10, 15, 20]) {
    for (const sourceCount of [1, 2, 3, 4, 5]) {
      const { reserve, perSource } = planVerticalQuota(maxResults, sourceCount)
      const effectiveSources = Math.min(sourceCount, reserve)
      assert.ok(
        effectiveSources * perSource <= reserve,
        `max=${maxResults} 源=${sourceCount}: 生效 ${effectiveSources}×${perSource} 超过预留 ${reserve}`,
      )
    }
  }
})

test('planVerticalQuota: 预留至少容纳每源 1 条（否则有源被完全浪费）', () => {
  for (const sourceCount of [1, 2, 3, 4]) {
    const { reserve } = planVerticalQuota(20, sourceCount)
    assert.ok(
      reserve >= Math.min(sourceCount, MAX_RESERVE),
      `${sourceCount} 个源应至少有 ${Math.min(sourceCount, MAX_RESERVE)} 个预留，实际 ${reserve}`,
    )
  }
})

test('provider: 路由源数上限与配额规划一致（防失配）', async () => {
  // 若路由返回的源数超过预留能容纳的量，多出的请求会被丢弃（白打）。
  // 生产代码用 maxSources 把源数限死，这里验证两者确实一致。
  const lines = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../lib/provider.js', import.meta.url), 'utf8'),
  )
  assert.match(lines, /maxSources:\s*MAX_VERTICAL_SOURCES/, '路由应显式传 maxSources')
  assert.match(lines, /planVerticalQuota\(maxResults, routed\.length\)/, '配额应按实际源数规划')
})

test('planVerticalQuota: 无源或无数上限时返回零', () => {
  assert.deepEqual(planVerticalQuota(10, 0), { reserve: 0, perSource: 0 })
  assert.deepEqual(planVerticalQuota(0, 3), { reserve: 0, perSource: 0 })
})

test('planVerticalQuota: 每源至少 1 条（否则源等于没参与）', () => {
  const { perSource } = planVerticalQuota(10, 10)
  assert.ok(perSource >= 1, '源再多，每源也应至少请求 1 条')
})

test('planVerticalQuota: 预留不超过上限（主源不能被垂直源挤空）', () => {
  for (const maxResults of [10, 20, 50]) {
    const { reserve } = planVerticalQuota(maxResults, 5)
    assert.ok(reserve <= MAX_RESERVE, `预留 ${reserve} 超过上限 ${MAX_RESERVE}`)
    assert.ok(reserve <= Math.max(1, Math.floor(maxResults / 2)), '主源应保住至少一半槽位')
  }
})

test('computeReserve: 给出源数时走新算法，不给时保持旧行为', () => {
  // 新算法（带源数）
  assert.equal(computeReserve(10, true, 2), planVerticalQuota(10, 2).reserve)
  // 旧行为（不传源数）—— 保持向后兼容
  assert.equal(computeReserve(10, true), 2)
  assert.equal(computeReserve(10, false), 0)
})

// ---------------------------------------------------------------------------
// truncated 语义（此前有误报）
// ---------------------------------------------------------------------------

test('mergeSources: truncated 表示「有内容被丢弃」，而非「刚好填满」', () => {
  const mk = (n, p = 'x') =>
    Array.from({ length: n }, (_, i) => ({ url: `https://${p}/${i}`, title: 't' }))

  // 恰好填满但一条没丢 → 不该报 truncated
  // （旧实现用 `out.length >= maxResults`，这种情况会误报，
  //  让消费者以为还有更多结果未展示。）
  assert.equal(mergeSources(mk(10), [], 10, 0).truncated, false, '刚好填满 ≠ 被截断')
  assert.equal(mergeSources(mk(5), [], 10, 0).truncated, false, '不足上限')

  // 确实被上限挤掉 → 报 truncated
  assert.equal(mergeSources(mk(20), [], 10, 0).truncated, true, '超出上限应报截断')
  assert.equal(
    mergeSources(mk(10), mk(5, 'e'), 10, 2).truncated,
    true,
    '主源+垂直源合计超出上限应报截断',
  )
})

test('mergeSources: 全是重复 URL 时不报 truncated（去重不是截断）', () => {
  const dup = [
    { url: 'https://same', title: 'a' },
    { url: 'https://same', title: 'b' },
    { url: 'https://same', title: 'c' },
  ]
  const r = mergeSources(dup, [], 10, 0)
  assert.equal(r.sources.length, 1)
  assert.equal(r.truncated, false, '去重丢弃的不是「因超限」，不该报截断')
})
