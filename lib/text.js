/**
 * 文本清洗与截断工具。与具体搜索源无关。
 */

/** HTML 实体与标签清理，压平为单行文本。 */
export function stripTags(html) {
  return String(html ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&ensp;/g, ' ')
    .replace(/&#0183;/g, '·')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/\s+/g, ' ')
    .trim()
}

/** 截断但不切断代理对（避免产出半个 emoji 导致 JSON 异常）。 */
export function cap(value, maxChars) {
  const s = String(value ?? '')
  if (!Number.isFinite(maxChars) || s.length <= maxChars) return s
  const cut = s.slice(0, Math.max(0, maxChars))
  const last = cut.charCodeAt(cut.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut
}

/** Unix 秒 → ISO 日期（仅日期部分）。非法输入返回 undefined。 */
export function unixSecondsToDate(seconds) {
  const n = Number(seconds)
  if (!Number.isFinite(n) || n <= 0) return undefined
  const d = new Date(n * 1000)
  if (Number.isNaN(d.getTime())) return undefined
  return d.toISOString().slice(0, 10)
}

/**
 * 把日期（ISO 串或 Date）压成人类可读的相对/绝对短格式。
 * 用于把「3 天前」这类时效信号带进结果，帮助模型判断新鲜度。
 */
export function formatDateShort(input, now = Date.now()) {
  if (!input) return undefined
  const d = input instanceof Date ? input : new Date(input)
  if (Number.isNaN(d.getTime())) return undefined

  const diffMs = now - d.getTime()
  const day = 86_400_000
  if (diffMs >= 0 && diffMs < day) return '今天'
  if (diffMs >= day && diffMs < 2 * day) return '昨天'
  if (diffMs >= 2 * day && diffMs < 7 * day) return `${Math.floor(diffMs / day)} 天前`
  return d.toISOString().slice(0, 10)
}

/**
 * 解析 Bing 结果块里出现的日期标记。
 *
 * Bing 在摘要前会带「2026年8月27日」「3 天前」「2026-08-27」等形式。
 * 这些是**免费的时效信号**——页面已经给了，不用额外请求。
 */
export function parseBingDate(text, now = Date.now()) {
  const s = String(text ?? '')

  // 相对时间
  const rel = s.match(/(\d+)\s*(分钟|小时|天|周|个月|年)前/)
  if (rel) {
    const n = Number(rel[1])
    const unit = rel[2]
    const mult = {
      分钟: 60_000,
      小时: 3_600_000,
      天: 86_400_000,
      周: 7 * 86_400_000,
      个月: 30 * 86_400_000,
      年: 365 * 86_400_000,
    }[unit]
    if (mult) return new Date(now - n * mult).toISOString().slice(0, 10)
  }

  // 中文绝对日期
  const cn = s.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/)
  if (cn) {
    const [_, y, m, d] = cn
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  }

  // ISO 风格
  const iso = s.match(/(\d{4})-(\d{2})-(\d{2})/)
  if (iso) return iso[0]

  return undefined
}

/**
 * 把「请求条数」归一为合法的正整数。
 *
 * 为什么需要它（实测发现的边界缺陷）：
 *   各源此前直接用 `Math.min(Math.max(maxResults, 1), 10)`，
 *   但 **`Math.max(NaN, 1)` 仍是 NaN** —— 于是会向 GitHub/npm/HN
 *   发出 `per_page=NaN` 这类畸形请求。
 *   小数（如 1.7）也会被直接透传，同样不合法。
 *
 * 各源可被**独立调用**（不经过 provider 的归一逻辑），
 * 故这层保护必须放在源内部，不能假设调用方已处理好。
 *
 * @param {unknown} value
 * @param {number} [max] - 上限
 * @param {number} [fallback] - 非法输入时的默认值
 * @returns {number} 落在 [1, max] 内的整数
 */
export function normalizeLimit(value, max = 10, fallback = 5) {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n)) return Math.max(1, Math.min(max, Math.floor(fallback)))
  return Math.max(1, Math.min(max, n))
}
