---
name: douyin-video-analysis
description: 抖音单视频全方位逆向分析。输入一条抖音视频 URL，按 V0.2 Spec 执行：分析配置确认 → 强制抖音登录 → 视频页面采集 → 10FPS 抽帧 → 语音/字幕/OCR → 全量评论区采集（含回复树，禁止采样）→ 大家都在搜 → 机制分析（点击前/内容/心理/工程/互动/商业化/诊断/迁移）→ 单文件 HTML 报告。当用户说"分析这条抖音视频""单视频拆解""逆向这个爆款"并给出 douyin.com 链接时使用本 skill。
version: 0.2.1
agent_created: true
---

# douyin-video-analysis — 抖音单视频全方位分析

对单条抖音视频做全方位逆向分析并输出单文件 HTML 报告。完整规范见 `references/spec-v0.2.md`（分析框架、证据体系、33 章报告结构、数据 Schema 全在那一层，本文件只管执行）。

- **需求—执行追溯**：`references/requirements-traceability.md`（三批优化需求 → 根因 → 修复 → 验证，含 3 起维护事故教训，改脚本前必读）。

## 七条铁律（V0.2 强制）

1. **先配置后分析**：用户给 URL 后，第一步必须用 AskUserQuestion 问分析配置（使用默认配置=全面分析 / 无补充信息=不假设赛道只给通用迁移模板 / 自定义补充：分析目的、目标赛道、账号定位、重点关注、希望复制的方向）。禁止收到 URL 直接开跑。
2. **先登录后采集**：无论别人的还是自己的视频，必须检测抖音登录态；未登录时弹出浏览器等用户扫码，确认 `is_logged_in` 成功后才进入采集。不收集密码、不碰验证码、不绕过风控。
3. **抽帧规则 V3-规范版**（2026-09-24 集成《通用关键帧抽取规则_V3.md》，现行）：
   - **算法**：状态机「采样 → 首帧保留 → 逐帧 {A 硬切检测 → B 冷却窗 → C 与场景锚点比软变化 → D 长镜头兜底} → 末帧保留」；
   - **A 硬切**：独立通道，标准巴氏距离 `sqrt(1-Σ√(h1·h2))`（64 bin 灰度直方图）。**禁止用软变化阈值判硬切**；
   - **B 冷却窗**：距上一保留帧 < `REFRACTORY_SEC` 丢弃（硬切不受限）；
   - **C 软变化**：比的是**场景锚点**（场景内不更新），**不是上一保留帧**（旧版反模式：慢摇/慢动作会链式漏过）；指标二选一 —— 真 SSIM（1=相同，`<SSIM_KEEP_BELOW` 算变化）或 pHash 汉明距离（`--soft-metric phash`）；受 `MAX_EVENT_PER_SCENE` 上限约束；
   - **D 兜底**：场景超 `LONG_SCENE_SEC` 且未补中点 → 补 1 个中点锚点；
   - **OCR 边界**：只能用于"丢弃确认"，**禁止因 OCR 变化新增帧**；保留帧 OCR 仅作报告附加展示；
   - **参数档（§7）**：talking_head(2FPS/2.5s/2) / fast_cut(5FPS/1.0s/2) / tutorial(3FPS/2.0s/3) / static_monitor(1FPS/5.0s/1) / generic(3FPS/2.0s/2)，用 `--type` 选择；
   - **★ 两项工程校准（不改规范语义，只做量纲与档位适配，实测依据见脚本头注释）**：
     - ① **硬切阈值量纲校准**：规范 `HARD_CUT_TH=0.85` 是理论区间写法，实测实拍视频巴氏距离 max 仅 ~0.46 → 直接套会永不触发。改为**自适应分位**：`cut_th = max(p95分位, 0.85×max×0.6)`；视频2 实测 p95=0.3069 → **17 硬切点**，与独立信号（10FPS SSIM<0.5 深谷）检出的「17 镜」相互印证。可用 `--hard-cut-th` 显式覆盖；
     - ② **SSIM 档位标定**：规范 `SSIM_KEEP_BELOW=0.93` 按静态机位标定；实测手持实拍视频同镜头内相邻 1/3 秒帧 SSIM 仅 0.53~0.61、场景内相对锚点中位数低至 0.17 → 0.93/0.55 均无区分度。故按机位动态性分档（静态 0.93 / 通用 0.85 / 动态 0.55），并运行时自检：场景内 SSIM 中位数 < 阈值-0.25 时输出 `ssim_channel_effective=false`，如实标注「软通道无区分度，主判定退化为硬切+冷却窗+事件上限」；
   - **脚本**：`scripts/keyframe_select.py`（V3 状态机，skimage SSIM + cv2 直方图/pHash，输出 `keyframes.json` + `keyframes.log.json` 决策日志 + §8 七项自检）+ `extract_frames.py`（任意 fps）。
4. **评论全量采集**：遍历到页面无更多可访问评论为止（含全部可展开回复）。只允许两种结束状态：`COMPLETE`（接口 has_more=0）或 `PARTIAL`（记录 collected_count / estimated_visible_count / reason）。禁止把"采了 50 条"说成全量。
5. **24 章必须含脚本文案公式**（2026-09-24 定为硬性规范）：
   - `analysis.replication.script_formula` 为**必填**字段，结构 `{title, formula:[{slot,text,rule}], dual_track_rule}`；
   - 槽位需覆盖完整脚本链路（钩子位 / 建立位 / 冲突位 / 兑现位 / 结尾钩子位），每槽位给「文案模板 + 使用规则」；
   - **兜底**：若数据缺失，`build_report.py` 会按本案例特征自动推导通用骨架并渲染，同时打「自动推导」徽章 + 明示来源。
     **任何情况下 24 章都不得缺少该区块**；分析阶段应主动产出真实公式，不要依赖兜底。
6. **封面 = 视频文件第 1 帧直接解码**（2026-09-24 定为硬性规范）：
   - **禁止用抽帧法/抽帧目录取封面**（抽帧目录是按固定 FPS 重采样的产物，存在时间偏移与压缩损失，
     实测与真实首帧 SSIM 仅 0.76、平均像素差 17.3）；
   - 必须用 `scripts/extract_cover.py <video> -o cover.png --meta cover.json` 直解 `frame_index=0`；
   - 报告 06 章封面图引用独立 `cover.png`，说明文字标注「视频文件直接解码的第 1 帧」；
     找不到 cover.png 时才回退抽帧首帧，并在报告中**橙色标注回退原因**。
7. **章节必须按标题编号升序排列**（2026-09-24 定为硬性规范）：
   - 各章分散在多个渲染函数里拼接，**拼接序 ≠ 编号序**（如「25 互动结构」会被拼到「05」后面）。`build_report.py` 尾部
     `reorder_cards_by_number(doc)` 已自动按 `<h3>` 编号（`\d+[a-z]?`）重排顶层 card，**无需人工干预**；
   - 无编号的系统卡（`关键帧与机器分析` / `keyframe_timeline` / `voiceover` / `CTA 与互动机制`）由 `_ANCHOR_SLOT`
     锚定到宿主章节之后（4.5 / 13.5 / 17.5 / 21.5）；
   - **⚠️ 维护陷阱**：顶层 card 有两种写法 —— `block()` 产出 `class='card'`（**单引号**），doc 硬编码为 `class="card"`（**双引号**）。
     切分正则必须写成 `r'''<div\b[^>]*class=['"]card['"]'''`；只匹配一种引号会导致大半章节被静默丢弃（曾出现 36 章只剩 6 章）。
     改完必须验证：`章节 card 数` 与改动前一致 且 `排序乱序项 = 0`。

## 资产与运行环境

- **浏览器登录态**：复用 `D:/julien/workbuddy/临时任务/douyin-collector/browser-profile/`（658M，已登录）。默认直接用，可用环境变量 `DVA_PROFILE_DIR` 覆盖。⚠️ 与 douyin-benchmark-analysis 共用同一 profile，两者不可同时运行（Chromium profile 锁）。
- **采集器**：`scripts/video-collector/`（Playwright，被动监听 `aweme/detail`、`comment/list`、`comment/list/reply` 接口 + DOM 滚动兜底）。
- **抽帧**：`scripts/extract_frames.py`（用 imageio-ffmpeg 自带 ffmpeg，`-vf fps=N`，默认按 `--type` 档位取 1~5FPS）。关键帧抽取见铁律 3。
- **封面**：`scripts/extract_cover.py`（直接解码视频第 1 帧，`frame_index=0`，无损 PNG + 元信息）。见铁律 6。
- **抽帧规范原文**：`references/keyframe-spec-v3.md`（《通用关键帧抽取规则_V3.md》归档，改算法前必读）。
- **OCR**：`scripts/ocr_frames.py`（rapidocr-onnxruntime，逐帧全量扫描 → ocr.json）。HF 下载被墙时设 `HF_ENDPOINT` 无效——直接 curl `https://hf-mirror.com/<repo>/resolve/main/<file>` 手动拉。
- **ASR**：`scripts/asr_transcribe.py`（faster-whisper，--model 可传本地模型目录）。建议 small（463MB）起步；huggingface_hub 下载器拉不动大文件，用 curl 手动下 model.bin/config.json/tokenizer.json/vocabulary.txt/preprocessor_config.json 到本地目录再传路径。不编造转写：speech_detected=false 就如实记录。
- **报告生成**：`scripts/build_report.py`（data.json + analysis.json → 单文件 HTML；同目录 asr.json/ocr.json 自动加载；V0.2.1 起分析章节为专用可读渲染，评论区为抖音原版式，时间轴带镜头缩略图；输出前自动按章节编号重排，见铁律 7）。
- **交付前自检**：`scripts/verify_report.py <report.html>`（章节数 / 排序 / 图片 / 五区块齐全性，退出码 0 = 可交付）。见 Stage 11。
- **产物目录**：一律落 Skill 外 —— `<workspace>/video-analysis/<run_id>/`（data / frames / video.mp4 / report）。

## 执行流程

### Stage 00 配置确认
识别 URL 中的 video_id（`/video/(\d+)`、`/note/(\d+)`、`/modal/(\d+)`；短链 v.douyin.com 先解析跳转）。输出配置确认界面（AskUserQuestion）。

### Stage 01 登录
```bash
cd .workbuddy/skills/douyin-video-analysis/scripts/video-collector
node collect.js --url=<URL>          # 未登录会自动弹浏览器等扫码，登录成功自动继续
```
登录检测：douyin.com cookies 含 `sessionid/sessionid_ss/sid_tt`。超时（10 分钟）则终止，不访客态采集（访客态实测评论被限流到个位数）。

### Stage 02~07 采集（一条命令完成）
同上命令自动完成：视频详情（标题/话题/时长/发布时间/赞评藏转）→ 视频文件下载（play_addr，失败如实记录）→ 全量评论+回复树（has_more 驱动 + 展开回复点击）→ 大家都在搜（DOM 抓取，抓不到记 PARTIAL）。产出 `data.json`。

### Stage 04 抽帧 + 封面
```bash
# ① 封面：直接解码视频第 1 帧（铁律 6，禁止用抽帧目录帧）
<managed-python> scripts/extract_cover.py <run_dir>/video.mp4 -o <run_dir>/cover.png --meta <run_dir>/cover.json

# ② 基础采样：按类型档位取 FPS（V3 规范 §5.1，默认 3FPS）
<managed-python> scripts/extract_frames.py <run_dir>/video.mp4 <run_dir>/frames3 --fps 3

# ③ 关键帧：V3 状态机（铁律 3）
<managed-python> scripts/keyframe_select.py <run_dir>/frames3 -o <run_dir>/keyframes.json \
    --type <fast_cut|talking_head|tutorial|static_monitor|generic> --ocr <run_dir>/ocr.json
```
核对帧数 ≈ duration×采样FPS。视频下载失败时记录 `visual_accessible=false`，不得伪造帧。
关键帧抽取后核对 `selfcheck`（密度应落 10~40/分钟、冷却违规 0、场景超限 0）；若输出
`ssim_channel_effective=false`，须在报告中如实标注软通道无区分度。

### Stage 05 ASR/OCR
- OCR：`<managed-python> scripts/ocr_frames.py <frames3_dir> -o ocr.json`（rapidocr，对基础采样帧全量扫描；
  帧目录口径必须与关键帧一致，避免时间轴口播/字幕错位）。
- ASR：先用 ffmpeg 抽音频（`-vn -ac 1 -ar 16000`），再 `<managed-python> scripts/asr_transcribe.py audio.mp3 -o asr.json --model <本地模型目录>`。
- 口播文案：ASR 原始转写 + OCR 字幕对齐校正（校正词标 *，依据写进 correction_note）；口播里有没有、OCR 里没有的句子（如「宽松版型太显壮」）按语义校正保留并标注。

### Stage 08~17 分析 + Stage 18 结论
由 agent 按 `references/spec-v0.2.md` §6 的十块分析框架执行，逐条结论绑证据（Timeline/Comment/Metric/Frame/Original Text），区分 FACT/OBSERVATION/INFERENCE，标置信度 HIGH/MEDIUM/LOW。结果写入 `analysis.json`（结构见 spec §10 的 `analysis` 节点）。

### Stage 11 HTML 报告
```bash
<managed-python> scripts/build_report.py <run_dir>/data.json <run_dir>/analysis.json -o <run_dir>/report/report.html
```
单文件、CSS/JS 内嵌、桌面端优先。必含：时间轴、33 章节（可按数据完整度合并）、全量评论表（筛选：全部/高赞/最新/AI 标签 + 搜索框，原始评论保留）、评论完整性单独显示、数据完整度矩阵、关键帧展示（不放全量帧仓库）。

**交付前必查（三条硬性规范）**：
1. 24 章存在「脚本文案公式」区块（铁律 5）——若显示「自动推导」徽章，说明分析阶段漏产出，应补写真实公式后重生成；
2. 06 章封面引用 `<run_dir>/cover.png` 且说明为「视频文件直接解码的第 1 帧」（铁律 6）——不得是抽帧目录帧；
3. 章节按编号升序（铁律 7）——跑一次自动自检，全绿才交付：
```bash
<managed-python> scripts/verify_report.py <run_dir>/report/report.html
```
自检口径：章节 card 数（~36，过少即 card 切分正则漏匹配引号）、排序乱序项=0、img 缺 src=0、
V3 状态机 / 脚本文案公式 / 直解封面 / 抽帧自检徽章 / 软通道告警五区块齐全。退出码 0 = ALL PASS。
最后用 present_files 交付。

## 口径红线

- 播放量/完播率/GMV 后台数据不采不写（公开页面拿不到就是拿不到）。
- 无公开播放量时只算「互动结构」（评论/点赞、收藏/点赞、分享/点赞），不叫互动率。
- 「大家都在搜」关键词与 hashtags 严格分开两个字段。
- 反向诊断结论必须标注"AI 分析判断，非客观事实"。
- 评论用户不画像、不推测敏感属性。

## 已知坑（来自 douyin-collector 实战）

- 评论分页竞态：滚动后必须等评论接口响应真回来再数条数，sleep 固定时长会静默少采（has_more=1 但响应未落地）。
- 评论区滚动要用真实鼠标滚轮悬停在评论容器上，`window.scroll` 无效。
- 启动优先 Edge/Chrome channel（系统默认浏览器优先），`--disable-blink-features=AutomationControlled`，viewport 跟随窗口。
- 无头模式易被风控，默认有头。
