/**
 * dsh-web-search-zerokey — 零 key web 搜索 provider。
 *
 * 本文件是**薄入口**：只做导出与插件注册，不含任何搜索逻辑。
 * 逻辑按「变化理由」分居：
 *
 *   lib/tls-ca.js          CA 注入（与搜索无关，几乎不变）
 *   lib/request-policy.js  缓存/限速/重试（随「上游多敏感」调整）
 *   lib/route.js           查询路由（会调整）
 *   lib/merge.js           结果合并（稳定）
 *   lib/sources/*          各源适配器（**随上游改版/新增而变**）
 *   lib/parse/*            页面解析（随页面结构改版而变）
 *   lib/provider.js        编排（稳定）
 *
 * 为什么需要它：
 *   本机 web_search 坏掉的共因是 Node CA 信任链，而非「缺 key」。
 *   本 provider 不依赖任何商业 API，available() 恒真。
 *
 * ★ 不可移除的护栏：绝不能把后端换成 `deepseek-official`。
 *   官方 `@deepseek-ai/dsh-web-search-deepseek` 的计费方式是
 *   「one search costs a full model turn in latency and tokens」——
 *   每次搜索 = 一次完整模型 turn，直接消耗 token/积分（官方 README 原文）。
 *   而它的 available() 恒报可用（apply() 总提供 resolveApiKey），
 *   故 seed 一旦丢失可能**静默 fallback 到烧积分的后端**。
 *   这正是 test/pin-guard.test.mjs 要锁死的东西。
 *
 * @module dsh-web-search-zerokey
 */

import { installCaTrust, DEFAULT_CA_PATH } from './lib/tls-ca.js'
import { ZeroKeySearchProvider } from './lib/provider.js'

export const name = 'web-search-zerokey'
export const inject = ['web']

/** 稳定 id，`web.searchProvider` 用它选中本 provider。 */
export const ZEROKEY_PROVIDER_ID = 'zerokey'

// ---------------------------------------------------------------------------
// 向后兼容的再导出
//
// 这些符号此前从 index.js 直接导出，已有测试与调用方依赖它们。
// 保持导出不变，使本次拆分是**纯重构**（行为零变化）。
// ---------------------------------------------------------------------------
export { installCaTrust, DEFAULT_CA_PATH }
export { ZeroKeySearchProvider }
export { stripTags, cap, parseBingDate, formatDateShort, unixSecondsToDate } from './lib/text.js'
export { parseBingHtml } from './lib/parse/bing.js'
export { classifyQuery, isTechQuery, routeSources } from './lib/route.js'
export { interleave, mergeSources, computeReserve } from './lib/merge.js'
export {
  TtlCache,
  MinIntervalLimiter,
  withRetry,
  isRetryableStatus,
  sleep,
} from './lib/request-policy.js'
export {
  SOURCES,
  PRIMARY_SOURCE_ID,
  ENHANCEMENT_SOURCE_IDS,
  getSource,
  SourceQuota,
} from './lib/sources/registry.js'
export {
  enrichWithContent,
  extractReadableText,
  looksLikeShellPage,
} from './lib/enrich.js'
export { AdaptationStore, defaultStatePath } from './lib/adapt.js'

/**
 * 把宿主的 `ctx.web.fetch()` 适配成本插件需要的「取文本」函数。
 *
 * 为什么必须走宿主 fetch 而不是自己 fetch（架构红线）：
 *   宿主的 fetchProvider（dsh-web-fetch-http）已内建完整防护：
 *     - 公网 IP 校验（私网/环回/链路本地一律拒绝）
 *     - DNS 重绑定防护（解析一次、校验整个地址集）
 *     - 同源重定向检查（跨源抛 WEB_REDIRECT_BLOCKED）
 *     - 拒绝 URL 内嵌凭据
 *   自己裸 fetch 会把这层防护全部绕过 —— 对「抓取搜索结果里的任意 URL」
 *   这种场景，等于把 SSRF 风险直接引进来。
 *
 * 返回结构（读自宿主源码，非猜测）：
 *   { url, statusCode, body: { kind: 'html'|'text', content: string }, truncated }
 *
 * @param {{fetch: Function}} web - ctx.web
 * @returns {(url: string, signal?: AbortSignal) => Promise<string>}
 */
export function adaptHostFetcher(web) {
  return async (url, signal) => {
    const result = await web.fetch({ url }, signal)
    const body = result?.body
    if (body && typeof body === 'object' && typeof body.content === 'string') {
      return body.content
    }
    // 兼容：若某版本直接返回字符串
    if (typeof body === 'string') return body
    if (typeof result === 'string') return result
    return ''
  }
}

/**
 * 插件入口。
 *
 * CA 注入属于本插件的副作用，必须随 fiber 一起撤销（HMR / 卸载时不残留 patch）。
 * ctx.effect 的 disposer 会在插件销毁时调用还原函数。
 */
export function apply(ctx, config) {
  // 惰性取 ctx.web.fetch：其它插件可能在更晚的时机注册 fetchProvider，
  // 故不在 apply 时定死引用，而是在真正要用时再解析。
  const fetchText = (url, signal) => adaptHostFetcher(ctx.web)(url, signal)

  const provider = new ZeroKeySearchProvider(() => config ?? {}, { fetchText })
  ctx.effect(() => installCaTrust(config?.caPath ?? DEFAULT_CA_PATH))
  ctx.web.registerSearchProvider(provider)
}
