# 贡献指南

感谢你愿意参与。本项目的核心约束只有一条：**零 key**。
任何改动都不得破坏它 —— 不引入需要 API key、账号、或外部服务的依赖。

---

## 快速开始

```bash
git clone https://github.com/husongzhen/dsh-web-search-zerokey.git
cd dsh-web-search-zerokey
npm test
```

> Node 23+ 必须用 glob（`"test/*.test.mjs"`），传目录会 `MODULE_NOT_FOUND`。
> 这也是 `package.json` 的 `test` 脚本写成带引号 glob 的原因。

---

## 不可协商的约束

以下四条请在改代码前先读一遍。它们都来自**实际踩过的坑**，不是风格偏好。

### 1. 不得引入任何需要 key 的依赖

这是本插件存在的全部理由。新增数据源时，请确认它是**公开且无需注册**的。

提交前自问：**用户需要去某个网站注册吗？** 需要 → 不符合本项目定位。

### 2. 抓取结果的任意 URL 必须走 `ctx.web.fetch()`

```js
// ❌ 错：绕过宿主的 SSRF 防护
await fetch(userControlledUrl)

// ✅ 对
await ctx.web.fetch(userControlledUrl)
```

宿主 fetchProvider 已内建公网 IP 校验、DNS 重绑定防护、同源重定向检查、
拒绝 URL 内嵌凭据。裸 `fetch()` 会绕过**全部**这些。

### 3. 不要破坏 `searchProvider: zerokey` 的 pin

官方搜索 provider（`deepseek-official`）**每次搜索消耗一次完整模型 turn**，
直接扣用户积分。`test/pin-guard.test.mjs` 会锁死这条约束。

**不要删这个测试，也不要为了让测试通过而改断言。**

### 4. 各源限速值改动必须有依据

| 源 | 间隔 | 依据类型 |
|---|---|---|
| `arxiv` | 3000ms | **官方 ToU 硬性要求** —— 不可调低 |
| `bing` | 800ms | 实测校准 —— 要调请重跑压测 |
| `juejin` / `csdn` | 800ms | 保守取值（未单独压测） |

**「保守」不能当理由用。** 如果你想把某个值调大或调小，
请在 PR 描述里附上**实测数据**（如「N 次请求、间隔 M ms、结果如何」）。

---

## 新增一个数据源

架构上只需两步 —— 不必动路由、合并或编排：

```bash
# 1. 实现源（参考 lib/sources/hackernews.js，结构最简单）
touch lib/sources/your-source.js

# 2. 注册
# 编辑 lib/sources/registry.js，加入 SOURCES
```

源的职责边界：

```js
export const id = 'your-source'
export const label = 'Your Source'   // 展示名，会出现在结果的 source 字段
export const kind = 'api'            // 'api' = 结构化接口 / 'scrape' = 抓取页面

export async function search(query, { maxResults, signal }) {
  // 返回 { sources: [...], truncated: boolean }
  // 每条 source 至少要有 url 与 title
}
```

注意事项：

- `maxResults` 请用 `normalizeLimit()` 归一 ——
  各源**可被独立调用**，不能假设调用方已处理好边界值
- 遇到限流（429/403）请设 `err.rateLimited = true` 并抛出，
  交给上层的自适应冷却处理。**不要自己重试。**
- 日期用 `formatDateShort()`；它会把非正时间戳判为无日期

新增源之后请补测试：参考 `test/sources-mocked.test.mjs` 的写法
（用假 fetch 喂固定响应，不联网）。

---

## 测试要求

```bash
npm test              # 必须全绿
npm run test:coverage # 看覆盖率
```

- **新功能必须带测试。** 覆盖率当前 98.55%，请勿显著拉低。
- **优先用真实数据做 fixture。** 例如 `test/fixtures/bing-real.html`
  是真实页面快照 —— 自造数据容易让测试「假通过」。
- **修 bug 时先加一个能复现该 bug 的测试**，确认它失败，再修。

### 边界值是你的朋友

本项目的 bug 绝大多数来自边界值。写测试时请覆盖：

```
undefined / null / NaN / 0 / 负数 / 小数 / 空字符串 / 超长输入
```

统计表明，用真实边界值驱动比「读代码找问题」有效得多。

---

## 探针实验纪律

如果你为验证行为而改动配置、写临时文件或建链接：

1. **改前先备份**，备份名要不容易被通配符误删
2. **临时文件统一前缀 `zz-probe-`**（`.gitignore` 已覆盖）
3. **清理干净**，清理后跑一次残留检查

---

## 提交与分支

```
main                ← 只接受 merge --no-ff，不接受直接提交
  └── feat/xxx      ← 功能
  └── fix/xxx       ← 修复
  └── docs/xxx      ← 文档
```

- **每步一提交**，提交信息说清「为什么」而不只是「改了什么」
- 一个 PR 只做一件事

---

## 报告问题

请附上：

- DSH 版本、Node 版本、操作系统
- 复现步骤（能贴出具体查询词最好）
- `node scripts/verify.mjs` 的输出
- 如果是搜索质量问题：**实际返回**与**期望返回**

---

## 关于抓取 Bing 的合规争议

已知悉：`bing` 源抓取的 `/search` 路径位于其 `robots.txt` 的 `Disallow` 列表内。
其余 6 个源是公开 API，无此问题。

工程上的缓解措施（缓存 / 按源限速 / 单飞合并）欢迎加强。
但**本项目不打算就此展开争论** —— 取舍已在 README 的「合规声明」中说明。
