/**
 * dsh-web-search-zerokey 多源路由与合并的单元测试。
 *
 * 运行：node --test test/
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { isTechQuery, mergeSources, interleave } from '../index.js'

test('isTechQuery: 英文与代码类查询应启用增强源', () => {
  const yes = [
    'Error: ENOENT no such file',
    'react useEffect cleanup',
    'cordis plugin 开发',
    'deepseek harness',
    'npm install failed',
    'TypeError: x is not a function',
    'how to use vite',
    'python 3.12 asyncio',
    'HTTP 404 handler',
  ]
  for (const q of yes) {
    assert.equal(isTechQuery(q), true, `应判为技术类: ${q}`)
  }
})

test('isTechQuery: 中文自然语言查询不应启用英文增强源', () => {
  const no = [
    '今天天气怎么样',
    '怎么把图片压缩变小一点',
    '北京有哪些好玩的景点推荐一下',
    '如何提高工作效率',
    '晚饭吃什么好',
  ]
  for (const q of no) {
    assert.equal(isTechQuery(q), false, `应判为非技术类: ${q}`)
  }
})

test('isTechQuery: 中文技术查询保持只走 Bing（与已批准的设计一致）', () => {
  // 这一条**故意**断言 false：用户批准的路由策略是「中文/通用走 Bing，
  // 技术类并行叠加 HN+GitHub」。中文长句即使含技术词，也归入「中文查询」。
  // 理由：HN 是英文语料，中文查询在它上面召回近零；GitHub 对中文词召回质量也差，
  // 强行增强会挤占 Bing 的槽位却不带来有效信息。
  assert.equal(isTechQuery('docker compose 端口冲突'), false)
  assert.equal(isTechQuery('电脑蓝屏怎么解决'), false)
})

test('isTechQuery: 空查询与边界输入', () => {
  assert.equal(isTechQuery(''), false)
  assert.equal(isTechQuery(null), false)
  assert.equal(isTechQuery(undefined), false)
  assert.equal(isTechQuery('   '), false)
})

test('mergeSources: 为主源与垂直源分配槽位', () => {
  const primary = [
    { url: 'https://a', title: 'A' },
    { url: 'https://b', title: 'B' },
    { url: 'https://c', title: 'C' },
  ]
  const extras = [{ url: 'https://hn', title: 'HN' }]

  const { sources, truncated } = mergeSources(primary, extras, 3, 1)
  assert.equal(sources.length, 3)
  // 保留 1 个槽位给垂直源，主源只进 2 条。
  assert.deepEqual(
    sources.map((s) => s.title),
    ['A', 'B', 'HN'],
  )
  assert.equal(truncated, true)
})

test('mergeSources: 跨源按 URL 去重', () => {
  const primary = [{ url: 'https://dup', title: 'primary' }]
  const extras = [{ url: 'https://dup', title: 'extra' }]

  const { sources } = mergeSources(primary, extras, 10, 1)
  assert.equal(sources.length, 1)
  assert.equal(sources[0].title, 'primary', '主源版本优先保留')
})

test('mergeSources: 垂直源不足时用主源回填，不浪费槽位', () => {
  const primary = [
    { url: 'https://a', title: 'A' },
    { url: 'https://b', title: 'B' },
    { url: 'https://c', title: 'C' },
  ]

  const { sources } = mergeSources(primary, [], 3, 2)
  assert.equal(sources.length, 3)
  assert.deepEqual(
    sources.map((s) => s.title),
    ['A', 'B', 'C'],
  )
})

test('mergeSources: extras 为 undefined 时不崩（回归：曾因展开非数组而 TypeError）', () => {
  const primary = [{ url: 'https://a', title: 'A' }]
  const { sources } = mergeSources(primary, undefined, 5, 2)
  assert.equal(sources.length, 1)
})

test('interleave: 各源结果交替出现，不独占', () => {
  const hn = [{ url: 'h1' }, { url: 'h2' }, { url: 'h3' }]
  const gh = [{ url: 'g1' }, { url: 'g2' }]

  const out = interleave([hn, gh])
  assert.deepEqual(
    out.map((x) => x.url),
    ['h1', 'g1', 'h2', 'g2', 'h3'],
  )
})

test('interleave: 回归 — 排前的源不得挤掉后面的源', () => {
  // 实测踩到的 bug：flat() 后 [h1,h2,g1,g2]，reserve=2 时 GitHub 恒为 0。
  const hn = [{ url: 'h1' }, { url: 'h2' }]
  const gh = [{ url: 'g1' }, { url: 'g2' }]

  const merged = mergeSources([], interleave([hn, gh]), 2, 2)
  const urls = merged.sources.map((s) => s.url)
  assert.ok(urls.includes('g1'), `GitHub 结果应出现在预留槽位中，实际: ${urls}`)
  assert.deepEqual(urls, ['h1', 'g1'])
})

test('interleave: 容忍空数组与 undefined', () => {
  assert.deepEqual(interleave([]), [])
  assert.deepEqual(interleave([[], []]), [])
  assert.deepEqual(interleave([undefined, [{ url: 'a' }]]).map((x) => x.url), ['a'])
  assert.deepEqual(interleave(undefined), [])
})

test('mergeSources: 结果不超过上限', () => {
  const primary = Array.from({ length: 20 }, (_, i) => ({
    url: `https://p${i}`,
    title: `P${i}`,
  }))
  const extras = Array.from({ length: 20 }, (_, i) => ({
    url: `https://e${i}`,
    title: `E${i}`,
  }))

  const { sources } = mergeSources(primary, extras, 5, 3)
  assert.equal(sources.length, 5)
})
