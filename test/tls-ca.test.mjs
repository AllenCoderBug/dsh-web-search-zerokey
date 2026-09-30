/**
 * TLS CA 注入的测试（此前函数覆盖仅 40%）。
 *
 * 为什么这个模块最该被测：
 *   它**patch 全局 `tls.createSecureContext`** —— 本机搜索能用的唯一原因，
 *   同时也是全插件**唯一会改动宿主进程全局行为的代码**。
 *   出错后果不是「搜索失败」，而是**破坏整个进程的 TLS 行为**
 *   （例如吞掉调用方显式传入的 ca、或让 patch 无法撤销而残留）。
 *
 * 测试策略：不真的去联网，而是：
 *   1. 用临时 CA 文件驱动 installCaTrust
 *   2. 检查 patch 后的 `tls.createSecureContext` 行为（ca 合并语义）
 *   3. 检查幂等性与可逆性（HMR/卸载的关键）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import tls from 'node:tls'

import { installCaTrust, DEFAULT_CA_PATH } from '../lib/tls-ca.js'

/** 造一个临时 CA 文件；返回 { dir, caPath, cleanup }。 */
function makeTempCa(content = '-----BEGIN CERTIFICATE-----\nFAKE\n-----END CERTIFICATE-----\n') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-probe-ca-'))
  const caPath = path.join(dir, 'ca.pem')
  fs.writeFileSync(caPath, content)
  return { dir, caPath, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

/** 每个用例后确保 tls.createSecureContext 被还原（防止污染其他测试）。 */
function withCleanup(t, dispose) {
  t.after(() => {
    try {
      dispose?.()
    } catch {
      /* 忽略 */
    }
  })
}

test('tls-ca: 证书缺失时静默返回 no-op（不抛错、不 patch）', () => {
  const before = tls.createSecureContext
  const restore = installCaTrust('/nonexistent/path/ca.pem')
  try {
    assert.equal(typeof restore, 'function', '应返回还原函数')
    assert.equal(tls.createSecureContext, before, '证书缺失时不该改动全局 tls')
    restore() // 不应抛错
  } finally {
    restore()
  }
})

test('tls-ca: 有证书时 patch 全局 createSecureContext', (t) => {
  const { caPath, cleanup } = makeTempCa()
  const before = tls.createSecureContext
  const restore = installCaTrust(caPath)
  withCleanup(t, restore)

  try {
    assert.notEqual(tls.createSecureContext, before, '应完成 patch')
    assert.equal(typeof tls.createSecureContext.original, 'function', '应保留原函数引用')
  } finally {
    restore()
    cleanup()
  }
})

test('tls-ca: 还原后精确回到原函数（HMR/卸载不残留）', (t) => {
  const { caPath, cleanup } = makeTempCa()
  const before = tls.createSecureContext
  const restore = installCaTrust(caPath)
  withCleanup(t, restore)

  restore()
  assert.equal(tls.createSecureContext, before, '还原必须精确回到原函数')
  cleanup()
})

test('tls-ca: 幂等 —— 重复调用只 patch 一次', (t) => {
  const { caPath, cleanup } = makeTempCa()
  const first = installCaTrust(caPath)
  withCleanup(t, first)
  const patchedOnce = tls.createSecureContext

  // 第二次调用应返回 no-op（检测到已注入）
  const second = installCaTrust(caPath)
  assert.equal(tls.createSecureContext, patchedOnce, '重复调用不该再包一层')

  // ★ 关键：第二次返回的还原函数是 no-op，调用它**不该**还原掉第一次的 patch。
  // 否则 fiber A 销毁会误删 fiber B 仍在用的 patch。
  second()
  assert.equal(tls.createSecureContext, patchedOnce, 'no-op 还原不该影响已有的 patch')

  first()
  cleanup()
})

/**
 * 统一 helper：把全局 createSecureContext 换成假函数后再调用 installCaTrust，
 * 这样 patch 内部调用的 `original` 就是我们的假函数，不会触到真实 OpenSSL。
 *
 * 为什么不能用「patch 后替换 .original」那种做法：
 *   实测会真的走到 OpenSSL（报 `no cipher match`），污染测试且结果不可信。
 */
function installWithFakeTls(caPath) {
  const real = tls.createSecureContext
  let captured
  const fake = function (options) {
    captured = options
    return {}
  }
  tls.createSecureContext = fake
  const restore = installCaTrust(caPath)
  return {
    restore,
    getCaptured: () => captured,
    cleanup: () => {
      restore()
      tls.createSecureContext = real
    },
  }
}

test('tls-ca: patch 后调用方显式传入的 ca 被保留（只增补、不替换）', (t) => {
  const customCa = '-----BEGIN CERTIFICATE-----\nCUSTOM\n-----END CERTIFICATE-----\n'
  const { caPath, cleanup: cleanupCa } = makeTempCa()
  const { cleanup, getCaptured } = installWithFakeTls(caPath)
  t.after(() => {
    cleanup()
    cleanupCa()
  })

  tls.createSecureContext({ ca: customCa })
  const captured = getCaptured()
  assert.ok(captured, '应把参数透传给原函数')
  assert.ok(Array.isArray(captured.ca), 'ca 应为数组（合并形式）')
  assert.ok(captured.ca.includes(customCa), '调用方的 ca 必须被保留')
  assert.ok(captured.ca.some((c) => c.includes('FAKE')), '注入的 CA 也应存在')
})

test('tls-ca: 调用方未传 ca 时注入自己的', (t) => {
  const { caPath, cleanup: cleanupCa } = makeTempCa()
  const { cleanup, getCaptured } = installWithFakeTls(caPath)
  t.after(() => {
    cleanup()
    cleanupCa()
  })

  tls.createSecureContext({})
  const captured = getCaptured()
  assert.ok(typeof captured.ca === 'string' && captured.ca.includes('FAKE'))
})

test('tls-ca: 其它选项被原样透传（不吞参数）', (t) => {
  const { caPath, cleanup: cleanupCa } = makeTempCa()
  const { cleanup, getCaptured } = installWithFakeTls(caPath)
  t.after(() => {
    cleanup()
    cleanupCa()
  })

  tls.createSecureContext({ minVersion: 'TLSv1.3', ciphers: 'X' })
  const captured = getCaptured()
  assert.equal(captured.minVersion, 'TLSv1.3', '不应吞掉调用方的选项')
  assert.equal(captured.ciphers, 'X')
})

test('tls-ca: 还原时若全局已被他人替换，则不动它（不踩别人的改动）', (t) => {
  const { caPath, cleanup } = makeTempCa()
  const restore = installCaTrust(caPath)

  // 模拟另一个库在我们之后又 patch 了同一函数
  const ourPatch = tls.createSecureContext
  const otherPatch = function () {
    return {}
  }
  tls.createSecureContext = otherPatch

  try {
    restore()
    assert.equal(
      tls.createSecureContext,
      otherPatch,
      '还原时必须先确认当前仍是自己的 patch，否则不该动',
    )
  } finally {
    tls.createSecureContext = ourPatch
    restore()
    cleanup()
  }
})

test('tls-ca: DEFAULT_CA_PATH 指向 ~/.dsh/certs', () => {
  assert.match(DEFAULT_CA_PATH, /\.dsh\/certs\/system-ca\.pem$/)
})

test('tls-ca: 真实本机 CA 存在时可正常 patch（集成）', (t) => {
  if (!fs.existsSync(DEFAULT_CA_PATH)) {
    t.skip('本机 CA 不存在')
    return
  }
  const before = tls.createSecureContext
  const restore = installCaTrust()
  withCleanup(t, restore)
  try {
    assert.notEqual(tls.createSecureContext, before, '本机 CA 应能驱动 patch')
  } finally {
    restore()
  }
  assert.equal(tls.createSecureContext, before)
})
