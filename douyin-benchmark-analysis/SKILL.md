---
name: douyin-benchmark-analysis
description: 抖音对标账号采集与对标分析。当用户给出抖音账号主页 URL 要求「跑这个账号 / 采集对标账号 / 对标分析 / 看看这个号」时使用。采集层通过真实浏览器被动监听接口，只采页面公开展示信息（账号资料、作品列表、单视频四项互动、公开评论），带完整性自检与合规丢弃审计；分析层产出对标报告与可迁移选题清单。不采集播放量/完播率/GMV 等非公开数据。
agent_created: true
---

# 抖音对标分析

## Overview

一个功能：**对标账号深度分析**。
（若用户只要「最近 N 条选题清单 + 数据统计」，改用 douyin-topic-stats 技能——那里更快、不采评论。）

全量作品 → 两段式采集（选样计划 → 确认门 → 代表视频详情 + 公开评论）→ 六节对标分析报告 + 可迁移选题清单。
耗时约 5~8 分钟（大账号更长）。

技术原理：浏览器（系统默认浏览器 / Edge / Chrome / 内置 Chromium）带着合法登录态正常访问页面，
只被动监听它自己发出的 `/aweme/v1/web/*` 接口响应；不构造签名、不重放请求。
数据经白名单闸门提取，超纲字段丢弃留痕。

## 环境准备（首次安装必做）

**第一步：环境自检 + 自动修依赖**（换机器 / 发给别人安装时，第一条命令永远是它）：

```bash
node scripts/check-env.js
```

自动检查并尽量自动修复：Node 版本（需 ≥18）、npm、playwright 依赖（缺失自动 npm install，npmmirror 源失败回退官方源）、
浏览器（依次找 Edge / Chrome，全无则自动下载 playwright 内置 Chromium 约 130MB）、
无图形环境提示（Linux 服务器需加 `--headless`）、登录态是否已存在。
退出码 0 = 就绪；1 = 存在需人工处理的阻塞项（按提示解决后重跑）。

各操作系统依赖安装细节（Node LTS / Edge 下载地址等）见 `references/install.md`。

**第二步：登录（强制，访客态不放行）**

```bash
export DC_HOME="<工作目录>/douyin-data"   # 建议放在当前任务目录下；Windows CMD 用 set DC_HOME=...
cd "<skill>/scripts/collector"
node collector.js --login                 # 弹出浏览器，扫码登录
```

采集命令在未登录时会**自动弹出扫码窗口并等待**（最长 10 分钟），登录确认后才开始采集；
等待超时则终止，绝不以访客态出数（访客态会被静默限流：作品卡首页、评论 5~10 条）。
登录态 profile 存 `$DC_HOME/browser-profile/`，含 Cookie，勿提交仓库、勿外传。

**第三步：离线自检（可选，22 项）**

```bash
node test/selftest.js
```

## Step 0：信息补充提示（收到账号 URL 后必须先做，不得直接开采）

用户发来抖音账号 URL 后，**先输出下面的提示块等待用户回复**，再进入第一段采集：

```
采集前请补充信息（可直接回复「无」或「默认」，全部按默认执行）：
1. 自身账号数据：是否提供自己账号的采集数据目录，用于报告第五节「与自身账号的差距」对比？
   （无 → 第五节标注"缺自身账号数据，无法对比"）
2. 分析侧重：默认「全面」（基本盘/内容结构/爆文要素/评论区/选题清单）。
   可指定侧重，如「只要爆文要素和评论区」「重点看可迁移选题」。
3. 代表视频数量：默认 19 条（置顶全收 + 高赞10 + 最新10 + 中位5 + 低赞5 去重）。
   可改数量或分组，如「12 条」「高赞加到 15」。
4. 其他关注点：有无特别想看的维度？（无 → 不加）
```

- 用户回复**「无」或「默认」** → 全按默认执行（19 条、全面分析、缺自身数据则第五节如实标注）
- 用户补充了信息 → 按补充执行（自身数据目录传给 `--from-plan` 流程后的分析层；数量/分组进采集参数）
- 提示块之后的流程不变：第一段全量作品+选样计划 → 确认门 → 第二段详情 → 分析 → rebuild 报告

## 采集（两段式，中间有一次用户确认）

### 第一段：全量作品 + 选样计划

```bash
cd "<skill>/scripts/collector"
node collector.js "https://www.douyin.com/user/<sec_uid>" --plan-only --detail-limit=19
```

- **作品列表默认全量**：一直滚到接口 `has_more=0`（90 于 2026-09-23 拍板）。大账号（如 1283 条）约需 3~5 分钟。
  需要限流时显式加 `--max-videos=N`。
- 第一段结束时输出**选样计划表**并落盘 `selection_plan.json`，内容含：
  - 账号、作品已采数 / 主页显示数 / 是否真的全量（`has_more`）
  - **选样标准**：按点赞表现分五组 —— pinned（置顶全收）/ high（点赞 Top N，默认 10）/
    latest（最新 N 条，默认 10）/ mid（点赞中位区间，默认 5）/ low（低点赞尾部，默认 5）；
    跨组去重顺序 pinned > high > latest > mid > low
  - 各组命中数、去重移除数、候选总数、拟采数量、评论抽样区间（20~50 条/视频）
  - 候选视频预览表（分组/点赞/标题）

### 确认门（必须停在这里等用户）

把计划表完整展示给用户，**等用户确认或调整后**才进入第二段。用户可调整：
- 数量：改 `--detail-limit=N`
- 标准：改分层配置 `--sampling=high:12,mid:4,low:4,latest:8,pinned:all`（数值或 `pinned:all`）
- 若计划里 `complete: false`（作品没滚到头），先告知用户并建议重跑第一段，不要直接续跑

### 第二段：从计划续跑详情

```bash
node collector.js --from-plan=<第一段的数据目录> --detail-limit=19
```

- 自动恢复作品列表状态，跳过主页/作品列表阶段，直接按已确认的标准采详情与评论。
- 也支持单段式一次跑完（跳过确认门，仅适合用户明确说"不用确认直接采"时）：
  `node collector.js <主页URL> --detail-limit=19`

### 采集完成后必做的完整性自检

读 `collection_log.json`，逐项核对（详见 `references/data-dictionary.md` §2）：

1. `errors[]` 里有无 `CAPTCHA` / `RATE_LIMIT` → 有则停止分析，先解决环境。
2. 每条视频 `comments_stop_reason` 是否为 `NO_PROGRESS_HAS_MORE` → **任何一条为该值，该账号数据不可信，重跑**。
3. `api_seen.COMMENT_LIST` 是否在合理区间（19 条代表视频 ≈90~115 次）。
4. `account.json → homepage_meta.has_more`：为 1 时（全量采集被中断/被限流），报告中必须写「作品列表未到列表尽头」。
5. `logged_in` 必须为 true。

## 分析（Step 6~7，产出必须回写进 HTML 报告）

1. 先读 `references/data-dictionary.md`（口径），再读 `references/analysis-framework.md`（报告结构与取数方式），最后读 `references/compliance.md`（红线）。
2. 按分析框架撰写 **`analysis.md`**（六节：账号基本盘 → 内容结构 → 爆文要素 → 评论区洞察 → 与自身账号差距 → 可迁移选题清单），存入本轮数据目录。
   **每个结论标注依据字段；缺失写「未采集」不填 0；播放量/完播率/GMV 维度不写；分析推断与数据事实分开标注。**
3. **必须回写报告**（否则 HTML 里只有采集数据、没有分析结论——这是报告的交付标准）：

```bash
node tools/rebuild-report.js <数据目录>
```

   重新生成的 HTML 报告为两层结构：一~七章采集事实（代码生成）+ 第八章「对标分析结论」（嵌入 analysis.md）。
   没写 analysis.md 时，第八章会显示醒目的占位提示，一眼能看出分析没做。

4. 多账号对标：跑多个账号后用 `tools/compare-accounts.js <dataDir1> <dataDir2> ...` 生成对照表。

**选样标注**：代表视频的分组（置顶/高赞/最新/中位/低赞）与标题会自动出现在报告的
「作品列表 → 选样列」和「代表视频详情 → 选样列 + 视频标题列」，无需手工维护。

## 故障排查（先探后改）

| 症状 | 工具 |
|---|---|
| 某接口突然采不到（抖音改版） | `node test/probe.js "<视频页URL>"` 列出页面实际发出的所有接口 |
| 评论只采到几条 | `DEBUG_COMMENTS=1` 重跑，看逐轮打点（moved / req+ / res+） |
| 需验证滚动/容器行为 | `test/probe-container.js <videoId>`（容器拓扑+逐个实测）、`test/probe-loop.js`（时序对照）、`test/probe-expand.js`（展开按钮 A/B） |
| 回退到旧逻辑做隔离验证 | `LEGACY_SLEEP=1` / `LEGACY_EXPAND=1` |

实测教训已固化在代码注释与 `data-dictionary.md` §6：评论「采没采完」只看 `has_more`（`total` 含楼中楼回复，不能当分母）；「企业号」与「蓝V认证」是两个概念；「大家都在搜」模块已下线，用搜索框推荐词做替代口径。

## Resources

- `scripts/check-env.js` — **首次安装必跑**：环境自检 + 自动修依赖（Node/npm/playwright/浏览器/登录态）
- `scripts/collector/` — 自包含采集器（collector.js + lib/ + tools/ + test/ + node_modules）
  - `collector.js` CLI 入口；`lib/collector.js` 核心采集器；`lib/spec.js` 全部规矩（白名单/状态机/阈值）；
    `lib/extract.js` 白名单提取闸门；`lib/report.js` HTML 报告（两层：采集事实 + 分析结论）
  - `tools/rebuild-report.js` 分析写入后重建报告；`tools/test-report.js` 单账号测试报告；
    `tools/compare-accounts.js` 多账号对照表；`tools/verify-report.js` 报告四项快速核对
- `references/install.md` — 跨平台安装指南（Windows/macOS/Linux，含手动排障）
- `references/data-dictionary.md` — 字段口径与完整性判读（分析前必读）
- `references/analysis-framework.md` — 对标分析框架与硬纪律
- `references/compliance.md` — 合规红线（采集侧+输出侧）
