/**
 * 生效自检脚本 —— 重启 DSH 后运行，一键确认插件的真实状态。
 *
 * 为什么需要它：
 *   「改了代码」与「运行中真的在用新代码」是两件事。本机踩过：
 *   host 进程加载的是启动时刻的插件，改了源目录/安装副本都不生效，
 *   必须重启。而重启后「有没有真的生效」需要一个客观判据，不能靠感觉。
 *
 * 用法（安装后）：
 *   node "$DSH_HOME/profiles/desktop/node_modules/dsh-web-search-zerokey/scripts/verify.mjs"
 *
 * 用法（开发时，在仓库内）：
 *   node scripts/verify.mjs
 *
 * 退出码：0 = 全部通过；1 = 有项目失败。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execSync } from 'node:child_process'

const INSTALL_DIR = path.join(
  os.homedir(),
  '.dsh/profiles/desktop/node_modules/dsh-web-search-zerokey',
)
const PROFILE_PATCH = path.join(os.homedir(), '.dsh/profiles/desktop/cordis.patch.yml')
const STATE_FILE = path.join(
  process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'),
  'cache/dsh-web-search-zerokey/adapt.json',
)

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  const mark = ok ? '✅' : '❌'
  console.log(`  ${mark} ${name}${detail ? `  ${detail}` : ''}`)
}

console.log('\n══════ zerokey 生效自检 ══════\n')

// ── 1. 安装副本是否存在且完整 ────────────────────────────────────────────
console.log('【安装副本】')
const installed = fs.existsSync(path.join(INSTALL_DIR, 'lib/provider.js'))
check('lib/ 已同步到安装副本', installed, installed ? '' : `缺少 ${INSTALL_DIR}/lib/provider.js`)

if (installed) {
  const libFiles = (function walk(dir) {
    let out = []
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) out = out.concat(walk(p))
      else if (e.name.endsWith('.js')) out.push(p)
    }
    return out
  })(path.join(INSTALL_DIR, 'lib'))
  check('安装副本 lib 文件数与源目录一致', libFiles.length === 17, `${libFiles.length} 个`)
}

// ── 2. pin 护栏（防烧积分）────────────────────────────────────────────
console.log('\n【护栏（防烧积分）】')
try {
  const patch = fs.readFileSync(PROFILE_PATCH, 'utf8')
  const lines = patch.split('\n')
  let inWeb = false
  let pinned
  for (const line of lines) {
    const m = line.match(/^\s*-?\s*id:\s*(\S+)\s*$/)
    if (m) { inWeb = m[1] === 'web'; continue }
    if (!inWeb) continue
    const sp = line.match(/^\s*searchProvider:\s*(\S+)\s*$/)
    if (sp) { pinned = sp[1]; break }
  }
  check('searchProvider 已 pin', pinned !== undefined)
  check('pin 指向 zerokey（非 deepseek-official）', pinned === 'zerokey', `实际: ${pinned}`)
} catch (e) {
  check('读取 profile patch', false, e.message)
}

// ── 3. 进程重启时间 vs 插件 mtime（关键判据）──────────────────────────
console.log('\n【生效判据】')
try {
  const ps = execSync(
    'ps -eo pid,lstart,command | grep "DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness$" | grep -v grep',
    { encoding: 'utf8' },
  ).trim()
  const firstLine = ps.split('\n')[0] ?? ''
  // lstart 形如 "三 9月/30 10:50:10 2026"
  const m = firstLine.match(/\S+\s+(\d+)月\/(\d+)\s+(\d+):(\d+):(\d+)\s+(\d+)/)
  if (m) {
    const [, mon, day, hh, mm, ss, year] = m
    const procTime = new Date(`${year}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}T${hh}:${mm}:${ss}`)
    const pluginMtime = fs.statSync(path.join(INSTALL_DIR, 'index.js')).mtime
    const newer = procTime > pluginMtime
    check(
      '进程启动晚于插件同步（= 已加载新代码）',
      newer,
      `进程 ${procTime.toLocaleString()} vs 插件 ${pluginMtime.toLocaleString()}`,
    )
    if (!newer) {
      console.log('     ⚠️  需要重启 DSH Desktop 才能加载新代码')
    }
  } else {
    check('解析 host 进程启动时间', false, '未能解析 ps 输出')
  }
} catch {
  check('查找 DSH host 进程', false, '未找到运行中的 host 进程')
}

// ── 3.5 加载契约（Cordis 插件要求）────────────────────────────────────
// 为什么要单独查：重启失败最常见的原因不是逻辑错误，而是**导出形状不符**
// （Cordis 要求 name / inject / apply 三件套）。这类问题在 import 层面看不出，
// 只有按契约逐项核对才会暴露。
console.log('\n【加载契约（Cordis）】')
try {
  const pkgPath = path.join(os.homedir(), '.dsh/profiles/desktop/package.json')
  const profilePkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  const bundles = profilePkg?.dsh?.profile?.bundles ?? []
  check('插件已登记进 profile bundles', bundles.includes('dsh-web-search-zerokey'))

  const mod = await import(path.join(INSTALL_DIR, 'index.js'))
  check('name 是字符串', typeof mod.name === 'string', String(mod.name))
  check('inject 声明了 web 依赖', Array.isArray(mod.inject) && mod.inject.includes('web'))
  check('apply 是函数', typeof mod.apply === 'function')

  // 实际跑一次 apply，确认注册契约成立
  const reg = []
  const eff = []
  mod.apply(
    {
      effect: (fn) => {
        eff.push(fn)
        return () => {}
      },
      web: {
        registerSearchProvider: (p) => {
          reg.push(p)
          return () => {}
        },
      },
    },
    {},
  )
  check('apply 注册了 search provider', reg.length === 1)
  check('provider.id 为 zerokey', reg[0]?.id === 'zerokey', String(reg[0]?.id))
  check('apply 注册了 CA effect', eff.length === 1)
} catch (e) {
  check('加载契约检查', false, e.message)
}

// ── 4. 功能冒烟 ────────────────────────────────────────────────────────
console.log('\n【功能冒烟】')
try {
  const mod = await import(path.join(INSTALL_DIR, 'index.js'))
  mod.installCaTrust?.()
  const provider = new mod.ZeroKeySearchProvider(() => ({}), { log: () => {} })
  check('provider.id 正确', provider.id === 'zerokey', provider.id)
  check('available() 恒真', provider.available() === true)

  const empty = await provider.search({ query: '' }, undefined)
  check('空查询契约', empty.sources.length === 0 && empty.truncated === false)

  const t0 = Date.now()
  const r = await provider.search({ query: 'mcp server typescript', maxResults: 10 }, undefined)
  const ms = Date.now() - t0
  check('真实搜索返回结果', r.sources.length > 0, `${r.sources.length} 条 / ${ms}ms`)
  check('结果含时效字段（P1 字段补全）', r.sources.some((s) => s.date), `${r.sources.filter((s) => s.date).length} 条带日期`)

  const sources = Object.keys(provider.adapt.summarizeAll())
  check('自适应已记录源统计', sources.length > 0, sources.join(', '))
} catch (e) {
  check('加载并调用插件', false, e.message)
}

// ── 5. 自适应持久化 ────────────────────────────────────────────────────
console.log('\n【自适应持久化】')
check(
  '状态文件路径',
  true,
  STATE_FILE,
)
if (fs.existsSync(STATE_FILE)) {
  try {
    const d = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
    check('状态文件可解析', true, `${Object.keys(d.sources ?? {}).length} 个源`)
  } catch (e) {
    check('状态文件可解析', false, e.message)
  }
} else {
  console.log('     (尚未生成，首次真实搜索后会出现)')
}

// ── 汇总 ───────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok)
// 「待重启」是预期中间态，不是故障 —— 单独区分，避免误判为插件有问题。
const pendingRestart = failed.filter((r) => /进程启动晚于插件同步/.test(r.name))
const realFailures = failed.filter((r) => !pendingRestart.includes(r))

console.log(`\n══════ ${results.length - failed.length}/${results.length} 通过 ══════`)

if (pendingRestart.length > 0) {
  console.log('\n⏳ 待重启：')
  for (const p of pendingRestart) console.log(`  · ${p.name}  ${p.detail}`)
  console.log('\n  代码已就位，重启 DSH Desktop 即可生效：')
  console.log('  退出 DSH（Cmd+Q，注意关窗口 ≠ 退出进程）后重新打开。')
}

if (realFailures.length > 0) {
  console.log('\n❌ 未通过项：')
  for (const f of realFailures) console.log(`  · ${f.name}${f.detail ? `  ${f.detail}` : ''}`)
  console.log('')
  process.exit(1)
}

if (pendingRestart.length === 0) {
  console.log('\n插件已生效 ✅\n')
} else {
  console.log('\n除待重启外全部通过 ✅\n')
}
