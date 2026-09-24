'use strict';

/**
 * verify-report.js —— 报告四项快速核对（跳转链接/评论表标注/分秒口径/分析排版）
 *
 * 用法: node tools/verify-report.js <report HTML 路径 或 数据目录>
 */

const fs = require('fs');
const path = require('path');

let arg = process.argv[2];
if (!arg) {
  console.error('用法: node tools/verify-report.js <report HTML 路径 或 数据目录>');
  process.exit(1);
}
let file = arg;
if (fs.existsSync(path.join(String(arg), 'collection_log.json'))) {
  const log = JSON.parse(fs.readFileSync(path.join(String(arg), 'collection_log.json'), 'utf8'));
  file = path.join(process.env.DC_HOME ? path.join(process.env.DC_HOME, 'report') : path.join(path.dirname(path.dirname(__dirname)), 'report'), `report-${log.run_id}.html`);
  if (!fs.existsSync(file)) {
    // 回退：从数据目录向上找 report/
    file = path.join(path.dirname(String(arg)), '..', 'report', `report-${log.run_id}.html`);
  }
}
if (!fs.existsSync(file)) {
  console.error(`找不到报告文件: ${file}`);
  process.exit(1);
}
const h = fs.readFileSync(file, 'utf8');
const m = (re) => (h.match(re) || []).length;

console.log(`报告: ${file}\n`);
console.log('1) 跳转链接 vlink:', m(/class="vlink"/g), '个 | douyin.com/video 链接:', m(/href="https:\/\/www\.douyin\.com\/video\//g));
console.log('2) 评论表选样+标题列:', /<th>选样<\/th><th>所属视频<\/th>/.test(h), '| 旧编号列残留:', /<th>视频<\/th>/.test(h));
const bare = h.match(/>\d+(\.\d+)?s</g) || [];
console.log('3) 分秒出现:', m(/\d+分\d+秒/g), '处 | 裸秒残留:', bare.length, JSON.stringify(bare.slice(0, 3)));
console.log('4) 分析区块:', /八、对标分析结论/.test(h), '| 占位提示(未做分析):', /分析尚未生成/.test(h), '| 表格:', m(/class="tbl"/g), '| 高亮:', m(/<mark>/g), '| 加粗:', m(/<b>/g));
console.log('5) 账号类型行:', /账号类型/.test(h), '| 标题字号(h1 21px):', /h1\{font-size:21px/.test(h));
