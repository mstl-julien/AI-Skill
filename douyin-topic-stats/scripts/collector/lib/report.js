'use strict';

/**
 * report.js —— HTML 报告（Spec §4.3）
 *
 * 两层内容，明确区分：
 *   一~七章 = 采集事实（代码生成，不含分析）
 *   第八章  = 对标分析结论（AI 按 references/analysis-framework.md 产出 analysis.md，
 *             放进数据目录后由本生成器嵌入；没有 analysis.md 时显示占位提示）
 */

const fs = require('fs');
const path = require('path');

const esc = (s) =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const fmt = (n) => (typeof n === 'number' ? n.toLocaleString('en-US') : n == null ? '—' : n);

/** 时长统一为「X分YY秒」（90 于 2026-09-23 定的口径，全报告不出现裸秒数） */
const fmtDur = (ms) => {
  if (typeof ms !== 'number' || !isFinite(ms) || ms <= 0) return '—';
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}分${String(s).padStart(2, '0')}秒`;
};

/** 抖音视频跳转链接（公开页面 URL，新窗口打开） */
const videoLink = (vid, label) => {
  if (!vid) return esc(label || '');
  const href = `https://www.douyin.com/video/${vid}`;
  const text = esc(label || vid);
  return `<a class="vlink" href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`;
};

/** 极简 Markdown 渲染（支持分析文档实际用到的语法：标题/列表/加粗/行内码/高亮/表格） */
function mdLite(md) {
  const lines = String(md).split(/\r?\n/);
  const out = [];
  let inList = false;
  let tableBuf = null; // { header: string[], rows: string[][] }
  const closeList = () => {
    if (inList) {
      out.push('</ul>');
      inList = false;
    }
  };
  const flushTable = () => {
    if (!tableBuf) return;
    const t = tableBuf;
    tableBuf = null;
    const cell = (txt, isHead) => `<${isHead ? 'th' : 'td'}>${txt}</${isHead ? 'th' : 'td'}>`;
    out.push('<div class="tbl"><table>');
    out.push(`<tr>${t.header.map((x) => cell(x, true)).join('')}</tr>`);
    for (const r of t.rows) out.push(`<tr>${r.map((x) => cell(x, false)).join('')}</tr>`);
    out.push('</table></div>');
  };
  const inline = (t) =>
    esc(t)
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/==([^=]+)==/g, '<mark>$1</mark>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    let m;
    // 表格行：| a | b | （含分隔行 |---|---|）。
    // 单元格内的 `\|` 是标题原文里的竖线，必须按字面保留 —— 先按"未转义的 |"切分，再把 \| 还原成 |。
    if (/^\s*\|(.+)\|\s*$/.test(line)) {
      closeList();
      const cells = line
        .trim()
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split(/(?<!\\)\|/)
        .map((x) => x.trim().replace(/\\\|/g, '|'));
      if (cells.every((x) => /^:?-{2,}:?$/.test(x) || x === '')) continue; // 分隔行
      if (!tableBuf) tableBuf = { header: cells.map(inline), rows: [] };
      else tableBuf.rows.push(cells.map(inline));
      continue;
    }
    flushTable();
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      closeList();
      const lvl = Math.min(m[1].length + 1, 5);
      out.push(`<h${lvl}>${inline(m[2])}</h${lvl}>`);
    } else if ((m = line.match(/^\s*[-*]\s+(.*)$/))) {
      if (!inList) {
        out.push('<ul>');
        inList = true;
      }
      out.push(`<li>${inline(m[1])}</li>`);
    } else if ((m = line.match(/^\s*\d+\.\s+(.*)$/))) {
      if (!inList) {
        out.push('<ul>');
        inList = true;
      }
      out.push(`<li>${inline(m[1])}</li>`);
    } else if (!line.trim()) {
      closeList();
    } else {
      closeList();
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  closeList();
  flushTable();
  return out.join('\n');
}

/** 读取数据目录里的 analysis.md（AI 按 analysis-framework 生成）；不存在返回 null */
function loadAnalysis(dataDir) {
  try {
    const p = path.join(dataDir, 'analysis.md');
    if (!fs.existsSync(p)) return null;
    const md = fs.readFileSync(p, 'utf8');
    return md.trim() ? { path: p, html: mdLite(md) } : null;
  } catch {
    return null;
  }
}

const GROUP_LABEL = {
  pinned: '置顶',
  high: '高赞',
  latest: '最新',
  mid: '中位',
  low: '低赞',
};

function pctCell(r) {
  if (!r || !r.total) return '<span class="muted">—</span>';
  const cls = r.pct >= 90 ? 'good' : r.pct >= 50 ? 'warn' : 'bad';
  return `<span class="${cls}">${r.available}/${r.total} (${r.pct}%)</span>`;
}

function buildReport(c, result) {
  const { videos, details, comments } = result;
  const log = c.log;
  const s = log.summary || {};
  const cov = log.coverage || {};
  const analysis = loadAnalysis(c.dataDir);

  // 账号类型判定（90 于 2026-09-23 定，当晚修正）：
  //   蓝V企业号 = verification_type===2（企业认证）；黄V个人认证(type=1，如干饭兄弟)→ 个人号/达人号
  //   旧规则 verification 非空即企业号 会把黄V达人误判成企业号，已废除
  const acc0 = c.account || {};
  const isBlueV = acc0.verification_type === 2;
  const isYellowV = acc0.verification_type === 1;
  const accountType = isBlueV ? '企业号' : isYellowV ? '个人号 / 达人号（黄V个人认证）' : '个人号 / 达人号';
  const accountNameHtml =
    esc(acc0.nickname || s.account || '未取到昵称') + (isBlueV ? ' <span class="bv">V</span>' : '');

  // 选样映射：video_id → 分组。详情行自带 sample_group；
  // 旧数据（无该字段）时从 selection_plan.json 回填。
  const selectedMap = {};
  for (const d of details) {
    if (d.sample_group) selectedMap[d.video_id] = d.sample_group;
  }
  if (c.dataDir) {
    try {
      const sp = JSON.parse(fs.readFileSync(path.join(c.dataDir, 'selection_plan.json'), 'utf8'));
      for (const v of sp.selection || []) {
        if (v.video_id && !selectedMap[v.video_id]) selectedMap[v.video_id] = v.sample_group;
      }
    } catch {
      /* 无计划文件则只用详情自带字段 */
    }
  }
  const groupTag = (gid) =>
    gid
      ? `<span class="tag" style="border-left:3px solid var(--info);padding-left:6px">${esc(GROUP_LABEL[gid] || gid)}</span>`
      : '<span class="muted">—</span>';

  // 视频元信息映射：评论表要用（选样标签 + 标题），标题优先取详情，缺失回退作品列表
  const vidInfo = {};
  for (const v of videos) {
    if (v.video_id) vidInfo[v.video_id] = { title: v.title || '', group: null };
  }
  for (const d of details) {
    if (d.video_id) {
      vidInfo[d.video_id] = vidInfo[d.video_id] || { title: '', group: null };
      if (d.title) vidInfo[d.video_id].title = d.title;
      const g = d.sample_group || selectedMap[d.video_id];
      if (g) vidInfo[d.video_id].group = g;
    }
  }
  for (const [vid, g] of Object.entries(selectedMap)) {
    if (vidInfo[vid]) vidInfo[vid].group = vidInfo[vid].group || g;
    else vidInfo[vid] = { title: '', group: g };
  }

  const errorsByType = {};
  for (const e of log.errors) errorsByType[e.error_type] = (errorsByType[e.error_type] || 0) + 1;

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>抖音采集结果 · ${esc(s.account || '')} · V0.1</title>
<style>
:root{
  --bg:#16181d; --panel:#1e2128; --panel2:#252932; --line:#333844;
  --tx:#e8eaf0; --tx2:#a2a9b8; --tx3:#6f7787;
  --ok:#3fd68c; --warn:#e8b33c; --bad:#e2565a; --info:#5aa9f0;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--tx);
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
  font-size:13px;line-height:1.65}
.wrap{max-width:1400px;margin:0 auto;padding:28px 22px 60px}
h1{font-size:21px;font-weight:600;margin:0 0 4px}
h2{font-size:16px;font-weight:600;margin:30px 0 12px;padding-left:9px;border-left:3px solid var(--info)}
.sub{color:var(--tx2);font-size:12px;margin-bottom:20px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(158px,1fr));gap:10px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:13px 14px}
.card .k{color:var(--tx3);font-size:11px;letter-spacing:.4px}
.card .v{font-size:20px;font-weight:600;margin-top:5px;font-variant-numeric:tabular-nums}
.card .n{color:var(--tx3);font-size:11px;margin-top:2px}
table{width:100%;border-collapse:collapse;background:var(--panel);border-radius:10px;overflow:hidden}
th,td{padding:8px 11px;text-align:left;border-bottom:1px solid var(--line);font-size:12px;vertical-align:top}
th{background:var(--panel2);color:var(--tx2);font-weight:600;font-size:11px;letter-spacing:.3px;white-space:nowrap}
tr:last-child td{border-bottom:none}
td.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.tag{display:inline-block;padding:1px 7px;border-radius:20px;font-size:10.5px;border:1px solid var(--line);color:var(--tx2)}
.good{color:var(--ok)} .warn{color:var(--warn)} .bad{color:var(--bad)} .muted{color:var(--tx3)}
.pill{display:inline-block;padding:2px 8px;border-radius:6px;font-size:11px;margin:2px 4px 2px 0;background:var(--panel2);border:1px solid var(--line)}
.bv{display:inline-block;min-width:16px;height:16px;line-height:16px;text-align:center;background:#2b7cff;color:#fff;font-size:11px;font-weight:700;border-radius:4px;padding:0 4px;vertical-align:2px;letter-spacing:0}
.thumb{width:52px;height:70px;object-fit:cover;border-radius:5px;background:var(--panel2);display:block}
.scroll{max-height:520px;overflow:auto;border-radius:10px;border:1px solid var(--line)}
.scroll table{border-radius:0}
.note{background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--warn);
  border-radius:8px;padding:11px 14px;color:var(--tx2);font-size:12px;margin-top:10px}
.note b{color:var(--tx)}
pre{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:12px;
  overflow:auto;font-size:11.5px;color:var(--tx2);max-height:340px;
  font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
.two{display:grid;grid-template-columns:1fr 1fr;gap:14px}
@media(max-width:900px){.two{grid-template-columns:1fr}}
</style>
</head>
<body><div class="wrap">

<h1>抖音对标分析报告 · ${accountNameHtml}</h1>
<div class="sub">
  账号类型 <b style="color:var(--info)">${esc(accountType)}</b>${isBlueV ? ' <span class="bv">V</span>' : ''} ｜
  运行 ID ${esc(log.run_id)} ｜ 开始 ${esc(log.started_at)} ｜ 结束 ${esc(log.finished_at || '—')}<br>
  来源 URL <span class="muted">${esc(log.input_url || '')}</span> ｜ 状态 <b>${esc(log.status)}</b>
</div>

<h2>一、采集结果摘要（Spec §4.2）</h2>
<div class="grid">
  <div class="card"><div class="k">作品数（主页显示）</div><div class="v">${fmt(s['作品数_主页显示'])}</div><div class="n">页面文本</div></div>
  <div class="card"><div class="k">已采集作品</div><div class="v">${fmt(s['作品数_已采集'])}</div><div class="n">列表去重后</div></div>
  <div class="card"><div class="k">代表视频</div><div class="v">${fmt(s['代表视频数'])}</div><div class="n">进入详情页</div></div>
  <div class="card"><div class="k">视频可访问</div><div class="v good">${fmt(s['视频可访问'])}</div><div class="n">页面正常打开</div></div>
  <div class="card"><div class="k">单视频数据成功</div><div class="v good">${fmt(s['单视频数据获取成功'])}</div><div class="n">四项互动数据</div></div>
  <div class="card"><div class="k">评论总条数</div><div class="v">${fmt(s['评论总条数'])}</div><div class="n">${fmt(s['评论获取成功视频数'])} 个视频有评论</div></div>
  <div class="card"><div class="k">评论覆盖率</div><div class="v warn">${esc(s['评论覆盖率'] || '—')}</div><div class="n">已采 / 接口声称总量</div></div>
  <div class="card"><div class="k">大家都在搜</div><div class="v ${s['大家都在搜_命中视频数'] ? 'good' : 'warn'}">${fmt(s['大家都在搜_命中视频数'])}</div><div class="n">命中视频数（实测该模块已不存在）</div></div>
  <div class="card"><div class="k">搜索框推荐词</div><div class="v good">${fmt(s['搜索框推荐词_命中视频数'])}</div><div class="n">命中视频数（替代来源）</div></div>
  <div class="card"><div class="k">失败项</div><div class="v ${s['失败项数'] ? 'bad' : 'good'}">${fmt(s['失败项数'])}</div><div class="n">错误日志条数</div></div>
</div>

<h2>二、字段覆盖度（Spec §28-A）</h2>
<div class="two">
  <div>
    <table>
      <tr><th colspan="2">账号字段</th></tr>
      <tr><td>整体完备度</td><td class="num">${pctCell(cov.account)}</td></tr>
      ${Object.entries(cov.video_fields || {})
        .filter(([k]) => k !== '封面对话')
        .map(([k, v]) => `<tr><td>作品 · ${esc(k)}</td><td class="num">${pctCell(v)}</td></tr>`)
        .join('')}
      ${Object.entries(cov.video_detail_fields || {})
        .map(([k, v]) => `<tr><td>详情 · ${esc(k)}</td><td class="num">${pctCell(v)}</td></tr>`)
        .join('')}
      ${Object.entries(cov.comment_fields || {})
        .map(([k, v]) => `<tr><td>评论 · ${esc(k)}</td><td class="num">${pctCell(v)}</td></tr>`)
        .join('')}
    </table>
  </div>
  <div>
    <table>
      <tr><th colspan="2">被动监听到的接口</th></tr>
      ${Object.entries(s.api_seen || {})
        .map(([k, v]) => `<tr><td>${esc(k)}</td><td class="num">${v} 次</td></tr>`)
        .join('') || '<tr><td class="muted">无</td><td></td></tr>'}
      <tr><th colspan="2">页面发了但未在监听</th></tr>
      ${Object.entries(s.not_watched_apis || {})
        .map(([k, v]) => `<tr><td class="muted">${esc(k)}</td><td class="num">${v} 次</td></tr>`)
        .join('') || '<tr><td class="muted">无</td><td></td></tr>'}
    </table>
  </div>
</div>

<h2>三、账号信息</h2>
<table>
  <tr>
    <td style="width:180px" class="muted">账号类型</td>
    <td><b style="color:var(--info)">${esc(accountType)}</b>${isBlueV ? ' <span class="bv">V</span>' : ''} <span class="muted">（判定规则：verification_type=2 蓝V企业认证 → 企业号；type=1 黄V个人认证或无标 → 个人号 / 达人号）</span></td>
    <td style="width:120px">${isBlueV ? '<span class="good">蓝V</span>' : ''}</td>
  </tr>
  ${Object.entries(c.account || {})
    .filter(([k]) => !['field_status', 'source', 'content_structure', 'homepage_meta', 'field_status_all'].includes(k))
    .map(([k, v]) => {
      const st = c.account && c.account.field_status ? c.account.field_status[k] : null;
      const badge = st ? `<span class="tag">${esc(st)}</span>` : '';
      return `<tr><td style="width:180px" class="muted">${esc(k)}</td><td>${v === null || v === '' ? '<span class="muted">null</span>' : esc(v)}</td><td style="width:120px">${badge}</td></tr>`;
    })
    .join('')}
  <tr><td class="muted">content_structure</td><td colspan="2">${esc(JSON.stringify(c.contentStructure))}</td></tr>
</table>

<h2>四、作品列表（前 ${Math.min(videos.length, 80)} / 共 ${videos.length}）</h2>
<div class="scroll">
<table>
  <tr><th>#</th><th>封面</th><th>标题 / 文案</th><th>话题</th><th>点赞</th><th>置顶</th><th>选样</th><th>video_id</th></tr>
  ${videos
    .slice(0, 80)
    .map(
      (v, i) => `<tr>
    <td class="num muted">${i + 1}</td>
    <td>${v.cover_image ? `<img class="thumb" src="${esc(v.cover_image)}" loading="lazy" referrerpolicy="no-referrer">` : '<span class="muted">—</span>'}</td>
    <td>${videoLink(v.video_id, (v.title || '').slice(0, 90)) || '<span class="muted">null</span>'}</td>
    <td>${(v.hashtags || []).slice(0, 4).map((h) => `<span class="pill">#${esc(h)}</span>`).join('') || '<span class="muted">—</span>'}</td>
    <td class="num">${fmt(v.likes)}</td>
    <td>${v.is_pinned ? '<span class="tag">置顶</span>' : ''}</td>
    <td>${groupTag(selectedMap[v.video_id])}</td>
    <td class="muted">${esc(v.video_id)}</td>
  </tr>`
    )
    .join('')}
</table>
</div>
<p class="sub">「选样」列标注该视频是否入选代表视频及分组（${Object.values(GROUP_LABEL).join(' / ')}）；空 = 未入选。</p>

<h2>五、代表视频详情（选样结果 + 四项互动数据）</h2>
<div class="scroll">
<table>
  <tr><th>选样</th><th>视频标题</th><th>video_id</th><th>时长</th><th>点赞</th><th>评论</th><th>收藏</th><th>分享</th><th>评论采到/总量</th><th>发布时间</th><th>话题</th><th>大家都在搜</th><th>搜索框推荐词</th><th>状态</th></tr>
  ${details
    .map(
      (d) => `<tr>
    <td>${groupTag(selectedMap[d.video_id] || d.sample_group)}</td>
    <td>${videoLink(d.video_id, (d.title || '').slice(0, 60)) || '<span class="muted">—</span>'}</td>
    <td class="muted">${videoLink(d.video_id)}</td>
    <td class="num">${fmtDur(d.video_duration)}</td>
    <td class="num">${fmt(d.likes)}</td>
    <td class="num">${fmt(d.comments)}</td>
    <td class="num">${fmt(d.favorites)}</td>
    <td class="num">${fmt(d.shares)}</td>
    <td class="num">${d.comments_collected == null ? '—' : d.comments_collected}${d.comments_total_on_page ? ' <span class="muted">/ ' + fmt(d.comments_total_on_page) + '</span>' : ''}</td>
    <td class="muted">${esc((d.publish_time || '').slice(0, 10))}</td>
    <td>${(d.hashtags || []).slice(0, 3).map((h) => `<span class="pill">#${esc(h)}</span>`).join('') || '<span class="muted">—</span>'}</td>
    <td>${d.search_keywords && d.search_keywords.value && d.search_keywords.value.length ? d.search_keywords.value.slice(0, 3).map((k) => `<span class="pill">${esc(k)}</span>`).join('') : '<span class="muted">' + esc((d.search_keywords && d.search_keywords.status) || '—') + '</span>'}</td>
    <td>${d.search_box_suggestions && d.search_box_suggestions.value && d.search_box_suggestions.value.length ? d.search_box_suggestions.value.slice(0, 3).map((k) => `<span class="pill">${esc(k)}</span>`).join('') : '<span class="muted">' + esc((d.search_box_suggestions && d.search_box_suggestions.status) || '—') + '</span>'}</td>
    <td>${d.detail_data_accessible ? '<span class="good">OK</span>' : '<span class="bad">FAIL</span>'}${d.video_playable ? ' <span class="muted">playable</span>' : ''}</td>
  </tr>`
    )
    .join('')}
</table>
</div>

<h2>六、评论样本（前 ${Math.min(comments.length, 100)} / 共 ${comments.length}）</h2>
<div class="scroll">
<table>
  <tr><th>选样</th><th>所属视频</th><th>用户</th><th>内容</th><th>获赞</th><th>IP属地</th><th>回复</th><th>时间</th></tr>
  ${comments
    .slice(0, 100)
    .map(
      (x) => {
        const info = vidInfo[x.video_id] || { title: '', group: null };
        return `<tr>
    <td>${groupTag(info.group)}</td>
    <td>${videoLink(x.video_id, (info.title || '').slice(0, 26)) || '<span class="muted">—</span>'}</td>
    <td>${esc(x.user_nickname || '')}</td>
    <td>${esc((x.content || '').slice(0, 110))}</td>
    <td class="num">${fmt(x.likes)}</td>
    <td class="muted">${esc(x.ip_location || '—')}</td>
    <td class="num">${x.reply_count == null ? '—' : x.reply_count}${x.has_replies ? ' <span class="muted">未展开</span>' : ''}</td>
    <td class="muted">${esc((x.publish_time || '').slice(0, 10))}</td>
  </tr>`;
      }
    )
    .join('')}
</table>
</div>

<h2>七、错误日志与合规审计（Spec §21 / §28-B/C）</h2>
<div class="note">
  <b>字段状态分布：</b>
  ${Object.entries(
    log.errors.reduce((a, e) => {
      a[e.error_type] = (a[e.error_type] || 0) + 1;
      return a;
    }, {})
  )
    .map(([k, v]) => `<span class="pill">${esc(k)} × ${v}</span>`)
    .join('') || '<span class="muted">无错误</span>'}
</div>
<div class="two" style="margin-top:12px">
  <div>
    <div class="sub" style="margin:0 0 8px">错误明细</div>
    <pre>${esc(
      log.errors
        .slice(0, 40)
        .map((e) => `[${e.stage}] ${e.error_type}\n  ${e.message}\n  @${e.timestamp}`)
        .join('\n\n') || '无'
    )}</pre>
  </div>
  <div>
    <div class="sub" style="margin:0 0 8px">合规丢弃字段（接口给了但白名单不要 → 已丢弃）</div>
    <pre>${esc(
      JSON.stringify(
        (log.dropped_fields || []).map((d) => ({
          stage: d.stage,
          compliance: d.compliance_dropped,
          unknown_count: d.unknown_dropped.length,
          unknown_sample: d.unknown_dropped.slice(0, 12),
        })),
        null,
        2
      )
    )}</pre>
  </div>
</div>

<h2>八、对标分析结论</h2>
${
  analysis
    ? `<div class="note" style="border-left-color:var(--warn)">
  <b>性质声明：</b>以下为 AI 按 <code>references/analysis-framework.md</code> 生成的分析结论（源文件 <code>analysis.md</code>）。
  一~七章为代码生成的采集事实，本章含分析推断——凡属推断均已按框架要求标注，播放量/完播率/GMV 等非公开维度不出现。
</div>
<div class="analysis">${analysis.html}</div>`
    : `<div class="note" style="border-left-color:var(--bad)">
  <b>分析尚未生成。</b>本报告目前只有采集事实（一~七章）。
  生成方法：按 <code>references/analysis-framework.md</code> 的六节结构与硬纪律撰写 <code>analysis.md</code>，
  存入本报告的数据目录，然后执行 <code>node tools/rebuild-report.js &lt;数据目录&gt;</code> 重新生成本页。
</div>`
}

<div class="note" style="border-left-color:var(--info)">
  <b>口径声明：</b>一~七章只呈现采集事实；第八章（若存在）为 AI 分析结论，与数据事实明确区分。所有数据来源于抖音公开页面（账号主页 / 视频详情页 / 评论区）及页面自身发出的接口响应。
  未采集且不予展示的数据包括：播放量、完播率、平均观看时长、转粉率、成交/GMV、投放数据 —— 这些在公开页面不可见。
  封面文案为图片内像素内容，V0.1 未做 OCR，标为 UNAVAILABLE。
</div>

</div></body></html>`;

  // 分析结论的样式
  const analysisCss = `<style>
a.vlink{color:var(--info);text-decoration:none;border-bottom:1px dashed rgba(90,169,240,.45)}
a.vlink:hover{color:#8cc4f7;border-bottom-color:#8cc4f7}
.analysis{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:18px 22px}
.analysis h2{border-left-color:var(--warn);margin-top:22px}
.analysis h3{font-size:15px;font-weight:600;margin:16px 0 6px;color:var(--tx)}
.analysis h4{font-size:14px;font-weight:600;margin:16px 0 6px;color:var(--tx)}
.analysis ul{margin:6px 0;padding-left:20px}
.analysis li{margin:3px 0}
.analysis code{background:var(--panel2);padding:1px 5px;border-radius:4px;font-size:11px}
.analysis p{margin:6px 0}
.analysis mark{background:rgba(232,179,60,.22);color:var(--warn);padding:0 4px;border-radius:3px;font-weight:600}
.analysis .tbl{margin:10px 0;overflow-x:auto}
.analysis .tbl table{background:var(--panel2);font-size:12px}
.analysis .tbl th{color:var(--tx3);font-weight:600;white-space:nowrap}
.analysis .tbl td{font-variant-numeric:tabular-nums}
</style>`;

  const finalHtml = html.replace('</head>', `${analysisCss}\n</head>`);

  const outDir = process.env.DC_HOME ? path.resolve(process.env.DC_HOME, 'report') : path.resolve(__dirname, '..', 'report');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `report-${c.runId}.html`);
  fs.writeFileSync(outPath, finalHtml, 'utf8');
  return outPath;
}

module.exports = { buildReport };
