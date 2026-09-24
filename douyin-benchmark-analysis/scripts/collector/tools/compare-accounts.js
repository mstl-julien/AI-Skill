'use strict';

/**
 * compare-accounts.js —— 跨账号采集对照（Spec §31 要求验 2~3 个不同类型账号）
 *
 * 用法:
 *   node tools/compare-accounts.js data/<runA> data/<runB> [data/<runC> ...]
 *
 * 目的：验证采集器在不同体量/不同类型账号上的稳定性，
 * 而不是只看单个账号跑通了就下结论。
 */

const fs = require('fs');
const path = require('path');

const dirs = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (dirs.length < 1) {
  console.error('用法: node tools/compare-accounts.js <runDir> [runDir...]');
  process.exit(1);
}

const R = (d, f) => JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'));

const rows = [];
for (const d of dirs) {
  const log = R(d, 'collection_log.json');
  const acc = R(d, 'account.json');
  const videos = R(d, 'videos.json');
  const details = R(d, 'video_details.json');
  const comments = R(d, 'comments.json');

  const isPresent = (v) => {
    if (v === null || v === undefined || v === '') return false;
    if (Array.isArray(v)) return v.length > 0;
    return true;
  };
  const coverPct = (arr, field) =>
    arr.length ? Math.round((arr.filter((r) => isPresent(r[field])).length / arr.length) * 100) : 0;

  const cmtCounts = details.map((x) => x.comments_collected || 0);
  const totalMap = {};
  for (const c of comments) totalMap[c.video_id] = (totalMap[c.video_id] || 0) + 1;
  const perVideo = details.map((x) => totalMap[x.video_id] || 0);

  rows.push({
    dir: path.basename(d),
    loggedIn: log.options && log.options.logged_in,
    nickname: acc.nickname,
    douyinId: acc.douyin_id,
    verified: acc.verification ? '已认证' : '无认证',
    worksOnPage: acc.content_structure ? acc.content_structure.works_count : null,
    worksCollected: videos.length,
    worksCoverage: acc.content_structure && acc.content_structure.works_count
      ? Math.round((videos.length / acc.content_structure.works_count) * 1000) / 10
      : null,
    dedupOk: new Set(videos.map((v) => v.video_id)).size === videos.length,
    pinned: videos.filter((v) => v.is_pinned).length,
    detailCount: details.length,
    accessible: details.filter((x) => x.video_accessible).length,
    fourMetrics: details.filter(
      (x) => [x.likes, x.comments, x.favorites, x.shares].every((v) => typeof v === 'number')
    ).length,
    likesCoverage: coverPct(videos, 'likes'),
    hashtagCoverage: coverPct(videos, 'hashtags'),
    publishTimeCoverage: coverPct(details, 'publish_time'),
    cmtPerVideoAvg: cmtCounts.length ? Math.round((cmtCounts.reduce((a, b) => a + b, 0) / cmtCounts.length) * 10) / 10 : 0,
    cmtPerVideoMin: Math.min(...perVideo),
    cmtPerVideoMax: Math.max(...perVideo),
    cmtUnder20: perVideo.filter((n) => n < 20).length,
    // "是否采完"必须以 has_more 为准，不能用 total 当分母。
    // 实测：total 计入了楼中楼回复，比顶层迭代器能返回的条数多，
    // 用 total 判完整度会把"接口已说没有"的采完视频误判为失败。
    cmtIncomplete: details.filter(
      (x) => x.comments_stop_reason === 'NO_PROGRESS_HAS_MORE' || x.comments_complete === false
    ).length,
    cmtStopReasons:
      Object.entries(
        details.reduce((a, x) => {
          const k = x.comments_stop_reason || '(未知)';
          a[k] = (a[k] || 0) + 1;
          return a;
        }, {})
      )
        .map(([k, v]) => `${k}:${v}`)
        .join(' / ') || '—',
    cmtTotal: comments.length,
    cmtCoverage: log.summary && log.summary['评论覆盖率'],
    searchKwHit: details.filter((x) => x.search_keywords && x.search_keywords.status === 'AVAILABLE').length,
    searchBoxHit: details.filter(
      (x) => x.search_box_suggestions && x.search_box_suggestions.status === 'AVAILABLE'
    ).length,
    errors: (log.errors || []).length,
    awemeTypes: log.summary && log.summary.aweme_type_seen ? JSON.stringify(log.summary.aweme_type_seen) : '—',
    loginWall: !!(log.list_incomplete && log.list_incomplete.login_wall_detected),
  });
}

function mdTable(headers, body) {
  return (
    `| ${headers.join(' | ')} |\n|${headers.map(() => '---').join('|')}|\n` +
    body.map((r) => `| ${r.join(' | ')} |`).join('\n') +
    '\n'
  );
}

const METRICS = [
  ['账号昵称', 'nickname'],
  ['抖音号', 'douyinId'],
  ['认证', 'verified'],
  ['作品数（主页显示）', 'worksOnPage'],
  ['作品数（已采集）', 'worksCollected'],
  ['作品采集比例', 'worksCoverage', '%'],
  ['作品去重无误', 'dedupOk'],
  ['置顶条数', 'pinned'],
  ['代表视频数', 'detailCount'],
  ['视频可访问', 'accessible'],
  ['四项互动齐备', 'fourMetrics'],
  ['点赞字段覆盖', 'likesCoverage', '%'],
  ['话题字段覆盖', 'hashtagCoverage', '%'],
  ['发布时间覆盖', 'publishTimeCoverage', '%'],
  ['评论/视频 平均', 'cmtPerVideoAvg'],
  ['评论/视频 最少', 'cmtPerVideoMin'],
  ['评论/视频 最多', 'cmtPerVideoMax'],
  ['评论 <20 条的视频数', 'cmtUnder20'],
  ['评论未采完（异常）', 'cmtIncomplete'],
  ['评论停止原因分布', 'cmtStopReasons'],
  ['评论总条数', 'cmtTotal'],
  ['评论覆盖率', 'cmtCoverage'],
  ['"大家都在搜"命中', 'searchKwHit'],
  ['搜索框推荐词命中', 'searchBoxHit'],
  ['aweme_type 分布', 'awemeTypes'],
  ['失败项', 'errors'],
  ['撞到登录墙', 'loginWall'],
];

const header = ['指标', ...rows.map((r) => r.nickname || r.dir)];
const body = METRICS.map(([label, key, suffix]) => [
  label,
  ...rows.map((r) => {
    const v = r[key];
    if (v === null || v === undefined) return '—';
    if (typeof v === 'boolean') return v ? '是' : '否';
    return `${v}${suffix || ''}`;
  }),
]);

const md = `# 跨账号采集对照（Spec §31）

> 目的：验证采集器在**不同体量 / 不同类型**账号上的稳定性。
> 只跑通一个账号不算验证通过。

生成时间：${new Date().toISOString()}

${mdTable(header, body)}

## 判读要点

- **作品采集比例**：受 \`--max-videos\` 限制与滚动轮数影响，**不等于 100% 是预期的**。
  接口 \`has_more\` 始终为 1，要采全需要续采机制。关键是程序**如实标注了未采全**，而不是假装完整。
- **评论/视频 最少**：如果显著低于 20，请先看"停止原因分布"再下结论。
  \`LIST_EXHAUSTED\` 表示接口 \`has_more=0\`（列表真的到底，例如该视频总共只有 16 条），**不是失败**；
  只有 \`NO_PROGRESS_HAS_MORE\` 才是异常（滚不出新数据但接口说还有）。
  历史 bug 是"滚动退出过早"，把在途分页请求掐断，表现为旧的粗筛指标显示多条视频只采到 5 条。
- **评论未采完（异常）**：只统计 \`NO_PROGRESS_HAS_MORE\`，是判断采集可靠性的**权威指标**。
- **评论覆盖率**：个位数百分比是**正常的**——Spec §14.1 只要求抽样，不要求全量。
  注意其分母是接口的 \`total\`，而 \`total\` 计入了楼中楼回复，会系统性低估完整度。
- **aweme_type 分布**：出现非 0 的类型说明账号里有图集/短剧等非普通视频。
  采集器**不做类型过滤**（只记录分布），避免静默丢数据。
- **"大家都在搜"命中恒为 0**：实测该模块已从抖音视频页下线，属平台现状，非采集失败。

---

*由 \`tools/compare-accounts.js\` 生成*
`;

const outDir = path.resolve(__dirname, '..', 'report');
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, '跨账号对照.md');
fs.writeFileSync(outPath, md, 'utf8');
console.log(`跨账号对照已生成: ${outPath}`);
console.log('');
console.log(mdTable(header, body));
