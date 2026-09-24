#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""报告交付前自检（铁律 7 附带的验证口径）。

用法:
    python verify_report.py <report.html>

检查项:
  1. 顶层章节 card 数量（应与分析框架一致，~36）；
  2. 章节排列是否按 <h3> 编号严格升序（含无编号卡片的锚点槽位）；
  3. 图片引用数与缺失 src；
  4. 六/七条铁律关键区块是否齐全：V3 状态机、脚本文案公式、直解封面、自检徽章、通道告警。

退出码 0 = 全部通过；1 = 有 FAIL。
"""
import re
import sys

# 无编号系统卡的锚点槽位（与 build_report._ANCHOR_SLOT 保持一致）
_ANCHOR_SLOT = {
    "关键帧与机器分析": 4.5,    # 数据层，接 04 之后
    "keyframe_timeline": 13.5,  # 紧随 13 之后、14 之前
    "CTA 与互动机制": 21.5,     # 接 21 之后
    "voiceover": 17.5,          # 口播文案，接 17 OCR 之后
}
# ⚠️ 双引号陷阱：card 有两种写法，必须同时匹配
_CARD_OPEN_RE = re.compile(r"""<div\b[^>]*class=['"]card['"]""")
_TOK_RE = re.compile(r"<div\b[^>]*>|</div>")


def split_top_level_cards(body):
    spans = []
    for m in _CARD_OPEN_RE.finditer(body):
        s = m.start()
        if any(a <= s < b for a, b in spans):
            continue
        depth, end = 0, None
        for t in _TOK_RE.finditer(body, s):
            if t.group(0).startswith("</"):
                depth -= 1
                if depth == 0:
                    end = t.end()
                    break
            else:
                depth += 1
        if end:
            spans.append((s, end))
    return spans


def sort_key(title):
    m = re.match(r"^\s*(\d+)\s*([a-z])?", title)
    if m:
        return int(m.group(1)) + ((ord(m.group(2)) - 96) / 100 if m.group(2) else 0)
    for k, v in _ANCHOR_SLOT.items():
        if k in title:
            return v
    return 999.0


def main():
    if len(sys.argv) < 2:
        print("用法: python verify_report.py <report.html>")
        return 1
    path = sys.argv[1]
    doc = open(path, encoding="utf-8").read()
    i, j = doc.find("<body>"), doc.find("</body>")
    body = doc[i:j] if i >= 0 and j > i else doc

    fails = []

    spans = split_top_level_cards(body)
    print(f"[1] 顶层章节 card 数: {len(spans)}")
    if len(spans) < 20:
        fails.append(f"章节数过少({len(spans)})，疑似 card 切分正则漏匹配引号写法")

    titles, bad, prev = [], 0, -1.0
    for s, e in spans:
        mh = re.search(r"<h3[^>]*>(.*?)</h3>", body[s:e], re.S)
        t = re.sub(r"<[^>]+>", "", mh.group(1)).strip() if mh else ""
        titles.append(t)
        k = sort_key(t)
        if k < prev:
            bad += 1
            print(f"    ! 乱序: {k:6.2f}  {t[:50]}")
        prev = k
    print(f"[2] 排序乱序项: {bad}")
    if bad:
        fails.append(f"存在 {bad} 处章节乱序")

    imgs = re.findall(r"<img\b[^>]*>", body)
    no_src = [x for x in imgs if "src=" not in x]
    print(f"[3] img 引用: {len(imgs)}，缺 src: {len(no_src)}")
    if no_src:
        fails.append(f"{len(no_src)} 个 img 缺 src")

    checks = {
        "V3 状态机区块": "规范 V3 状态机" in doc,
        "脚本文案公式": ("script_formula" in doc or "脚本文案公式" in doc),
        "直解封面": "cover.png" in doc,
        "抽帧自检徽章": "kf-selfcheck" in doc,
        "软通道有效性告警": "kf-warn" in doc,
    }
    print("[4] 关键区块:")
    for k, v in checks.items():
        print(f"    {'OK ' if v else 'FAIL'} {k}")
        if not v:
            fails.append(f"缺少区块: {k}")

    print("\n" + ("=" * 46))
    if fails:
        print("FAIL —— 交付前必须修复：")
        for f in fails:
            print("  -", f)
        return 1
    print("ALL PASS —— 可以交付")
    return 0


if __name__ == "__main__":
    sys.exit(main())
