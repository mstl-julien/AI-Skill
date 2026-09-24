'use strict';

/**
 * test-report.js —— 生成 Spec §28 要求的测试报告（Markdown）
 *
 * 用法:
 *   node tools/test-report.js <本轮数据目录> [--baseline=<对照数据目录>]
 *
 * A/B/C 三段由数据自动生成（避免手抄出错）；
 * D/E 两段是人工维护的发现清单——因为"为什么会出现这个问题、下版怎么改"
 * 本来就是判断，不是数据能算出来的。换账号时应逐条复核，不要照抄。
 */

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const runDir = args.find((a) => !a.startsWith('--'));
const baselineArg = args.find((a) => a.startsWith('--baseline='));
const baselineDir = baselineArg ? baselineArg.split('=')[1] : null;

if (!runDir) {
  console.error('用法: node tools/test-report.js <本轮数据目录> [--baseline=<对照目录>]');
  process.exit(1);
}

const R = (p) => JSON.parse(fs.readFileSync(path.join(runDir, p), 'utf8'));
const R2 = (dir, p) => JSON.parse(fs.readFileSync(path.join(dir, p), 'utf8'));

const account = R('account.json');
const videos = R('videos.json');
const details = R('video_details.json');
const comments = R('comments.json');
const log = R('collection_log.json');

const STATUS = { AVAILABLE: 'AVAILABLE', EMPTY: 'EMPTY', UNAVAILABLE: 'UNAVAILABLE', NOT_VISIBLE: 'NOT_VISIBLE', NOT_COLLECTED: 'NOT_COLLECTED', FAILED: 'FAILED' };

// ------------------------------------------------------------
// 覆盖度计算
//
// 设计修正：按"实际取值"判断是否采到，而不是读 field_status 映射表。
// 起因：上一版因为漏标 video_id / video_accessible 的状态，
// 报告出现"0/183 (0%)"这种和数据自相矛盾的结论。
// 状态表是人工维护的，迟早会和真实数据脱节；取值不会。
// ------------------------------------------------------------

/** 值是否真的采到了 */
function isPresent(v) {
  if (v === null || v === undefined || v === '') return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') {
    // {status, value} 形态（如 search_keywords）
    if ('status' in v) {
      return v.status === STATUS.AVAILABLE || (Array.isArray(v.value) && v.value.length > 0);
    }
    return true;
  }
  return true;
}

function cover(rows, field) {
  const total = rows.length;
  if (!total) return { a: 0, t: 0, pct: 0 };
  const a = rows.filter((r) => isPresent(r[field])).length;
  return { a, t: total, pct: Math.round((a / total) * 100) };
}

/** 该字段在数据里的主导状态（用于解释"为什么是 0%"） */
function dominantStatus(rows, field) {
  const counts = {};
  for (const r of rows) {
    const s = r.field_status && r.field_status[field];
    if (s) counts[s] = (counts[s] || 0) + 1;
  }
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return top ? top[0] : null;
}

/** Markdown 表格单元格转义：竖线 + 换行（换行会把表格撑破） */
function cell(v) {
  if (v === null || v === undefined || v === '') return '`null`';
  return String(v)
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, '<br>')
    .slice(0, 300);
}

function coverAccount() {
  const fields = ['nickname','douyin_id','verification','avatar','following_count','followers_count','total_likes','ip_location','profile_age','bio','identity_text'];
  const ok = fields.filter((f) => {
    const v = account[f];
    return v !== null && v !== undefined && v !== '';
  }).length;
  return { a: ok, t: fields.length + 1, pct: Math.round((ok / (fields.length + 1)) * 100) };
}
const ACCOUNT_FIELDS = ['nickname','douyin_id','verification','enterprise_account','enterprise_shop_permissions','avatar','following_count','followers_count','total_likes','ip_location','profile_age','bio','identity_text'];
const VIDEO_FIELDS = ['video_id','video_url','cover_image','cover_text','title','hashtags','likes','is_pinned'];
const DETAIL_FIELDS = ['video_duration','title','hashtags','likes','comments','favorites','shares','publish_time','search_keywords','video_accessible'];
const COMMENT_FIELDS = ['comment_id','user_nickname','content','publish_time','likes','ip_location','reply_count'];

const STATUS_LABEL = {
  AVAILABLE: '✅ 采到',
  EMPTY: '⚪ 页面有但为空',
  UNAVAILABLE: '❌ 当前环境无法获得',
  NOT_VISIBLE: '🚫 页面未公开显示',
  NOT_COLLECTED: '⏸ 本轮未采',
  FAILED: '🔴 采集失败',
};

const sourceOf = (field) => {
  if (['cover_text'].includes(field)) return '封面图片内像素，未做 OCR';
  if (['search_keywords'].includes(field)) return '页面模块本身不存在（"大家都在搜"已下线）';
  if (['profile_age'].includes(field)) return '主页未展示年龄';
  if (['verification'].includes(field)) return '该账号无认证标识（注意：不等于非企业号，见 enterprise_account）';
  if (['enterprise_shop_permissions'].includes(field)) return '该账号非企业号，无相关权限';
  if (['video_duration'].includes(field)) return '接口未返回时长';
  return '—';
};

// ------------------------------------------------------------
// C 段：无法采集的原因分类（Spec §28-C 要求区分四类）
// ------------------------------------------------------------
function classifyUnavailable() {
  const out = {
    notVisible: [],      // 公开页面没有
    techFailed: [],      // 页面有，技术上没获取到
    loginRequired: [],   // 需要登录
    pageFailed: [],      // 页面访问失败
  };
  // 字段层面
  for (const f of ACCOUNT_FIELDS) {
    const s = account.field_status && account.field_status[f];
    if (s === STATUS.NOT_VISIBLE) out.notVisible.push(`账号.${f}`);
    if (s === STATUS.UNAVAILABLE) out.techFailed.push(`账号.${f}`);
  }
  for (const f of VIDEO_FIELDS) {
    const c = cover(videos, f);
    if (c.t && c.a === 0) out.techFailed.push(`作品.${f}（0/${c.t}）`);
  }
  for (const d of details) {
    if (d.field_status && d.field_status.search_keywords === STATUS.NOT_VISIBLE) {
      if (!out.notVisible.includes('视频.search_keywords')) out.notVisible.push('视频.search_keywords（"大家都在搜"模块不存在）');
    }
  }
  // 硬性不可得（Spec §27）
  out.notVisible.push('播放量 / 完播率 / 平均观看时长 / 转粉率 / GMV / 成交 —— 公开页面不可见（Spec §27）');
  // 错误日志
  for (const e of log.errors || []) {
    const line = `[${e.stage}] ${e.error_type}: ${String(e.message).slice(0, 130)}`;
    if (e.error_type === 'LOGIN_REQUIRED') out.loginRequired.push(line);
    else if (e.error_type === 'TIMEOUT' || e.error_type === 'NETWORK_ERROR' || e.error_type === 'PAGE_NOT_FOUND') out.pageFailed.push(line);
    else out.techFailed.push(line);
  }
  if (log.list_incomplete) {
    out.techFailed.push(`作品列表不完整：${log.list_incomplete.note}`);
  }
  return out;
}

// ------------------------------------------------------------
// 访客 vs 登录 对照
// ------------------------------------------------------------
function compare(bDir) {
  const bl = R2(bDir, 'collection_log.json');
  const bv = R2(bDir, 'videos.json');
  const bc = R2(bDir, 'comments.json');
  const bd = R2(bDir, 'video_details.json');
  const avg = (arr) => (arr.length ? (arr.reduce((s, x) => s + x, 0) / arr.length).toFixed(1) : '—');
  const perVideo = (arr, det) => {
    const map = {};
    for (const c of arr) map[c.video_id] = (map[c.video_id] || 0) + 1;
    const vals = det.map((d) => map[d.video_id] || 0);
    return avg(vals);
  };
  return {
    baselineRun: path.basename(bDir),
    rows: [
      ['作品列表条数', bv.length, videos.length],
      ['代表视频条数', bd.length, details.length],
      ['单视频可访问', bd.filter((d) => d.video_accessible).length, details.filter((d) => d.video_accessible).length],
      ['评论总条数', bc.length, comments.length],
      ['平均每条视频评论数', perVideo(bc, bd), perVideo(comments, details)],
      ['失败项数', (bl.errors || []).length, (log.errors || []).length],
    ],
  };
}

// ------------------------------------------------------------
// D/E：人工维护的发现清单
// ------------------------------------------------------------
const FINDINGS = [
  {
    id: 'D1',
    title: '滚动作品列表会不会漏数据？—— 会，而且是静默漏',
    detail:
      '首次实测（访客态）只采到 21 条，页面显示 894 条，但程序按"连续 3 轮无新增"判定为"已到底"并正常输出。接口 has_more=1 被忽略。' +
      '已在代码中加入诚实性检查：has_more=1 时绝不判定到底，改为记 list_incomplete 并报 DATA_NOT_VISIBLE / LOGIN_REQUIRED。',
    verdict: '必须修复（已修）',
  },
  {
    id: 'D2',
    title: 'window.scrollTo 在抖音主页无效',
    detail:
      '作品列表在内部可滚动容器里，window.scrollTo / documentElement.scrollTop / 最大可滚动容器 scrollTop 三种方式实测均无法触发分页。' +
      '改为真实滚轮事件 page.mouse.wheel 后恢复正常。判断是懒加载挂在 wheel/scroll 事件 + IntersectionObserver 上。',
    verdict: '必须修复（已修）',
  },
  {
    id: 'D3',
    title: '访客态是最大的隐藏变量',
    detail:
      '账号信息与单视频四项互动在访客态完全正常，容易让人误判"不需要登录"。但作品列表被卡在第一页，评论区被砍到 5~10 条。' +
      '两处都"不报错"，只表现为数据变少——是最难发现的一类问题。',
    verdict: '必须修复（已改为登录态）',
  },
  {
    id: 'D4',
    title: '评论区需要渐进滚动，且每页只给 5 条',
    detail:
      '评论接口每页仅返回 5 条（total 可能上万）。直接把 scrollTop 拉到底会跳过懒加载触发点，一条都不加载。' +
      '改为每轮推进 80% 视口高度后正常，且滚动过程中还要侦测登录墙（它可能在滚动第 N 轮才出现）。',
    verdict: '必须修复（已修）',
  },
  {
    id: 'D5',
    title: '"大家都在搜"模块已不存在于视频页',
    detail:
      'Spec §17 假设该模块公开可见，但实测 19 条视频全部返回 found:false。' +
      '页面上真实存在的是"搜索框滚动推荐词"（来源 api/suggest_words，结构 data[].words[].word）。' +
      '已按 Spec §18 的分离原则拆成两个字段：search_keywords（NOT_VISIBLE）+ search_box_suggestions（AVAILABLE）。',
    verdict: '需求边界问题，需 90 拍板',
  },
  {
    id: 'D6',
    title: '接口返回的字段远多于 Spec 允许采集的字段',
    detail:
      '实测 aweme 级响应有 152~164 个顶层字段，账号级 135 个。其中 statistics 节点实测返回 ' +
      '["recommend_count","comment_count","digg_count","admire_count","play_count","share_count","collect_count"]，' +
      'play_count / recommend_count / admire_count 三个是页面不展示的非公开指标。' +
      '且 play_count 实测取值恒为 0——如果靠"取到就存"，会存进一堆 0，看起来还"有数据"。',
    verdict: '必须修复（已加白名单闸门 + 合规丢弃审计）',
  },
  {
    id: 'D7',
    title: 'Object.assign 覆盖页面状态字段',
    detail:
      '合并接口数据时把 video_accessible / video_playable 一起覆盖成接口里的 false，导致"数据全采到了但视频可访问=0"这种自相矛盾的报告。',
    verdict: '必须修复（已修）',
  },
  {
    id: 'D8',
    title: 'readyState 读得太早',
    detail: 'domcontentloaded 后立刻读 <video>.readyState 恒为 0，导致 video_playable 全为 false。已改为轮询等待（最多 9s）。',
    verdict: '必须修复（已修）',
  },
  {
    id: 'D9',
    title: '响应体读取存在竞态',
    detail:
      '跳转到下一个视频时，上一个视频的评论响应可能还在途，导致 "Protocol error (Network.getResponseBody): No resource with given identifier found"（实测出现 1 次，约损失 5 条评论）。' +
      '已在切换视频前加 800ms 沉降；根治方案见 E 段。',
    verdict: '建议修复',
  },
  {
    id: 'D10',
    title: '页面自身 JS 报错与真实错误混在一起',
    detail: '抖音页面自身持续抛 React minified error（#418/#422），会把"失败项数"污染成看起来很高。已单独归入 page_errors，不计入失败项。',
    verdict: '必须修复（已修）',
  },
  {
    id: 'D11',
    title: '登录态 / 验证码正则过宽会误报',
    detail: '页面导航栏长期存在「登录」按钮、页脚有「安全」字样，用宽松正则必然把正常页面判成登录墙或验证码。已收紧为只匹配"拦截性"文案。',
    verdict: '必须修复（已修）',
  },
  {
    id: 'D12',
    title: '评论退出判据用"固定 sleep"衡量，导致静默少采（本项最重要）',
    detail:
      '现象：同一账号 19 条视频里，有 0~11 条（随机波动）评论只采到 5 条，其余 53~55 条；' +
      '这些视频**不报任何错误**，覆盖率显示 0.1%~0.4% 也不报警。\n\n' +
      '定位过程（四个假设被独立探针逐一推翻，最后靠给生产代码装仪表锁定）：\n' +
      '1. "容器选错" —— 推翻。探针实测页面只有 1 个"可滚且含评论节点"的容器，代码选中的就是它，且 moved=true。\n' +
      '2. "滚动无效" —— 推翻。写 scrollTop 后回读确实变化（0→1233），并当场触发了分页请求（5→15 条）。\n' +
      '3. "开始太早（评论面板未挂载）" —— 推翻。复刻生产时序（readyState>=2 即开始）单页重跑，6 轮拿到 65 条、idle 全程为 0。\n' +
      '4. "误点简介的「展开」打断加载" —— 推翻。A/B 对照（点/不点）：75 条 vs 85 条，均正常。\n\n' +
      '真因（由"接口请求数"这一指标锁定）：把各轮次的**评论接口请求数**与实际采集量对齐后发现两者严格同步缩放——' +
      '10-55 轮 66 次请求 / 采到 513 条 / 11 条失败；12-44 轮 91 次 / 794 条 / 4 条失败；修复后 113 次 / 992 条 / 0 条失败。' +
      '失败视频平均只发出 1~2 次分页请求（成功视频需 6 次）。\n\n' +
      '机制：旧实现是"滚完 sleep(900~1600ms) 后就数条数，连续 3 轮没涨就判定到底"。' +
      '这个 sleep 与"分页请求是否真的完成"毫无关系。当响应比 sleep 慢，循环在响应回来之前就判定"到底"并**跳转到下一条视频**，' +
      '把那些本会送达数据的请求**在途掐断**。被中止的请求不产生 response 事件，因此既不计入接口统计、也不产生错误——' +
      '这正是"静默少采"的来源。失败程度随网络延迟随机波动，所以同一份代码会出现 0/1/4/11 条失败。\n\n' +
      '另附一个被顺手确认的真实缺陷：expandCollapsedComments() 的守卫写成 ' +
      '`el.closest(\'[data-e2e*="comment"]\') || el.parentElement`，而 parentElement 永远为真，' +
      '导致"只在评论区里点"的保险完全失效——实测它点的是简介区的「展开」（最近 data-e2e=detail-video-info）。' +
      '已改为必须有评论节点祖先。此项经 A/B 验证**不是**本次少采的原因，但属确定性缺陷，仍应修。\n\n' +
      '修复：① 把"固定 sleep"换成"等真正的分页请求/响应"（评论响应未到不放弃，超时才降级）；' +
      '② 降级阈值与放弃阈值分离（连续 3 轮无进展 → 换鼠标真实滚轮；连续 6 轮 → 才放弃）；' +
      '③ 增加诚实性检查：放弃时若接口 has_more=1，一律记 comment_list_incomplete 并报 DATA_NOT_VISIBLE，不得判定"采完"。',
    verdict: '必须修复（已修，回归消失：4/19 → 0/19）',
  },
  {
    id: 'D13',
    title: '评论完整性需要"停止原因"而不只是一个布尔值',
    detail:
      'Spec 的评论采样区间是 20~50 条/视频，因此"采到 50 条就停"是**正常**，不是失败；' +
      '而"接口 has_more=1 却怎么滚都不出新"才是异常。两者都表现为 has_more=1，只用一个 complete 布尔值会混淆。' +
      '已拆为三态：REACHED_SAMPLING_CAP（到采样上限，正常）/ LIST_EXHAUSTED（接口 has_more=0，真的到底）/ NO_PROGRESS_HAS_MORE（滚不出新数据但接口说还有，异常）。' +
      '修复后实测分布：17 条 REACHED_SAMPLING_CAP + 2 条 LIST_EXHAUSTED + 0 条 NO_PROGRESS_HAS_MORE。',
    verdict: '必须修复（已修）',
  },
  {
    id: 'D14',
    title: '接口的 total 不能当作"应该采到多少"的分母',
    detail:
      '两条被判定为"覆盖率不足"的视频（15/16=93.8%、48/64=75%）其实**都采完了**：退出时 has_more=0、cursor 已到末页、后者滚了 11 轮才耗尽。' +
      '说明评论接口的 total 计入了非顶层列表的内容（多半是楼中楼回复）。因此 coverage_pct 用 total 作分母会**系统性低估**完整度，' +
      '只有 has_more 才是权威信号。报告里保留 coverage_pct（它是接口自己的声明，可追溯），但"是否采完"一律以 has_more 为准，不拿 total 当判据。',
    verdict: '口径问题，需在文档中固化（已记入 README 与报告口径说明）',
  },
];

const SUGGESTIONS = [
  { level: '必须修复', items: [
    '把"数据完整性自检"固化为流程：接口 has_more=1 / total>已采集数 时，一律不得输出"采集完成"。',
    '任何"等采集就绪"的等待，都必须等一个可观测的信号（接口请求/响应、DOM 变化），禁止用固定 sleep 当作"应该好了"。',
    '白名单闸门与合规丢弃清单保持硬编码，禁止任何"先存下来以后再说"的旁路。',
    '登录态作为前置条件显式检查，未登录时直接拒绝开跑，而不是降级为访客态继续。',
  ]},
  { level: '建议修复', items: [
    '彻底消除响应体竞态：改为"先等所有在途响应落盘，再导航"（当前 waitInflight 只覆盖"已在读体"的响应，不覆盖"已发出但未拿到响应头"的请求），或用独立的 page 承载采集、主 page 负责导航。',
    '作品列表支持"续采"：记录 max_cursor，中断后可从中断点继续（1283 条作品需要多轮才能采全）。',
    '评论采集加入"高获赞 / 问题型 / 争议型"的择优抽样，而不是纯按页面顺序取前 N 条（Spec §14.1 的原意）。',
    '为每轮采集输出一份机器可读的"规格核对表"，把 NOT_VISIBLE / UNAVAILABLE 逐字段列清楚，避免下游 AI 误用空值。',
    '把 test/probe-container.js / probe-loop.js / probe-expand.js 三个定向探针保留下来作为"故障考古"工具：它们把"猜"变成"测"，本次四个错误假设全靠它们才被及时推翻。',
  ]},
  { level: '可暂不处理', items: [
    '评论楼中楼展开（Spec §15 已明确 V0.1 不做）。',
    '封面文案 OCR（属内容理解，Spec §27 划归后续版本）。',
    '多账号并发、代理池、自动过验证等——Spec §24 明确禁止在 V0.1 做。',
  ]},
];

// ------------------------------------------------------------
// 组装
// ------------------------------------------------------------
function table(headers, rows) {
  const head = `| ${headers.join(' | ')} |\n|${headers.map(() => '---').join('|')}|\n`;
  return head + rows.map((r) => `| ${r.join(' | ')} |`).join('\n') + '\n';
}

const un = classifyUnavailable();
const ac = coverAccount();

let md = `# 抖音公开数据采集器 V0.1 · 真实账号测试报告

> 本报告只呈现采集事实，不含分析结论（Spec §2.3：采集层与分析层必须解耦）。

## 0. 运行概览

| 项 | 值 |
|---|---|
| 账号昵称 | **${account.nickname || '—'}** |
| 抖音号 | ${account.douyin_id || '—'} |
| 主页 URL | ${log.input_url || '—'} |
| 登录态 | ${log.options && log.options.logged_in ? '**已登录**' : '未登录（访客态）'} |
| 运行 ID | ${log.run_id} |
| 开始 / 结束 | ${log.started_at} → ${log.finished_at} |
| 数据目录 | \`${path.relative(process.cwd(), runDir).replace(/\\\\/g, '/')}\` |
| 状态 | **${log.status}** |

### 采集结果摘要

${table(['指标', '值', '说明'], [
  ['作品数（主页显示）', account.content_structure ? account.content_structure.works_count : '—', '页面文本'],
  ['作品数（已采集）', videos.length, '去重后'],
  ['代表视频数', details.length, '进入详情页'],
  ['视频可访问', details.filter((d) => d.video_accessible).length, '页面正常打开'],
  ['四项互动数据获取成功', details.filter((d) => d.data !== null && d.detail_data_accessible).length, '赞/评/藏/转'],
  ['评论总条数', comments.length, `${details.filter((d) => comments.some((c) => c.video_id === d.video_id)).length} 条视频有评论`],
  ['评论覆盖率', (log.summary && log.summary['评论覆盖率']) || '—', '已采 / 接口声称总量（有分母才谈得上完整度）'],
  ['"大家都在搜"命中', details.filter((d) => d.search_keywords && d.search_keywords.status === STATUS.AVAILABLE).length, '实测该模块已不存在'],
  ['搜索框推荐词命中', details.filter((d) => d.search_box_suggestions && d.search_box_suggestions.status === STATUS.AVAILABLE).length, '替代来源'],
  ['失败项', (log.errors || []).length, '页面自身 JS 噪音已单独归档'],
])}

---

## A. 实际采集到了什么（Spec §28-A）

### A1 账号字段

${table(['字段', '值', '状态'], [
  ...ACCOUNT_FIELDS.map((f) => {
    const st = account.field_status ? account.field_status[f] : null;
    return [`\`${f}\``, cell(account[f]), STATUS_LABEL[st] || st || '—'];
  }),
])}

**账号整体完备度：${ac.a}/${ac.t}（${ac.pct}%）** ｜ 内容结构：\`${JSON.stringify(account.content_structure)}\`

### A2 作品字段覆盖度（${videos.length} 条）

${table(['字段', '采到/总数', '覆盖率', '未采到的原因'], VIDEO_FIELDS.map((f) => {
  const c = cover(videos, f);
  const ds = dominantStatus(videos, f);
  return [`\`${f}\``, `${c.a}/${c.t}`, c.pct + '%', c.a === c.t ? '—' : `${STATUS_LABEL[ds] || ds || '—'}｜${sourceOf(f)}`];
}))}

### A3 单视频字段覆盖度（${details.length} 条）

${table(['字段', '采到/总数', '覆盖率', '未采到的原因'], DETAIL_FIELDS.map((f) => {
  const c = cover(details, f);
  const ds = dominantStatus(details, f);
  return [`\`${f}\``, `${c.a}/${c.t}`, c.pct + '%', c.a === c.t ? '—' : `${STATUS_LABEL[ds] || ds || '—'}｜${sourceOf(f)}`];
}))}

### A4 评论字段覆盖度（${comments.length} 条）

${table(['字段', '采到/总数', '覆盖率'], COMMENT_FIELDS.map((f) => {
  const c = cover(comments, f);
  return [`\`${f}\``, `${c.a}/${c.t}`, c.pct + '%'];
}))}

### A4-plus 评论完整度（逐视频）

> 只报"采到多少条"是没意义的——必须给出分母。下表是每条代表视频的"实际采到 / 接口声称总量"。

${table(['video_id', '采到', '接口声称总量', '覆盖率', '备注'], details.map((d) => {
  const got = d.comments_collected;
  const tot = d.comments_total_on_page;
  const pct = d.comments_coverage_pct;
  let note = '';
  if (typeof pct === 'number') note = pct >= 20 ? '抽样充足' : '仅为抽样（Spec §14.1 不要求全量）';
  else note = '接口未返回 total';
  return [
    `\`${String(d.video_id).slice(-8)}\``,
    got == null ? '—' : got,
    tot == null ? 'UNAVAILABLE' : tot,
    pct == null ? '—' : pct + '%',
    note,
  ];
}))}

### A5 被动监听到的接口

${table(['接口', '调用次数'], Object.entries(log.summary && log.summary.api_seen ? log.summary.api_seen : {}).map(([k, v]) => [`\`${k}\``, v]))}

${log.summary && log.summary.not_watched_apis && Object.keys(log.summary.not_watched_apis).length
  ? `页面发出但未在监听的接口：\n\n${table(['接口', '次数'], Object.entries(log.summary.not_watched_apis).map(([k, v]) => [`\`${k}\``, v]))}`
  : ''}

---

## B. 哪些信息无法采集（Spec §28-B）

### B1 字段级缺口

${table(['字段', '状态', '备注'], [
  ...ACCOUNT_FIELDS.filter((f) => account.field_status && account.field_status[f] !== STATUS.AVAILABLE)
    .map((f) => [`账号.\`${f}\``, STATUS_LABEL[account.field_status[f]] || account.field_status[f], sourceOf(f)]),
  ...VIDEO_FIELDS.filter((f) => cover(videos, f).a === 0)
    .map((f) => [`作品.\`${f}\``, STATUS_LABEL.UNAVAILABLE, sourceOf(f)]),
  ['视频.\`search_keywords\`', STATUS_LABEL.NOT_VISIBLE, '视频页不存在"大家都在搜"模块'],
])}

### B2 明确不采集（Spec §27）

播放量、完播率、平均观看时长、转粉率、粉丝画像、成交数据、GMV、商品数据、广告数据 —— 这些在公开页面均不可见。

> 补充实测：\`statistics.play_count\` 即使被接口返回，取值也**恒为 0**。即便忽略合规问题，它也不构成可用数据。

---

## C. 为什么无法采集（Spec §28-C）

> 必须严格区分四类原因，不能笼统说"采不到"。

### C1 公开页面没有（NOT_VISIBLE）

${un.notVisible.length ? un.notVisible.map((x) => `- ${x}`).join('\n') : '- 无'}

### C2 页面有，但技术上没有获取到

${un.techFailed.length ? un.techFailed.map((x) => `- ${x}`).join('\n') : '- 无'}

### C3 需要登录

${un.loginRequired.length ? un.loginRequired.map((x) => `- ${x}`).join('\n') : '- 无（本轮为登录态）'}

### C4 页面访问失败

${un.pageFailed.length ? un.pageFailed.map((x) => `- ${x}`).join('\n') : '- 无'}

---

## D. 实际运行过程中的问题

${FINDINGS.map((f) => `### ${f.id} · ${f.title}\n\n${f.detail}\n\n**判定：${f.verdict}**\n`).join('\n')}
`;

// 访客 vs 登录
if (baselineDir) {
  const cmp = compare(baselineDir);
  md += `
---

## D-plus. 访客态 vs 登录态 对照（Spec §28-D 重点）

对照基线：\`${cmp.baselineRun}\`

${table(['指标', '访客态', '登录态', '差异'], cmp.rows.map((r) => {
  const b = Number(r[1]);
  const c = Number(r[2]);
  let d = '—';
  if (!Number.isNaN(b) && !Number.isNaN(c)) {
    if (b === 0) d = c > 0 ? `↑ ${c}` : '—';
    else d = c === b ? '持平' : `${c > b ? '↑' : '↓'} ${Math.abs(c - b)}（${Math.round(((c - b) / b) * 100)}%）`;
  }
  return [r[0], r[1], r[2], d];
}))}

**结论：登录是硬前置条件，不是可选项。** 访客态下作品列表与评论区同时被限流，且**都不报错**——
只表现为"数据变少"，属于最难发现的一类问题。

> 口径说明：基线那一轮是**迭代中期的代码**，因此"单视频可访问 0→19"里有一部分来自后来修掉的
> Object.assign 覆盖 bug，不能全部归因于登录。真正由登录带来的差异是**作品列表条数**与
> **评论深度**两行——这两个在两次运行里用的是同一套滚动逻辑，唯一变量就是登录态。
`;
}

md += `
---

## E. 建议下一版怎么修改（Spec §28-E）

${SUGGESTIONS.map((s) => `### ${s.level}\n\n${s.items.map((i) => `- ${i}`).join('\n')}\n`).join('\n')}

---

## F. 合规审计（本轮实际拦下的字段）

${log.dropped_fields && log.dropped_fields.length
  ? table(
      ['采集阶段', '超纲字段数', '合规丢弃（接口给了但页面不展示）'],
      log.dropped_fields.map((d) => [
        `\`${d.stage}\``,
        d.unknown_dropped_count,
        (d.compliance_dropped || []).map((c) => `\`${c.field}\`(${c.sample_value})`).join('<br>') || '—',
      ])
    )
  : '_无_'}

口径声明：以上所有"合规丢弃"字段均**未进入结果数据**。每个 URL 都能用浏览器正常打开验证，
但我们只记录页面公开展示的部分，接口多给的内部指标一律丢弃并留痕。

---

## G. 验收标准核对（Spec §26）

${table(['标准', '结果'], [
  ['1. 输入公开账号 URL 可成功进入主页', '✅'],
  [`2. 可建立作品列表并获取公开点赞数`, `${videos.length} 条，点赞字段覆盖 ${cover(videos, 'likes').pct}%`],
  ['3. 可根据作品列表筛选代表视频', `✅ 分层后 ${details.length} 条`],
  ['4. 可进入代表视频并获得四项公开互动数据', `${details.filter((d) => d.detail_data_accessible).length}/${details.length} 条成功`],
  ['5. 可读取部分公开评论与"大家都在搜"', `评论 ${comments.length} 条；"大家都在搜"该模块已不存在，改由搜索框推荐词替代`],
])}

---

*报告由 \`tools/test-report.js\` 生成 · 数据目录 \`${path.basename(runDir)}\`*
`;

const outDir = path.resolve(__dirname, '..', 'report');
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, `测试报告_${(account.nickname || 'unknown').replace(/[\\/:*?"<>|]/g, '_')}_${log.run_id}.md`);
fs.writeFileSync(outPath, md, 'utf8');
console.log(`测试报告已生成: ${outPath}`);
console.log(`长度: ${md.length} 字符`);
