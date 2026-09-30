# 回滚手册

> 出问题时按本文操作。**每一步都已验证过命令的可用性**（标了依据）。

---

## 一、先判断是哪种问题

| 症状 | 大概率原因 | 走哪节 |
|---|---|---|
| 搜索返回空 / 报 `WEB_PROVIDER_*` | 插件未加载或 pin 错 | §3 |
| 搜索能返回但质量差 | 源被限流/冷却（正常降级） | §4 |
| DSH 启动失败 / 报模块找不到 | 安装副本文件缺失 | §2 |
| 想彻底回到升级前 | — | §3 |

**先跑自检脚本**，它会告诉你是哪类问题：

```bash
cd ~/.dsh/profiles/desktop
node node_modules/dsh-web-search-zerokey/scripts/verify.mjs
```

---

## 二、安装副本文件缺失 / 损坏

**原因**：`file:` 依赖被 pnpm 装成**目录副本**，改源目录不会自动同步。

**修复**（重新同步）：

```bash
# SRC = 你的仓库克隆位置
SRC=~/dsh-web-search-zerokey
DST=~/.dsh/profiles/desktop/node_modules/dsh-web-search-zerokey
cp "$SRC/index.js" "$SRC/package.json" "$DST/"
rm -rf "$DST/lib" && cp -R "$SRC/lib" "$DST/lib"
```

然后**重启 DSH**（Cmd+Q 真正退出，关窗口不算）。

> 为什么可以直接 `cp` 而不必 `pnpm install`：
> `pnpm-lock.yaml` 里该依赖是 `type: directory`，pnpm 也只是拷贝，
> 且 `package.json` 的 `files` 白名单只含 3 类路径。
> 已用 `npm pack --dry-run` 验证：包含 17 个 lib 文件 = 源目录 17 个，一致。

---

## 三、回到升级前的版本

### 3.1 快速回滚整个插件目录

```bash
cd ~/dsh-web-search-zerokey      # 你的仓库克隆位置
git log --oneline                # 找到目标提交
git checkout <目标提交> -- .
# 再按 §2 同步到安装副本，然后重启
```

**已知可用版本**（都验证过可取出）：

| 提交 | 形态 | 说明 |
|---|---|---|
| `c335d8f` 及更早 | **单文件** index.js（9123 bytes） | 升级前的形态（只有 Bing） |
| `d83d1b2` | 单文件 + 多源增强 | 有 Bing+HN+GitHub |
| `ae5a291` | 分层（当前） | 完全体 |

### 3.2 ⚠️ 如果只是想「停用本插件」

**不能只注释 bundle 行** —— 那会导致 `WEB_PROVIDER_CONFIGURED_MISSING`。

原因：`cordis.patch.yml` 里 pin 着 `searchProvider: zerokey`，
插件不注册时这个 pin 就指向一个不存在的 provider。

**两步必须同时做**：

1. `~/.dsh/profiles/desktop/package.json` → `dsh.profile.bundles` 里
   注释掉 `"dsh-web-search-zerokey"`
2. `~/.dsh/profiles/desktop/cordis.patch.yml` → 删掉 `- id: web` 那一段
   （或改成 `searchProvider: deepseek-official`）

**再提醒一次**：`deepseek-official` 每次搜索 = 一次完整模型 turn，
**会消耗 token/积分**。若不想烧积分，宁可修好本插件而不是切到它。

---

## 四、搜索质量差（多数是正常的降级）

**先别急着回滚**，大概率是源被限流后的正常表现：

- GitHub 匿名额度 **10 次/小时**，打光后自动冷却 15 分钟
- arXiv 官方要求 **3 秒/次**，且本机可达性本身不稳定
- Bing 抓取较频繁时可能被风控

**查看自适应状态**：

```bash
cat ~/.dsh/cache/dsh-web-search-zerokey/adapt.json
```

这个文件记录了每个源的成功率、延迟、限流率。
如果某个源 `successRate` 很低，自适应会**自动降低它的配额**——
这是设计行为，不是 bug。

**手动重置**（想让它重新学习）：

```bash
rm -f ~/.dsh/cache/dsh-web-search-zerokey/adapt.json
```

**临时只走 Bing**（排除垂直源干扰）：在 profile patch 的 `- id: web` 下加：

```yaml
- id: web
  config:
    searchProvider: zerokey
    fetchProvider: http
    multiSource: false
```

---

## 五、验证回滚成功

任何回滚后都跑一次：

```bash
cd ~/.dsh/profiles/desktop
node node_modules/dsh-web-search-zerokey/scripts/verify.mjs
```

全部通过（`插件已生效 ✅`）即回滚成功。

---

## 六、测一下搜索是否真的能用

自检脚本只做冒烟。真实使用中直接搜一个技术词即可，例如：

- `mcp server typescript` —— 应返回 Bing + Hacker News + GitHub 混合结果，
  且结果带日期
- `北京周末去哪里玩` —— 应返回**纯 Bing 中文**结果（不该有英文源混入）
