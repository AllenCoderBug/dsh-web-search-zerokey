# Changelog

本文件记录所有值得注意的变更。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

---

## [1.0.4] — 2026-09-30

### 修复

- **README「桌面版手工装」漏了 `pnpm install` 步骤** ——
  该节只说「改 `package.json` 两处」，但**只改声明不会下载包**：
  `node_modules/` 下什么都没有，插件加载必然失败。

  实测验证：建一个只含 dependencies + bundles 声明的 profile 目录，
  `node_modules` 根本不存在。

  现补为**明确三步**：改声明 → `pnpm install` → `Cmd+Q` 重启。

- 补充 `pnpm` 不在 PATH 时的回退写法。桌面版自带 pnpm，但它不在用户
  `PATH` 里 —— 这是本机实测踩到的（`pnpm install` 报 `command not found`）。
  回退命令：
  ```bash
  node "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/pnpm/bin/pnpm.cjs" install
  ```

### 说明

- 本次为**文档修复**，代码未变。因 npm 的 `readme` 字段是发布时快照，
  必须重新发版才能刷新 npm 页面上的 README。

---

## [1.0.3] — 2026-09-30

### 新增

- **插件自带 provider 绑定** —— 装完即用，不再需要用户手工编辑
  `cordis.patch.yml`。

  依据（本机 profile 的 `cordis.yml` 官方注释）：
  ```
  层序：bundle patch → 用户的 cordis.patch.yml → --patch overlay
  ```
  插件的 patch 属**最前**层，用户配置在后、会覆盖它 ——
  所以自带绑定既让「装完即用」成立，又不剥夺用户改主意的权利。

  ⚠️ 同时**必须完整重述 `fetchProvider`**：patch 是**整块替换** config
  而非合并（官方文档原文「a later patch can replace that row's complete
  config」），漏了它抓取会坏。

### 文档

- README 安装章节重排：**桌面版 GUI 安装放第一位**（照 `dsh-context` 等
  头部插件的写法）。此前把 npm 放第一，但普通用户最该用的是 GUI。
- 新增「关于 provider 绑定」章节，说明如何改回官方搜索。

---

## [1.0.2] — 2026-09-30

### 文档

- **README 大幅精简**：333 行 → 184 行。它现在只回答用户关心的三件事 ——
  「解决什么问题」「怎么装」「怎么用」。
- **补上缺失的 npm 安装方式**：包早已发布到 npm，README 却只写了 CLI 和
  桌面版两种途径，**唯一列出的安装方式竟然是漏的**。现已补为推荐方式。
- 移出的设计细节（请求去重 / 垂直源配额 / 降级 / 自适应 / 架构分层）
  并入 `CONTRIBUTING.md` —— README 讲「怎么用」，CONTRIBUTING 讲「怎么改」。

---

## [1.0.1] — 2026-09-30

### 修复

- **README 顶部的安装命令是错的** —— 写成了
  `dsh plugin --profile desktop add ...`，但 `desktop` profile 由桌面 App 独占管理，
  该命令会被明确拒绝：
  ```
  error: profile "desktop" is managed exclusively by the Electron application
  ```
  1.0.0 时只修正了「安装」章节，**漏改了顶部「快速开始」那段**，
  导致照抄顶部命令的用户会直接撞报错。现已统一。

### 说明

- 桌面版与 Web/TUI 版的安装方式**不同**，README 已分两条路径写清：
  - 桌面版（Electron）：GUI 插件市场安装，或手工改 `bundles` + `cordis.patch.yml`
  - Web / TUI 版（CLI）：`dsh plugin --profile web add <pkg>`

---

## [1.0.0] — 2026-09-30

首个公开发布版。**核心承诺：零 key —— 不填任何 API key、不启任何本地服务、不消耗模型积分。**

### 新增

- **多源聚合**：7 个数据源（Bing / Hacker News / GitHub / arXiv / npm / 掘金 / CSDN），
  结果按轮转（interleave）合并，避免单一源独占槽位
- **中英文自动路由**：中文技术查询走掘金/CSDN，生活类查询只走 Bing（不混入英文源）
- **自适应调度（自进化）**：按源统计成功率与限流率，动态调整配额与冷却；
  状态持久化，跨重启保留
- **两层请求去重**：SingleFlight（并发合并）+ TTL 缓存
- **优雅降级**：主源失败但垂直源有结果时返回部分结果并标注 `degraded`
- **证据层标注**：每条结果带 `source` / `sourceKind`
- **TLS CA 进程内注入**：解决 DSH 桌面版从 GUI 启动时无法注入 `NODE_EXTRA_CA_CERTS` 的问题
- **生效自检脚本** `scripts/verify.mjs`：20+ 项检查，区分「待重启」与「真失败」

### 设计约束（不可协商）

- `searchProvider` 必须 pin 为 `zerokey` —— 防止 fallback 到官方搜索
  （其「one search costs a full model turn in latency and tokens」）
- 抓取结果的任意 URL 必须走 `ctx.web.fetch()`，不得裸 `fetch()`（SSRF）
- arXiv 严格遵守官方 3s 限速（ToU 硬性要求）

### 修复（开发期发现并已解决）

- `isRetryableStatus(429)` 返回 true → 限流源被重试 3 次，加剧节流
- `MinIntervalLimiter` 把间隔存在实例字段 → arXiv 的 3000ms 被其他源覆盖成 100ms
- 超时未被识别为退避触发 → 每次学术类查询白等 8 秒
- `mergeSources` 用 `flat()` → 前面的源独占预留槽位，后面的源永不出现
- 空查询实际打到了上游 → 返回误导性的「页面结构可能已变更」
- `maxResults=0` 却返回 1 条
- 垂直源配额计算错误 → 2 源各请求 2 条却只预留 2 槽位，一半请求白打
- 自适应配额允许**上浮** → 突破预留约束
- 各源会用 `Math.min(Math.max(maxResults, 1), 10)` 产生 `NaN` 参数发给上游
- `formatDateShort(-1)` 产出 `1969-12-31` 假日期
- `truncated` 语义误报（「刚好填满」被当成「有内容被丢弃」）
- GitHub 源对自然语言长句返回 ★0/★1 玩具仓库 → 加 MIN_STARS 阈值
- TLS CA 注入未测 → 补 10 条测试（函数覆盖 40% → 100%）

### 测试

- **162 个用例**，行覆盖 **98.55%**
- 含真实 Bing 页面快照（`test/fixtures/bing-real.html`），避免「只在自造数据上通过」
- `test/pin-guard.test.mjs` 锁死防烧积分的 pin 约束

---

## [0.3.0] — 2026-09-29

内部版本。单文件起步（185 行），抓取 Bing 页面解析，解决本机搜索整体不可用的
CA 信任链问题。

[1.0.0]: https://github.com/AllenCoderBug/dsh-web-search-zerokey/releases/tag/v1.0.0
