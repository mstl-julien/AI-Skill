# 数据字典与口径（分析前必读）

> 本文档是消费采集产出的权威口径。**违反口径的分析结论一律无效。**

## 1. 产物清单

一次采集在 `DC_HOME/data/<runId>/` 下产出：

| 文件 | 内容 |
|---|---|
| `account.json` | 账号级字段（昵称/抖音号/认证/粉丝数/获赞/简介/身份表述/企业号）+ 内容结构 + 分页元信息 |
| `videos.json` | 作品列表（默认全量滚到 `has_more=0`，含点赞/话题/发布状态） |
| `selection_plan.json` | 选样计划（分组标准/各层命中数/候选预览，两段式采集的第一段产物） |
| `video_details.json` | 代表视频详情（时长/标题/话题/四项互动/发布时间/搜索词）+ 评论采集元信息 |
| `comments.json` | 扁平评论数组（评论人昵称/内容/时间/获赞/IP属地/回复数） |
| `collection_log.json` | 运行日志：错误清单、合规丢弃审计、接口命中统计、**完整性自检** |
| `../report/report-<runId>.html` | 人读数据查看页（深色主题） |

## 2. 完整性判读（最重要的一节）

### 2.1 权威信号是 `has_more`，不是条数、不是 `total`

**禁止**用「采到 N 条」或「覆盖率 X%」判断采没采完。

- 实测评论接口的 `total` **计入了楼中楼回复**，比顶层列表实际能返回的条数多。
  实证：多条视频「采到 16 / 接口声称 33」却 `has_more=0`、cursor 已到末页、滚了 8~11 轮才耗尽。
  拿 `total` 当分母会把「已采完」误判成「覆盖率不足」。

### 2.2 `comments_stop_reason` 三态（video_details.json 每条视频都有）

| 值 | 含义 | 判定 |
|---|---|---|
| `REACHED_SAMPLING_CAP` | 采到了采样上限（默认 20~50 条/视频） | **正常**。抽样是 Spec 设计，不是失败 |
| `LIST_EXHAUSTED` | 接口 `has_more=0`，列表真的到底 | **正常**，该视频评论已采全 |
| `NO_PROGRESS_HAS_MORE` | 滚不出新数据但接口 `has_more=1` | **唯一异常**。数据不可信，需重跑该账号 |

分析时只把 `NO_PROGRESS_HAS_MORE` 当失败，其余两种都是"数据可用"。

### 2.3 评论接口请求数 = 采集可靠性的旁证

`collection_log.json` → `api_seen.COMMENT_LIST`。
19 条代表视频正常需要 ≈90~115 次分页请求。**请求数异常偏低 + 错误数为 0 = 静默少采**（历史 bug 的特征：请求数 66~91 次 vs 正常 111~113 次）。落盘字段 `comment_traffic`（requests/responses 双侧流水）可用于核对。

### 2.4 作品列表完整性

**作品列表默认全量采集**（滚到接口 `has_more=0`，2026-09-23 拍板）。

- `account.json → homepage_meta.has_more`：
  - `0` = 列表真的到底，`works.collected` 就是该账号全部作品
  - `1` = **未到列表尽头**（被 `--max-videos` 限流、登录墙或滚动中断），此时：
    - 分析结论必须标注「仅基于已采 N 条」
    - 选样计划 `works.complete=false`，应先重跑第一段再分析
- `collection_log.json → list_incomplete` 存在 = 程序已如实标记未采全。
- 小账号验证记录：68 作品的账号实测 68/68 全采、`has_more=0`，「到底判定」可信。

## 3. 字段状态机（6 态）

每个关键字段在 `field_status` 里有状态标注：

| 状态 | 含义 | 分析时怎么用 |
|---|---|---|
| `AVAILABLE` | 采到且有值 | 可用 |
| `EMPTY` | 字段在但值为空（如无认证 → verification=null） | 可用，按"空值"解读 |
| `UNAVAILABLE` | 接口没给 | **禁用**，不得填 0、不得猜 |
| `NOT_VISIBLE` | 页面上根本不存在（如"大家都在搜"已下线） | 禁用，且不得写"采集失败" |
| `NOT_COLLECTED` | 本轮未要求采集 | 禁用 |
| `FAILED` | 采集动作失败 | 禁用，写进风险说明 |

## 4. 错误分类（9 类）

`collection_log.json → errors[]`，`error_type` 取值：
`PAGE_NOT_FOUND` / `LOGIN_REQUIRED` / `CAPTCHA` / `RATE_LIMIT` / `TIMEOUT` /
`ELEMENT_NOT_FOUND` / `NETWORK_ERROR` / `DATA_NOT_VISIBLE` / `UNKNOWN`。

注意：`page_errors`（页面自身 React 报错）是抖音页面噪音，**不计入**失败项。

## 5. 合规边界（字段为什么缺）

接口原始响应含 150~430 个字段，白名单闸门只放行页面公开展示的字段，
其余全部丢弃并留痕（`collection_log.json → dropped_fields`）。

其中**被合规拦截**（接口给了但页面不展示，属非公开数据，V0.1 永不采集）：
`statistics.play_count`（播放量）、`statistics.recommend_count`（推荐数）、
`statistics.admire_count`（赞赏数）、`video.bit_rate`、`video.play_addr`、
`video.download_addr`、`aweme_control`、`author.uid`、`author.sec_uid`。

**因此：任何"播放量/完播率"维度的对标分析在 V0.1 都做不了** —— 不是漏采，是合规红线。
点赞 / 评论 / 收藏 / 分享四项是页面公开展示的，可用。

## 6. 已知口径事实（实测，防重复踩坑）

- 「大家都在搜」模块已从抖音视频页下线（3 账号 × 19 视频 = 0 命中）；
  替代口径为**搜索框滚动推荐词**（`search_box_suggestions`，来源 `api/suggest_words`），两者严格分开。
- 抖音号以接口 `unique_id` 为准（人工截图转录会误读，实测 `yodd55` vs `ycdd55`）。
- 「企业号」与「认证」的判读（**90 于 2026-09-23 定，当晚修正**）：
  数据判据是 `verification_type`（已加入白名单）：**0=无认证；1=个人认证（黄V达人）；2=企业认证（蓝V）**。
  展示规则：type=2 → **企业号**（名后蓝V徽章）；type=1 或无标 → **个人号 / 达人号**（type=1 时标注"黄V个人认证"）。
  ⚠️ 旧规则"verification 非空即企业号"已废除——实测会把黄V达人误判成企业号（干饭兄弟案例：
  `custom_verify=""`、`enterprise_verify_reason=""`、`verification_type=1`，页面无蓝V，实为黄V达人）。
  `enterprise_verify_reason` 非空是蓝V的可靠旁证。⚠️ type=2 的语义来自抖音社区通用约定，
  当前三账号样本（0/1/0）均非蓝V，**采到真蓝V账号时需用探针复核一次**。
  `enterprise_account` / 电商权限字段只作原始数据留档，不参与类型判定。
- `identity_text` 是简介中**自述身份的抄录**（如「XX训练中心 老板」），不是 AI 推断；
  简介没有身份表述时为 null —— 这是如实记录，不是采集失败。
