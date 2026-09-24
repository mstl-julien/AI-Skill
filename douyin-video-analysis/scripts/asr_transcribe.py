#!/usr/bin/env python3
"""
ASR 语音转写 —— douyin-video-analysis Stage 05

用法:
    python asr_transcribe.py <audio.(mp3|wav|m4a)> -o <out_json> [--model small]

依赖: faster-whisper（managed venv 内 pip install faster-whisper）
模型首次运行会自动下载到用户缓存目录（small ≈ 460MB / base ≈ 140MB）。
输出 JSON:
    { "model": "small", "language": "zh", "duration": 26.3, "speech_detected": true,
      "segments": [ {"start": 0.0, "end": 3.2, "text": "..."} ],
      "full_text": "..." }

口径: 不编造转写。若模型判定无语音，如实输出 speech_detected=false。
"""
import argparse
import json
import os
import sys


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("audio")
    ap.add_argument("-o", "--output", required=True)
    ap.add_argument("--model", default="small",
                    help="模型名（tiny/base/small/medium）或本地模型目录路径")
    ap.add_argument("--language", default="zh")
    args = ap.parse_args()

    from faster_whisper import WhisperModel
    model_ref = args.model
    if os.path.isdir(model_ref):
        print(f"[ASR] 使用本地模型目录: {model_ref}", flush=True)
    else:
        print(f"[ASR] 加载模型 {args.model}（首次运行需下载，请耐心等待）...", flush=True)
    model = WhisperModel(model_ref, device="cpu", compute_type="int8")
    segments, info = model.transcribe(args.audio, language=args.language, vad_filter=True,
                                      vad_parameters={"min_silence_duration_ms": 500})
    segs = []
    for s in segments:
        text = s.text.strip()
        if text:
            segs.append({"start": round(s.start, 2), "end": round(s.end, 2), "text": text})
            print(f"  [{s.start:.2f}-{s.end:.2f}] {text}", flush=True)

    out = {
        "model": args.model,
        "language": info.language,
        "language_probability": round(getattr(info, "language_probability", 0) or 0, 3),
        "duration": round(info.duration, 2),
        "speech_detected": len(segs) > 0,
        "segments": segs,
        "full_text": "".join(s["text"] for s in segs),
    }
    with open(args.output, "w", encoding="utf-8") as fp:
        json.dump(out, fp, ensure_ascii=False, indent=2)
    status = "检测到语音" if out["speech_detected"] else "未检测到可转写语音（如实记录）"
    print(f"[ASR] 完成: {len(segs)} 段, {status} → {args.output}")


if __name__ == "__main__":
    main()
