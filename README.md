# dsh-web-search-zerokey

**给 DeepSeek Harness（DSH）的零 key 联网搜索。**

不填任何 API key · 不启任何本地服务 · 不消耗模型积分。

---

## 它解决什么问题

给 AI 装上「联网搜索」，通常要先过一道坎：

| 常见方案 | 你要付出的代价 |
|---|---|
| DSH 官方搜索 | **每次搜索 = 一次完整模型 turn**，直接扣积分 |
| Google / Bing 官方 API | 要申请 key（Bing 的还**已于 2025-08-11 退役**） |
| SearXNG | 要自己跑一个 Docker 实例并长期维护 |
| Tavily / Brave 等 | 要 key，免费额度会耗尽 |

**这个插件不需要任何 key，装完就能搜。**

因为它走的是「抓公开网页 + 调公开接口」——公开信息本来就不需要授权。

---

## 安装

### 方式一：npm（推荐）

```bash
npm install -g dsh-web-search-zerokey
```

或装进 DSH profile：

```bash
dsh plugin --profile web add dsh-web-search-zerokey
```

### 方式二：DSH 桌面版

在 GUI 的**插件市场**里搜索 `zerokey` 安装。

> ⚠️ 桌面版的 profile 叫 `desktop`，但**不能用 CLI 装**，会报：
> `error: profile "desktop" is managed exclusively by the Electron application`
> 桌面版请用 GUI 市场，或按下方「手工装」操作。

### 方式三：从 GitHub 装

```bash
dsh plugin --profile web add github:AllenCoderBug/dsh-web-search-zerokey
```

---

## ★ 装完必须做一步：把 provider 指到它

**不配置的话不会生效。** DSH 的选择规则是「恰好一个可用时自动选中；
多个可用时必须显式指定」，而官方搜索也在列表里。

编辑 `cordis.patch.yml`（桌面版在 `~/.dsh/profiles/desktop/`）：

```yaml
- id: web
  config:
    searchProvider: zerokey
```

> **为什么这步不能省**：不指定就可能 fallback 到官方搜索，
> 而它每次搜索消耗一次完整模型 turn —— 直接扣你的积分。
> 本仓库有 `test/pin-guard.test.mjs` 锁死这条约束，防止误改。

### 桌面版手工装（GUI 市场不可用时）

改两处：

**1. `~/.dsh/profiles/desktop/package.json`**

```jsonc
{
  "dependencies": {
    "dsh-web-search-zerokey": "^1.0.1"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "dsh-web-search-zerokey"   // 加到已有列表里
      ]
    }
  }
}
```

**2. `~/.dsh/profiles/desktop/cordis.patch.yml`** —— 就是上面那段 pin 配置。

然后**完全退出 DSH（`Cmd+Q`）再重开**。

> ⚠️ **关窗口 ≠ 退出进程**。macOS 上必须 `Cmd+Q`。

---

## 验证是否生效

重启后跑一次自检：

```bash
node ~/.dsh/profiles/desktop/node_modules/dsh-web-search-zerokey/scripts/verify.mjs
```

它会逐项确认：安装完整性 / pin 护栏 / **进程是否真的加载了新代码** / 功能冒烟。
全部通过会打印 `插件已生效 ✅`。

---

## 它会搜出什么

7 个数据源并行，结果自动去重合并：

| 源 | 类型 | 特点 |
|---|---|---|
| Bing | 抓页 | 主源，覆盖最广 |
| Hacker News | 公开 API | 真人技术讨论，**带热度与评论数** |
| GitHub | 公开 API | 仓库检索 |
| arXiv | 公开 API | 论文 |
| npm | 公开 API | 包元数据 |
| 掘金 / CSDN | 公开 API | 中文技术 |

**中英文自动路由**：中文技术查询走掘金/CSDN，生活类查询只走 Bing（不混入英文源）。

实际效果（查 `mcp server typescript`）：

```
Bing 6 条 + Hacker News 2 条 + GitHub 2 条
```

带**热度信号**的条目长这样——这是普通搜索结果页给不出的：

```
Show HN: Kreuzberg – Modern async Python library...   Hacker News · 197 分 · 75 评论 · 2025-02-15
LeonHartley/Coerce-rs                                 ★752 · Rust · 更新 6 天前
```

---

## 配置项（都可选）

| 键 | 默认 | 说明 |
|---|---|---|
| `multiSource` | `true` | 关掉则只走 Bing |
| `includeContent` | `false` | 抓正文片段（实测延迟 +466%，谨慎开） |
| `maxSnippetChars` | `500` | 单条摘要上限 |
| `cacheTtlMs` | `300000` | 缓存 TTL（5 分钟） |
| `timeoutMs` | `12000` | 总超时 |

---

## 已知限制

- **`bing` 源是抓页**，该路径位于其 `robots.txt` 的 `Disallow` 列表内。
  其余 6 个源是公开 API，无此问题。使用者请自行确认所在司法辖区的合规性。
- **arXiv 需严守 3 秒/次**（官方 ToU 硬性要求），插件已强制，请勿调低。
- GitHub 匿名限流 10 次/小时，撞限时会自动冷却该源。

---

## 开发

```bash
git clone https://github.com/AllenCoderBug/dsh-web-search-zerokey.git
cd dsh-web-search-zerokey
npm test          # 162 个用例
```

设计与实现细节见 [CONTRIBUTING.md](./CONTRIBUTING.md) 与
[UPGRADE-PLAN.md](./UPGRADE-PLAN.md)（含每条决策的依据分级）。

## 致谢

Provider 接口形态参考了 [`dsh-web-search-searxng`](https://github.com/chinng-inta/dsh-web-search-searxng)
（MIT，by chinng_inta）。实现（HTML 抓取解析、多源聚合、路由、自适应、TLS CA 注入）为独立开发。

## 许可

[MIT](./LICENSE)
