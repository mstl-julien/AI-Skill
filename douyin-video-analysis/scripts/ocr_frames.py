#!/usr/bin/env python3
"""
OCR 全帧文字识别 —— douyin-video-analysis Stage 05

用法:
    python ocr_frames.py <frames_dir> -o <out_json> [--every 1]

依赖: rapidocr-onnxruntime（managed venv 内 pip install）
输出 JSON:
    { "frames_count": N, "results": [ { "frame": "f_00001.jpg", "t": 0.0,
      "lines": [ {"text": "...", "box": [x,y,w,h], "conf": 0.98} ] } ] }
"""
import argparse
import json
import os
import sys


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("frames_dir")
    ap.add_argument("-o", "--output", required=True)
    ap.add_argument("--every", type=int, default=1, help="每 N 帧跑一次（默认 1=全量 10FPS）")
    args = ap.parse_args()

    from rapidocr_onnxruntime import RapidOCR
    ocr = RapidOCR()

    fps_index = os.path.join(args.frames_dir, "frames_index.json")
    if os.path.isfile(fps_index):
        idx = json.load(open(fps_index, encoding="utf-8"))
        frames = idx["frames"]
        interval = idx.get("frame_interval", 0.1)
    else:
        files = sorted(f for f in os.listdir(args.frames_dir) if f.endswith(".jpg"))
        frames = [{"file": f, "t": round(i * 0.1, 2)} for i, f in enumerate(files)]
        interval = 0.1

    results = []
    for i, fr in enumerate(frames):
        if i % args.every != 0:
            continue
        p = os.path.join(args.frames_dir, fr["file"])
        raw, _ = ocr(p)
        lines = []
        for box, text, conf in (raw or []):
            lines.append({
                "text": text,
                "box": [round(v, 1) for pt in box for v in pt],
                "conf": round(float(conf), 3),
            })
        if lines or i % 10 == 0:
            results.append({"frame": fr["file"], "t": fr["t"], "lines": lines})
        if i % 50 == 0:
            print(f"  OCR 进度 {i}/{len(frames)}", flush=True)

    out = {
        "engine": "rapidocr-onnxruntime",
        "frames_total": len(frames),
        "frames_ocr": len(results),
        "frame_interval": interval,
        "results": results,
    }
    with open(args.output, "w", encoding="utf-8") as fp:
        json.dump(out, fp, ensure_ascii=False, indent=2)
    n_texts = sum(len(r["lines"]) for r in results)
    print(f"[OCR] 完成: {len(results)} 帧含文字, 共 {n_texts} 行 → {args.output}")


if __name__ == "__main__":
    main()
