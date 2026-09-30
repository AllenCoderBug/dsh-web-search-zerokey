/**
 * 查询路由：判定一次查询应该启用哪些垂直源。
 *
 * 设计取舍：**宁可漏判，不可误判**。
 * 误判（把中文通用查询当技术查询）会把无关源的结果混进结果里，
 * 让用户看到一堆无关标题 —— 那比「少几个增强源」糟得多。
 * 所以判定必须保守：拿不准就不增强。
 *
 * 第二条取舍：**限制启用的源数量**。
 * 每启用一个源 = 真实发出一次请求 = 暴露面上升 + 上游压力上升。
 * 而预留槽位最多 3 个，启用 5 个源只会让每个源都发请求却挤不进结果 ——
 * 纯粹的浪费。故按优先级取前 N 个（默认 2）。
 */

/**
 * 各类查询的信号词。
 *
 * `mode` 决定多条模式如何组合，这个区别很关键：
 *   - `any`：命中任一即成立（用于 code/academic/package —— 出现一个技术标记就够了）
 *   - `all`：**必须全部命中**（用于 chineseTech —— 需要「中文」**且**「技术词」同时成立）
 *
 * 为什么 chineseTech 必须是 `all`：
 *   实测踩到 —— 只用「含中文」判定时，「今天天气怎么样」也会启用掘金/CSDN，
 *   把无关的中文技术文章混进生活类查询结果里。
 *   而 `some()`（OR）恰好实现不出「且」的语义，故显式区分。
 */
const SIGNALS = {
  code: {
    mode: 'any',
    patterns: [
      /[a-z][A-Z]/, // camelCase / PascalCase
      /[a-z]+_[a-z]+/i, // snake_case
      /\b\w+\.(js|ts|tsx|jsx|py|go|rs|java|rb|c|cpp|h|json|ya?ml|toml|md)\b/i,
      /\b[a-z]+\.[a-z]+\.[a-z]+\b/i, // 命名空间 a.b.c
      /\w+\(\)/, // 函数调用
      /\b(api|sdk|cli|pnpm|yarn|pip|docker|k8s|kubernetes|git|regex|sql|http|json|yaml|html|css|react|vue|node|python|rust|golang|typescript|javascript|error|exception|stack ?trace|compile|build|deploy|plugin|framework|library|package|module|function|class|interface|async|await|promise|webpack|vite|eslint|jest|pytest|mcp|cordis|harness)\b/i,
      /\bv?\d+\.\d+(\.\d+)?\b/, // 版本号
      /\b[45]\d{2}\b/, // HTTP 错误码
    ],
  },
  academic: {
    mode: 'any',
    patterns: [
      /\b(paper|论文|arxiv|preprint|journal|citation|survey|state of the art|sota|benchmark|dataset|algorithm|theorem|proof|llm|transformer|neural|gradient|embedding|fine-?tun(e|ing)|rlhf|tokeniz)\b/i,
    ],
  },
  package: {
    mode: 'any',
    patterns: [
      /\b(npm|pnpm|yarn|pip|pypi|crate|cargo|gem|dependency|dependencies|install|import)\b/i,
      // 裸包名形态：全小写连字符/点分隔，且整串就是查询（如 fastapi、react-dom）
      /^[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)+$/,
    ],
  },
  chineseTech: {
    mode: 'all',
    patterns: [
      /[\u4e00-\u9fff]/, // ① 含中文
      // ② 且含技术词
      /(掘金|csdn|博客园|源码|代码|编程|教程|实战|踩坑|报错|异常|笔记|面试|原理|实现|编译|部署|框架|插件|接口|数据库|算法|模型|训练|推理|参数|配置|性能|优化|架构|组件|函数|变量|类型|版本|安装|依赖)/i,
    ],
  },
}

/** 含 ≥N 个中日韩字符时视为「中文长句」——偏向自然语言提问。 */
const CJK_LONG_SENTENCE_THRESHOLD = 4

/** 默认最多启用几个垂直源（见文件头第二条取舍）。 */
const DEFAULT_MAX_SOURCES = 2

/** 统计中日韩字符数。 */
function countCjk(text) {
  return (String(text ?? '').match(/[\u4e00-\u9fff\u3040-\u30ff]/g) ?? []).length
}

/**
 * 判定查询命中的标签集合。
 *
 * @param {string} query
 * @returns {{tags: Set<string>, isLongChinese: boolean}}
 */
export function classifyQuery(query) {
  const q = String(query ?? '').trim()
  const tags = new Set()
  if (q.length === 0) return { tags, isLongChinese: false }

  const isLongChinese = countCjk(q) >= CJK_LONG_SENTENCE_THRESHOLD

  for (const [tag, spec] of Object.entries(SIGNALS)) {
    // mode 决定多条模式的组合语义（见 SIGNALS 注释）
    const hit =
      spec.mode === 'all'
        ? spec.patterns.every((re) => re.test(q))
        : spec.patterns.some((re) => re.test(q))
    if (hit) tags.add(tag)
  }

  // 中文长句偏向人话提问：撤掉需要英文语料的标签，避免污染。
  // 保留 chineseTech（掘金/CSDN 本身就是中文源，正中目标）。
  if (isLongChinese) {
    tags.delete('code')
    tags.delete('academic')
    tags.delete('package')
  }

  return { tags, isLongChinese }
}

/**
 * 兼容旧 API：是否值得启用（英文）技术类增强源。
 *
 * 语义等价于「命中 code / academic / package 之一」。
 */
export function isTechQuery(query) {
  const { tags, isLongChinese } = classifyQuery(query)
  if (isLongChinese) return false
  return tags.has('code') || tags.has('academic') || tags.has('package')
}

/**
 * 决定启用哪些垂直源。
 *
 * 优先级按「该标签下最直接的源」排：越靠前越先用。
 *
 * @param {string} query
 * @param {{available?: string[], maxSources?: number}} [opts]
 * @returns {string[]} 源 id 列表
 */
export function routeSources(query, opts = {}) {
  const { tags } = classifyQuery(query)
  const available = opts.available ? new Set(opts.available) : undefined
  const maxSources = opts.maxSources ?? DEFAULT_MAX_SOURCES

  const picked = []
  const add = (sid) => {
    if (picked.includes(sid)) return
    if (available && !available.has(sid)) return
    picked.push(sid)
  }

  // 按标签优先级依次补充，直到达到上限。
  // package 先于 code：查包名时包元数据比社区讨论更直接。
  if (tags.has('package')) {
    add('npm')
    add('github')
  }
  if (tags.has('academic')) {
    add('arxiv')
    add('hackernews')
  }
  if (tags.has('code')) {
    add('hackernews')
    add('github')
  }
  if (tags.has('chineseTech')) {
    add('juejin')
    add('csdn')
  }

  return picked.slice(0, Math.max(0, maxSources))
}
