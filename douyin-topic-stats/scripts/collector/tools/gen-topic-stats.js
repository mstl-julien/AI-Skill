'use strict';

/**
 * gen-topic-stats.js —— 生成「最近 N 条选题清单 + 数据统计」HTML 报告（功能需求二）
 *
 * 用法: node tools/gen-topic-stats.js <数据目录> [取前N条，默认100]
 * 产出: <数据目录>/选题统计_最近N条.html
 *
 * 数据来源：--plan-only --max-videos=N 采集的作品列表（含发布时间/四项互动，不进详情、不采评论）。
 */

const fs = require('fs');
const path = require('path');

const dir = path.resolve(process.argv[2] || '.');
const N = Number(process.argv[3] || 100);
const rulesFile = process.argv[4] || null; // 可选：自定义聚类规则 JSON
const acc = JSON.parse(fs.readFileSync(path.join(dir, 'account.json'), 'utf8'));
const all = JSON.parse(fs.readFileSync(path.join(dir, 'videos.json'), 'utf8'));
const vids = all.slice(0, Math.min(N, all.length));

/**
 * 选题聚类规则。两种来源，优先级：
 *   1) 命令行传入的规则文件（-- 按账号标题句式定制，见 assets/topic-rules.example.json）
 *   2) 默认 = 按每条视频的第一个话题标签聚类（数据驱动，通用于任何账号）
 */
function loadRules() {
  if (rulesFile) {
    const p = path.resolve(rulesFile);
    if (!fs.existsSync(p)) {
      console.error(`规则文件不存在: ${p}`);
      process.exit(1);
    }
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    const list = Array.isArray(raw) ? raw : raw.clusters;
    return list.map((c) => ({
      key: c.key,
      note: c.note || '',
      re: new RegExp(c.pattern || c.re, c.flags || 'u'),
    }));
  }
  return null; // 走默认（首话题标签）
}

const CLUSTERS = loadRules();
for (const v of vids) {
  const t = (v.title || '');
  if (CLUSTERS) {
    const hit = CLUSTERS.find((c) => c.re.test(t));
    v._cluster = hit ? hit.key : '未归类';
  } else {
    // 默认：按"第一个真正的主题标签"聚类。
    // 注意要跳过账号自己的名字标签（如蓝战非的 #蓝战非 几乎每条都有，
    // 不跳过会让 98/100 条全归为一类，聚类失去意义）。
    const selfName = String(acc.nickname || '').trim().toLowerCase();
    const tags = v.hashtags || [];
    const topic = tags.find((t) => String(t).trim().toLowerCase() !== selfName);
    v._cluster = topic ? `#${topic}` : tags.length ? `#${tags[0]}` : '（无话题标签）';
  }
}




const esc = (s) =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const sum = (arr, k) => arr.reduce((a, v) => a + (v[k] || 0), 0);
const date = (v) => (v.publish_time || '').slice(0, 10).replace(/-/g, '/'); // 完整年月日（90 于 2026-09-23 定）
const link = (v) =>
  v.video_id
    ? `<a href="https://www.douyin.com/video/${v.video_id}" target="_blank" rel="noopener noreferrer">${esc(v.title.replace(/\s+/g, ' ').slice(0, 46))}</a>`
    : esc(v.title || '');

// ---- 总量统计 ----
const tot = {
  likes: sum(vids, 'likes'),
  comments: sum(vids, 'comments'),
  favorites: sum(vids, 'favorites'),
  shares: sum(vids, 'shares'),
};

// ---- 聚类统计 ----
const byCluster = {};
for (const v of vids) (byCluster[v._cluster] = byCluster[v._cluster] || []).push(v);
const noteOf = (key) => (CLUSTERS ? (CLUSTERS.find((c) => c.key === key) || {}).note || '' : '按首话题标签聚类');
const clusterRows = Object.keys(byCluster)
  .map((key) => {
    const g = byCluster[key];
    return {
      key,
      note: noteOf(key),
      n: g.length,
      likesSum: sum(g, 'likes'),
      likesAvg: Math.round(sum(g, 'likes') / g.length),
      favSum: sum(g, 'favorites'),
      shareSum: sum(g, 'shares'),
      cmtSum: sum(g, 'comments'),
      best: [...g].sort((a, b) => (b.likes || 0) - (a.likes || 0))[0],
    };
  })
  .sort((a, b) => b.n - a.n);

// ---- Top10 ----
const top10 = [...vids].sort((a, b) => (b.likes || 0) - (a.likes || 0)).slice(0, 10);

const accountType =
  acc.verification_type === 2
    ? '企业号 <span class="bv">V</span>（蓝V企业认证）'
    : acc.verification_type === 1
      ? '个人号 / 达人号（黄V个人认证）'
      : '个人号 / 达人号';

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>选题统计 · ${esc(acc.nickname || '')} · 最近${vids.length}条</title>
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
table{width:100%;border-collapse:collapse;background:var(--panel);border-radius:10px;overflow:hidden}
th,td{padding:8px 11px;text-align:left;border-bottom:1px solid var(--line);font-size:12px;vertical-align:top}
th{color:var(--tx3);font-weight:600;white-space:nowrap}
tr:hover td{background:var(--panel2)}
td.num{text-align:right;font-variant-numeric:tabular-nums}
.muted{color:var(--tx3)}
.scroll{max-height:640px;overflow:auto;border-radius:10px;border:1px solid var(--line)}
.scroll table{border-radius:0}
.note{background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--warn);
  border-radius:8px;padding:11px 14px;color:var(--tx2);font-size:12px;margin-top:10px}
.note b{color:var(--tx)}
a{color:var(--info);text-decoration:none;border-bottom:1px dashed rgba(90,169,240,.45)}
a:hover{color:#8cc4f7;border-bottom-color:#8cc4f7}
.bv{display:inline-block;min-width:16px;height:16px;line-height:16px;text-align:center;
  background:#2b7cff;color:#fff;font-size:11px;font-weight:700;border-radius:4px;padding:0 4px;vertical-align:2px}
th[data-sort]{user-select:none}
th[data-sort]:hover{color:var(--info)}
th .arr{color:var(--info);font-size:10px}
tbody tr{cursor:default}
</style>
</head>
<body><div class="wrap">

<h1>选题清单与数据统计 · ${esc(acc.nickname || '未取到昵称')} · 最近${vids.length}条</h1>
<div class="sub">
  账号类型 <b style="color:var(--info)">${accountType}</b> ｜
  粉丝 ${fmt(acc.followers_count)} ｜ 获赞 ${fmt(acc.total_likes)} ｜ ${esc(acc.ip_location || '')}<br>
  采集范围：最新 ${vids.length} 条（${date(vids[vids.length - 1])} ~ ${date(vids[0])}）｜
  生成时间 ${new Date().toISOString().slice(0, 19).replace('T', ' ')}
</div>

<h2>一、总量统计</h2>
<table>
  <tr><th>指标</th><th>合计</th><th>均值/条</th></tr>
  <tr><td>点赞</td><td class="num">${fmt(tot.likes)}</td><td class="num">${fmt(Math.round(tot.likes / vids.length))}</td></tr>
  <tr><td>评论</td><td class="num">${fmt(tot.comments)}</td><td class="num">${fmt(Math.round(tot.comments / vids.length))}</td></tr>
  <tr><td>收藏</td><td class="num">${fmt(tot.favorites)}</td><td class="num">${fmt(Math.round(tot.favorites / vids.length))}</td></tr>
  <tr><td>转发</td><td class="num">${fmt(tot.shares)}</td><td class="num">${fmt(Math.round(tot.shares / vids.length))}</td></tr>
</table>

<h2>二、选题类型汇总（按条数排序）</h2>
<table>
  <tr><th>选题类型</th><th>条数</th><th>点赞合计</th><th>点赞均值</th><th>收藏合计</th><th>转发合计</th><th>评论合计</th><th>说明</th></tr>
  ${clusterRows
    .map(
      (r) =>
        `<tr><td><b>${esc(r.key)}</b></td><td class="num">${r.n}</td><td class="num">${fmt(r.likesSum)}</td>` +
        `<td class="num">${fmt(r.likesAvg)}</td><td class="num">${fmt(r.favSum)}</td><td class="num">${fmt(r.shareSum)}</td>` +
        `<td class="num">${fmt(r.cmtSum)}</td><td class="muted">${esc(r.note)}</td></tr>`
    )
    .join('')}
</table>
<div class="note"><b>各类型最佳单条：</b><br>
${clusterRows
  .map(
    (r) =>
      `・<b>${esc(r.key)}</b>（${r.n} 条）最高赞 ${fmt(r.best.likes)} —— ${esc(r.best.title.replace(/\s+/g, ' ').slice(0, 40))}（${date(r.best)}）`
  )
  .join('<br>')}
</div>

<h2>三、单条点赞 Top10</h2>
<table class="sortable">
  <thead><tr><th>#</th><th>标题</th><th data-sort="str">发布</th><th data-sort="num">点赞</th><th data-sort="num">评论</th><th data-sort="num">收藏</th><th data-sort="num">转发</th></tr></thead>
  <tbody>
  ${top10
    .map(
      (v, i) =>
        `<tr><td class="num">${i + 1}</td><td>${link(v)}</td><td class="muted" data-v="${esc(v.publish_time || '')}">${date(v)}</td>` +
        `<td class="num" data-v="${v.likes || 0}">${fmt(v.likes)}</td><td class="num" data-v="${v.comments || 0}">${fmt(v.comments)}</td><td class="num" data-v="${v.favorites || 0}">${fmt(v.favorites)}</td><td class="num" data-v="${v.shares || 0}">${fmt(v.shares)}</td></tr>`
    )
    .join('')}
  </tbody>
</table>

<h2>四、完整清单（${vids.length} 条，按发布时间倒序；点击表头可按 发布/点赞/评论/收藏/转发 排序）</h2>
<div class="scroll">
<table class="sortable">
  <thead><tr><th>#</th><th>标题</th><th>选题类型</th><th data-sort="str">发布</th><th data-sort="num">点赞</th><th data-sort="num">评论</th><th data-sort="num">收藏</th><th data-sort="num">转发</th></tr></thead>
  <tbody>
  ${vids
    .map(
      (v, i) =>
        `<tr><td class="num muted">${i + 1}</td><td>${link(v)}${v.is_pinned ? ' <span class="bv" style="background:var(--warn);color:#16181d">顶</span>' : ''}</td>` +
        `<td class="muted">${esc(v._cluster)}</td><td class="muted" data-v="${esc(v.publish_time || '')}">${date(v)}</td>` +
        `<td class="num" data-v="${v.likes || 0}">${fmt(v.likes)}</td><td class="num" data-v="${v.comments || 0}">${fmt(v.comments)}</td><td class="num" data-v="${v.favorites || 0}">${fmt(v.favorites)}</td><td class="num" data-v="${v.shares || 0}">${fmt(v.shares)}</td></tr>`
    )
    .join('')}
  </tbody>
</table>
</div>

<script>
// 表头点击排序：发布(按原始时间戳字符串)、点赞/评论/收藏/转发(按数值)，再点一次切换升降序
document.querySelectorAll('table.sortable th[data-sort]').forEach(function (th) {
  th.style.cursor = 'pointer';
  th.title = '点击排序（升/降切换）';
  th.addEventListener('click', function () {
    var table = th.closest('table');
    var idx = Array.prototype.indexOf.call(th.parentElement.children, th);
    var tbody = table.querySelector('tbody');
    var rows = Array.prototype.slice.call(tbody.querySelectorAll('tr'));
    var dir = th.getAttribute('data-dir') === 'asc' ? 'desc' : 'asc';
    th.setAttribute('data-dir', dir);
    // 清掉同表其他表头的排序标记
    Array.prototype.forEach.call(table.querySelectorAll('th[data-sort]'), function (o) {
      if (o !== th) o.removeAttribute('data-dir');
      var arr = o.querySelector('.arr');
      if (arr) arr.textContent = '';
    });
    var arrow = th.querySelector('.arr');
    if (arrow) arrow.textContent = dir === 'asc' ? ' ▲' : ' ▼';
    var numeric = th.getAttribute('data-sort') === 'num';
    rows.sort(function (a, b) {
      var ca = a.children[idx], cb = b.children[idx];
      var va = ca ? ca.getAttribute('data-v') : '';
      var vb = cb ? cb.getAttribute('data-v') : '';
      var cmp;
      if (numeric) {
        cmp = (parseFloat(va) || 0) - (parseFloat(vb) || 0);
      } else {
        cmp = String(va).localeCompare(String(vb));
      }
      return dir === 'asc' ? cmp : -cmp;
    });
    rows.forEach(function (r) { tbody.appendChild(r); });
  });
});
</script>

<div class="note" style="border-left-color:var(--info)">
  <b>口径声明：</b>四项互动（赞/评/藏/转）均为抖音页面公开展示数据；播放量/完播率属非公开数据，不予采集与展示。
  评论按要求未展开。选题类型为基于标题的规则聚类（分析判断），完整标题以链接跳转抖音原页为准。
</div>

</div></body></html>
`;

const out = path.join(dir, `选题统计_最近${vids.length}条.html`);
fs.writeFileSync(out, html, 'utf8');
console.log('已生成:', out);
console.log('\n聚类结果:');
for (const r of clusterRows) {
  console.log(`  ${r.key}  ${r.n}条  赞均 ${fmt(r.likesAvg)}  (最佳 ${fmt(r.best.likes)})`);
}
