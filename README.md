# dsh-web-search-zerokey

给 DeepSeek Harness（DSH）的**零 key 网页搜索 provider**。

不需要任何 API key、不需要外部实例、**不消耗模型 turn / 积分**。

---

## 为什么需要它

本机 `web_search` 曾整体不可用。排查后的共因**不是「缺 key」，而是 Node CA 信任链**：
DSH Desktop 从 GUI 启动，`NODE_EXTRA_CA_CERTS` 无法通过 `.env`、`.zshrc` 或
`launchctl setenv` 注入（三条路实测全堵）。

本插件改为**在进程内 patch `tls.createSecureContext`** 注入本机 CA —— 零配置、零重启、零特权。
只增补信任根，**不关闭校验**（与 `NODE_TLS_REJECT_UNAUTHORIZED=0` 有本质区别）。

---

## ★ 最重要的一条：不要换成 DeepSeek 官方搜索

官方 `@deepseek-ai/dsh-web-search-deepseek`（id `deepseek-official`）的计费方式是：

> "one search costs **a full model turn** in latency and tokens"（官方 README 原文）

**每次搜索 = 一次完整模型 turn**，直接消耗 token / 积分。
而它默认就在 base bundle 里注册，且 `available()` **恒报可用**
（`apply()` 总会提供 `resolveApiKey`，即使没配 key）。

⇒ 配置里那行 `searchProvider: zerokey` **不只是「选一个 provider」**，
它是**防止 fallback 到烧积分后端的护栏**。

`test/pin-guard.test.mjs` 会锁死这条口径：改动者会在测试阶段立刻发现，
而不是等到积分被扣。**不要删这个测试。**

---

## 安装与生效

```
改源目录  →  同步安装副本  →  重启 DSH
```

三步缺一不生效（`file:` 依赖被 pnpm 装成**目录副本**，不是 symlink）。

```bash
SRC=~/Documents/myprojects/mind/handoff/dsh-web-search-zerokey
DST=~/.dsh/profiles/desktop/node_modules/dsh-web-search-zerokey
cp "$SRC/index.js" "$SRC/package.json" "$DST/"
rm -rf "$DST/lib" && cp -R "$SRC/lib" "$DST/lib"
```

**生效判据**（进程启动时间必须**晚于**安装副本 mtime）：

```bash
ps -eo pid,lstart,command | grep "DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness$"
stat -f "%Sm" ~/.dsh/profiles/desktop/node_modules/dsh-web-search-zerokey/lib/provider.js
```

---

## 架构

入口 `index.js` 是**薄层**（约 120 行），只做导出与注册。
逻辑按**变化的边界**分居：

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

**新增一个源**：只需加 `lib/sources/<name>.js` + 在 `lib/sources/registry.js` 注册一行，
不必动路由、合并或编排。

---

## 数据源（7 个）

| id | 类型 | 说明 |
|---|---|---|
| `bing` | 抓页 | 主源，唯一不可降级 |
| `hackernews` | API | 真人技术讨论，带热度/评论数 |
| `github` | API | 仓库检索（匿名限流 10/h，自动冷却） |
| `arxiv` | API | 论文（**官方 ToU 要求 ≥3s/次**，已强制） |
| `npm` | API | 包元数据 |
| `juejin` | API | 中文技术 |
| `csdn` | API | 中文技术 |

> ⚠️ Bing 抓取的 `/search` 路径位于其 `robots.txt` 的 `Disallow` 列表。
> 这是**用户已知情承担**的取舍；工程上以缓存 + 限速降低暴露面。

---

## 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `multiSource` | `true` | 关掉则只走 Bing |
| `includeContent` | **`false`** | 抓正文片段（实测延迟 **+466%**，谨慎开启） |
| `maxSnippetChars` | `500` | 单条摘要上限 |
| `cacheTtlMs` | `300000` | 缓存 TTL |
| `retries` | `2` | 幂等 GET 重试次数 |
| `minIntervals` | 按源 | 覆盖各源最小请求间隔 |
| `timeoutMs` | `12000` | 总超时 |

---

## 降级行为

主源（Bing）失败时**不会**直接整体失败 —— 若垂直源有结果，会返回部分结果
并标注：

```js
{ sources: [...], degraded: true, failedSource: 'bing' }
```

设计理由：Bing 挂掉时 HN/GitHub 明明有结果，把它们一起丢掉是过度保守。
但**必须标注**，否则「主源已坏」这个系统性信号会被掩盖。

> 若主源与垂直源**都**失败，则抛错 —— 不把「全挂了」伪装成「搜索无结果」。

## 请求去重（两层）

| 层 | 作用 | 实测 |
|---|---|---|
| **SingleFlight** | 同键**并发**合并（TTL 缓存挡不住并发穿透） | 10 个相同查询并发 → 上游 **10 → 1 次** |
| **TTL 缓存** | 跨时间的同查询复用 | 重复查询 940ms → **2ms** |

## 垂直源配额

单次查询最多启用 **2 个**垂直源，预留 **4 个**槽位（`planVerticalQuota`）。

关键约束：**生效源数 × 每源条数 ≤ 预留**，否则多发的请求会被丢弃
（实测踩到：2 源各请求 2 条，只进 2 条 → 一半请求白打）。
实测效果：技术查询为 `Bing 6 + HN 2 + GitHub 2`。

为什么两层都要：只有 TTL 时，N 个相同查询同时到达会**各自打一次上游**
（都查不到缓存）——这不只是浪费，且「同查询短时高频重复」正是被风控盯上的形态。

## 自适应（自进化）

把已观测到的事实转成下一次的调度决策：

- 成功率低 → 该源配额下降（下限 0.5，**不会归零**）
- 频繁限流 → 冷却自动拉长（上限 4 倍）
- 指数衰减（0.9）→ 上游恢复后不被历史失败永久拖累

状态持久化在 `$DSH_HOME/cache/dsh-web-search-zerokey/adapt.json`，
**跨重启保留**（否则每次归零，那不叫进化）。

**安全边界**：自适应**只能调调度参数**，绝不允许开关安全机制、修改源清单、
或触碰 `searchProvider` 的 pin。载入时二次夹逼 —— 文件被改坏最坏只导致「慢一点」。

---

## 安全

抓取结果里的**任意 URL 必须走 `ctx.web.fetch()`**，不许裸 `fetch()`。

宿主 fetchProvider 已内建：公网 IP 校验、DNS 重绑定防护、同源重定向检查、
拒绝 URL 内嵌凭据。自己裸抓会绕过全部这些（SSRF 风险）。

---

## 生效自检（重启后先跑这个）

```bash
cd ~/.dsh/profiles/desktop
node ~/Documents/myprojects/mind/handoff/dsh-web-search-zerokey/scripts/verify.mjs
```

一键确认 13 项：安装副本完整性 / pin 护栏 / **进程是否已加载新代码** /
功能冒烟 / 自适应状态。脚本会把「待重启」与「真失败」分开报告 ——
前者是预期中间态，不是故障。

> 注意：**关窗口 ≠ 退出进程**。需 Cmd+Q 真正退出后重开。

## 测试

```bash
node --test "test/*.test.mjs"    # Node 23+ 必须用 glob，传目录会 MODULE_NOT_FOUND
```

覆盖：路由分类 / 缓存 / 限速 / 重试 / 各源解析 / 边界输入 / 自适应 / pin 护栏 /
编排层（降级·配额·交错·冷却·并发合并）。

当前：**122 个用例，行覆盖 96.36%**。含 `test/fixtures/bing-real.html`
（真实 Bing 页面快照），避免「只在自造数据上通过」。

---

## 相关文档

- `UPGRADE-PLAN.md` —— 升级方案与依据分级（S/A/B/C/D）
- `../handoff-2026-09-30-zerokey-v0.3.0.md` —— 交接文档
- `../README-CA修复说明.md` —— CA 信任链的完整排查记录
