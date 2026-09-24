# 抖音单视频全方位分析 Skill — 执行 Spec V0.2

> 本文件是 V0.2 完整规范存档。SKILL.md 只保留执行要点，细节以此为准。

**Skill名称：** `douyin-video-analysis`
**中文名称：** 抖音单视频全方位分析 Skill
**版本：** V0.2
**核心目标：** 对单条抖音视频进行从账号上下文、点击前包装、内容结构、观看心理、视频制作、互动传播、评论区、商业化到复制迁移的全方位逆向分析，并输出结构化 HTML 报告。

---

# 1. 本版本核心变更（四条强制规则）

## 规则一：用户补充信息必须在分析前完成
用户输入视频 URL 后，第一步不是分析，而是请求可选分析补充信息（默认配置 / 无 / 自定义）。完成后才进入登录流程。

## 规则二：所有分析必须先完成抖音登录
无论分析别人的视频还是自己的视频，都必须：打开抖音 → 等待用户登录 → 确认登录成功 → 再开始采集。不收集密码、不绕过验证。

## 规则三：视频抽帧固定为 10 FPS
每1秒抽10帧（frame_interval = 0.1s）。10秒→100帧，30秒→300帧。不得自行改成 1/2/5 FPS 或场景变化才抽帧。

## 规则四：评论区执行全量采集
不采用 20~50 条采样。获取登录状态下公开页面能访问到的全部评论（顶层 + 可展开回复 + 层级关系），直到没有新的可访问评论。无法全量时必须记录实际数量和失败原因（collection_status = PARTIAL）。

---

# 2. 整体流程

```
用户输入单视频URL
  → Stage 00 分析参数确认（默认/无/自定义）
  → Stage 01 抖音登录（等待+确认）
  → Stage 02 视频页面采集（video_url/video_id/title/hashtags/duration/publish_time/likes/comments/favorites/shares）
  → Stage 03 视频原始内容获取（可播放性判定）
  → Stage 04 10 FPS 抽帧
  → Stage 05 语音/字幕/文本提取（ASR 带时间戳 + OCR 屏幕文字）
  → Stage 06 全量评论区采集（遍历+展开回复+去重）
  → Stage 07 大家都在搜（search_keywords，与 hashtags 严格区分）
  → Stage 08~17 分析（点击前/内容/观看心理/内容工程/互动传播/评论区需求/数据/商业化/反向诊断/复制迁移）
  → Stage 18 五大结论
  → HTML 报告
```

---

# 3. 数据来源标注

所有原始数据带来源和采集时间：`VIDEO_PAGE / VIDEO_CONTENT / COMMENT_AREA / USER_PROVIDED / AI_ANALYSIS`。

---

# 4. 抽帧与镜头

- 10 FPS 是视觉观察采样率；镜头切分（Shot 01 / 00:00.0-00:02.4 …）是后续分析结果，两者不能混淆。
- 抽出的帧用于：封面、画面主体、人物、场景、产品、构图、字幕、屏幕文字、镜头变化、剪辑节点、时间轴分析。
- HTML 报告只展示关键帧（封面/首帧/Hook/镜头切换/重要节点/CTA），不展示全部帧。

---

# 5. 评论采集细节

- 字段：comment_id, parent_comment_id, user_nickname, user_avatar, content, publish_time, likes, ip_location, reply_count, has_replies。
- 去重：优先 comment_id；否则 昵称+内容+发布时间 临时键。
- 完整性记录：total_comments_collected / total_replies_collected / total_comment_nodes / collection_status（COMPLETE 仅当页面明确无更多评论；PARTIAL 须记录 collected_count / estimated_visible_count / reason）。
- 隐私：评论用户信息仅作为页面公开数据保存；不画像、不推测个人敏感属性；分析重点是内容/获赞/层级/时间。

---

# 6. 分析框架（Stage 08~17）

1. **点击前**：封面（视觉主体/构图/文字/情绪/悬念/账号统一性）、标题首屏（利益/痛点/冲突/好奇/身份/风险）、点击动机（Primary + Secondary Motive + Evidence）。
2. **内容**：选题拆解（大主题→细分→场景→问题→选题）、核心用户问题、核心价值、真实内容结构（以视频为准还原）。
3. **观看心理**：Hook（时间/类型/承诺/信息缺口）、情绪曲线（建立→放大→转折→释放）、认知机制（反常识/信息差/对比/悬念/损失厌恶…）、注意力机制 → Attention Map。
4. **内容工程**：语言、画面、逐镜头表（开始/结束/时长/景别/机位/运动/内容/台词/作用）、字幕、剪辑节奏 → Rhythm Map、声音。
5. **互动传播**：CTA、评论诱因、收藏机制、分享机制。
6. **评论区需求分析**（基于全量评论）：高频问题/关键词/共鸣/质疑/争议/补充/未满足需求/下一期期待 → 需求地图 → 潜在内容机会。
7. **数据表现**：公开模式（赞/评/藏/转）；无公开播放量时计算「互动结构」= 评论/点赞、收藏/点赞、分享/点赞（不称作互动率）。
8. **商业化**：商业目的、产品植入、商业承接链路（视频→评论→主页→橱窗→直播间）、内容价值与商业价值匹配。
9. **反向诊断**：Hook与正文不一致/承诺过高/信息过密/节奏问题/逻辑跳跃/视觉单调/植入突兀/CTA过强/证明不足等，须标注为 AI 分析判断。
10. **复制迁移**：可直接复制 / 可迁移（抽象成通用机制）/ 不可复制（身份/资源/独家）/ 核心机制一句话（通过【机制A】制造【心理结果】再通过【机制B】推动【用户行为】）/ 迁移建议（有目标赛道给≥3个方向，无则给通用模板）。

---

# 7. 证据与置信度体系

- 每个结论至少关联一类证据：Video Timeline / Comment / Metric / Screenshot-Frame / Original Text。
- 严格区分 FACT / OBSERVATION / INFERENCE。
- 结论带置信度 HIGH / MEDIUM / LOW（依据证据数量、质量、数据完整度、一致性）。

---

# 8. 数据完整度展示

报告必须显示：视频页面 / 视频 / 视觉 / 音频 / OCR / 评论 / 回复 / 搜索 / 用户后台 各项覆盖度（如 100% / 未提供），评论完整性单独显示。

---

# 9. HTML 报告要求

- 单文件、CSS/JS 内嵌、桌面端优先、双击可开。
- 33 个章节（01 报告摘要 … 33 数据与证据附录），模块化卡片、标签、图表、时间轴、可展开证据、评论筛选/搜索（全部/高赞/最新/问题/质疑/争议/高频关键词——分类为 AI 分析标签，原始评论保留）。
- 时间轴是报告核心：时间 + 语音 + 字幕 + 画面 + 镜头 + 情绪 + 认知机制 + 内容作用。

---

# 10. 数据 Schema

```json
{
  "task": { "video_url": "", "analysis_mode": "public_competitor", "user_context": { "analysis_goal": "", "target_niche": "", "account_positioning": "", "focus_points": "" } },
  "login": { "required": true, "status": "", "verified_at": "" },
  "video": { "video_id": "", "title": "", "hashtags": [], "duration": null, "publish_time": "" },
  "metrics": { "likes": null, "comments": null, "favorites": null, "shares": null },
  "media": { "visual_accessible": false, "audio_accessible": false, "frame_rate_analysis": 10, "frames_count": 0, "frames": [] },
  "transcript": [], "ocr": [], "shots": [],
  "comments": { "top_level": [], "replies": [], "total_nodes": 0, "collection_status": "" },
  "search": { "keywords": [] },
  "analysis": { "click": {}, "topic": {}, "value": {}, "structure": {}, "hook": {}, "emotion": {}, "cognition": {}, "attention": {}, "language": {}, "visual": {}, "shots": {}, "subtitles": {}, "editing": {}, "sound": {}, "interaction": {}, "comments": {}, "commercial": {}, "diagnosis": {}, "replication": {} },
  "evidence": [], "confidence": {},
  "collection": { "coverage": {}, "errors": [] }
}
```

---

# 11. 用户体验与验收

- 配置确认 + 登录两个前置动作完成后，剩余流程自动执行，不反复确认（除非登录失败/验证码/页面不可访问/视频无法读取）。
- V0.2 验收：① 输入 URL 后必须先要配置再分析；② 未登录不得分析；③ 采集标题/时长/话题/赞评藏转/发布时间（能得多少记多少）；④ 30秒视频约300帧；⑤ 全量评论遍历；⑥ 时间轴；⑦ 单文件 HTML。
- V0.2 不做：批量分析、多账号对比、自动仿写/发布/评论/点赞/关注。
- 版本路线：V0.3 准确率 → V0.4 账号上下文/多视频对比 → V0.5 机制迁移/脚本生成 → V1.0 固化为 Growth OS Content Reverse Engineering Skill。
