/**
 * P0 防回归：searchProvider 必须 pin 在 zerokey。
 *
 * 为什么这是硬约束（不是洁癖）：
 *   官方 `@deepseek-ai/dsh-web-search-deepseek`（id `deepseek-official`）默认在
 *   base bundle 中注册，且其 available() **恒报可用**——因为它的 apply() 总会提供
 *   resolveApiKey，即使没配任何 key。
 *
 *   而它的计费方式（官方 README 原文）：
 *     "one search costs a full model turn in latency and tokens"
 *   即**每次搜索 = 一次完整模型 turn**，直接消耗 token/积分。
 *
 *   pin 一旦丢失或写错，两种后果都不可接受：
 *     ① 恰好只有一个可用 provider → 静默 fallback 到烧积分的官方搜索
 *     ② 多个可用 → WEB_PROVIDER_AMBIGUOUS，搜索直接失败
 *
 * ⇒ 用测试把这条口径锁死：改动者会在 CI/本地测试阶段立刻发现，而不是等到积分被扣。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PROFILE_PATCH = path.join(
  os.homedir(),
  '.dsh/profiles/desktop/cordis.patch.yml',
)

/** 从 cordis.patch.yml 中取出 `id: web` 段的 searchProvider。 */
function readPinnedSearchProvider(source) {
  const lines = String(source).split('\n')
  let inWebEntry = false
  for (const line of lines) {
    // 顶层条目以 "- id: xxx" 开始
    const entryMatch = line.match(/^\s*-?\s*id:\s*(\S+)\s*$/)
    if (entryMatch) {
      inWebEntry = entryMatch[1] === 'web'
      continue
    }
    if (!inWebEntry) continue
    const sp = line.match(/^\s*searchProvider:\s*(\S+)\s*$/)
    if (sp) return sp[1]
  }
  return undefined
}

const exists = fs.existsSync(PROFILE_PATCH)

test('P0: cordis.patch.yml 的 web 条必须 pin searchProvider（禁止裸奔）', { skip: !exists }, () => {
  const src = fs.readFileSync(PROFILE_PATCH, 'utf8')
  const pinned = readPinnedSearchProvider(src)

  assert.ok(
    pinned !== undefined,
    'web 条目缺少 searchProvider！\n' +
      '后果：可能静默 fallback 到 deepseek-official（每次搜索烧一次模型 turn）。\n' +
      '修复：在 cordis.patch.yml 的 `- id: web` 下写 searchProvider: zerokey',
  )
})

test('P0: searchProvider 必须是 zerokey，绝不可为 deepseek-official', { skip: !exists }, () => {
  const src = fs.readFileSync(PROFILE_PATCH, 'utf8')
  const pinned = readPinnedSearchProvider(src)

  assert.notEqual(
    pinned,
    'deepseek-official',
    '★ 严重：searchProvider 被指到 deepseek-official —— 每次搜索都会消耗一次完整模型 turn（烧积分）。\n' +
      '这是明确被否决的方案，见 handoff/dsh-web-search-zerokey/UPGRADE-PLAN.md §3。',
  )

  assert.equal(
    pinned,
    'zerokey',
    `searchProvider 期望为 zerokey，实际为 "${pinned}"。\n` +
      '若非有意更换后端，请勿改动此行——它同时是「不烧积分」的护栏。',
  )
})

test('P0: 解析器自检（防止测试本身写错而假绿）', () => {
  const sample = [
    '- insert:',
    '    - id: mcp-clio',
    '      name: x',
    '',
    '- id: web',
    '  config:',
    '    searchProvider: zerokey',
    '    fetchProvider: http',
    '',
    '- id: ui-chat',
    '  config:',
    '    searchProvider: should-not-match',
  ].join('\n')

  assert.equal(readPinnedSearchProvider(sample), 'zerokey')
  assert.equal(readPinnedSearchProvider('no web entry here'), undefined)
  // 必须只认 web 条目，不能把别的条目的同名键读进来
  assert.equal(
    readPinnedSearchProvider('- id: web\n  config:\n    fetchProvider: http'),
    undefined,
  )
})
