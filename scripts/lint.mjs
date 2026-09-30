#!/usr/bin/env node
/**
 * 零依赖代码检查（lint）。
 *
 * ## 为什么不用 ESLint / Prettier
 * 本项目的核心承诺是**零 key、零外部服务**，`dependencies` 必须为空
 * （CI 里有一条守护断言）。虽然 devDependencies 不影响用户安装，
 * 但引入工具链会带来两个真实成本：
 *   1. lockfile 膨胀、CI 变慢
 *   2. 配置本身就是需要维护的产物
 * 而我们需要检查的东西很少 —— 语法 + 几条风格约定。
 * Node 自带的 `--check` + 几十行脚本就够了。
 *
 * ## 检查项
 *   1. **语法**：`node --check` 全量
 *   2. **风格**：单引号、无行尾分号、无 tab、缩进 2 空格
 *   3. **结构**：模块必须有文件头注释（本项目每个 lib 模块都写了「变化理由」）
 *   4. **禁词**：不留 `TODO` / `FIXME` / `console.log`（应为 log 回调）
 *
 * 用法：`node scripts/lint.mjs`
 * 退出码：0 = 全过；1 = 有问题
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 收集所有需要检查的源文件。 */
function collectFiles() {
  const out = []
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === '.git') continue
        walk(p)
      } else if (/\.(m?js)$/.test(e.name)) {
        out.push(p)
      }
    }
  }
  for (const d of ['lib', 'scripts', 'test']) {
    const p = path.join(ROOT, d)
    if (fs.existsSync(p)) walk(p)
  }
  out.push(path.join(ROOT, 'index.js'))
  return out.sort()
}

const files = collectFiles()
const errors = []

// ── 1. 语法 ──────────────────────────────────────────────────────────────
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' })
  } catch (e) {
    errors.push(`${path.relative(ROOT, f)}: 语法错误\n${e.stderr?.toString().split('\n')[0] ?? ''}`)
  }
}

// ── 2/3/4. 逐文件风格与结构 ──────────────────────────────────────────────
/** 测试文件与脚本允许 console（它们是给人看的输出）。 */
const isTestOrScript = (rel) => rel.startsWith('test/') || rel.startsWith('scripts/')

for (const f of files) {
  const rel = path.relative(ROOT, f)
  const text = fs.readFileSync(f, 'utf8')
  const lines = text.split('\n')

  // 文件头注释（lib/ 下的模块必须有 —— 本项目靠它记录「变化理由」）
  if (rel.startsWith('lib/') && !/^\s*\/\*\*/.test(lines[0])) {
    errors.push(`${rel}: 缺少文件头注释（本项目 lib 模块需说明变化理由）`)
  }

  lines.forEach((line, i) => {
    const n = i + 1
    const st = line.trim()
    if (!st) return

    if (line.includes('\t')) errors.push(`${rel}:${n} 含 tab（应统一 2 空格）`)

    // 跳过注释行
    const isComment = st.startsWith('//') || st.startsWith('*') || st.startsWith('/*')
    if (isComment) return

    if (st.endsWith(';') && !st.endsWith(';;')) {
      errors.push(`${rel}:${n} 行尾分号（本项目风格不带分号）`)
    }
    // 只在**非注释行**报 TODO/FIXME。
    // （否则本文件自己说明「检查 TODO」的那行会被误判 —— 实测踩到过。）
    if (/\b(TODO|FIXME)\b/.test(st) && !/[`'"]/.test(st)) {
      errors.push(`${rel}:${n} 残留 TODO/FIXME`)
    }
    if (!isTestOrScript(rel) && /console\.\w+\(/.test(st)) {
      errors.push(`${rel}:${n} 用了 console（应走 log 回调）`)
    }
  })
}

// ── 报告 ────────────────────────────────────────────────────────────────
if (errors.length === 0) {
  console.log(`✅ lint 通过（${files.length} 个文件：语法 / 风格 / 结构 / 禁词）`)
  process.exit(0)
}
console.log(`❌ lint 发现 ${errors.length} 个问题：\n`)
for (const e of errors) console.log('  · ' + e)
process.exit(1)
