#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
HTML 报告生成 —— douyin-video-analysis V0.2 Stage 11（V0.2.1 可读性重构）

用法:
    python build_report.py <data.json> [analysis.json] -o <report.html>

- data.json: 采集器产出（必需）
- analysis.json: agent 分析产出（可选；缺失时分析章节显示"待分析"占位）
- asr.json / ocr.json: 与 data.json 同目录时自动加载（ASR/OCR 数据）
- 单文件 HTML，CSS/JS 内嵌，桌面端优先，双击可开（关键帧/头像为相对路径引用）
"""
import argparse
import html
import json
import os
import re


def esc(s) -> str:
    return html.escape(str(s if s is not None else ""))


def fmt_num(n) -> str:
    if n is None:
        return "—"
    return f"{n:,}"


def fmt_t(sec) -> str:
    if sec is None:
        return "—"
    m, s = divmod(float(sec), 60)
    return f"{int(m):02d}:{s:04.1f}"


# ============ 标签映射：analysis.json / data.json 的 key → 中文 ============
L = {
    # click
    "visual_subject": "视觉主体", "composition": "构图", "cover_text": "封面文字",
    "emotion_conflict": "情绪/冲突", "account_consistency": "账号视觉统一性",
    "text": "文本", "structure": "结构", "hooks_in_title": "标题钩子",
    "primary": "首要动机", "secondary": "次要动机", "evidence": "证据",
    "confidence": "置信度",
    # topic / user_question
    "attributes": "属性评估", "demand": "需求强度", "universality": "普适性",
    "verticality": "垂直度", "timeliness": "时效性", "extensibility": "延展性",
    "target_audience": "目标人群", "core_problem": "核心问题", "pain_points": "痛点",
    "expected_result": "期望结果",
    # value / hook
    "types": "价值类型", "core": "核心价值", "time": "发生时间", "type": "类型",
    "content": "内容", "promise": "承诺", "information_gap": "信息缺口",
    # emotion / cognition / attention
    "curve": "情绪曲线", "stage": "阶段", "emotion": "情绪", "mechanisms": "机制",
    "name": "机制", "desc": "说明", "map": "Attention Map", "driver": "注意力驱动因素",
    "rhythm_summary": "节奏小结",
    # 工程
    "style": "风格", "subtitle_chain": "字幕链（完整脚本）", "keywords": "关键词",
    "note": "备注", "scenes": "场景", "subjects": "人物", "color": "色彩",
    "props": "道具", "summary": "小结", "detail_note": "细节",
    "position": "位置", "density": "信息密度", "duration": "总时长",
    "avg_shot_length": "平均镜头长度", "first_3s": "前 3 秒", "middle": "中段",
    "ending": "结尾", "rhythm_map": "Rhythm Map", "status": "状态",
    # interaction / commercial
    "exists": "是否存在", "implicit": "隐性 CTA", "match": "匹配度",
    "comment_triggers": "评论诱因", "favorite_mechanism": "收藏机制",
    "share_mechanism": "分享机制", "purpose": "商业目的", "placement": "产品植入",
    "chain": "商业承接链路",
    # comments_analysis
    "total_nodes": "总评论节点", "high_freq": "高频关键词", "kw": "关键词",
    "count": "出现次数", "ratio": "占比", "examples": "例证", "resonance": "用户共鸣",
    "unmet_demand": "未满足需求", "next_episode_expectation": "下一期期待",
    "demand_map": "需求地图",
    # replication
    "directly_copyable": "可直接复制", "abstract_mechanism": "抽象机制",
    "not_copyable": "不可复制", "one_line": "一句话机制",
    "general_migration_template": "通用迁移模板", "steps": "步骤",
    "general_directions": "通用迁移方向", "direction": "方向",
    # diagnosis
    "items": "诊断项", "issue": "问题", "severity": "严重度",
    # five conclusions
    "why_study": "① 为什么值得研究", "core_attraction": "② 最核心的吸引机制",
    "core_value": "③ 最核心的内容价值",
    "core_interaction_commercial": "④ 最核心的互动/商业机制",
    "most_copyable": "⑤ 最值得复制的是什么",
    # metrics meaning
    "metrics_meaning": "指标意义分析", "value_meaning": "在这条视频里说明什么",
    "evidence_note": "证据/口径", "ai_judgment": "AI 判断",
    # misc
    "restored": "还原结构", "breakdown": "选题拆解", "label": "内容",
}

SEVERITY_CLS = {"高": "bad", "中": "warn", "低": "ok"}
CONF_CLS = {"HIGH": "ok", "MEDIUM": "warn", "LOW": "bad"}


def lbl(k) -> str:
    return L.get(k, k)


def conf_badge(v) -> str:
    if not v:
        return ""
    cls = CONF_CLS.get(str(v).upper(), "muted")
    return f" <span class='badge {cls}'>{esc(v)}</span>"


# ============ 通用渲染：dict / list → 可读 HTML ============
def render_value(v, key="") -> str:
    """递归渲染任意 JSON 值为可读 HTML。"""
    if isinstance(v, str):
        return esc(v)
    if isinstance(v, (int, float)) or v is None:
        return esc(v if v is not None else "—")
    if isinstance(v, list):
        if all(isinstance(x, str) for x in v):
            if not v:
                return "<span class='muted'>无</span>"
            return "<ul class='plain-list'>" + "".join(f"<li>{esc(x)}</li>" for x in v) + "</ul>"
        return "<div class='mini-cards'>" + "".join(
            f"<div class='mini-card'>{render_dict(x, inline=True)}</div>" for x in v) + "</div>"
    if isinstance(v, dict):
        return render_dict(v)
    return esc(v)


def render_dict(d, inline=False) -> str:
    rows = []
    for k, v in d.items():
        if isinstance(v, (dict, list)) and not inline:
            rows.append(f"<div class='sub-block'><h5>{esc(lbl(k))}</h5>{render_value(v, k)}</div>")
        else:
            vv = v
            if isinstance(v, (dict, list)):
                vv = render_value(v, k)
            rows.append(f"<tr><td>{esc(lbl(k))}</td><td>{vv}</td></tr>")
    if inline:
        return "<table class='kv inline-kv'>" + "".join(rows) + "</table>"
    # 分离子块
    plain = "".join(r for r in rows if r.startswith("<tr>"))
    subs = "".join(r for r in rows if r.startswith("<div"))
    out = f"<table class='kv'>{plain}</table>" if plain else ""
    return out + subs


def block(title, body, extra="") -> str:
    return f"<div class='card'><h3>{title}{extra}</h3>{body}</div>"


# ============ 采集层渲染 ============
def cov_cell(v) -> str:
    if v is None:
        return "<td class='muted'>未提供</td>"
    if isinstance(v, str):
        return f"<td class='warn'>{esc(v)}</td>"
    pct = {1: "100%", 0: "0%", 0.5: "部分"}.get(v, f"{int(v*100)}%")
    cls = "ok" if v == 1 else ("warn" if 0 < v < 1 else "bad")
    return f"<td class='{cls}'>{pct}</td>"


COV_LABELS = {
    "video_page": "视频页面数据", "video_visual": "视频视觉数据", "audio": "音频数据",
    "ocr": "OCR数据", "comments": "评论数据", "replies": "回复数据",
    "search": "搜索数据", "user_backend": "用户后台数据",
}


def render_asr(asr: dict, analysis: dict) -> str:
    if not asr:
        return ("<div class='card'><h3>16 ASR 口播文案</h3>"
                "<p class='muted'>asr.json 不存在 —— ASR 未运行，音频数据不可用（如实记录，不编造转写）。</p></div>")
    if not asr.get("speech_detected"):
        return (f"<div class='card'><h3>16 ASR 口播文案</h3>"
                f"<p>模型（{esc(asr.get('model'))}）<b>未检测到可转写语音</b>（speech_detected=false）。"
                f"音频轨存在（时长 {fmt_t(asr.get('duration'))}），判断为 BGM 主导、无人声口播。"
                f"<b>不编造口播文案。</b></p></div>")
    segs = "".join(
        f"<div class='seg'><span class='tl-time'>{fmt_t(s['start'])}-{fmt_t(s['end'])}</span>"
        f"<span>{esc(s['text'])}</span></div>" for s in asr["segments"])
    raw = (f"<details><summary class='muted' style='cursor:pointer'>查看 ASR 原始转写（未校正，"
           f"{len(asr['segments'])} 段）</summary><div class='transcript' style='margin-top:8px'>{segs}</div></details>")
    vo = analysis.get("voiceover")
    if vo and vo.get("segments"):
        corr = "".join(
            f"<div class='seg'><span class='tl-time'>{fmt_t(s['start'])}-{fmt_t(s['end'])}</span>"
            f"<span>{esc(s['text'])}</span></div>" for s in vo["segments"])
        full = "".join(s["text"] for s in vo["segments"])
        return (f"<div class='card'><h3>16 ASR 完整口播文案{conf_badge('HIGH')}</h3>"
                f"<p class='muted'>模型 {esc(asr.get('model'))} · 语言 {esc(asr.get('language'))}"
                f"（置信 {asr.get('language_probability')}）· {len(vo['segments'])} 句 · 全程有口播（女声旁白念稿）</p>"
                f"<div class='transcript'>{corr}</div>"
                f"<h4>口播全文</h4><p class='full-text'>{esc(full)}</p>"
                f"<p class='muted' style='font-size:12px'>{esc(vo.get('correction_note',''))}</p>"
                + raw + "</div>")
    return (f"<div class='card'><h3>16 ASR 完整口播文案{conf_badge('HIGH')}</h3>"
            f"<p class='muted'>模型 {esc(asr.get('model'))} · {len(asr['segments'])} 段（无校正版）</p>"
            f"<div class='transcript'>{segs}</div>"
            f"<h4>全文</h4><p class='full-text'>{esc(asr.get('full_text'))}</p></div>")


def render_ocr(ocr: dict) -> str:
    if not ocr:
        return ("<div class='card'><h3>17 OCR 屏幕文字</h3>"
                "<p class='muted'>ocr.json 不存在 —— OCR 未运行。</p></div>")
    # 去重合并：连续相同文字只保留首次出现
    seen, merged = set(), []
    for r in ocr.get("results", []):
        for ln in r.get("lines", []):
            t = ln["text"].strip()
            if t and t not in seen:
                seen.add(t)
                merged.append({"t": r["t"], "text": t, "conf": ln["conf"]})
    rows = "".join(
        f"<tr><td class='tl-time'>{fmt_t(m['t'])}</td><td>{esc(m['text'])}</td>"
        f"<td class='muted'>{m['conf']:.2f}</td></tr>" for m in merged)
    return (f"<div class='card'><h3>17 OCR 屏幕文字{conf_badge('HIGH')}</h3>"
            f"<p class='muted'>引擎 {esc(ocr.get('engine'))} · 逐帧扫描 {ocr.get('frames_total')} 帧，"
            f"去重后 {len(merged)} 条文字（按首次出现时间排序）</p>"
            f"<table><thead><tr><th>首次出现</th><th>文字</th><th>置信</th></tr></thead><tbody>{rows}</tbody></table></div>")


def render_metrics_meaning(mm: dict, metrics: dict) -> str:
    cells = [("❤ 点赞", metrics.get("likes")), ("💬 评论", metrics.get("comments")),
             ("⭐ 收藏", metrics.get("favorites")), ("↗ 分享", metrics.get("shares"))]
    stats = "".join(f"<div class='stat'><b>{fmt_num(v)}</b><span>{k}</span></div>" for k, v in cells)
    body = "".join(
        f"<div class='mini-card wide'><h5>{esc(lbl(k))}：{fmt_num(metrics.get(k))}</h5>"
        f"{render_value(v, k)}</div>"
        for k, v in mm.items() if k in ("likes", "comments", "favorites", "shares"))
    return (f"<div class='card'><h3>05 关键指标与意义分析</h3>"
            f"<div class='stat-row'>{stats}</div>"
            f"<p class='muted'>口径：公开页面数据（{esc(metrics.get('source') or 'VIDEO_PAGE')}）。"
            f"以下逐项意义为 AI 分析判断，非平台官方解读。</p>{body}</div>")


def render_interaction_structure(metrics: dict) -> str:
    lk = metrics.get("likes") or 0
    def ratio(x): return f"{(x or 0)/lk:.1%}" if lk else "—"
    rows = [("评论/点赞", ratio(metrics.get("comments")), "表达欲/需求外溢强度"),
            ("收藏/点赞", ratio(metrics.get("favorites")), "决策存证强度（买前标记）"),
            ("分享/点赞", ratio(metrics.get("shares")), "社交推荐强度（转给谁看）")]
    trs = "".join(f"<tr><td>{a}</td><td><b>{b}</b></td><td class='muted'>{c}</td></tr>" for a, b, c in rows)
    return (f"<div class='card'><h3>25 互动结构</h3>"
            f"<p class='muted'>无公开播放量，只计算结构比值，不称作「互动率」。</p>"
            f"<table><thead><tr><th>比值</th><th>数值</th><th>含义</th></tr></thead><tbody>{trs}</tbody></table></div>")


# ============ 帧体系（V2-SSIM：10FPS 基础采样 + SSIM 关键帧筛选，90 于 2026-09-23 定） ============
MACHINE_FPS = 10.0


def parse_shot_range(t_str: str):
    """'00:00.0-00:04.4' → (start_s, end_s)"""
    m = re.match(r"(\d+):(\d+\.?\d*)\s*-\s*(\d+):(\d+\.?\d*)", t_str or "")
    if not m:
        return None
    return (int(m.group(1)) * 60 + float(m.group(2)),
            int(m.group(3)) * 60 + float(m.group(4)))


def frame_at(t: float, frames_dir: str, fps: float = MACHINE_FPS):
    idx = max(1, round(t * fps))
    # 钳位回退：目标帧不存在（如末尾超界）时向前找最近的帧
    for i in range(idx, 0, -1):
        f = f"f_{i:05d}.jpg"
        if os.path.isfile(os.path.join(frames_dir, f)):
            return f
    return None


def shot_frames(t_str: str, camera: str, frames_dir: str):
    """按机位规则出帧：
    - 固定机位：首帧 / 中点代表帧 / 尾帧 共 3 帧
    - 动态机位：逐秒节点帧（每秒首尾两帧，即全部整秒边界 + 首尾）"""
    rng = parse_shot_range(t_str)
    if not rng:
        return []
    s, e = rng
    if camera == "dynamic":
        times = [s] + [float(x) for x in range(int(s) + 1, int(e) + 1) if s < x < e] + [e]
        times = sorted(set(round(t, 2) for t in times))
        labels = ["第%.1f秒" % t for t in times]
        out = [(frame_at(t, frames_dir), t, lb) for t, lb in zip(times, labels)]
    else:
        mid = (s + e) / 2
        out = [(frame_at(t, frames_dir), t, lb) for t, lb in
               ((s, "首帧"), (mid, "中点代表帧"), (e, "尾帧"))]
    seen, res = set(), []
    for f, t, lb in out:
        if f and f not in seen:
            seen.add(f)
            res.append((f, t, lb))
    return res


def render_timeline(analysis: dict, kf_tl: dict, kf_frames_dir: str, kf_frames_rel: str) -> str:
    if not kf_tl or not kf_tl.get("units"):
        return ("<div class='card'><h3>14 视频时间轴</h3>"
                "<p class='muted'>analysis.json 未提供 keyframe_timeline（关键帧驱动的时间轴分析）。</p></div>")
    items = []
    for u in kf_tl["units"]:
        f = u.get("keyframe")
        img = ""
        if f and kf_frames_dir and os.path.isfile(os.path.join(kf_frames_dir, f)):
            img = f"<figure class='tl-kf'><img src='{kf_frames_rel}/{f}' loading='lazy'></figure>"
        cam = u.get("camera")
        cam_badge = ("<span class='badge muted'>固定机位</span>" if cam == "fixed"
                     else "<span class='badge warn'>动态机位</span>" if cam == "dynamic" else "")
        ssim = u.get("ssim_vs_prev")
        ssim_txt = f"单元切入 SSIM={ssim}" if ssim is not None else "强制保留（首帧）"
        lbl_txt = re.sub(r"^U\d+\s*", "", u.get("label") or "")
        subs = u.get("sub_shots") or []
        subs_html = ""
        if subs:
            subs_html = ("<details class='subs'><summary>子镜 " + str(len(subs)) + " 个（10FPS 细粒度硬切点）</summary><table class='subs-tbl'><thead>"
                         "<tr><th>时间</th><th>子镜</th><th>切入 SSIM</th></tr></thead><tbody>" +
                         "".join(f"<tr><td class='tl-time'>{esc(s.get('time'))}</td><td>{esc(s.get('label'))}</td>"
                                 f"<td>{esc(s.get('cut_ssim') if s.get('cut_ssim') is not None else '—')}</td></tr>"
                                 for s in subs) + "</tbody></table></details>")
        items.append(
            f"<div class='tl-item'><div class='tl-kf-wrap'>{img}</div><div class='tl-body'>"
            f"<div class='tl-head'><span class='tl-unit'>U{u['kf_index']:02d}</span>"
            f"<span class='tl-time'>{esc(u['time_range'])}（{u['duration_s']}s）</span>"
            f"<b>{esc(lbl_txt)}</b>{cam_badge}<span class='cut-tag'>{esc(ssim_txt)}</span></div>"
            f"<div class='tl-text'>口播：「{esc(u.get('voiceover') or '—')}」</div>"
            f"<div class='tl-text'>字幕：「{esc(u.get('subtitle') or '—')}」</div>"
            f"<div class='muted'>情绪：{esc(u.get('emotion') or '—')} ｜ 机制：{esc(u.get('mechanism') or '—')} ｜ 作用：{esc(u.get('function') or '—')}</div>"
            f"{subs_html}</div></div>")
    n = len(kf_tl["units"])
    return (f"<div class='card'><h3>14 视频时间轴（关键帧驱动，共 {n} 个分析单元）{conf_badge('HIGH')}</h3>"
            f"<p class='muted'>{esc(kf_tl.get('note',''))}每单元展示该关键帧原图（等比例），"
            f"口播/字幕按时段自动匹配，子镜为 10FPS 细粒度 SSIM 硬切点。</p>"
            f"<div class='timeline'>{''.join(items)}</div></div>")


# ============ 关键帧：V3 规则筛选后关键帧全展示 + OCR 附加信息 ============
def render_keyframes(data: dict, analysis: dict, kf: dict, ocr: dict, kf_frames_dir: str, kf_frames_rel: str) -> str:
    if not kf or not kf_frames_dir:
        return ("<div class='card'><h3>关键帧与机器分析</h3>"
                "<p class='muted'>keyframes.json 不存在或帧目录缺失。</p></div>")
    n_kf, n_cand = kf.get("keyframes_count"), kf.get("candidates")
    rule = kf.get("rule", "V3")
    base_fps = kf.get("sample_fps") or kf.get("base_fps", 3)
    params = kf.get("params", {})
    calib = kf.get("calibration", {})
    sc = kf.get("selfcheck", {})
    vtype = kf.get("video_type", "generic")
    soft_metric = kf.get("soft_metric", "ssim")

    # OCR 附加信息：按 keyframe 时间取邻近帧 OCR 文本（仅展示，不参与筛选）
    ocr_by_t = {}
    if ocr:
        for r in ocr.get("results", []):
            txt = " ".join(ln["text"].strip() for ln in r.get("lines", []) if ln["text"].strip())
            if txt:
                ocr_by_t[round(r["t"], 1)] = txt

    def ocr_near(t):
        base = round(1 / base_fps, 2)
        for i in range(0, 4):
            for dt in (round(i * base, 2), round(-i * base, 2)):
                v = ocr_by_t.get(round(t + dt, 1))
                if v:
                    return v
        return None

    REASON_LABEL = {"first": "首帧", "hard_cut": "硬切", "event": "事件帧",
                    "long_scene_midpoint": "长镜中点", "last": "末帧"}
    REASON_CLS = {"first": "r-first", "hard_cut": "r-cut", "event": "r-evt",
                  "long_scene_midpoint": "r-mid", "last": "r-last"}

    cells = []
    for k in kf.get("keyframes", []):
        f = k["frame"]
        if not os.path.isfile(os.path.join(kf_frames_dir, f)):
            continue
        reason = k.get("keep_reason", "")
        r_lbl = REASON_LABEL.get(reason, reason)
        r_cls = REASON_CLS.get(reason, "")
        # 度量文本：硬切给 cut 分数，事件帧给 ssim/phash
        if reason == "hard_cut" and k.get("hard_cut_score") is not None:
            metric_txt = f"cut {k['hard_cut_score']}"
        elif k.get("soft_metric") == "phash" and k.get("soft_value") is not None:
            metric_txt = f"pHash {k['soft_value']}"
        elif k.get("ssim_vs_anchor") is not None:
            metric_txt = f"SSIM {k['ssim_vs_anchor']}"
        else:
            metric_txt = ""
        ocr_t = ocr_near(k["t"])
        ocr_html = f"<div class='kf-ocr'>{esc(ocr_t[:44])}</div>" if ocr_t else ""
        scene_badge = f"<span class='muted'>S{k.get('scene_id', 0):02d}</span>"
        cells.append(
            f"<figure class='kf'><img src='{kf_frames_rel}/{f}' loading='lazy'>"
            f"<figcaption><b>{fmt_t(k['t'])}</b> {scene_badge} "
            f"<span class='kf-reason {r_cls}'>{esc(r_lbl)}</span>"
            f"<span class='muted kf-metric'>{esc(metric_txt)}</span>{ocr_html}</figcaption></figure>")

    # 自检区块
    dens = sc.get("3_density_per_min", "—")
    dens_v = sc.get("3_density_verdict", "")
    dens_cls = "ok" if dens_v == "合理" else "warn"
    ssim_eff = calib.get("ssim_channel_effective", True)
    ssim_insight = calib.get("ssim_scene_insight", {}) or {}
    cut_th = calib.get("hard_cut_th_effective", "—")

    selfcheck_html = (
        "<div class='kf-selfcheck'>"
        f"<span class='badge {dens_cls}'>密度 {esc(dens)}/分钟（{esc(dens_v)}）</span>"
        f"<span class='badge {'ok' if sc.get('4_refractory_violations', 0) == 0 else 'warn'}'>"
        f"冷却窗 {esc(sc.get('4_refractory_violations', '—'))} 违规</span>"
        f"<span class='badge {'ok' if sc.get('5_scene_event_cap_violations', 0) == 0 else 'warn'}'>"
        f"场景事件上限 {esc(sc.get('5_scene_event_cap_violations', '—'))} 违规</span>"
        f"<span class='badge {'ok' if sc.get('6_ocr_new_frame', 0) == 0 else 'warn'}'>"
        f"OCR 新增帧 {esc(sc.get('6_ocr_new_frame', '—'))}</span>"
        f"<span class='badge {'ok' if sc.get('7_first_frame') else 'warn'}'>首帧</span>"
        f"<span class='badge {'ok' if sc.get('7_last_frame') else 'warn'}'>末帧</span>"
        "</div>")

    # SSIM 通道有效性提示
    chan_note = ""
    if not ssim_eff and ssim_insight:
        chan_note = (
            f"<p class='muted kf-warn'>⚠ 本视频 SSIM/软变化通道<b>无区分度</b>："
            f"场景内相对锚点 SSIM 中位数仅 {esc(ssim_insight.get('median'))}，"
            f"阈值 {esc(ssim_insight.get('keep_below'))} 下有 "
            f"{esc(ssim_insight.get('pct_below_keep'))}% 的帧被判为变化帧。"
            f"该指标按静态机位标定，手持动态实拍下失效 —— 关键帧实际由"
            f"<b>硬切检测 + 冷却窗 + 单场景事件上限</b>共同确定。</p>")

    return (
        f"<div class='card'><h3>关键帧与机器分析（规范 {esc(rule)} 状态机）</h3>"
        f"<p class='muted'>类型档 <b>{esc(vtype)}</b> ｜ 基础采样 <b>{fmt_num(base_fps)} FPS</b> "
        f"共 <b>{n_cand}</b> 候选帧（绑定时间戳）→ 状态机筛选 → 关键帧 <b>{n_kf}</b> 帧"
        f"（过滤 {kf.get('filtered_count')} 冗余帧）｜ 识别场景 <b>{kf.get('scenes_count')}</b> 个。</p>"
        f"<p class='muted'>参数：硬切阈值 <b>{esc(cut_th)}</b>（{esc(calib.get('mode', '—'))}）｜ "
        f"SSIM 下限 {esc(params.get('SSIM_KEEP_BELOW'))} ｜ 冷却窗 {esc(params.get('REFRACTORY_SEC'))}s ｜ "
        f"单场景事件上限 {esc(params.get('MAX_EVENT_PER_SCENE'))} ｜ 长镜阈值 {esc(params.get('LONG_SCENE_SEC'))}s ｜ "
        f"软变化指标 <b>{esc(soft_metric)}</b></p>"
        f"<p class='muted'>保留规则：<span class='kf-reason r-first'>首帧</span> "
        f"<span class='kf-reason r-cut'>硬切</span>（独立巴氏距离通道，不与软阈值共用）"
        f"<span class='kf-reason r-evt'>事件帧</span>（与<b>场景锚点</b>比软变化，非上一保留帧）"
        f"<span class='kf-reason r-mid'>长镜中点</span> <span class='kf-reason r-last'>末帧</span>。"
        f"OCR 仅作附加展示、不参与保留决策。</p>"
        f"{chan_note}{selfcheck_html}"
        f"<div class='kf-grid'>{''.join(cells)}</div></div>")


# ============ 抖音风格评论区 ============
def avatar_html(c: str) -> str:
    """头像：远程图加载失败时 JS 回退为昵称首字。"""
    if not c:
        return "<span class='avatar av-fb'>?</span>"
    return (f"<img class='avatar' src='{esc(c)}' loading='lazy' referrerpolicy='no-referrer' "
            f"onerror=\"this.outerHTML='<span class=\\'avatar av-fb\\'>音</span>'\">")


def render_comments_douyin(comments: dict, author_nickname: str) -> str:
    top = comments.get("top_level", [])
    reps = comments.get("replies", [])
    status = comments.get("collection_status", "?")
    badge = "<span class='badge ok'>COMPLETE</span>" if status == "COMPLETE" else "<span class='badge warn'>PARTIAL</span>"
    partial = ""
    if status == "PARTIAL" and comments.get("partial_reason"):
        partial = f"<p class='warn-text'>未全量原因：{esc(comments['partial_reason'])}</p>"

    replies_by_parent = {}
    for r in reps:
        replies_by_parent.setdefault(r.get("parent_comment_id"), []).append(r)
    for k in replies_by_parent:
        replies_by_parent[k].sort(key=lambda x: -(x.get("likes") or 0))

    rows = []
    for i, c in enumerate(top, 1):
        cid = c.get("comment_id")
        is_author = author_nickname and c.get("user_nickname") == author_nickname
        author_tag = "<span class='author-tag'>作者</span>" if is_author else ""
        like_active = " active" if (c.get("likes") or 0) > 0 else ""
        rows.append(
            f"<div class='dy-comment' data-kind='top' data-likes='{c.get('likes') or 0}' "
            f"data-time='{c.get('publish_time') or ''}' data-text='{esc(c.get('content'))[:200]}'>"
            f"{avatar_html(c.get('user_avatar'))}"
            f"<div class='dy-main'>"
            f"<div class='dy-nick'>{esc(c.get('user_nickname') or '抖音用户')}{author_tag}</div>"
            f"<div class='dy-content'>{esc(c.get('content'))}</div>"
            f"<div class='dy-meta'><span>{esc((c.get('publish_time') or '')[:10])}</span>"
            f"<span class='dot'>·</span><span>{esc(c.get('ip_location') or 'IP 未知')}</span>"
            f"<span class='dot'>·</span><span class='dy-reply-btn'>回复</span></div></div>"
            f"<div class='dy-like{like_active}'>♡<b>{fmt_num(c.get('likes')) if c.get('likes') else ''}</b></div>"
            f"</div>")

        children = replies_by_parent.get(cid) or []
        if children:
            kid_html = []
            for r in children:
                r_author = author_nickname and r.get("user_nickname") == author_nickname
                r_tag = "<span class='author-tag'>作者</span>" if r_author else ""
                kid_html.append(
                    f"<div class='dy-comment reply' data-kind='reply' data-likes='{r.get('likes') or 0}' "
                    f"data-time='{r.get('publish_time') or ''}' data-text='{esc(r.get('content'))[:200]}'>"
                    f"{avatar_html(r.get('user_avatar'))}"
                    f"<div class='dy-main'>"
                    f"<div class='dy-nick'>{esc(r.get('user_nickname') or '抖音用户')}{r_tag}</div>"
                    f"<div class='dy-content'>{esc(r.get('content'))}</div>"
                    f"<div class='dy-meta'><span>{esc((r.get('publish_time') or '')[:10])}</span>"
                    f"<span class='dot'>·</span><span>{esc(r.get('ip_location') or 'IP 未知')}</span></div></div>"
                    f"<div class='dy-like'>♡<b>{fmt_num(r.get('likes')) if r.get('likes') else ''}</b></div></div>")
            rows.append(
                f"<div class='dy-replies-wrap' data-parent='{esc(cid)}'>"
                f"<div class='dy-replies'>{''.join(kid_html)}</div>"
                f"<div class='dy-expand' onclick='this.parentNode.classList.toggle(\"open\")'>"
                f"—— 共 {len(children)} 条回复，点击展开/收起 ——</div></div>")

    tbody = "".join(rows) or "<p class='muted'>无评论数据</p>"
    return f"""
<div class="card">
  <h3>19 全量评论（抖音原版式）{badge}</h3>
  <div class="stat-row">
    <div class="stat"><b>{fmt_num(comments.get('total_top_level'))}</b><span>一级评论</span></div>
    <div class="stat"><b>{fmt_num(comments.get('total_replies'))}</b><span>回复</span></div>
    <div class="stat"><b>{fmt_num(comments.get('total_nodes'))}</b><span>总评论节点</span></div>
    <div class="stat"><b>{fmt_num(comments.get('api_total_including_nested'))}</b><span>接口 total（含楼中楼，仅参考）</span></div>
  </div>
  {partial}
  <p class="muted">排序与展示规则对齐抖音：一级评论按平台返回序（热度序），回复按点赞降序；「作者」标为官方账号回复；头像加载失败显示占位。</p>
  <div class="filter-bar">
    <input id="c-search" type="text" placeholder="搜索评论内容...">
    <select id="c-filter">
      <option value="all">全部</option><option value="top">仅一级</option>
      <option value="reply">含回复</option><option value="hot">高赞(≥5)</option>
      <option value="author">作者回复</option>
    </select>
    <select id="c-sort">
      <option value="orig">平台序</option><option value="likes">按点赞</option><option value="time">按时间</option>
    </select>
  </div>
  <div class="dy-panel" id="c-panel">{tbody}</div>
</div>"""


# ============ 分析层各章节（专用渲染，拒绝裸 JSON） ============
def render_click(click: dict, frames_dir: str, frames_rel: str, cover_rel: str = None) -> str:
    cover = click.get("cover", {})
    title = click.get("title_first_screen", {})
    motive = click.get("click_motive", {})
    # ★ 封面 = 直接从视频文件解码的第 1 帧（禁止用抽帧目录里的采样帧）
    cover_img = cover_rel if cover_rel else None
    if cover_img:
        cover_full = (f"<img class='cover-full' src='{cover_img}' loading='lazy'>"
                      f"<p class='muted' style='font-size:12px'>"
                      f"▲ 完整封面：视频文件直接解码的第 1 帧（frame_index=0，非抽帧采样）</p>")
    else:
        # 降级：无独立封面文件时，用抽帧目录首帧兜底并明确标注
        fb = frame_at(0.0, frames_dir) if frames_dir else None
        cover_full = (f"<img class='cover-full' src='{frames_rel}/{fb}' loading='lazy'>"
                      f"<p class='muted' style='font-size:12px;color:#d46b08'>"
                      f"▲ 封面回退为抽帧目录首帧（未找到独立封面文件 cover.png，建议运行 extract_cover.py）</p>"
                      if fb else "")
    return block("06 点击前分析", (
        "<div class='sub-block'><h5>① 封面</h5>" + render_dict(cover) + cover_full + "</div>"
        "<div class='sub-block'><h5>② 标题 / 首屏</h5>" + render_dict(title) + "</div>"
        "<div class='sub-block'><h5>③ 点击动机</h5>"
        f"<table class='kv'><tr><td>首要动机</td><td>{esc(motive.get('primary','—'))}</td></tr>"
        f"<tr><td>次要动机</td><td>{esc(motive.get('secondary','—'))}</td></tr>"
        f"<tr><td>证据</td><td>{esc(motive.get('evidence','—'))}</td></tr></table></div>"
        + conf_badge(click.get("confidence"))
    ))


def render_structure(struct: dict) -> str:
    steps = struct.get("restored", [])
    flow = "".join(
        f"<div class='step'><span class='step-n'>{i}</span>"
        f"<div><b>{esc(s.get('stage'))}</b> <span class='tl-time'>{esc(s.get('time'))}</span>"
        f"<div class='muted'>{esc(s.get('desc'))}</div></div></div>"
        for i, s in enumerate(steps, 1))
    return block("09 内容结构", flow + f"<p class='muted'>{esc(struct.get('note',''))}</p>")


def render_cognition(cog: dict) -> str:
    rows = "".join(
        f"<div class='mini-card'><h5>{esc(m.get('name'))}</h5><p>{esc(m.get('desc'))}</p>"
        f"<p class='muted'>证据：{esc(m.get('evidence'))}</p></div>" for m in cog.get("mechanisms", []))
    return block("12 认知机制", f"<div class='mini-cards'>{rows}</div>")


def render_diagnosis(dia: dict) -> str:
    rows = "".join(
        f"<tr><td>{esc(d.get('issue'))}</td>"
        f"<td><span class='badge {SEVERITY_CLS.get(d.get('severity'),'muted')}'>{esc(d.get('severity'))}</span></td>"
        f"<td>{esc(d.get('desc'))}</td></tr>" for d in dia.get("items", []))
    return (block("23 反向诊断", f"<table><thead><tr><th>问题</th><th>严重度</th><th>说明</th></tr></thead><tbody>{rows}</tbody></table>")
            + "<p class='muted' style='margin-top:8px'>⚠ 本节全部为 AI 分析判断，非客观事实。</p>")


def default_script_formula(rep: dict, analysis: dict) -> dict:
    """兜底脚本文案公式：当 analysis.json 未提供 replication.script_formula 时，
    从已有分析字段（一句话机制 / 可直接复制项 / 钩子 / 情绪曲线）推导出一个通用公式骨架。
    ★ 强制要求：24 章必须始终出现脚本文案公式（90 于 2026-09-24 定为硬性规范）。"""
    one = rep.get("one_line", "")
    copies = rep.get("directly_copyable", []) or []
    hook = (analysis.get("hook") or {})
    emo = (analysis.get("emotion") or {})
    # 钩子类型
    hook_type = ""
    if isinstance(hook, dict):
        hook_type = hook.get("type") or hook.get("hook_type") or ""
        if not hook_type:
            for k in ("first_3s", "opening", "hook"):
                if hook.get(k):
                    hook_type = str(hook.get(k))[:40]
                    break
    # 情绪关键词（兼容多种结构：字符串 / 字符串列表 / 对象列表 / 曲线分段）
    emo_kw = ""
    if isinstance(emo, dict):
        raw = emo.get("curve") or emo.get("emotion_curve") or emo.get("arc") or emo.get("stages")
        parts = []
        if isinstance(raw, str):
            parts = [raw]
        elif isinstance(raw, list):
            for x in raw[:5]:
                if isinstance(x, dict):
                    # 取对象里有意义的字段拼装，避免渲染成裸 dict
                    lbl = x.get("emotion") or x.get("name") or x.get("label") or x.get("stage") or ""
                    st = x.get("stage") or ""
                    if lbl and st and st != lbl:
                        parts.append(f"{st}（{lbl}）")
                    elif lbl:
                        parts.append(str(lbl))
                    elif st:
                        parts.append(str(st))
                else:
                    parts.append(str(x))
        elif raw:
            parts = [str(raw)]
        emo_kw = " → ".join(p for p in parts if p)[:80]

    return {
        "title": "脚本文案公式（通用骨架·由本案例特征自动推导）",
        "auto_derived": True,
        "formula": [
            {"slot": "0-3s 钩子位",
             "text": f"【{hook_type or '悬念提问/结果前置'}】+ 立刻抛出本期最大悬念或反差",
             "rule": "不铺垫、不自我介绍；首帧画面即剧透关键信息；字幕与口播同频"},
            {"slot": "3-8s 建立位",
             "text": "交代本期规则/情境（谁、在哪、要干什么）+ 给出观众可参与的选择项",
             "rule": f"机制需一句话说清；直接复用本案例可复制项：{'；'.join(str(x) for x in copies[:2]) or '系列角色+期数编号'}"},
            {"slot": "8s-中段 冲突位",
             "text": f"围绕悬念制造 2~3 轮反复拉扯，每轮给一个小结论再推翻。情绪走线：{emo_kw or '好奇→共鸣→期待'}",
             "rule": "每 5~8 秒一个小反转；口播与字幕互补不重复；机位/景别随情绪递进"},
            {"slot": "中后段 兑现位",
             "text": "揭晓答案/结果，把前期铺垫全部回收",
             "rule": "兑现必须在观众耐心耗尽前出现；揭晓后立即接情绪高点（惊讶/自嘲/庆祝）"},
            {"slot": "结尾 钩子位",
             "text": "抛下期预告 + 明确的互动指令（猜/选/评论区点单）",
             "rule": f"把评论区变成选题委员会；呼应系列编号，形成追更惯性。本案例核心机制：{one[:60]}"},
        ],
        "dual_track_rule": "公式为通用骨架：槽位与规则可迁移，具体文案必须按目标赛道、账号人设、产品重新填写，禁止直接照抄本案例文案。",
    }


def render_replication(rep: dict, analysis: dict | None = None) -> str:
    one = f"<div class='one-line'>{esc(rep.get('one_line',''))}</div>"
    copyable = "<ul class='plain-list'>" + "".join(f"<li>{esc(x)}</li>" for x in rep.get("directly_copyable", [])) + "</ul>"
    notc = "<ul class='plain-list'>" + "".join(f"<li>{esc(x)}</li>" for x in rep.get("not_copyable", [])) + "</ul>"
    tpl = rep.get("general_migration_template", {})
    steps = "".join(f"<div class='step'><span class='step-n'>{i}</span><div>{esc(s)}</div></div>"
                    for i, s in enumerate(tpl.get("steps", []), 1))
    dirs = "".join(f"<div class='mini-card'><h5>{esc(d.get('direction'))}</h5><p>{esc(d.get('desc'))}</p></div>"
                   for d in tpl.get("general_directions", []))
    # ★ 脚本文案公式：强制区块。缺失时用兜底公式推导，并醒目标注来源。
    sf = rep.get("script_formula")
    auto = False
    if not sf or not sf.get("formula"):
        sf = default_script_formula(rep, analysis or {})
        auto = True
    rows = "".join(
        f"<div class='step'><span class='step-n'>{i}</span><div>"
        f"<b>{esc(s.get('slot'))}</b>"
        f"<div class='formula-text'>{esc(s.get('text'))}</div>"
        f"<div class='muted' style='font-size:12px'>规则：{esc(s.get('rule'))}</div></div></div>"
        for i, s in enumerate(sf.get("formula", []), 1))
    src_note = ("<p class='muted' style='font-size:12px;color:#d46b08'>"
                "ⓘ 本公式为系统按本案例特征自动推导的通用骨架（原分析未提供 script_formula 字段）"
                "；槽位与规则可直接迁移，文案需按目标赛道重写。</p>" if auto else "")
    sf_html = (f"<div class='sub-block formula-box'><h5>{esc(sf.get('title','脚本文案公式'))}"
               f"{' <span class=\"badge warn\" style=\"font-size:10px\">自动推导</span>' if auto else ''}</h5>"
               f"{src_note}{rows}"
               f"<p class='muted' style='font-size:12px'>双轨规则：{esc(sf.get('dual_track_rule',''))}"
               f"{conf_badge('HIGH')}</p></div>")
    return block("24 复制与迁移", (
        f"<h5>一句话机制</h5>{one}"
        + sf_html +
        "<div class='sub-block'><h5>可直接复制</h5>" + copyable + "</div>"
        "<div class='sub-block'><h5>不可复制（身份/资源/存量）</h5>" + notc + "</div>"
        f"<div class='sub-block'><h5>通用迁移模板（未提供目标赛道）</h5>{steps}</div>"
        f"<div class='sub-block'><h5>通用迁移方向</h5><div class='mini-cards'>{dirs}</div></div>"))


def render_five(fc: dict) -> str:
    cards = "".join(
        f"<div class='fc-card'><div class='fc-n'>{i}</div><div>{esc(v)}</div></div>"
        for i, (k, v) in enumerate(fc.items(), 1))
    return block("32 五大核心结论", f"<div class='fc-grid'>{cards}</div>")


def render_comments_demand(ca: dict) -> str:
    hf = "".join(
        f"<div class='mini-card'><h5>「{esc(h.get('kw'))}」 × {h.get('count')}"
        f"{' <span class=badge warn>' + esc(h.get('ratio')) + '</span>' if h.get('ratio') else ''}</h5>"
        f"<p class='muted'>例：{'；'.join(esc(e) for e in h.get('examples', [])[:3])}</p></div>"
        for h in ca.get("high_freq", []))
    dm = ca.get("demand_map", {})
    dm_rows = "".join(f"<tr><td>{esc(k)}</td><td>{esc(v)}</td></tr>" for k, v in dm.items())
    return block("20 评论区需求分析（基于全量评论）", (
        f"<table class='kv'>"
        f"<tr><td>总评论节点</td><td>{fmt_num(ca.get('total_nodes'))}</td></tr></table>"
        f"<h5>高频关键词</h5><div class='mini-cards'>{hf}</div>"
        f"<h5>用户共鸣</h5><p>{esc(ca.get('resonance','—'))}</p>"
        f"<h5>未满足需求</h5><ul class='plain-list'>" +
        "".join(f"<li>{esc(x)}</li>" for x in ca.get("unmet_demand", [])) + "</ul>"
        f"<h5>下一期期待</h5><p>{esc(ca.get('next_episode_expectation','—'))}</p>"
        f"<h5>需求地图</h5><table class='kv'>{dm_rows}</table>"))


def render_generic_analysis(a: dict, skip: set) -> str:
    """其余分析块：标题映射 + 通用可读渲染。"""
    titles = {
        "topic": "07 选题分析", "user_question": "07b 核心用户问题", "value": "08 内容价值",
        "hook": "10 Hook 分析", "emotion": "11 情绪机制", "attention": "13 注意力机制（Attention Map）",
        "language": "15a 语言", "visual": "15b 画面", "shots": "15c 镜头", "subtitles": "15d 字幕",
        "editing": "15e 剪辑节奏", "sound": "18 声音系统", "interaction": "CTA 与互动机制",
        "commercial": "22 商业化分析",
    }
    out = []
    for key, val in a.items():
        if key in skip or not isinstance(val, (dict, list)) or key == "timeline":
            continue
        title = titles.get(key, key)
        extra = conf_badge(val.get("confidence")) if isinstance(val, dict) else ""
        out.append(block(esc(title), render_value(val), extra))
    return "\n".join(out)


# ============ 主流程 ============
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("data")
    ap.add_argument("analysis", nargs="?")
    ap.add_argument("-o", "--output", required=True)
    ap.add_argument("--title", default=None, help="报告名称（自动追加生成日期时间）")
    args = ap.parse_args()

    with open(args.data, encoding="utf-8") as f:
        data = json.load(f)
    analysis = {}
    if args.analysis and os.path.isfile(args.analysis):
        with open(args.analysis, encoding="utf-8") as f:
            analysis = json.load(f)

    # 同目录自动发现 ASR / OCR
    data_dir = os.path.dirname(os.path.abspath(args.data))
    asr_p, ocr_p = os.path.join(data_dir, "asr.json"), os.path.join(data_dir, "ocr.json")
    asr = json.load(open(asr_p, encoding="utf-8")) if os.path.isfile(asr_p) else None
    ocr = json.load(open(ocr_p, encoding="utf-8")) if os.path.isfile(ocr_p) else None
    kf_p = os.path.join(data_dir, "keyframes.json")
    kf = json.load(open(kf_p, encoding="utf-8")) if os.path.isfile(kf_p) else None


    task, video, login = data.get("task", {}), data.get("video", {}), data.get("login", {})
    metrics, comments, search = data.get("metrics", {}), data.get("comments", {}), data.get("search", {})
    cov = data.get("collection", {}).get("coverage", {})
    cov_notes = data.get("collection", {}).get("coverage_notes", {})
    # 用户后台数据：对标账号视频 → 未提供；自有账号视频 → 按用户提供的后台数据如实显示
    is_self = task.get("analysis_mode") in ("self_owner", "self", "own_account")
    ub = cov.get("user_backend")
    ub_cell = cov_cell(ub) if is_self else "<td class='muted'>未提供（对标账号视频）</td>"
    cov_rows = ""
    for k, v in cov.items():
        cell = ub_cell if k == "user_backend" else cov_cell(v)
        cov_rows += (f"<tr><td>{esc(COV_LABELS.get(k, k))}</td>{cell}"
                     f"<td class='muted' style='font-size:12px'>{esc(cov_notes.get(k, ''))}</td></tr>")

    # 报告标题：合适的名称 + 生成日期时间
    from datetime import datetime
    gen_ts = datetime.now().strftime("%Y-%m-%d %H:%M")
    author_n = (video.get("author") or {}).get("nickname") or "抖音视频"
    title_short = re.sub(r"#\S+", "", video.get("title") or "").strip()[:14] or "单视频"
    report_title = args.title or f"{author_n}「{title_short}」全方位逆向分析报告"
    report_title_full = f"{report_title} · 生成于 {gen_ts}"

    # 可跳转链接
    v_url = task.get("video_url") or ""
    v_id = video.get("video_id") or ""
    v_link = linkify(v_url, v_url.split("?")[0] or v_url)
    id_link = linkify(f"https://www.douyin.com/video/{v_id}", v_id) if v_id else "—"
    author_sec = (video.get("author") or {}).get("sec_uid")
    author_link = (linkify(f"https://www.douyin.com/user/{author_sec}", author_n)
                   if author_sec else esc(author_n or "—"))

    hashtags = "".join(f"<span class='kw'>{esc(h)}</span>" for h in video.get("hashtags", [])) or "<span class='muted'>无</span>"
    status_badge = "<span class='badge ok'>COMPLETE</span>" if comments.get("collection_status") == "COMPLETE" else "<span class='badge warn'>PARTIAL</span>"

    # frames 目录：时间轴切点帧用 10FPS 细粒度帧；关键帧展示用 V3 3FPS 帧
    out_dir = os.path.dirname(os.path.abspath(args.output))
    # ★ 封面文件（视频第 1 帧直接解码，由 extract_cover.py 产出；禁止用抽帧目录帧）
    cover_rel = None
    for cand in (os.path.join(data_dir, "cover.png"),
                 os.path.join(data_dir, "cover.jpg"),
                 os.path.join(out_dir, "cover.png"),
                 os.path.join(out_dir, "cover.jpg"),
                 os.path.join(os.path.dirname(out_dir), "cover.png"),
                 os.path.join(os.path.dirname(out_dir), "cover.jpg")):
        if os.path.isfile(cand):
            cover_rel = os.path.relpath(cand, out_dir).replace("\\", "/")
            break
    frames_dir, frames_rel = None, "frames"
    for cand, rel in ((os.path.join(out_dir, "frames"), "frames"),
                      (os.path.join(os.path.dirname(out_dir), "frames"), "../frames"),
                      (os.path.join(out_dir, "frames15"), "frames15"),
                      (os.path.join(os.path.dirname(out_dir), "frames15"), "../frames15")):
        if os.path.isdir(cand):
            frames_dir, frames_rel = cand, rel
            break
    kf_frames_dir, kf_frames_rel = frames_dir, frames_rel
    for cand in (os.path.join(data_dir, "frames3"),
                 os.path.join(out_dir, "frames3"),
                 os.path.join(os.path.dirname(out_dir), "frames3")):
        if os.path.isdir(cand):
            kf_frames_dir = cand
            kf_frames_rel = os.path.relpath(cand, out_dir).replace("\\", "/")
            break

    # 视频文件：显示标题名 + 相对路径可点击跳转
    vf = data.get("media", {}).get("video_file")
    if vf and os.path.isfile(os.path.join(data_dir, vf)):
        vf_abs = os.path.join(data_dir, vf)
        vf_rel = os.path.relpath(vf_abs, out_dir).replace("\\", "/")
        vf_disp = data.get("media", {}).get("video_file_display") or os.path.basename(vf)
        vf_link = (f"<a href='{esc(vf_rel)}' target='_blank' class='vlink'>{esc(vf_disp)}</a> "
                   f"<span class='muted' style='font-size:12px'>(路径: {esc(vf_rel)})</span>")
    else:
        vf_link = "未下载"

    author_nickname = (video.get("author") or {}).get("nickname") or ""
    mm = analysis.get("metrics_meaning", {})
    analysis_skip = {"timeline", "metrics_meaning", "click", "structure", "cognition",
                     "diagnosis", "replication", "five_conclusions", "comments_analysis", "meta"}

    # 关键帧口径以 keyframes.json（V3 实跑产物）为准，避免 data.json.media 里的历史残留值污染报告
    _kf_items = (kf or {}).get("keyframes") or (kf or {}).get("frames") or []
    _kf_count = len(_kf_items) if _kf_items else (data.get("media", {}).get("keyframes_count") or "—")
    if kf:
        _kf_rule = f"《通用关键帧抽取规则 {kf.get('rule') or 'V3'}》{kf.get('video_type') or ''} 档·软指标 {kf.get('soft_metric') or 'ssim'}".strip()
    else:
        _kf_rule = data.get("media", {}).get("frame_rule") or ""

    doc = f"""<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<title>{esc(report_title_full)}</title>
<style>
:root{{--bg:#f5f6f8;--card:#fff;--ink:#1f2329;--muted:#86909c;--line:#e5e6eb;--brand:#fe2c55;--ok:#00b42a;--warn:#ff7d00;--bad:#f53f3f}}
*{{box-sizing:border-box}}
body{{margin:0;font-family:"Microsoft YaHei",system-ui,sans-serif;background:var(--bg);color:var(--ink);font-size:14px;line-height:1.65}}
.wrap{{max-width:1180px;margin:0 auto;padding:24px}}
h1{{font-size:22px}} h3{{font-size:16px;margin:0 0 14px;border-left:4px solid var(--brand);padding-left:10px}}
h4{{font-size:14px;margin:16px 0 8px;color:var(--ink)}} h5{{font-size:13px;margin:14px 0 6px;color:var(--muted)}}
.card{{background:var(--card);border-radius:10px;padding:18px 22px;margin-bottom:16px;box-shadow:0 1px 3px rgba(0,0,0,.06)}}
.muted{{color:var(--muted)}} .ok{{color:var(--ok)}} .warn{{color:var(--warn)}} .bad{{color:var(--bad)}}
.warn-text{{color:var(--warn)}}
.badge{{display:inline-block;padding:2px 10px;border-radius:10px;font-size:12px;color:#fff;vertical-align:middle}}
.badge.ok{{background:var(--ok)}} .badge.warn{{background:var(--warn)}} .badge.bad{{background:var(--bad)}} .badge.muted{{background:var(--muted)}}
.stat-row{{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:12px}}
.stat{{flex:1;min-width:120px;background:#fafafa;border:1px solid var(--line);border-radius:8px;padding:12px;text-align:center}}
.stat b{{display:block;font-size:22px}} .stat span{{font-size:12px;color:var(--muted)}}
table{{width:100%;border-collapse:collapse}} th,td{{border-bottom:1px solid var(--line);padding:8px 10px;text-align:left;vertical-align:top}}
th{{background:#fafafa;font-weight:600;font-size:12px;color:var(--muted)}}
.kv td:first-child{{width:170px;color:var(--muted)}}
.sub-block{{margin:14px 0;padding:12px 14px;background:#fafbfc;border-radius:8px;border:1px solid var(--line)}}
.sub-block h5{{margin-top:0}}
.mini-cards{{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:10px}}
.mini-card{{background:#fafbfc;border:1px solid var(--line);border-radius:8px;padding:10px 14px}}
.mini-card.wide{{grid-column:1/-1}}
.mini-card h5{{margin:0 0 6px;color:var(--ink)}} .mini-card p{{margin:4px 0}}
.plain-list{{margin:4px 0;padding-left:20px}} .plain-list li{{margin:3px 0}}
.one-line{{background:#fff5f7;border:1px solid #ffd6de;border-radius:8px;padding:12px 16px;font-weight:700;color:var(--brand);margin:8px 0}}
.step{{display:flex;gap:12px;margin:8px 0;align-items:flex-start}}
.step-n{{min-width:24px;height:24px;border-radius:50%;background:var(--brand);color:#fff;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;margin-top:2px}}
.kws{{display:flex;flex-wrap:wrap;gap:8px}}
.kw{{background:#f2f3f5;border:1px solid var(--line);border-radius:14px;padding:4px 12px;font-size:13px}}
.filter-bar{{display:flex;gap:10px;margin:12px 0}}
.filter-bar input{{flex:1;padding:8px 12px;border:1px solid var(--line);border-radius:8px}}
.filter-bar select{{padding:8px;border:1px solid var(--line);border-radius:8px}}
.tl-item{{display:flex;gap:16px;padding:14px 0;border-bottom:1px dashed var(--line);align-items:flex-start}}
.tl-kf-wrap{{flex:0 0 clamp(120px,16vw,200px)}}
.tl-kf{{margin:0}}
.tl-kf img{{width:100%;height:auto;object-fit:contain;border-radius:8px;border:1px solid var(--line);display:block;background:#000}}
.tl-unit{{font-family:Consolas,monospace;background:var(--brand);color:#fff;border-radius:4px;padding:1px 8px;font-size:12px;font-weight:700}}
.subs{{margin-top:8px}}
.subs summary{{cursor:pointer;color:#1d6fe8;font-size:12px}}
.subs-tbl{{margin-top:6px;font-size:12px}}
.subs-tbl td,.subs-tbl th{{padding:4px 8px}}
.tl-strip{{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}}
.tl-fig{{margin:0;width:96px}}
.tl-fig figcaption{{font-size:11px;color:var(--muted);padding:3px 2px}}
.cover-full{{width:100%;max-width:420px;border-radius:10px;border:1px solid var(--line);display:block;margin:8px 0}}
.formula-box{{background:#fffbe6;border-color:#ffe58f}}
.formula-text{{background:#fff;border:1px dashed #d9d9d9;border-radius:6px;padding:8px 12px;margin:6px 0;font-size:13px}}
.kf-grid{{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;max-height:660px;overflow:auto}}
.kf{{margin:0}}
.kf img{{width:100%;height:auto;object-fit:contain;border-radius:4px;border:1px solid var(--line);display:block;background:#000}}
.kf figcaption{{font-size:10px;padding:3px 2px;line-height:1.4}}
.kf-ocr{{color:#1d6fe8;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}}
.kf-reason{{display:inline-block;font-size:9px;padding:0 5px;border-radius:6px;color:#fff;background:var(--muted);vertical-align:middle}}
.kf-reason.r-first{{background:#7a5af8}} .kf-reason.r-cut{{background:#e8462d}}
.kf-reason.r-evt{{background:#1d6fe8}} .kf-reason.r-mid{{background:#0aa87a}} .kf-reason.r-last{{background:#7a5af8}}
.kf-metric{{font-size:9px;white-space:nowrap}}
.kf-selfcheck{{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0 12px}}
.kf-selfcheck .badge{{font-size:11px;font-weight:500}}
.kf-warn{{background:#fff7e6;border-left:3px solid #faad14;padding:8px 12px;border-radius:4px;line-height:1.6}}
.cut-tag{{font-size:11px;color:#1d6fe8;background:#eaf2fe;border-radius:4px;padding:1px 8px}}
.vlink{{color:#1d6fe8;text-decoration:none;border-bottom:1px dashed #9cc3f5}}
.vlink:hover{{color:var(--brand);border-bottom-color:var(--brand)}}
.tl-head{{display:flex;gap:12px;align-items:baseline;flex-wrap:wrap}}
.tl-time{{font-family:Consolas,monospace;color:var(--brand);font-weight:700;font-size:13px}}
.tl-text{{margin:2px 0;color:#4e5969}}
.timeline{{max-height:720px;overflow:auto}}
.transcript .seg{{display:flex;gap:12px;padding:6px 0;border-bottom:1px dashed var(--line)}}
.full-text{{background:#fafbfc;border:1px solid var(--line);border-radius:8px;padding:12px 16px}}
/* 抖音评论区 */
.dy-panel{{max-height:760px;overflow:auto;border:1px solid var(--line);border-radius:8px;padding:6px 0}}
.dy-comment{{display:flex;gap:10px;padding:10px 16px}}
.dy-comment:hover{{background:#fafafa}}
.dy-comment.reply{{padding:8px 12px 8px 0}}
.dy-main{{flex:1;min-width:0}}
.dy-nick{{font-size:12px;color:var(--muted)}}
.dy-content{{font-size:14px;margin:2px 0;word-break:break-word}}
.dy-meta{{font-size:12px;color:var(--muted);display:flex;gap:6px;align-items:center}}
.dot{{color:var(--line)}}
.dy-reply-btn{{cursor:default}} .dy-reply-btn:hover{{color:var(--brand)}}
.dy-like{{min-width:44px;text-align:center;color:var(--muted);font-size:12px;flex-shrink:0}}
.dy-like b{{display:block;font-weight:400}} .dy-like.active{{color:var(--brand)}}
.dy-like.active::first-letter{{content:"♥"}}
.avatar{{width:36px;height:36px;border-radius:50%;flex-shrink:0;object-fit:cover;background:#f2f3f5}}
.av-fb{{display:flex;align-items:center;justify-content:center;background:#e5e6eb;color:var(--muted);font-size:14px}}
.author-tag{{display:inline-block;margin-left:6px;padding:0 6px;border-radius:3px;background:var(--brand);color:#fff;font-size:10px;vertical-align:1px}}
.dy-replies{{display:none;background:#fafbfc;border-radius:8px;margin:2px 0 6px 46px;padding:2px 0}}
.dy-replies-wrap.open .dy-replies{{display:block}}
.dy-expand{{margin:0 0 8px 46px;font-size:12px;color:#495976;cursor:pointer;user-select:none}}
.dy-expand:hover{{color:var(--brand)}}
/* 五大结论 */
.fc-grid{{display:grid;grid-template-columns:1fr 1fr;gap:12px}}
.fc-card{{display:flex;gap:12px;background:#fafbfc;border:1px solid var(--line);border-radius:8px;padding:14px}}
.fc-n{{min-width:28px;height:28px;border-radius:50%;background:var(--brand);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700}}
.frames-grid{{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}}
.frames-grid figure{{margin:0}}
.frames-grid img{{width:100%;border-radius:8px;border:1px solid var(--line);display:block}}
.frames-grid figcaption{{font-size:12px;padding:6px 2px;line-height:1.5}}
@media (max-width:900px){{.frames-grid,.fc-grid{{grid-template-columns:1fr 1fr}}}}
.meta-grid td:first-child{{width:160px;color:var(--muted)}}
footer{{text-align:center;color:var(--muted);font-size:12px;padding:20px}}
</style></head><body><div class="wrap">
<h1>{esc(report_title_full)} <span class="muted" style="font-size:13px">douyin-video-analysis V0.2.1</span></h1>

<div class="card"><h3>01 报告摘要</h3>
<p>视频 <b>{v_link}</b>（id: {id_link}）</p>
<p class="muted">采集时间：{esc(task.get('collected_at') or '—')} ｜ 登录状态：{esc(login.get('status') or '—')} ｜ 分析模式：{esc(task.get('analysis_mode') or '—')}（默认配置=全面分析）</p>
<p class="muted">数据分层：FACT/OBSERVATION 分离，逐条结论绑证据；视觉分析基于《通用关键帧抽取规则 V3》状态机（硬切独立通道 + 场景锚点软变化 + 冷却窗 + 事件上限）{'；ASR 已运行' if asr else '；ASR 未运行'}。</p>
</div>

<div class="card"><h3>02 视频基本信息</h3>
<table class="meta-grid">
<tr><td>标题</td><td>{esc(video.get('title') or '—')}</td></tr>
<tr><td>话题 hashtags</td><td>{hashtags}</td></tr>
<tr><td>时长</td><td>{fmt_t(video.get('duration'))}</td></tr>
<tr><td>发布时间</td><td>{esc(video.get('publish_time') or '—')}</td></tr>
<tr><td>作者</td><td>{author_link}</td></tr>
<tr><td>视频文件</td><td>{vf_link}（{esc(_kf_rule or data.get('media',{}).get('frame_rule') or '')}：基础采样 {esc(data.get('media',{}).get('frame_rate_machine') or '—')}FPS {esc(data.get('media',{}).get('frames_count') or '—')} 帧 → 关键帧 {esc(_kf_count)} 帧）</td></tr>
</table></div>

<div class="card"><h3>04 数据完整度（按实际分析情况填写）</h3>
<table><thead><tr><th>数据项</th><th>覆盖度</th><th>口径说明</th></tr></thead><tbody>{cov_rows}</tbody></table>
<p class="muted">音频/OCR 覆盖度按实际分析产出填写（音频=已提取+ASR 全程转写；OCR=全帧扫描），非公开页面口径。
后台数据（播放/完播/GMV）公开页面不可得，不采不写。</p></div>

{render_metrics_meaning(mm, metrics) if mm else render_metrics_basic(metrics)}
{render_interaction_structure(metrics)}

<div class="card"><h3>23b 评论完整性 {status_badge}</h3>
<table class="kv">
<tr><td>一级评论</td><td>{fmt_num(comments.get('total_top_level'))}</td></tr>
<tr><td>回复</td><td>{fmt_num(comments.get('total_replies'))}</td></tr>
<tr><td>总评论节点</td><td>{fmt_num(comments.get('total_nodes'))}</td></tr>
<tr><td>采集状态</td><td>{esc(comments.get('collection_status') or '—')}</td></tr>
</table>
{'<p class="warn-text">失败原因：' + esc(comments.get('partial_reason') or '') + '</p>' if comments.get('collection_status') == 'PARTIAL' else ''}
</div>

{render_keyframes(data, analysis, kf, ocr, kf_frames_dir, kf_frames_rel) if kf else ''}
{render_timeline(analysis, analysis.get('keyframe_timeline'), kf_frames_dir, kf_frames_rel)}
{render_asr(asr, analysis)}
{render_ocr(ocr)}
{render_search(search)}
{render_click(analysis.get('click', {}), frames_dir, frames_rel, cover_rel) if analysis.get('click') else ''}
{render_structure(analysis.get('structure', {})) if analysis.get('structure') else ''}
{render_cognition(analysis.get('cognition', {})) if analysis.get('cognition') else ''}
{render_comments_demand(analysis.get('comments_analysis', {})) if analysis.get('comments_analysis') else ''}
{render_generic_analysis(analysis, analysis_skip)}
{render_diagnosis(analysis.get('diagnosis', {})) if analysis.get('diagnosis') else ''}
{render_replication(analysis.get('replication', {}), analysis) if analysis.get('replication') else ''}
{render_five(analysis.get('five_conclusions', {})) if analysis.get('five_conclusions') else (lambda: '')()}
{render_comments_douyin(comments, author_nickname)}

<div class="card"><h3>33 采集异常记录</h3>
{(''.join(f"<p class='warn-text'>[{esc(e.get('stage'))}] {esc(e.get('type'))}: {esc(e.get('message'))}</p>" for e in data.get('collection', {}).get('errors', [])) or '<p class="muted">无异常</p>')}
</div>

<footer>由 douyin-video-analysis V0.2.1 生成 · 只采公开信息 · 采集与分析分离 · FACT/OBSERVATION/INFERENCE 分层</footer>
</div>
<script>
const panel = document.querySelector('#c-panel');
if (panel) {{
  const q = document.querySelector('#c-search'), f = document.querySelector('#c-filter'), s = document.querySelector('#c-sort');
  const units = Array.from(panel.children); // 一级评论 + 回复包裹块
  function ownerOf(el) {{
    if (el.classList.contains('dy-replies-wrap')) return el.dataset.parent;
    return null;
  }}
  function apply() {{
    const kw = (q.value || '').toLowerCase(), mode = f.value, sort = s.value;
    const visible = [];
    units.forEach(u => {{
      if (u.classList.contains('dy-comment')) {{
        const like = +u.dataset.likes || 0, text = u.dataset.text || '', time = u.dataset.time || '';
        let ok = true;
        if (mode === 'top' || mode === 'reply') ok = ok && u.dataset.kind === 'top';
        if (mode === 'hot') ok = ok && like >= 5;
        if (mode === 'author') ok = ok && u.querySelector('.author-tag');
        if (kw) ok = ok && text.toLowerCase().includes(kw);
        u.style.display = ok ? '' : 'none';
        if (ok) visible.push(u);
        return;
      }}
      // 回复包裹块：随其父评论显隐 + 自身筛选
      const pid = u.dataset.parent;
      const parent = units.find(x => x.classList.contains('dy-comment') && x.querySelector('[data-parent]') === null);
      const kids = Array.from(u.querySelectorAll('.dy-comment'));
      let any = false;
      kids.forEach(k => {{
        let ok = true;
        if (mode === 'reply') ok = true;
        if (mode === 'top') ok = false;
        if (mode === 'hot') ok = (+k.dataset.likes || 0) >= 5;
        if (mode === 'author') ok = !!k.querySelector('.author-tag');
        if (kw) ok = ok && (k.dataset.text || '').toLowerCase().includes(kw);
        k.style.display = ok ? '' : 'none';
        if (ok) {{ any = true; visible.push(k); }}
      }});
      const parentEl = units.find(x => x.classList.contains('dy-comment') &&
        x.getAttribute('data-kcid') === pid);
      const parentVisible = !parentEl || parentEl.style.display !== 'none';
      u.style.display = (any || (parentVisible && mode !== 'reply')) ? '' : 'none';
    }});
    // 排序：一级评论按所选键重排（回复保持各自内部序）
    if (sort !== 'orig') {{
      const tops = units.filter(u => u.classList.contains('dy-comment'));
      tops.sort((a, b) => {{
        if (sort === 'likes') return (+b.dataset.likes || 0) - (+a.dataset.likes || 0);
        return (b.dataset.time || '').localeCompare(a.dataset.time || '');
      }});
      const anchor = panel; // 重挂
      tops.forEach(t => panel.appendChild(t));
      units.filter(u => u.classList.contains('dy-replies-wrap')).forEach(w => {{
        const pid = w.dataset.parent;
        const p = tops.find(t => t.getAttribute('data-kcid') === pid);
        if (p) p.after(w); else panel.appendChild(w);
      }});
    }}
  }}
  // 给一级评论打 cid 锚点，便于回复块跟随
  document.querySelectorAll('.dy-replies-wrap').forEach(w => {{
    const pid = w.dataset.parent;
    // 通过相邻关系找父：遍历前面的 .dy-comment
    let el = w.previousElementSibling;
    while (el && !el.classList.contains('dy-comment')) el = el.previousElementSibling;
    if (el) el.setAttribute('data-kcid', pid);
  }});
  q.addEventListener('input', apply); f.addEventListener('change', apply); s.addEventListener('change', apply);
}}
</script>
</body></html>"""

    os.makedirs(out_dir, exist_ok=True)
    # ★ 按章节编号重排（90 要求）：各章节分散在多个渲染函数里拼接，拼接序 ≠ 编号序
    doc = reorder_cards_by_number(doc)
    with open(args.output, "w", encoding="utf-8") as f:
        f.write(doc)
    print(f"[报告] 已生成: {args.output}")


# ============ 章节按标题编号排序（90 于 2026-09-24 要求） ============
# 各章节分散在多个渲染函数里拼接，拼接顺序 ≠ 章节编号顺序（如 25 排在 05 后、06 排在 21 后）。
# 此处统一按 <h3> 中的章节编号升序重排顶层 <div class="card"> 序列。

# 无编号卡片的定位锚点（插到该编号之后）
_ANCHOR_SLOT = {
    "关键帧与机器分析": 4.5,    # 数据层，接 04 之后
    "keyframe_timeline": 13.5,  # 紧随 14 时间轴
    "CTA 与互动机制": 21.5,     # 接 21 之后
    "voiceover": 17.5,          # 口播文案，接 17 OCR 之后
}
_NUM_RE = re.compile(r"^\s*(\d+)\s*([a-z])?")


def _chapter_sort_key(title: str, orig: int):
    t = re.sub(r"<[^>]+>", "", title or "").strip()
    m = _NUM_RE.match(t)
    if m:
        major = int(m.group(1))
        minor = (ord(m.group(2)) - ord("a") + 1) * 10 if m.group(2) else 0
        return (major, minor, orig)
    for k, v in _ANCHOR_SLOT.items():
        if k in t:
            return (int(v), round((v - int(v)) * 100), orig)
    return (98, 0, orig)   # 未识别 → 靠后，保留原序


def _split_top_level_cards(body: str):
    """切分 body 中所有顶层 <div class="card">…</div> 块。

    返回 (prefix, cards, suffix)：
      prefix = 第一张 card 之前的文本；
      cards  = [{"title","html","order"}]，html 含该 card 自身的完整闭合标签；
      suffix = 最后一张 card 之后的文本。
    用 `<div class="card">` 作锚点 + div 深度配对找闭合（card 内部允许嵌套 div）。
    """
    # 注意：card 有两种写法 —— block() 产出 class='card'（单引号），doc 硬编码 class="card"（双引号）
    card_open_re = re.compile(r'''<div\b[^>]*class=['"]card['"]''')
    tok_re = re.compile(r'<div\b[^>]*>|</div>')
    spans = []
    for m in card_open_re.finditer(body):
        start = m.start()
        if any(s <= start < e for s, e in spans):
            continue  # 嵌套在已有 card 内，跳过
        # 从 card 起点做 div 深度配对，找到它自己的闭合位置
        depth, end = 0, None
        for t in tok_re.finditer(body, start):
            if t.group(0).startswith("</"):
                depth -= 1
                if depth == 0:
                    end = t.end()
                    break
            else:
                depth += 1
        if end:
            spans.append((start, end))

    if not spans:
        return None, [], None
    prefix = body[:spans[0][0]]
    cards = []
    for i, (s, e) in enumerate(spans):
        seg = body[s:e]
        mh = re.search(r"<h3[^>]*>(.*?)</h3>", seg, re.S)
        title = re.sub(r"<[^>]+>", "", mh.group(1)).strip() if mh else ""
        cards.append({"title": title, "html": seg, "order": i})
    # suffix = 最后一张 card 闭合之后的全部内容
    suffix = body[spans[-1][1]:]
    return prefix, cards, suffix


def reorder_cards_by_number(doc: str) -> str:
    """按章节编号重排 body 内的顶层 card，非 card 内容保持位置。"""
    m = re.search(r"(<body>)(.*)(</body>)", doc, re.S)
    if not m:
        return doc
    body = m.group(2)
    prefix, cards, suffix = _split_top_level_cards(body)
    if not cards:
        return doc
    ordered = sorted(cards, key=lambda c: _chapter_sort_key(c["title"], c["order"]))
    new_body = prefix + "".join(c["html"] for c in ordered) + suffix
    return doc[:m.start(2)] + new_body + doc[m.end(2):]


def linkify(url: str, text: str = None) -> str:
    if not url:
        return "—"
    return f"<a href='{esc(url)}' target='_blank' rel='noopener' class='vlink'>{esc(text or url)}</a>"


def render_metrics_basic(metrics: dict) -> str:
    cells = [("❤ 点赞", metrics.get("likes")), ("💬 评论", metrics.get("comments")),
             ("⭐ 收藏", metrics.get("favorites")), ("↗ 分享", metrics.get("shares"))]
    stats = "".join(f"<div class='stat'><b>{fmt_num(v)}</b><span>{k}</span></div>" for k, v in cells)
    return f"<div class='card'><h3>05 关键指标</h3><div class='stat-row'>{stats}</div><p class='muted'>来源：{esc(metrics.get('source') or 'VIDEO_PAGE')}。指标意义分析待 analysis.json 提供 metrics_meaning。</p></div>"


def render_search(search: dict) -> str:
    kws = search.get("keywords", [])
    if not kws:
        return ("<div class='card'><h3>21 大家都在搜</h3>"
                f"<p class='muted'>未采集到（状态：{esc(search.get('collection_status', '?'))}）。注意：与 hashtags 严格区分。</p></div>")
    tags = "".join(f"<span class='kw'>{esc(k)}</span>" for k in kws)
    return f"<div class='card'><h3>21 大家都在搜</h3><div class='kws'>{tags}</div></div>"


if __name__ == "__main__":
    main()
