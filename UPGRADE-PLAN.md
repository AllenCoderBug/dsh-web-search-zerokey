# 搜索工具升级方案（定稿）

> 适用：`dsh-web-search-zerokey`（DSH 的 `web_search` 后端）
> 定稿：2026-09-30 ｜ 状态：待执行
> 依据：本文每条结论都标了等级 —— **S** 规范原文 / **A** 行业标准 / **B** 实测 / **C** 经验 / **D** 我的推论

---

## 0. 一句话

现在是「能搜」，目标是「搜得全、信息够、跑得稳」——**不引入任何 key、不消耗积分**。

---

## 1. 现状（实测，不是印象）

| 项 | 实测值 |
|---|---|
| 代码规模 | `index.js` 510 行，单文件 |
| 引擎 | Bing（抓页）+ HN（API）+ GitHub（API） |
| 缓存 | ❌ 无 |
| 限速 | ❌ 无 |
| 重试 | ❌ 无 |
| 单条 snippet 上限 | 300 字符 |
| **真实页面正文** | **5181 字节** ← 差 **17 倍** |
| 时间过滤 | ❌ 无 |

**分层诊断**：

| 层 | 现状 |
|---|---|
| 检索层 | ✅ 做得最厚（3 引擎） |
| 提取层 | ⚠️ 存在但**没接上**——`ctx.web.fetch()` 可用，`web_search` 不调它 |
| 证据层 | ⚠️ 弱——有 URL，无时间/热度/来源标注 |
| 安全层 | ✅ **官方已有**（见 §2 纠正） |

---

## 2. 两条纠正（前几轮我说错了，这里更正）

### 纠正 1：安全层不是空白，官方已经做好了 【B】

asar 内 `/dsh/node_modules/@deepseek-ai/dsh-web-fetch-http` 已内建：

| 防护 | 实现 |
|---|---|
| SSRF | `isPublicIpAddress()` 只放行 unicast；IPv4-mapped IPv6 按内嵌 IP 判；NAT64 拦截 |
| DNS 重绑定 | `resolvePublicAddresses()` 解析一次、校验**整个地址集** |
| 跨源重定向 | `redirect: "manual"` + `isSameOrigin()` |
| 凭据泄漏 | 拒绝 URL 内嵌 user/password |

⇒ **不用自建 SSRF 白名单**。但立一条红线：**凡抓取结果里的任意 URL，必须走 `ctx.web.fetch()`，不许裸 `fetch()`**。

### 纠正 2：提取层不该自建 【B】

`ctx.web` 暴露：`registerSearchProvider` / `registerFetchProvider` / `search()` / **`fetch()`**

DSH 天生就是「检索 + 提取」双插槽。⇒ **不在 search 插件里重造提取器**，需要正文时**回调 `ctx.web.fetch()`**。

---

## 3. 三条硬约束（已拍板，不再讨论）

| # | 约束 | 来源 |
|---|---|---|
| **1** | **绝不启用 DeepSeek 官方搜索** —— 每次搜索 = 一次完整模型 turn，烧积分 | 用户拍板 |
| **2** | **实用优先**：先把搜索跑顺，抓页合规风险知情承担 | 用户拍板 |
| **3** | **`searchProvider: zerokey` 的 pin 必须保留** | 见下 |

**约束 3 为什么是护栏**：官方 `dsh-web-search-deepseek`（id `deepseek-official`）默认在 base bundle 里注册，且 `available()` **恒报可用**。pin 一旦丢失 → `WEB_PROVIDER_AMBIGUOUS`，或**悄悄 fallback 到烧积分的后端**。【B】

---

## 4. 合规实况（知情承担，此处只记录事实）

【S，各站 robots.txt 自身声明】

| 站点 | 搜索路径 | robots |
|---|---|---|
| **Bing** | `/search?q=` | **`Disallow: /search`（UA: `*`）** ← 我们在用 |
| 百度 | `/s?wd=` | `Disallow: /s?` |
| 搜狗 | `/web?query=` | `Disallow: /web?` |
| 知乎 | `/search` | `Disallow: /search` |
| 头条 | `/search` | `Disallow: /search` |

风控实测：百度 → 302 到**图形验证码墙**；搜狗 → 返回 **5576 字节空壳**（正常页 ~100KB）；Bing → 200/101KB 可解析。

**法律风险我只给到 C 级** —— 国内判决原文未取到，不写成结论。

**⇒ 工程含义**：既然知情承担，就更该**降低暴露面**（缓存、限速、分担请求）——这既是"跑顺"的诉求，也客观减风险。

---

## 5. 国内可达的源（实测，全部 200）【B】

| 源 | 端点 | 性质 |
|---|---|---|
| GitHub | `api.github.com/search/repositories` | 官方 API |
| HN | `hn.algolia.com/api/v1/search` | 官方 API |
| arXiv | `export.arxiv.org/api/query` | 官方 API（**必须 https**） |
| npm | `registry.npmjs.org/-/v1/search` | 官方 API |
| PyPI | `pypi.org/pypi/<pkg>/json` | 官方 API |
| 掘金 | `api.juejin.cn/search_api/v1/search` | 站点 API（**POST**） |
| CSDN | `so.csdn.net/api/v3/search` | 站点 API |
| B站 | `api.bilibili.com/x/web-interface/search/all/v2` | 站点 API |

**❌ 国内不可达（000）**：Google、DuckDuckGo、Mojeek、SearXNG、Startpage、zh.wikipedia API。

**⇒ 结论**：「国内只能抓页」是误判。垂直类官方 API 反而畅通。

---

## 6. 升级项

### P0 · 防回归（先做，5 分钟）

| # | 做什么 | 验收 |
|---|---|---|
| 0.1 | **加 pin 断言测试**：当前生效 provider 必须是 `zerokey`，不得是 `deepseek-official` | 测试通过；配置被误改时**测试报错** |

**理由**：约束 1 是红线，但红线目前只写在注释里——**没有机制**。改的人（包括未来的我）不会知道。

### P1 · 零成本收益（不发新请求，只把已有信息用上）

| # | 做什么 | 依据 | 验收 |
|---|---|---|---|
| 1.1 | **HN 字段补全**：`num_comments` / `created_at` / `author` | B（字段实测存在） | 结果里能看到评论数与日期 |
| 1.2 | **Bing 结果日期提取**：页面已有「3 天前 / 2026年8月27日」，现被丢弃 | B | 结果带日期 |
| 1.3 | **GitHub 补 `updated_at` / `language`** | B | 同上 |
| 1.4 | **snippet 上限 300 → 可配置**，默认 500 | B | 配置生效 |

**为什么优先**：**单价不变，信息量提升**。纯赚。

### P2 · 稳定性（降暴露面）

| # | 做什么 | 目的 | 验收 |
|---|---|---|---|
| 2.1 | **缓存**（同 query 短时复用，TTL 可配） | 请求频次↓ | 重复 query 命中缓存（打日志可见） |
| 2.2 | **限速**（Bing 侧最小间隔） | 不易触发风控 | 连续查询请求间隔达标 |
| 2.3 | **重试**（仅幂等 GET，指数退避） | 抖动容错 | 模拟失败能重试 |

### P3 · 扩展源（分担 Bing 压力）

| # | 源 | 触发条件 |
|---|---|---|
| 3.1 | 掘金 / CSDN | 中文技术类查询 |
| 3.2 | arXiv | 学术类查询 |
| 3.3 | npm / PyPI | 包名类查询 |

**实现注意**【B】：掘金**必须 POST**，字段在 `data[].result_model.article_info.{title,brief_content,ctime}`，**链接要自己拼** `juejin.cn/post/<id>`；B站结构按 `result_type` 分组嵌套。

### P4 · 跃迁（需实测数据再定）

| # | 做什么 | 代价 |
|---|---|---|
| 4.1 | 对 Top-N 结果调 **`ctx.web.fetch()`** 取正文片段 | 延迟 +2~4s；token↑ |
| 4.2 | 引用绑定（结果带来源标注） | — |

**4.1 治的是「17 倍信息差」，但应先做可开关实验拿数据**，不凭感觉默认开。

---

## 7. 架构（边界决策）

**判尺：变化的边界 = 拆分的边界。**

510 行单文件里住着**变化率完全不同**的东西：

| 模块 | 变化频率 |
|---|---|
| Bing 解析 | **随 Bing 改版而变** |
| HN/GitHub/arXiv/掘金 | **会不断新增** |
| 路由判定 | 会调整 |
| 合并配额 | 稳定 |
| CA 注入 | 几乎不变 |

**实证依据**【B】：各源响应结构差异极大（掘金 POST+嵌套 / B站分组 / arXiv 是 XML）→ 每个源一个适配器，比在一个文件里堆 if 清晰。

建议结构：

```
dsh-web-search-zerokey/
  index.js          ← 只做 provider 注册 + 编排（薄）
  lib/tls-ca.js     ← CA 注入（与搜索无关，独立）
  lib/sources/      ← bing.js hackernews.js github.js arxiv.js juejin.js ...
  lib/route.js      ← 查询类型判定
  lib/merge.js      ← 合并与配额
  lib/cache.js      ← 缓存/限速
  test/
```

⚠️ **新建目录 = 边界决策，需用户确认后动手。**

---

## 8. 已排除（实测无效，别再试）

| 方案 | 结论 |
|---|---|
| Bing `qdr=d/w/m` 时间过滤 | ❌ **完全无效**——带不带结果一模一样 |
| Bing `filters=ex1:"ez1"` | ❌ 同样无效 |
| DuckDuckGo | ❌ 本机不可达（000） |
| 百度 | ❌ 图形验证码墙 |
| Bing Search API | ❌ **2025-08-11 已退役**，不再接受新注册【S】 |
| 自建 SSRF 防护 | ❌ 不需要，官方已有 |
| 在 search 插件里自建提取器 | ❌ 走 `ctx.web.fetch()` |

---

## 9. 取不到的（诚实标注）

- **Brave Search API 免费额度** —— 官网国内 000 不可达，未取到
- **Google CSE 额度** —— 页面 SPA，未取到
- **国内爬虫判决原文** —— 未取到，故法律风险只给 C 级
- **Anthropic / OpenAI 搜索规格** —— 区域封锁 / Cloudflare 拦截

---

## 10. 执行顺序与验收

| 步 | 内容 | 验收判据 | 回滚 |
|---|---|---|---|
| 1 | P0 pin 测试 | 测试通过；篡改 pin 时测试失败 | git revert |
| 2 | P1 字段补全 | 同一 query 对比：字段数变多 | git revert |
| 3 | P2 缓存限速 | 日志显示缓存命中；请求间隔达标 | 配置开关 |
| 4 | P3 新增源 | 新源结果出现在返回里 | 配置开关 |
| 5 | 架构拆分 | 测试全绿；行为不变 | git revert |
| 6 | P4 正文实验 | 延迟/token 实测对比数据 | 开关关闭 |

**每步独立提交，可单独回滚。**

**生效链（缺一不生效）**：改源目录 → 同步安装副本 → **重启 DSH**。
判据：`ps -eo pid,lstart,command | grep "DeepSeek Harness.app/Contents/MacOS"` 启动时间 **晚于** 安装副本 mtime。【B】

---

## 11. 我的推荐

**先做 1 + 2 + 3**（pin 测试 + 字段补全 + 缓存限速）。

理由：全部**低风险、有依据、立刻见效**。第 4、5 步（新增源、架构拆分）等前三步验证完再走。第 6 步用数据决策，不凭感觉。

---

## 附：测试基线

```bash
node --test "test/*.test.mjs"   # Node 23 必须用 glob，传目录会报 MODULE_NOT_FOUND
```
