'use strict';

/**
 * rebuild-report.js —— 分析写入后重新生成 HTML 报告
 *
 * 用途：报告分两层（采集事实 + 对标分析结论）。
 * 采集完成时先生成"仅事实"版报告；AI 按 references/analysis-framework.md
 * 写好 analysis.md 放进数据目录后，用本工具重新生成"事实 + 分析"完整版。
 *
 * 用法: node tools/rebuild-report.js <数据目录>   （即 data/<runId>/）
 *
 * 不重新采集，只读盘：account.json / videos.json / video_details.json /
 * comments.json / collection_log.json (+ 可选 analysis.md / selection_plan.json)。
 */

const fs = require('fs');
const path = require('path');
const { buildReport } = require('../lib/report');

const dataDir = process.argv[2];
if (!dataDir || !fs.existsSync(path.join(String(dataDir), 'collection_log.json'))) {
  console.error('用法: node tools/rebuild-report.js <数据目录>   （目录里需有 collection_log.json）');
  process.exit(1);
}
const dir = path.resolve(String(dataDir));
const R = (name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));

const log = R('collection_log.json');
const shim = {
  runId: log.run_id || path.basename(dir),
  dataDir: dir,
  log,
  contentStructure: null,
  account: null,
};
try {
  const acc = R('account.json');
  shim.account = acc;
  shim.contentStructure = acc.content_structure || null;
} catch {
  /* account.json 缺失时报告对应区块留空 */
}

const result = {
  videos: R('videos.json'),
  details: R('video_details.json'),
  comments: R('comments.json'),
};

// 回填选样分组：新采集的详情自带 sample_group；
// 旧数据没有时，优先用 selection_plan.json，再退化为"按默认标准重算取前 N 条"。
if (result.details.some((d) => !d.sample_group) && !(fs.existsSync(path.join(dir, 'selection_plan.json')))) {
  try {
    const E = require('../lib/extract');
    const spec = require('../lib/spec');
    const sel = E.selectRepresentativeVideos(result.videos, spec.DEFAULT_SAMPLING);
    const n = result.details.length;
    for (let i = 0; i < n && i < sel.selected.length; i += 1) {
      const hit = result.details.find((d) => d.video_id === sel.selected[i].video_id);
      if (hit && !hit.sample_group) hit.sample_group = sel.selected[i].sample_group;
    }
    console.log('  已按默认选样标准回填 sample_group（旧数据无该字段）');
  } catch (e) {
    console.log(`  回填 sample_group 失败（不影响生成）: ${e.message}`);
  }
}

const out = buildReport(shim, result);
const hasAnalysis = fs.existsSync(path.join(dir, 'analysis.md'));
console.log(`报告已重新生成: ${out}`);
console.log(`  分析结论: ${hasAnalysis ? '已嵌入（analysis.md）' : '未嵌入 —— 数据目录里没有 analysis.md，本报告仅含采集事实'}`);
