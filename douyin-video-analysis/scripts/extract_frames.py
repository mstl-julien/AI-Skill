#!/usr/bin/env python3
"""
10 FPS 视频抽帧 —— douyin-video-analysis V0.2 Stage 04

用法:
    python extract_frames.py <video.mp4> <outdir> [--fps 10]

依赖: imageio-ffmpeg（自带静态 ffmpeg，无需系统安装）
    pip install imageio-ffmpeg   # 装在 managed venv 内

输出:
    <outdir>/f_00001.jpg ... 按帧序号命名
    <outdir>/frames_index.json  # {fps, frame_interval, frames_count, duration_s}

口径: 固定 10 FPS，frame_interval=0.1s，不得改采样率（V0.2 铁律 3）。
"""
import argparse
import json
import os
import subprocess
import sys


def get_ffmpeg_exe() -> str:
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except ImportError:
        print("缺少 imageio-ffmpeg。请先在 managed venv 执行: pip install imageio-ffmpeg", file=sys.stderr)
        sys.exit(2)


def probe_duration(ffmpeg_exe: str, video: str) -> float | None:
    # 用 ffmpeg -i 的 stderr 抠时长（避免额外依赖 ffprobe）
    proc = subprocess.run([ffmpeg_exe, "-i", video], capture_output=True, text=True, encoding="utf-8", errors="ignore")
    import re
    m = re.search(r"Duration:\s*(\d+):(\d+):(\d+\.?\d*)", proc.stderr)
    if not m:
        return None
    h, mi, s = m.groups()
    return int(h) * 3600 + int(mi) * 60 + float(s)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("outdir")
    ap.add_argument("--fps", type=float, default=10.0, help="固定 10，除非 Spec 升版")
    args = ap.parse_args()

    if not os.path.isfile(args.video):
        print(f"视频文件不存在: {args.video}", file=sys.stderr)
        sys.exit(1)

    os.makedirs(args.outdir, exist_ok=True)
    ffmpeg = get_ffmpeg_exe()

    duration = probe_duration(ffmpeg, args.video)
    pattern = os.path.join(args.outdir, "f_%05d.jpg")
    cmd = [
        ffmpeg, "-y",
        "-i", args.video,
        "-vf", f"fps={args.fps}",
        "-q:v", "2",
        pattern,
    ]
    print(f"[抽帧] fps={args.fps} (interval={1/args.fps:.2f}s)")
    proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="ignore")
    if proc.returncode != 0:
        print(f"ffmpeg 失败:\n{proc.stderr[-2000:]}", file=sys.stderr)
        sys.exit(3)

    frames = sorted(f for f in os.listdir(args.outdir) if f.startswith("f_") and f.endswith(".jpg"))
    n = len(frames)
    expected = int((duration or 0) * args.fps)
    print(f"[抽帧] 完成: {n} 帧 (时长 {duration}s → 预期 ≈{expected})")

    index = {
        "fps": args.fps,
        "frame_interval": round(1 / args.fps, 3),
        "frames_count": n,
        "duration_s": duration,
        "expected_frames": expected,
        "frames": [{"file": f, "t": round(i / args.fps, 2)} for i, f in enumerate(frames)],
    }
    with open(os.path.join(args.outdir, "frames_index.json"), "w", encoding="utf-8") as fp:
        json.dump(index, fp, ensure_ascii=False, indent=2)
    print(f"[抽帧] 索引: {os.path.join(args.outdir, 'frames_index.json')}")

    # 校验口径
    if duration and abs(n - expected) > max(3, expected * 0.05):
        print(f"⚠ 帧数偏差较大: 实际 {n} vs 预期 {expected}，请检查视频文件完整性", file=sys.stderr)


if __name__ == "__main__":
    main()
