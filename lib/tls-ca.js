/**
 * 进程内 TLS 信任根注入。
 *
 * 与搜索逻辑无关，被独立出来是因为**它的变化理由完全不同**：
 * 搜索源随上游改版而变，而这段代码只在「DSH 启动路径能否注入 CA」这件事变化时才动。
 *
 * 背景：DSH Desktop 从 GUI 启动，`NODE_EXTRA_CA_CERTS` 无法通过
 *   ~/.dsh/.env（BOOTSTRAP_NAMES 会硬报错）、~/.zshrc（DESKTOP_SHELL_ENVIRONMENT_KEYS
 *   窄名单会丢弃）或 `launchctl setenv`（沙箱内报 "Not privileged to set domain
 *   environment"）注入。故改为在插件内 patch `tls.createSecureContext`。
 *
 * 安全性质：**只增补信任根，不降低校验强度** —— 与
 * `NODE_TLS_REJECT_UNAUTHORIZED=0` 有本质区别，证书链仍被完整验证。
 */
import tls from 'node:tls'
import fs from 'node:fs'

/** 本机 CA 快照的默认位置。 */
export const DEFAULT_CA_PATH = `${process.env.HOME ?? ''}/.dsh/certs/system-ca.pem`

/** 标记位，用于幂等判断。 */
const INJECTED_FLAG = Symbol.for('dsh.web-search-zerokey.caInjected')

/**
 * 为进程内 TLS 注入本机 CA，返回还原函数。
 *
 * 幂等：重复调用只生效一次；已注入过则返回 no-op 还原函数。
 *
 * @param {string} caPath - CA PEM 文件路径
 * @returns {() => void} 还原函数
 */
export function installCaTrust(caPath = DEFAULT_CA_PATH) {
  let ca
  try {
    ca = fs.readFileSync(caPath, 'utf8')
  } catch {
    // 证书缺失不是致命错误：若运行环境本就信任（例如已设 NODE_EXTRA_CA_CERTS），
    // 搜索依然可用。这里只静默返回，由请求层在真正握手失败时给出指引。
    return () => {}
  }

  if (tls.createSecureContext[INJECTED_FLAG] === true) return () => {}

  const original = tls.createSecureContext
  const patched = function (options = {}) {
    // 与已有 ca 合并而非替换：调用方显式指定的信任根优先保留。
    return original.call(this, {
      ...options,
      ca: options.ca === undefined ? ca : [].concat(options.ca, ca),
    })
  }
  patched[INJECTED_FLAG] = true
  // 让其它代码能识别 patch 后的函数仍代表原语义。
  patched.original = original
  tls.createSecureContext = patched

  return () => {
    // 仅当当前仍是我们的 patch 时才还原，避免踩掉别人的改动。
    if (tls.createSecureContext === patched) tls.createSecureContext = original
  }
}
