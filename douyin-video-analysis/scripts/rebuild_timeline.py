#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
时间轴重建 —— 按 V3 关键帧（规范状态机产出）重塑 analysis.json 的 keyframe_timeline

用途：抽帧规则从旧版（10FPS+SSIM0.05 / 3FPS+SSIM0.05）切换到 V3 规范版后，
      关键帧集合发生变化（如视频2：99帧 → 46帧/18场景），
      必须同步重建时间轴，否则报告的时间轴单元与关键帧展示不一致。

逻辑：
  1. 读 V3 keyframes.json，得到规范化的保留帧列表（frame/t/scene_id/keep_reason/...）；
  2. 读旧 analysis.json 的 keyframe_timeline（含人工/模型写的解读文本），
     按时间就近把旧单元的语义字段（label/stage/emotion/mechanism/function/camera 等）
     迁移到新的 V3 单元；
  3. 时间轴单元的时间范围 = 本 V3 关键帧 t → 下一个 V3 关键帧 t；
  4. 口播/字幕按新单元时间窗从 asr.json / ocr.json 重新抽取；
  5. 输出回 analysis.json（备份原文件）。

用法:
    python rebuild_timeline.py <run_dir> --kf keyframes.json --analysis analysis.json \
        [--asr asr.json] [--ocr ocr.json] [--dry-run]
"""
import argparse
import json
import os
import shutil
import sys


def load_json(p):
    if p and os.path.isfile(p):
        return json.load(open(p, encoding="utf-8"))
    return None


def overlap(a0, a1, b0, b1):
    return max(0.0, min(a1, b1) - max(a0, b0))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("run_dir")
    ap.add_argument("--kf", default="keyframes.json")
    ap.add_argument("--analysis", default="analysis.json")
    ap.add_argument("--asr", default="asr.json")
    ap.add_argument("--ocr", default="ocr.json")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    RD = args.run_dir
    kf = load_json(os.path.join(RD, args.kf))
    an = load_json(os.path.join(RD, args.analysis))
    asr = load_json(os.path.join(RD, args.asr))
    ocr = load_json(os.path.join(RD, args.ocr))
    if not kf or not an:
        print("[错误] 缺少 keyframes.json 或 analysis.json", file=sys.stderr); sys.exit(1)

    kfs = kf["keyframes"]
    old_tl = an.get("keyframe_timeline") or {}
    old_units = old_tl.get("units") or []
    print(f"[输入] V3 关键帧 {len(kfs)} 帧 ｜ 旧时间轴单元 {len(old_units)} 个")

    # --- 旧单元按时间索引（用于语义迁移）---
    def old_time(u):
        tr = u.get("time_range", "0-0s")
        try:
            return float(str(tr).split("-")[0].replace("s", ""))
        except Exception:
            return 0.0

    old_sorted = sorted(old_units, key=old_time)

    def nearest_old(t):
        """找时间上最近的旧单元，用于迁移语义文本。"""
        if not old_sorted:
            return None
        return min(old_sorted, key=lambda u: abs(old_time(u) - t))

    # --- ASR 时段池 ---
    asr_segs = []
    if asr:
        for s in (asr.get("segments") or asr.get("results") or []):
            st, en = s.get("start"), s.get("end")
            tx = (s.get("text") or "").strip()
            if st is not None and en is not None and tx:
                asr_segs.append((float(st), float(en), tx))

    # --- OCR 逐帧池（key → t）---
    ocr_by_t = {}
    if ocr:
        for r in (ocr.get("results") or []):
            txt = " ".join(ln.get("text", "").strip() for ln in (r.get("lines") or []) if ln.get("text", "").strip())
            if txt:
                ocr_by_t[round(float(r["t"]), 1)] = txt

    units = []
    for i, k in enumerate(kfs):
        t0 = float(k["t"])
        t1 = float(kfs[i + 1]["t"]) if i + 1 < len(kfs) else t0 + 1.0
        # 口播：该时间窗内 ASR 文本拼接
        vo = " ".join(tx for (st, en, tx) in asr_segs if overlap(t0, t1, st, en) > 0.05).strip()
        # 字幕：该窗内首个非空 OCR
        sub = ""
        tt = t0
        while tt < t1 + 1e-6:
            v = ocr_by_t.get(round(tt, 1))
            if v:
                sub = v
                break
            tt = round(tt + 0.1, 2)

        ou = nearest_old(t0) or {}
        reason = k.get("keep_reason", "")
        REASON_CN = {"first": "强制保留（首帧）", "hard_cut": "硬切（独立巴氏通道）",
                     "event": "事件帧（vs 场景锚点软变化）",
                     "long_scene_midpoint": "长镜中点锚点", "last": "强制保留（末帧）"}
        units.append({
            "kf_index": i + 1,
            "keyframe": k["frame"],
            "time_range": f"{t0:.1f}-{t1:.1f}s",
            "duration_s": round(t1 - t0, 2),
            "scene_id": k.get("scene_id"),
            "keep_reason": reason,
            "reason": REASON_CN.get(reason, reason),
            "hard_cut_score": k.get("hard_cut_score"),
            "ssim_vs_anchor": k.get("ssim_vs_anchor"),
            # 语义字段：从时间最近的旧单元迁移（保持解读口径连续）
            "label": ou.get("label", ""),
            "stage": ou.get("stage", ""),
            "emotion": ou.get("emotion", ""),
            "mechanism": ou.get("mechanism", ou.get("function", "")),
            "function": ou.get("function", ""),
            "camera": ou.get("camera"),
            "camera_note": ou.get("camera_note", ""),
            "voiceover": vo or ou.get("voiceover", ""),
            "subtitle": sub or "—",
            "sub_shots": [],
            "sub_shot_count": 0,
        })

    new_tl = {
        "note": (f"以规范 V3 关键帧（{kf.get('keyframes_count')} 帧 / {kf.get('scenes_count')} 场景，"
                 f"类型档 {kf.get('video_type')}，基础采样 {kf.get('sample_fps')}FPS）为分析单元；"
                 f"保留依据为 首帧/硬切/事件帧/长镜中点/末帧 五类；"
                 f"口播取自 ASR 时段匹配，字幕取自关键帧邻近 OCR（仅附加展示）。"),
        "sample_fps": kf.get("sample_fps"),
        "scenes_count": kf.get("scenes_count"),
        "units_count": len(units),
        "units": units,
    }
    print(f"[输出] 新时间轴单元 {len(units)} 个（场景 {kf.get('scenes_count')} 个）")

    if args.dry_run:
        print("[dry-run] 未写入。样例：")
        for u in units[:3]:
            print("  ", json.dumps({k: v for k, v in u.items() if k != "sub_shots"}, ensure_ascii=False)[:220])
        return

    bak = os.path.join(RD, args.analysis + ".bak")
    if not os.path.exists(bak):
        shutil.copy2(os.path.join(RD, args.analysis), bak)
        print(f"[备份] {bak}")
    an["keyframe_timeline"] = new_tl
    with open(os.path.join(RD, args.analysis), "w", encoding="utf-8") as fp:
        json.dump(an, fp, ensure_ascii=False, indent=2)
    print(f"[写入] {os.path.join(RD, args.analysis)}")


if __name__ == "__main__":
    main()
