# dsh-web-search-zerokey

**给 DeepSeek Harness（DSH）的零 key 联网搜索。**

不填任何 API key · 不启任何本地服务 · 不消耗模型积分。

```bash
# 桌面版：在 GUI 的「插件市场」里搜索 zerokey 安装
# Web / TUI 版：
dsh plugin --profile web add dsh-web-search-zerokey
```

装完直接就能搜。**没有第二步**——不需要去申请 key，不需要填配置，不需要起 Docker。

> ⚠️ 桌面版的 profile 叫 `desktop`，但**不能用 CLI 装** —— 会被
> `error: profile "desktop" is managed exclusively by the Electron application` 拒绝。
> 详见下方[安装](#安装)章节。

---

## 为什么叫 zero-key

市面上给 AI 用的搜索，几乎都要一样东西：

| 方案 | 代价 |
|---|---|
| 官方搜索 API | 要 key，且**每次搜索 = 一次完整模型 turn**（直接扣积分） |
| SearXNG 自建 | 要自己跑一个 Docker 实例，还得维护 |
| Google / Bing 官方 API | 要 key，Bing 的还**已于 2025-08-11 退役** |
| Tavily / Brave 等 | 要 key，有免费额度但会耗尽 |

本插件的路线：**直接抓公开网页 + 调公开接口**，全部免费、全部无需注册。

那它凭什么不用 key？——因为**它本来就只需要公开信息**。
搜索这件事的本质是「把公开网页上的内容找出来」，而公开网页不需要授权。

---

## 特性

| | |
|---|---|
| **零配置** | 装完即用。没有 key、没有 endpoint、没有配置文件 |
| **多源聚合** | 7 个源并行，结果交错合并（不让某个源独占） |
| **中英文自动路由** | 中文技术查询走掘金/CSDN，生活类只走 Bing（不污染） |
| **不烧积分** | 一次搜索就是一次 HTTP，与模型 turn 完全无关 |
| **自适应调度** | 哪个源不稳就少用它、冷却拉长，状态跨重启保留 |
| **优雅降级** | 主源挂了但垂直源有结果 → 返回部分结果并标注，不整体失败 |
| **带证据** | 每条结果标注来源与类型（`source` / `sourceKind`） |

---

## 数据源（7 个）

| id | 取数方式 | 说明 |
|---|---|---|
| `bing` | 抓页 | 主源，覆盖最广 |
| `hackernews` | 公开 API | 真人技术讨论，带**热度与评论数** |
| `github` | 公开 API | 仓库检索（匿名限流 10/h，撞限自动冷却） |
| `arxiv` | 公开 API | 论文（严格遵守官方 3s 限速） |
| `npm` | 公开 API | 包元数据 |
| `juejin` | 公开 API | 中文技术 |
| `csdn` | 公开 API | 中文技术 |

实测效果（`mcp server typescript`，`maxResults=10`）：

```
Bing 6 条 + Hacker News 2 条 + GitHub 2 条
```

HN 与 GitHub 的条目自带热度信号，例如：

```
Show HN: Kreuzberg – Modern async Python library...   Hacker News · 197 分 · 75 评论 · 2025-02-15
LeonHartley/Coerce-rs                                 ★752 · Rust · 更新 6 天前
```

**197 分 75 评论** 这种信号，是普通搜索结果页给不出来的。

---

## 安装

> ⚠️ **先看清你是哪种用户** —— 两者的安装方式**不能混用**。

### A. DSH 桌面版（Electron App）

**推荐：在 GUI 的「插件市场 / 插件管理」里搜索 `zerokey` 一键安装**，
然后在设置里把搜索 provider 选为 `zerokey`。

如果你想手工装，桌面版的 profile 是 `desktop`，**不能用 CLI 装** ——
`dsh plugin --profile desktop ...` 会被明确拒绝：

```
error: profile "desktop" is managed exclusively by the Electron application
```

（`desktop` 由桌面 App 独占管理。这条来自 `@deepseek-ai/dsh` 的 `lib/bin.js`。）

手工装需要改两处：

**1. `~/.dsh/profiles/desktop/package.json`** —— 加进 bundles 与 dependencies：

```jsonc
{
  "dependencies": {
    "dsh-web-search-zerokey": "^1.0.0"
  },
  "dsh": {
    "profile": {
      "bundles": [
        // ...已有的 bundle
        "dsh-web-search-zerokey"
      ]
    }
  }
}
```

**2. `~/.dsh/profiles/desktop/cordis.patch.yml`** —— pin 住 provider：

```yaml
- id: web
  config:
    searchProvider: zerokey
```

然后 `Cmd+Q` 完全退出 DSH 再重开。

### B. Web / TUI 版（CLI）

```bash
dsh plugin --profile web add dsh-web-search-zerokey
```

再从 GitHub 装（未发 npm 时）：

```bash
dsh plugin --profile web add github:AllenCoderBug/dsh-web-search-zerokey
```

装完**同样需要** pin（见下）。

### ★ 无论哪种方式，都必须 pin 住 provider

装完**还不会自动生效**。DSH 的 provider 选择规则是
「恰好一个可用时自动选中；多个可用时必须显式指定」。

而本插件的 `available()` 恒为 `true`，官方搜索 provider 也在 base bundle 里 ——
所以**必须**显式指定（就是上面的 `cordis.patch.yml` 那段）。

> **为什么这一步不能省？**
> 不指定的话，DSH 可能 fallback 到官方搜索（`deepseek-official`），
> 而它**每次搜索消耗一次完整模型 turn** —— 直接扣你的积分。
> 本仓库的 `test/pin-guard.test.mjs` 会把这条锁死，防止误改。

### 生效判据

重启 DSH 后跑一次自检：

```bash
node ~/.dsh/profiles/desktop/node_modules/dsh-web-search-zerokey/scripts/verify.mjs
```

脚本会逐项确认：安装完整性 / pin 护栏 / **进程是否真的加载了新代码** /
功能冒烟 / 自适应状态。它会把「待重启」（预期中间态）与「真失败」分开报告。

> ⚠️ **关窗口 ≠ 退出进程**。macOS 上需 `Cmd+Q` 真正退出后重开。

---

## 配置项

全部可选，不填就用默认值。

| 键 | 默认 | 说明 |
|---|---|---|
| `multiSource` | `true` | 关掉则只走 Bing |
| `includeContent` | **`false`** | 抓正文片段（实测延迟 **+466%**，谨慎开启） |
| `maxSnippetChars` | `500` | 单条摘要上限 |
| `cacheTtlMs` | `300000` | 缓存 TTL（5 分钟） |
| `retries` | `2` | 幂等 GET 重试次数 |
| `timeoutMs` | `12000` | 总超时 |
| `minIntervals` | 按源 | 覆盖各源最小请求间隔 |

### 各源限速的依据（改动前请读）

| 源 | 间隔 | 依据 |
|---|---|---|
| `arxiv` | **3000ms** | **官方 ToU 硬性要求**：「make no more than one request every three seconds」。见 [arXiv API ToU](https://info.arxiv.org/help/api/tou.html)。违反会 429。**不可调低。** |
| `bing` | 800ms | 实测校准：300ms ×5 次全过；800ms ×8 次全过（无验证码）。原 1200ms 是过度保守 |
| `juejin` / `csdn` | 800ms | 站点 API 受风控约束，未单独压测，故与 Bing 同值 |

> ⚠️ **同一张表里两个值依据不同，不可类比。**
> arXiv 是「官方规定」（不可动）；Bing 是「实测校准」（要调请重跑压测，别凭感觉改）。

---

## 工作原理

### 请求去重（两层）

| 层 | 作用 | 实测 |
|---|---|---|
| **SingleFlight** | 同键**并发**合并 | 10 个相同查询并发 → 上游只打 **1 次** |
| **TTL 缓存** | 跨时间复用 | 重复查询 940ms → **2ms** |

两层都要：只有 TTL 时，N 个相同查询同时到达会**各自打一次上游**
（都查不到缓存）。这不只是浪费 —— 「同查询短时高频」正是被风控盯上的形态。

### 自适应（自进化）

把观测到的事实转成下一次的调度决策：

- 成功率低 → 该源配额下降（下限 0.5，**不会归零**）
- 频繁限流 → 冷却自动拉长（上限 4 倍）
- 指数衰减（0.9）→ 上游恢复后不被历史失败永久拖累

状态持久化在 `$DSH_HOME/cache/dsh-web-search-zerokey/adapt.json`，**跨重启保留**。

真实运行示例（某次重启后的状态文件）：

| 源 | 成功率 | 自适应反应 |
|---|---|---|
| `arxiv` | 0% | 配额降至 **0.75** |
| `github` | 79% | 限流率 21% → 冷却 **×1.17** |
| `bing` / `hackernews` | 91% / 94% | 配额 1.0（健康） |

**安全边界**：自适应**只能调调度参数**。它不允许开关安全机制、修改源清单、
或触碰 `searchProvider` 的 pin。载入时二次夹逼 —— 文件被改坏最坏只导致「慢一点」。

### 降级行为

主源（Bing）失败时**不会**直接整体失败 —— 若垂直源有结果，会返回部分结果并标注：

```js
{ sources: [...], degraded: true, failedSource: 'bing' }
```

理由：Bing 挂掉时 HN/GitHub 明明有结果，把它们一起丢掉是过度保守。
但**必须标注**，否则「主源已坏」这个系统性信号会被掩盖。

> 若主源与垂直源**都**失败，则抛错 —— 不把「全挂了」伪装成「搜索无结果」。

### 垂直源配额

单次查询最多启用 **2 个**垂直源，预留 **4 个**槽位。

关键约束：**生效源数 × 每源条数 ≤ 预留**，否则多发的请求会被丢弃
（实测踩到：2 源各请求 2 条，只进 2 条 → 一半请求白打）。

---

## 架构

入口 `index.js` 是**薄层**（149 行），只做导出与注册。
逻辑按**变化的边界**分居（17 个模块）：

| 路径 | 变化理由 |
|---|---|
| `lib/tls-ca.js` | 与搜索无关，几乎不变 |
| `lib/request-policy.js` | 随「上游多敏感」调整 |
| `lib/route.js` | 查询路由，会调整 |
| `lib/merge.js` | 结果合并，稳定 |
| `lib/sources/*` | **随上游改版 / 新增而变** |
| `lib/parse/*` | **随页面结构改版而变** |
| `lib/adapt.js` | 自适应调度 |
| `lib/provider.js` | 编排，稳定 |

**新增一个源**：只需加 `lib/sources/<name>.js` + 在 `lib/sources/registry.js`
注册一行，不必动路由、合并或编排。

---

## 安全

抓取结果里的**任意 URL 必须走 `ctx.web.fetch()`**，不许裸 `fetch()`。

宿主 fetchProvider 已内建：公网 IP 校验、DNS 重绑定防护、同源重定向检查、
拒绝 URL 内嵌凭据。自己裸抓会绕过全部这些（SSRF 风险）。

**TLS 处理**：本插件在进程内 patch `tls.createSecureContext` 以注入本机 CA
（用于 DSH Desktop 从 GUI 启动时无法注入 `NODE_EXTRA_CA_CERTS` 的场景）。
它**只增补信任根，不降低校验强度** —— 与 `NODE_TLS_REJECT_UNAUTHORIZED=0`
有本质区别，证书链仍被完整验证。

---

## 合规声明

本插件的 `bing` 源通过**抓取搜索页 HTML** 获取结果，该路径位于
Bing 的 `robots.txt` 的 `Disallow` 列表内。

- 其余 6 个源均为**公开 API**，无此问题
- 工程上以**缓存 + 按源限速 + 单飞合并**降低请求频次（实测可将高频重复查询压到 0 次上游请求）
- 使用者应自行确认其所在司法辖区与使用场景的合规性

如果你更倾向完全规避此风险，设置 `multiSource: false` 不会解决
（主源就是 Bing）；可改为只使用 API 类源 —— 但那会显著降低覆盖率，
因为 Bing 是唯一覆盖「全中文通用网页」的源。

---

## 开发

```bash
git clone https://github.com/AllenCoderBug/dsh-web-search-zerokey.git
cd dsh-web-search-zerokey
npm test                  # 162 个用例
npm run test:coverage     # 含覆盖率报告（当前 98.55%）
```

> 注意：Node 23+ 必须用 glob（`"test/*.test.mjs"`），传目录会 `MODULE_NOT_FOUND`。

测试覆盖：路由分类 / 缓存 / 限速 / 重试 / 各源解析 / 边界输入 / 自适应 /
pin 护栏 / 编排层（降级·配额·交错·冷却·并发合并）/ TLS CA 注入。

含 `test/fixtures/bing-real.html`（**真实 Bing 页面快照**），
避免「只在自造数据上通过」。

贡献前请读 [CONTRIBUTING.md](./CONTRIBUTING.md)。

---

## 致谢

- Provider 的接口形态参考了 [`dsh-web-search-searxng`](https://github.com/chinng-inta/dsh-web-search-searxng)
  （MIT，by chinng_inta）。本插件的实现（HTML 抓取解析、多源聚合、路由、
  自适应调度、TLS CA 注入）均为独立开发。

## 许可

[MIT](./LICENSE)
