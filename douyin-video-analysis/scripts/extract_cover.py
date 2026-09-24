#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
封面抽取 —— 直接从视频文件抽第 1 帧作为封面（禁止用抽帧目录/抽帧法）

★ 规范（90 于 2026-09-24 定，硬性）：
   封面必须直接解码视频文件的第 1 帧（frame_index=0），不得从抽帧采样目录里挑帧。
   原因：抽帧目录是按固定 FPS 重采样的产物，可能存在时间偏移、缩放或丢帧，
         会导致封面与真实首帧不一致。

实现：ffmpeg -vf select 取首帧，无损 PNG；同时输出首帧元信息（时间戳/分辨率/文件）。

用法:
    python extract_cover.py <video_file> -o <out.png> [--meta cover.json]
"""
import argparse
import json
import os
import subprocess
import sys


def find_ffmpeg():
    """优先用 imageio-ffmpeg 自带的 ffmpeg，其次系统 ffmpeg。"""
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        pass
    from shutil import which
    return which("ffmpeg")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("video", help="原始视频文件路径")
    ap.add_argument("-o", "--output", required=True, help="输出封面图路径（建议 .png）")
    ap.add_argument("--meta", default=None, help="可选：输出首帧元信息 JSON")
    args = ap.parse_args()

    if not os.path.isfile(args.video):
        print(f"[错误] 视频文件不存在: {args.video}", file=sys.stderr)
        sys.exit(1)
    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        print("[错误] 未找到 ffmpeg（可 pip install imageio-ffmpeg）", file=sys.stderr)
        sys.exit(1)

    os.makedirs(os.path.dirname(os.path.abspath(args.output)) or ".", exist_ok=True)
    # 直接解码第 1 帧：-frames:v 1，输入定位 0
    cmd = [ffmpeg, "-y", "-loglevel", "error", "-i", args.video,
           "-vf", "select=eq(n\\,0)", "-frames:v", "1", "-vsync", "0", args.output]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0 or not os.path.isfile(args.output) or os.path.getsize(args.output) == 0:
        # 兜底：某些封装 select 过滤器异常，改用 -ss 0 + 单帧
        cmd2 = [ffmpeg, "-y", "-loglevel", "error", "-ss", "0", "-i", args.video,
                "-frames:v", "1", args.output]
        r2 = subprocess.run(cmd2, capture_output=True, text=True)
        if r2.returncode != 0 or not os.path.isfile(args.output) or os.path.getsize(args.output) == 0:
            print(f"[错误] 首帧抽取失败:\n{r.stderr}\n{r2.stderr}", file=sys.stderr)
            sys.exit(1)

    # 元信息
    meta = {"method": "video_first_frame", "frame_index": 0, "timestamp_sec": 0.0,
            "source_video": os.path.basename(args.video), "cover_file": os.path.basename(args.output),
            "size_bytes": os.path.getsize(args.output)}
    try:
        from PIL import Image
        with Image.open(args.output) as im:
            meta["width"], meta["height"] = im.size
    except Exception:
        pass
    if args.meta:
        with open(args.meta, "w", encoding="utf-8") as fp:
            json.dump(meta, fp, ensure_ascii=False, indent=2)
    print(f"[封面] 已抽取视频第 1 帧 → {args.output} "
          f"({meta.get('width','?')}x{meta.get('height','?')}, {meta['size_bytes']} bytes)")


if __name__ == "__main__":
    main()
