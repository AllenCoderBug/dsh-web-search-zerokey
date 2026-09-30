/**
 * 正文片段增强（P4）：把搜索结果从「只有摘要」升级为「带正文节选」。
 *
 * 治的是什么（实测依据）：
 *   单条 snippet 上限 300 字符，而真实页面正文约 5181 字节 —— **信息密度差 17 倍**。
 *   这使得「搜索」只回答了「去哪找」，没回答「那里说了什么」，
 *   模型必须再调一次 web_fetch 才能拿到内容，多一跳。
 *
 * 为什么必须可开关且默认关闭：
 *   代价真实且非零 —— 每个结果多一次网络往返（3 条 ≈ +2~4s），
 *   且返回内容变长会抬高 token 成本。效果需要用实测数据决策，不能凭感觉默认开。
 *
 * ★ 安全红线（架构要求，不是建议）：
 *   抓取结果里的任意 URL **必须**走宿主提供的 fetcher（即 ctx.web.fetch()），
 *   不许裸 fetch()。原因：宿主 fetchProvider 已内建完整 SSRF 防护
 *   （公网 IP 校验、DNS 重绑定防护、同源重定向检查、拒绝 URL 内嵌凭据）。
 *   自己裸抓等于把这层防护全部绕过。
 *
 *   本模块通过依赖注入接收 fetcher，故它自身不含任何网络调用 ——
 *   既保证了红线，也让它可以被离线测试。
 */
import { stripTags, cap } from './text.js'

/** 只对可信度较高的结果取正文，避免为低价值结果浪费请求。 */
const DEFAULT_MAX_FETCH = 2

/**
 * 需要整块丢弃的元素（内容对「正文」无贡献，且往往是噪声或脚本）。
 * 逐个标签处理而非用一条带反向引用的正则 —— JS 里 `<\/\1>` 配合 `s` 标志
 * 会直接抛 SyntaxError（实测踩到），逐标签写法更可靠也更好读。
 */
const DROP_ELEMENTS = ['script', 'style', 'noscript', 'svg', 'nav', 'footer', 'header', 'form']

/**
 * 从 HTML 中提取可读正文（轻量剥离，非 readability）。
 *
 * 取舍：不引第三方 readability 依赖。理由：
 *   - 依赖会增加插件体积与供应链面，而 DSH 插件的 `files` 白名单需显式列出；
 *   - 我们只需要「够干净的片段」，不需要完整正文结构。
 * 已知不足：SPA 页面会得到壳页（正文为空）。此时**必须如实返回空**，
 * 让上层知道「抓到了但没内容」，而不是把壳页当正文塞进去。
 */
export function extractReadableText(html, maxChars = 1200) {
  if (!html) return ''
  let out = String(html)
  for (const tag of DROP_ELEMENTS) {
    out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'), ' ')
  }
  // 未闭合的同类标签（如被截断的页面）也要清掉开头部分
  out = out.replace(/<!--[\s\S]*?-->/g, ' ')
  const text = stripTags(out)
  return cap(text, maxChars)
}

/**
 * 判断抓取结果是否「形似壳页」——HTTP 200 但几乎没有正文。
 *
 * 为什么需要它：SPA 的 200 响应与「一个很短的页面」长得一模一样，
 * 若不做区分，会把空壳当正文，产生「看起来成功但内容为空」的静默失败。
 */
export function looksLikeShellPage(text, minChars = 80) {
  return String(text ?? '').trim().length < minChars
}

/**
 * 为若干结果补充正文片段。
 *
 * @param {Array} sources - 搜索结果（需含 url）
 * @param {object} opts
 * @param {(url: string, signal?: AbortSignal) => Promise<string>} opts.fetchText
 *        宿主提供的取文函数（必须内部走 ctx.web.fetch）
 * @param {number} [opts.maxFetch] - 最多为几条结果取正文
 * @param {number} [opts.maxChars] - 每条正文节选上限
 * @param {AbortSignal} [opts.signal]
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<Array>} 新数组（不修改入参）
 */
export async function enrichWithContent(sources, opts) {
  const {
    fetchText,
    maxFetch = DEFAULT_MAX_FETCH,
    maxChars = 1200,
    signal,
    log = () => {},
  } = opts

  if (typeof fetchText !== 'function' || !Array.isArray(sources) || sources.length === 0) {
    return sources ?? []
  }

  const targets = sources.slice(0, Math.max(0, maxFetch))
  const rest = sources.slice(targets.length)

  const enriched = await Promise.all(
    targets.map(async (item) => {
      if (!item?.url) return item
      try {
        const raw = await fetchText(item.url, signal)
        const text = extractReadableText(raw, maxChars)
        if (looksLikeShellPage(text)) {
          // 静默失败是最糟的：明确记一笔，但不改变结果（只是没有正文）。
          log(`正文抓取得到疑似壳页（${text.length} 字符），已跳过：${item.url}`)
          return item
        }
        // 保留原有 snippet（来自搜索页，通常更聚焦），另加正文节选。
        return { ...item, content: text }
      } catch (error) {
        log(`正文抓取失败，已保留摘要：${item.url} — ${error?.message ?? error}`)
        return item
      }
    }),
  )

  return [...enriched, ...rest]
}
