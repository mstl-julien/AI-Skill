---
name: douyin-topic-stats
description: 抖音账号「最近 N 条视频选题清单 + 数据统计」快速采集。当用户要求「列出最近 100 条/200 条视频的选题」「统计这些视频的数据」「盘点选题」，或明确说不需要评论时使用该技能。只采作品列表（不进详情页、不采评论），产物为可排序 HTML：编号/标题/选题类型/完整发布年月日/点赞/评论/收藏/转发，含选题聚类汇总与 Top10。约 1 分钟完成。若用户要的是深度对标分析（含评论区洞察、对标报告、可迁移选题），改用 douyin-benchmark-analysis 技能。
agent_created: true
---

# 抖音选题清单与数据统计

## Overview

只做一件事：**快速盘一个抖音账号最近 N 条视频的选题与数据**。

- 只采作品列表（`--plan-only --max-videos=N`），**不进视频详情页、不采评论** —— 这是它比完整对标分析快 5 倍的原因
- 产出可排序 HTML：完整清单（编号｜标题｜选题类型｜完整年月日｜四项互动，点击表头即排序）+ 选题聚类汇总 + Top10
- 数据来源与完整对标分析器一致：真实浏览器被动监听抖音自身接口，只取页面公开展示字段，播放量/GMV 等不采不写

## 环境准备（首次安装必做）

```bash
node scripts/check-env.js
```

自动检查并修复：Node（≥18）、npm、playwright 依赖（缺失自动装）、浏览器（Edge/Chrome/Chromium 三选一自动探测或下载）、无图形环境提示、登录态提示。跨平台细节见 `references/install.md`。

## 使用流程

### 第一步：登录（强制，访客态不放行）

```bash
export DC_HOME="<工作目录>/douyin-data"     # Windows CMD: set DC_HOME=...；PowerShell: $env:DC_HOME=...
cd "<skill>/scripts/collector"
node collector.js --login                  # 扫码登录，profile 存 $DC_HOME/browser-profile/
```

采集命令在未登录时会**自动弹出扫码窗口等待**，检测到登录态后才开始采集；超时终止，绝不以访客态出数。

### 第二步：采集作品列表（默认最近 100 条）

```bash
node collector.js "<账号主页URL>" --plan-only --max-videos=100 --detail-limit=1
```

- `--max-videos=N` 限流作品数量（默认不限，滚到接口 `has_more=0`）。取最新 N 条时显式指定。
- 分页批次粒度约 18~20 条/轮，实采条数会**略超 N**（如 100 → 110），生成时自动截取前 N 条。
- 耗时约 30~60 秒（大账号略长）。产物在 `$DC_HOME/data/<runId>/`。

### 第三步：生成选题统计 HTML

```bash
node tools/gen-topic-stats.js <数据目录> 100
# 需要按标题句式定制聚类时，加第三个参数（规则文件）：
node tools/gen-topic-stats.js <数据目录> 100 ../../assets/topic-rules.example.json
```

- **默认聚类**：按每条视频的第一个"真正的主题标签"聚类（自动跳过账号自己的名字标签，如 #蓝战非）——零配置、通用于任何账号，但粒度偏粗
- **自定义聚类**：复制 `assets/topic-rules.example.json` 改成该账号的标题句式规则（正则 + 优先级，从上到下命中即归类），再作为第三个参数传入。
  换账号分析时**应当**定制，这是选题洞察质量的关键
- 产出 `<数据目录>/选题统计_最近N条.html`

## 产出说明

| 区块 | 内容 |
|---|---|
| 页头 | 账号类型（蓝V企业号 / 黄V个人认证 / 无认证）、粉丝、获赞、采集范围（完整年月日） |
| 一、总量统计 | 赞/评/藏/转 的合计与均值（四项均为页面公开展示数据） |
| 二、选题类型汇总 | 每类条数、点赞合计/均值、收藏、转发、评论 + 各类最佳单条 |
| 三、Top10 | 单条点赞前十 |
| 四、完整清单 | 全部 N 条，列序 **编号｜标题｜选题类型｜发布｜点赞｜评论｜收藏｜转发** |

- 发布列为**完整年月日**（YYYY/MM/DD），排序键用原始时间戳，跨月排序正确
- 标题可点击跳转抖音原页；置顶视频带「顶」标
- 发布、点赞、评论、收藏、转发 5 列**点击表头即排序**，再点切换升降序

## 数据口径与红线

- 四项互动（点赞/评论/收藏/转发）与发布时间均为抖音**页面公开展示**数据
- **播放量、完播率、GMV 等非公开字段一律不采集、不展示**（合规红线，不是能力限制）
- 选题类型是**基于标题/标签的规则聚类**，属分析判断；完整标题以跳转原页为准
- 需要"评论区洞察"时必须走 `douyin-benchmark-analysis`（评论数据在详情页阶段才产生）

## Resources

- `scripts/check-env.js` — 首次安装必跑：环境自检 + 自动修依赖
- `scripts/collector/` — 自包含采集器（collector.js + lib/ + tools/ + node_modules）
- `assets/topic-rules.example.json` — 自定义聚类规则模板（旅行类账号示例）
- `references/install.md` — 跨平台安装与手动排障
- `references/data-dictionary.md` — 字段口径、聚类规则写法、常见问题
