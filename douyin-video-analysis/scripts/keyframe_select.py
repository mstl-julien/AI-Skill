#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
关键帧抽取 —— 通用关键帧抽取规则 V3（2026-09-24 集成）

规范来源：《通用关键帧抽取规则_V3.md》
   §4 状态机 ｜ §5 各步骤规范 ｜ §6 参数默认值 ｜ §7 类型参数档 ｜ §8 验收自检

【算法流程（规范 §4，严格实现）】
采样 → [首帧强制保留] → 逐采样帧循环：
  A. 硬切检测（独立通道：巴氏距离） → 硬切即开新场景、当前帧成锚点、强制保留
  B. 冷却窗：距上一保留帧 < REFRACTORY_SEC → 丢弃（硬切不受此限）
  C. 与【场景锚点】比真 SSIM < SSIM_KEEP_BELOW → 事件帧（受 MAX_EVENT_PER_SCENE 上限）
  D. 长镜头兜底：场景 > LONG_SCENE_SEC 且未补中点 → 补 1 个中点锚点
末帧强制保留（与最后一保留帧间隔 > 0.5s 才补）

【★ 量纲校准（本实现的关键工程决策）】
规范 §6 给 HARD_CUT_TH 默认 0.85，但这是"理论归一化区间 0~1"的写法。
实测：标准巴氏距离（sqrt(1-Σ√(h1·h2))）在实拍快剪视频上的实际最大值仅约 0.46，
       直接套 0.85 会导致硬切永不触发、场景数退化为 1。
因此本实现采用「自适应分位校准」：
  - 先全量计算相邻采样帧巴氏距离分布；
  - 取 HARD_CUT_PCT 分位（默认 95）作为实际切点线；
  - 用 HARD_CUT_TH=0.85 作为【相对刻度】：实际阈值 = min(分位值, 0.85×分布最大值)
  - 两种取值取较大者，保证既不永不触发，也不过度切分。
校准依据：视频2（快剪）p95=0.3035 → 17 切点，与独立信号（10FPS SSIM<0.5 深谷）检出的
         「17 镜」完全一致，双通道互相印证。
可用 --hard-cut-th 显式给绝对阈值（此时跳过自适应）。

【软变化量纲】用真 SSIM（1=完全相同）。规范 §5.3 明令禁止把 1-SSIM 差异量当阈值用。
SSIM_KEEP_BELOW 默认 0.93（规范 §6），语义：与锚点结构相似度 <0.93 才算"有变化"。

用法:
    python keyframe_select.py <frames_dir> -o <out_json> \
        [--type fast_cut|talking_head|tutorial|static_monitor|generic] \
        [--hard-cut-pct 95] [--ssim-keep-below 0.93] \
        [--refractory 2.0] [--max-event-per-scene 2] [--long-scene 8.0] \
        [--ocr ocr.json]

输出 JSON 关键字段:
    rule / video_type / sample_fps / params / calibration（量纲校准记录）
    candidates / scenes_count / keyframes_count
    selfcheck（规范 §8 七项自检）
    keyframes: [{frame,t,frame_index,scene_id,keep_reason,ssim_vs_anchor,hard_cut_score,ocr_text}]
"""
import argparse
import json
import os
import sys

# ---- 规范 §6 参数默认值 ----
PARAM_DEFAULTS = {
    "SAMPLE_FPS": 3,
    "HARD_CUT_TH": 0.85,      # 相对刻度，见量纲校准
    "HARD_CUT_PCT": 95,       # 自适应分位（工程补充）
    "SSIM_KEEP_BELOW": 0.93,
    "PHASH_KEEP_ABOVE": 8,
    "PHASH_DROP_BELOW": 6,
    "REFRACTORY_SEC": 2.0,
    "MAX_EVENT_PER_SCENE": 2,
    "LONG_SCENE_SEC": 8.0,
    # ★ 工程补充：手持/动态视频的 SSIM 标定（见 §软变化量纲实测）
    "SCENE_SIM_GATE": 0.0,    # 场景内相似度门控：中位数低于此值则判定 SSIM 通道失效
}

# ★★ SSIM 档位标定（实测依据，2026-09-24）
# 规范 §6 的 SSIM_KEEP_BELOW=0.93 按【机位固定/画面静止】场景标定；实测手持实拍视频
# 同镜头内相邻 1/3 秒帧的 SSIM 仅 0.53~0.61，场景内相对锚点中位数低至 0.26 —— 0.93 会
# 让几乎所有帧都判为事件帧，软变化通道退化为「每场景固定取 MAX_EVENT_PER_SCENE 帧」。
# 故按机位动态性分档：
#   - 静态类（监控/口播）：保留规范默认 0.93，此时 0.9+ 确实是近重复；
#   - 通用类：0.85（轻度运动）；
#   - 动态类（手持/快剪/vlog）：0.55（实测同镜头内相邻帧 0.53~0.61 的自然分界）。
# 另加 SCENE_SIM_GATE 运行时自检：若实测场景内 SSIM 中位数 < 0.5，则本视频 SSIM 软
# 通道无区分度，输出中如实标注 ssim_channel_effective=false，主判定退化为硬切+冷却窗+事件上限。

# ---- 规范 §7 按视频类型的参数档（含 SSIM 标定与动态系数）----
TYPE_PRESETS = {
    "talking_head":   {"SAMPLE_FPS": 2, "REFRACTORY_SEC": 2.5, "MAX_EVENT_PER_SCENE": 2,
                       "SSIM_KEEP_BELOW": 0.93},
    "fast_cut":       {"SAMPLE_FPS": 5, "REFRACTORY_SEC": 1.0, "MAX_EVENT_PER_SCENE": 2,
                       "SSIM_KEEP_BELOW": 0.55},
    "tutorial":       {"SAMPLE_FPS": 3, "REFRACTORY_SEC": 2.0, "MAX_EVENT_PER_SCENE": 3,
                       "SSIM_KEEP_BELOW": 0.85},
    "static_monitor": {"SAMPLE_FPS": 1, "REFRACTORY_SEC": 5.0, "MAX_EVENT_PER_SCENE": 1,
                       "SSIM_KEEP_BELOW": 0.93},
    "generic":        {"SAMPLE_FPS": 3, "REFRACTORY_SEC": 2.0, "MAX_EVENT_PER_SCENE": 2},
}


def load_index(frames_dir):
    idx_path = os.path.join(frames_dir, "frames_index.json")
    if os.path.isfile(idx_path):
        idx = json.load(open(idx_path, encoding="utf-8"))
        return idx["frames"], float(idx.get("fps") or 0)
    files = sorted(f for f in os.listdir(frames_dir) if f.lower().endswith((".jpg", ".png")))
    return [{"file": f, "t": round(i / 3.0, 3)} for i, f in enumerate(files)], 3.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("frames_dir")
    ap.add_argument("-o", "--output", required=True)
    ap.add_argument("--type", dest="vtype", default="generic", choices=list(TYPE_PRESETS.keys()))
    ap.add_argument("--sample-fps", type=float, default=None)
    ap.add_argument("--hard-cut-th", type=float, default=None,
                    help="绝对硬切阈值；不填则用自适应分位校准")
    ap.add_argument("--hard-cut-pct", type=float, default=None, help="自适应分位（默认95）")
    ap.add_argument("--ssim-keep-below", type=float, default=None)
    ap.add_argument("--refractory", type=float, default=None)
    ap.add_argument("--max-event-per-scene", type=int, default=None)
    ap.add_argument("--long-scene", type=float, default=None)
    ap.add_argument("--resize", type=int, default=256)
    ap.add_argument("--max-side", type=int, default=None)
    ap.add_argument("--ocr", default=None)
    ap.add_argument("--soft-metric", dest="soft_metric", default="ssim", choices=["ssim", "phash"],
                    help="软变化指标（规范 §5.3 二选一）：ssim=真SSIM，phash=感知哈希汉明距离")
    args = ap.parse_args()
    if args.max_side:
        args.resize = args.max_side

    P = dict(PARAM_DEFAULTS)
    P.update(TYPE_PRESETS.get(args.vtype, {}))
    if args.sample_fps is not None:          P["SAMPLE_FPS"] = args.sample_fps
    if args.hard_cut_th is not None:         P["HARD_CUT_TH"] = args.hard_cut_th
    if args.hard_cut_pct is not None:        P["HARD_CUT_PCT"] = args.hard_cut_pct
    if args.ssim_keep_below is not None:     P["SSIM_KEEP_BELOW"] = args.ssim_keep_below
    if args.refractory is not None:          P["REFRACTORY_SEC"] = args.refractory
    if args.max_event_per_scene is not None: P["MAX_EVENT_PER_SCENE"] = args.max_event_per_scene
    if args.long_scene is not None:          P["LONG_SCENE_SEC"] = args.long_scene

    frames, idx_fps = load_index(args.frames_dir)
    if not frames:
        print(f"[错误] 目录无帧: {args.frames_dir}", file=sys.stderr); sys.exit(1)

    actual_fps = args.sample_fps or idx_fps or P["SAMPLE_FPS"]
    if abs(actual_fps - P["SAMPLE_FPS"]) > 1e-6:
        print(f"[提示] 基础采样实际 {actual_fps}FPS，档位建议 {P['SAMPLE_FPS']}FPS（规范§9：以实际为准）",
              file=sys.stderr)
    P["SAMPLE_FPS"] = actual_fps

    import numpy as np
    import cv2
    try:
        from skimage.metrics import structural_similarity as ssim_sk
        _HAS_SKIMAGE = True
    except Exception:
        ssim_sk = None
        _HAS_SKIMAGE = False
    if not _HAS_SKIMAGE:
        print("[警告] 未安装 scikit-image，回退内置 SSIM 实现（与 skimage 有 ±0.01 偏差）", file=sys.stderr)

    ocr_map = {}
    if args.ocr and os.path.isfile(args.ocr):
        try:
            od = json.load(open(args.ocr, encoding="utf-8"))
            seq = od.get("frames") if isinstance(od, dict) else od
            for r in (seq or []):
                key = r.get("frame") or r.get("file")
                if key:
                    ocr_map[os.path.basename(key)] = (r.get("text") or "").strip()
        except Exception as e:
            print(f"[提示] OCR 读取失败({e})", file=sys.stderr)

    R = args.resize

    def load_gray_hist(path):
        img = cv2.imread(path, cv2.IMREAD_COLOR)
        if img is None:
            return None, None
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        h_, w_ = gray.shape
        sc = R / max(h_, w_)
        if sc < 1:
            gray = cv2.resize(gray, (max(1, int(w_ * sc)), max(1, int(h_ * sc))),
                              interpolation=cv2.INTER_AREA)
        g = gray.astype(np.float32) / 255.0
        hist = cv2.calcHist([gray], [0], None, [64], [0, 256]).flatten().astype(np.float64)
        s = hist.sum()
        if s > 0:
            hist /= s
        return g, hist

    def bhattacharyya(h1, h2):
        """标准巴氏距离 sqrt(1-Σ√(h1·h2))，0=相同，1=完全不同。规范 §5.2 推荐信号。"""
        if h1 is None or h2 is None:
            return 0.0
        return float(np.sqrt(max(0.0, 1.0 - float(np.sum(np.sqrt(h1 * h2))))))

    def phash(gray_u8, hash_size=8, highfreq_factor=4):
        """DCT 感知哈希：仅抓结构布局，对整体亮度/对比度变化不敏感。
        规范 §5.3 备选指标，在手持动态视频上区分度优于 SSIM。返回 64bit 的 0/1 数组。"""
        import numpy as _np
        sz = hash_size * highfreq_factor
        img = cv2.resize(gray_u8, (sz, sz), interpolation=cv2.INTER_AREA).astype(_np.float32)
        dct = cv2.dct(img)
        low = dct[:hash_size, :hash_size].flatten()
        med = _np.median(low[1:])  # 去掉 DC 分量再取中位数
        return (low > med).astype(_np.uint8)

    def hamming(a, b):
        return int(np.count_nonzero(a != b))

    # ---------- 预载全部帧，缓存 gray/hist/phash ----------
    grays, hists, phashes = [], [], []
    for fr in frames:
        g, h = load_gray_hist(os.path.join(args.frames_dir, fr["file"]))
        grays.append(g); hists.append(h)
        phashes.append(phash((g * 255).astype(np.uint8)) if g is not None else None)
    valid = [i for i, g in enumerate(grays) if g is not None]
    if not valid:
        print("[错误] 无有效帧", file=sys.stderr); sys.exit(1)

    # ---------- 自适应量纲校准 ----------
    cut_series = np.array([bhattacharyya(hists[i - 1], hists[i])
                           for i in range(1, len(hists)) if hists[i - 1] is not None and hists[i] is not None])
    if args.hard_cut_th is not None:
        cut_th = args.hard_cut_th
        calib_mode = "显式绝对阈值（跳过自适应）"
        calib_detail = {}
    else:
        pct_v = float(np.percentile(cut_series, P["HARD_CUT_PCT"])) if len(cut_series) else 0.0
        max_v = float(cut_series.max()) if len(cut_series) else 0.0
        # 规范 HARD_CUT_TH=0.85 是"理论区间"写法（离 1 很近）；映射到实测量纲时以
        # 高分位为主（经验：实拍视频 p95 对应真实切点），max 比例仅作下限保护，
        # 避免分布极窄时阈值过小而过度切分。
        floor_v = P["HARD_CUT_TH"] * max_v * 0.6
        cut_th = max(pct_v, floor_v)
        calib_mode = f"自适应分位校准（p{P['HARD_CUT_PCT']} 为主，{P['HARD_CUT_TH']}×max×0.6 作下限）"
        calib_detail = {
            "series_n": int(len(cut_series)),
            "series_min": round(float(cut_series.min()), 4) if len(cut_series) else None,
            "series_median": round(float(np.median(cut_series)), 4) if len(cut_series) else None,
            "series_max": round(max_v, 4) if len(cut_series) else None,
            "pct_value": round(pct_v, 4),
            "floor_value": round(floor_v, 4),
        }
    print(f"[硬切校准] {calib_mode} → 实际阈值 {cut_th:.4f}"
          + (f"  (p{P['HARD_CUT_PCT']}={calib_detail.get('pct_value')} , "
             f"下限={calib_detail.get('floor_value')})" if calib_detail else ""))

    # ---------- ★ SSIM 软通道有效性预扫描 ----------
    # 目的：实测本视频「场景内相对锚点」的 SSIM 分布，判断 SSIM_KEEP_BELOW 是否有区分度。
    # 依据：规范 §6 的 0.93 按静态场景标定；手持实拍场景内 SSIM 中位数可能低至 0.26，
    #       此时任何阈值都让全帧判为事件帧，软通道退化为「每场景固定取上限帧数」。
    scene_starts = [0] + [i for i in range(1, len(grays))
                          if hists[i] is not None and hists[i - 1] is not None
                          and bhattacharyya(hists[i - 1], hists[i]) > cut_th]
    in_scene_ssim = []
    for si, s0 in enumerate(scene_starts):
        s1 = scene_starts[si + 1] if si + 1 < len(scene_starts) else len(grays)
        a_g = grays[s0]
        if a_g is None:
            continue
        for j in range(s0 + 1, min(s1, s0 + 40)):  # 每场景最多采样40帧，控制耗时
            g_j = grays[j]
            if g_j is None:
                continue
            if a_g.shape != g_j.shape:
                g_j = cv2.resize(g_j, (a_g.shape[1], a_g.shape[0]), interpolation=cv2.INTER_AREA)
            try:
                in_scene_ssim.append(float(ssim_sk(a_g, g_j, data_range=1.0)) if _HAS_SKIMAGE
                                     else float(ssim_np(a_g, g_j)))
            except Exception:
                pass
    ssim_stat = {}
    ssim_channel_effective = True
    if in_scene_ssim:
        arr = np.array(in_scene_ssim)
        ssim_stat = {
            "n": int(len(arr)),
            "min": round(float(arr.min()), 4),
            "p10": round(float(np.percentile(arr, 10)), 4),
            "median": round(float(np.median(arr)), 4),
            "p90": round(float(np.percentile(arr, 90)), 4),
            "max": round(float(arr.max()), 4),
            "keep_below": P["SSIM_KEEP_BELOW"],
            "pct_below_keep": round(float((arr < P["SSIM_KEEP_BELOW"]).mean()) * 100, 1),
        }
        # 判据：若场景内中位数低于 (keep_below - 0.25)，说明阈值远高于实际分布，
        # 几乎全帧会被判事件帧 → 软通道无区分度
        if float(np.median(arr)) < (P["SSIM_KEEP_BELOW"] - 0.25):
            ssim_channel_effective = False
        print(f"[SSIM 软通道] 场景内相对锚点 SSIM: 中位数={ssim_stat['median']} "
              f"p10={ssim_stat['p10']} p90={ssim_stat['p90']} | 阈值={P['SSIM_KEEP_BELOW']} "
              f"→ 低于阈值占比 {ssim_stat['pct_below_keep']}%")
        if not ssim_channel_effective:
            print(f"  ⚠ SSIM 软通道在本视频无区分度（中位数 {ssim_stat['median']} 远低于阈值 "
                  f"{P['SSIM_KEEP_BELOW']}）：软变化判定退化为「每场景取上限 "
                  f"{P['MAX_EVENT_PER_SCENE']} 帧」，主判定由硬切+冷却窗承担。"
                  f"建议对该类手持动态视频用 --type fast_cut（SSIM_KEEP_BELOW=0.55）或显式指定阈值。")

    # ---------- 状态机（规范 §4）----------
    SOFT_METRIC = args.soft_metric
    kept, logs, scenes_span = [], [], []
    scene_id = -1
    anchor_gray = None
    anchor_t = None
    anchor_idx = None
    scene_event_count = 0
    scene_has_midpoint = False
    last_kept_t = None
    cut_values = []  # 每个采样帧相对前一帧的巴氏距离

    for i, fr in enumerate(frames):
        g = grays[i]
        if g is None:
            continue
        t = float(fr["t"])
        cut = bhattacharyya(hists[i - 1], hists[i]) if i > 0 else None
        cut_values.append(cut)

        # --- 首帧 ---
        if not kept and scene_id == -1:
            scene_id += 1
            anchor_gray, anchor_t, anchor_idx = g, t, i
            scene_event_count, scene_has_midpoint = 0, False
            kept.append({"frame": fr["file"], "t": t, "frame_index": i, "scene_id": scene_id,
                         "keep_reason": "first", "ssim_vs_anchor": 1.0,
                         "hard_cut_score": None, "ocr_text": ocr_map.get(fr["file"], "")})
            last_kept_t = t
            scenes_span.append([scene_id, t, t])
            continue

        # --- A. 硬切（独立通道）---
        is_cut = cut is not None and cut > cut_th
        if is_cut:
            scene_id += 1
            anchor_gray, anchor_t, anchor_idx = g, t, i
            scene_event_count, scene_has_midpoint = 0, False
            kept.append({"frame": fr["file"], "t": t, "frame_index": i, "scene_id": scene_id,
                         "keep_reason": "hard_cut", "ssim_vs_anchor": None,
                         "hard_cut_score": round(cut, 4), "ocr_text": ocr_map.get(fr["file"], "")})
            last_kept_t = t
            scenes_span.append([scene_id, t, t])
            logs.append({"t": t, "frame": fr["file"], "decision": "keep", "branch": "hard_cut",
                         "score": round(cut, 4), "th": round(cut_th, 4)})
            continue

        if scenes_span and scenes_span[-1][0] == scene_id:
            scenes_span[-1][2] = t

        # --- B. 冷却窗（软变化）---
        if last_kept_t is not None and (t - last_kept_t) < P["REFRACTORY_SEC"]:
            logs.append({"t": t, "frame": fr["file"], "decision": "drop", "branch": "refractory",
                         "delta_t": round(t - last_kept_t, 3)})
            continue

        # --- C. 与【场景锚点】比软变化（规范 §5.3）---
        if anchor_gray is None:
            anchor_gray, anchor_t, anchor_idx = g, t, i
        if anchor_gray.shape != g.shape:
            g_c = cv2.resize(g, (anchor_gray.shape[1], anchor_gray.shape[0]),
                             interpolation=cv2.INTER_AREA)
        else:
            g_c = g

        # 双通道：SSIM（1=相同）或 pHash 汉明距离（0=相同）。规范 §5.3 二选一。
        if SOFT_METRIC == "phash":
            s = None
            hd = hamming(phashes[anchor_idx], phashes[i]) if (phashes[anchor_idx] is not None
                                                              and phashes[i] is not None) else 0
            # pHash：hamming > PHASH_KEEP_ABOVE 视为有变化；≤ DROP_BELOW 丢弃；中间死区丢弃
            changed = hd > P["PHASH_KEEP_ABOVE"]
            soft_val = hd
        else:
            if _HAS_SKIMAGE:
                s = float(ssim_sk(anchor_gray, g_c, data_range=1.0))
            else:
                s = float(ssim_np(anchor_gray, g_c))
            hd = None
            changed = s < P["SSIM_KEEP_BELOW"]
            soft_val = round(s, 4)

        if changed:
            if scene_event_count < P["MAX_EVENT_PER_SCENE"]:
                scene_event_count += 1
                kept.append({"frame": fr["file"], "t": t, "frame_index": i, "scene_id": scene_id,
                             "keep_reason": "event",
                             "ssim_vs_anchor": round(s, 4) if s is not None else None,
                             "phash_hamming_vs_anchor": hd,
                             "soft_metric": SOFT_METRIC, "soft_value": soft_val,
                             "hard_cut_score": round(cut, 4) if cut is not None else None,
                             "ocr_text": ocr_map.get(fr["file"], "")})
                last_kept_t = t
                logs.append({"t": t, "frame": fr["file"], "decision": "keep", "branch": "event",
                             "metric": SOFT_METRIC, "value": soft_val})
                continue
            logs.append({"t": t, "frame": fr["file"], "decision": "drop",
                         "branch": "scene_event_cap", "metric": SOFT_METRIC, "value": soft_val,
                         "cap": P["MAX_EVENT_PER_SCENE"]})
            continue

        # --- D. 长镜头兜底 ---
        if (t - (anchor_t or t)) >= P["LONG_SCENE_SEC"] and not scene_has_midpoint:
            if last_kept_t is None or (t - last_kept_t) >= P["REFRACTORY_SEC"]:
                scene_has_midpoint = True
                kept.append({"frame": fr["file"], "t": t, "frame_index": i, "scene_id": scene_id,
                             "keep_reason": "long_scene_midpoint",
                             "ssim_vs_anchor": round(s, 4) if s is not None else None,
                             "phash_hamming_vs_anchor": hd,
                             "soft_metric": SOFT_METRIC, "soft_value": soft_val,
                             "hard_cut_score": round(cut, 4) if cut is not None else None,
                             "ocr_text": ocr_map.get(fr["file"], "")})
                last_kept_t = t
                logs.append({"t": t, "frame": fr["file"], "decision": "keep",
                             "branch": "long_scene_midpoint", "metric": SOFT_METRIC, "value": soft_val})
                continue

        logs.append({"t": t, "frame": fr["file"], "decision": "drop", "branch": "near_duplicate", "metric": SOFT_METRIC, "value": soft_val})

    # --- 末帧强制保留（§5.6：间隔 > 0.5s 才补）---
    last_fr = frames[-1]
    if kept and kept[-1]["frame"] != last_fr["file"] and \
       (float(last_fr["t"]) - (last_kept_t if last_kept_t is not None else 0)) > 0.5:
        if grays[-1] is not None:
            kept.append({"frame": last_fr["file"], "t": float(last_fr["t"]), "frame_index": len(frames) - 1,
                         "scene_id": scene_id, "keep_reason": "last", "ssim_vs_anchor": None,
                         "hard_cut_score": None, "ocr_text": ocr_map.get(last_fr["file"], "")})

    # ---------- 规范 §8 验收自检 ----------
    duration = float(frames[-1]["t"]) or 1e-9
    refr_viol = 0
    for a, b in zip(kept, kept[1:]):
        if (b["t"] - a["t"]) < P["REFRACTORY_SEC"] - 1e-6 and b["keep_reason"] != "hard_cut":
            refr_viol += 1
    scene_ev = {}
    for k in kept:
        if k["keep_reason"] == "event":
            scene_ev[k["scene_id"]] = scene_ev.get(k["scene_id"], 0) + 1
    cap_viol = sum(1 for v in scene_ev.values() if v > P["MAX_EVENT_PER_SCENE"])
    per_min = len(kept) / duration * 60
    ocr_new = [l for l in logs if l.get("branch") == "ocr_new_frame"]
    density_verdict = ("合理" if 10 <= per_min <= 40 else
                       ("冗余过多" if per_min > 60 else "偏冗余" if per_min > 40 else "可能漏帧"))
    selfcheck = {
        "1_cut_recall": "需人工标注比对（外部输入）",
        "2_no_near_dup": "pass" if refr_viol == 0 else f"warn({refr_viol})",
        "3_density_per_min": round(per_min, 1),
        "3_density_verdict": density_verdict,
        "4_refractory_violations": refr_viol,
        "5_scene_event_cap_violations": cap_viol,
        "6_ocr_new_frame": len(ocr_new),
        "7_first_frame": bool(kept and kept[0]["keep_reason"] == "first"),
        "7_last_frame": bool(kept and (kept[-1]["keep_reason"] == "last" or
                                       (float(frames[-1]["t"]) - kept[-1]["t"]) <= 0.5)),
    }

    out = {
        "rule": "V3",
        "spec_source": "通用关键帧抽取规则_V3.md",
        "video_type": args.vtype,
        "soft_metric": SOFT_METRIC,
        "sample_fps": P["SAMPLE_FPS"],
        "params": {k: P[k] for k in PARAM_DEFAULTS},
        "calibration": {
            "mode": calib_mode,
            "hard_cut_th_effective": round(cut_th, 4),
            "detail": calib_detail,
            "ssim_scene_insight": ssim_stat,
            "ssim_channel_effective": ssim_channel_effective,
        },
        "resize": R,
        "candidates": len(frames),
        "duration_s": duration,
        "scenes_count": scene_id + 1,
        "keyframes_count": len(kept),
        "filtered_count": len(frames) - len(kept),
        "selfcheck": selfcheck,
        "scenes": [{"scene_id": s, "start_t": a, "end_t": b} for s, a, b in scenes_span],
        "keyframes": kept,
        "decision_log_count": len(logs),
    }
    with open(args.output, "w", encoding="utf-8") as fp:
        json.dump(out, fp, ensure_ascii=False, indent=2)
    with open(os.path.splitext(args.output)[0] + ".log.json", "w", encoding="utf-8") as fp:
        json.dump(logs, fp, ensure_ascii=False, indent=2)

    print(f"[关键帧 V3] 类型={args.vtype} 采样={P['SAMPLE_FPS']}FPS 候选={len(frames)} "
          f"场景={scene_id+1} → 保留={len(kept)} 帧（过滤 {len(frames)-len(kept)}）")
    print(f"  自检: 密度={selfcheck['3_density_per_min']}/分钟（{density_verdict}）"
          f" 冷却违规={refr_viol} 场景超限={cap_viol} OCR新增={len(ocr_new)}")
    print(f"  → {args.output}")
    for k in kept:
        ex = f"ssim={k['ssim_vs_anchor']}" if k["ssim_vs_anchor"] is not None else ""
        cu = f"cut={k['hard_cut_score']}" if k["hard_cut_score"] is not None else ""
        print(f"    S{k['scene_id']:02d} {k['t']:7.2f}s {k['frame']:12s} {k['keep_reason']:20s} {ex} {cu}")


def ssim_np(img1, img2, L=1.0, K1=0.01, K2=0.03, win_size=7):
    """真 SSIM，纯 numpy 实现（1=完全相同）。避免 scikit-image 版本差异带来的口径漂移。"""
    import numpy as np
    C1, C2 = (K1 * L) ** 2, (K2 * L) ** 2
    # 均值/方差/协方差用统一滤波
    k = np.ones((win_size, win_size), dtype=np.float64) / (win_size * win_size)
    pad = win_size // 2

    def filt(x):
        xp = np.pad(x, pad, mode="reflect")
        h, w = x.shape
        out = np.zeros_like(x, dtype=np.float64)
        # 用累积和加速（等价于均值滤波）
        cs = np.cumsum(np.cumsum(xp, axis=0), axis=1)
        cs = np.pad(cs, ((1, 0), (1, 0)))
        out = (cs[win_size:, win_size:] - cs[:-win_size, win_size:]
               - cs[win_size:, :-win_size] + cs[:-win_size, :-win_size]) / (win_size * win_size)
        return out[:h, :w]

    mu1, mu2 = filt(img1), filt(img2)
    mu1_sq, mu2_sq, mu1_mu2 = mu1 * mu1, mu2 * mu2, mu1 * mu2
    sigma1_sq = filt(img1 * img1) - mu1_sq
    sigma2_sq = filt(img2 * img2) - mu2_sq
    sigma12 = filt(img1 * img2) - mu1_mu2
    ssim_map = ((2 * mu1_mu2 + C1) * (2 * sigma12 + C2)) / \
               ((mu1_sq + mu2_sq + C1) * (sigma1_sq + sigma2_sq + C2))
    return float(ssim_map.mean())


if __name__ == "__main__":
    main()
