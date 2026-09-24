'use strict';

/**
 * CLI 入口 —— 严格按 Spec §30 的 14 步执行顺序编排。
 *
 * 用法：
 *   node collector.js --login                          # 首次：扫码登录，保存 profile
 *   node collector.js <主页URL>                        # 采集
 *   node collector.js <主页URL> --max-videos=200 --detail-limit=30
 *   node collector.js <主页URL> --headless             # 无头（不推荐，易被风控）
 */

const fs = require('fs');
const path = require('path');

const { DouyinCollector } = require('./lib/collector');
const E = require('./lib/extract');
const spec = require('./lib/spec');
const { buildReport } = require('./lib/report');

function parseArgs(argv) {
  const out = { flags: {}, url: null };
  for (const a of argv.slice(2)) {
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      out.flags[k] = v === undefined ? true : v;
    } else if (/^https?:\/\//.test(a)) {
      out.url = a;
    }
  }
  return out;
}

/** 解析 --sampling=high:12,mid:4,low:4,latest:8,pinned:all 形式的分层覆盖 */
function parseSampling(v) {
  if (!v) return null;
  const smp = { ...spec.DEFAULT_SAMPLING };
  for (const pair of String(v).split(',')) {
    const [k, raw] = pair.split(':');
    if (!(k in smp)) {
      console.error(`  未知分组 "${k}"（可用：high/mid/low/latest/pinned）`);
      process.exit(1);
    }
    smp[k] = raw === 'all' ? Infinity : Number(raw);
    if (!Number.isFinite(smp[k]) && smp[k] !== Infinity) {
      console.error(`  分组 "${k}" 的数量非法: ${raw}`);
      process.exit(1);
    }
  }
  return smp;
}

function normUrl(u) {
  // 兼容分享短链 / 带参数链接
  const m = String(u).match(/douyin\.com\/user\/([A-Za-z0-9_\-]+)/);
  if (m) return `https://www.douyin.com/user/${m[1]}`;
  return u;
}

async function main() {
  const { flags, url } = parseArgs(process.argv);

  // maxVideos：0 = 全量（默认）。--max-videos=N 显式限流；--full 等价于全量。
  const maxVideos = flags['max-videos'] ? Number(flags['max-videos']) : 0;
  const detailLimit = flags['detail-limit'] ? Number(flags['detail-limit']) : spec.DEFAULTS.detailLimit;
  const sampling = parseSampling(flags.sampling);

  const opts = {
    url: url ? normUrl(url) : null,
    headless: !!flags.headless,
    maxVideos: flags.full ? 0 : maxVideos,
    detailLimit,
    commentMin: spec.DEFAULT_COMMENT_SAMPLING.minPerVideo,
    commentMax: spec.DEFAULT_COMMENT_SAMPLING.maxPerVideo,
  };

  console.log('==============================================');
  console.log(' 抖音公开数据采集器 V0.1 （实验版）');
  console.log(' 原则：只采公开可见信息 / 不编造 / 采集与分析分离');
  console.log('==============================================');

  // -------- STEP 1 初始化 --------
  const c = new DouyinCollector(opts);
  console.log(`\n[STEP 1] 初始化  运行目录: ${c.dataDir}`);

  try {
    await c.launch();

    // -------- 登录模式（只登录，不采集） --------
    if (flags.login) {
      const okLogin = await c.waitForManualLogin();
      if (!okLogin) process.exitCode = 1;
      console.log('\n登录流程结束（profile 已持久化到 browser-profile/）。');
      await c.close();
      return;
    }

    // -------- 入参校验（放在登录等待之前，避免白等一场） --------
    if (!flags['from-plan'] && !opts.url) {
      console.error('\n缺少账号主页 URL。用法: node collector.js https://www.douyin.com/user/xxxx');
      await c.close();
      process.exitCode = 1;
      return;
    }

    // -------- 采集前强制登录（90 于 2026-09-23 定：必须等待登录并确认后才可进行数据采集） --------
    let loggedIn = await c.isLoggedIn();
    if (!loggedIn) {
      console.log('[STEP 1] 登录态: 未登录（访客态）。');
      console.log('  ⚠ 访客态会被静默限流（实测：作品卡在首页、评论仅 5~10 条），不允许用访客态出数。');
      console.log('  ⚠ 请在弹出的浏览器窗口里扫码登录 —— 登录成功后本程序自动继续采集。');
      const okLogin = await c.waitForManualLogin();
      loggedIn = await c.isLoggedIn();
      if (!okLogin || !loggedIn) {
        c.log.options.logged_in = false;
        c.log.finished_at = null;
        console.error('\n[登录] 等待超时仍未登录。按规则不进行访客态采集，终止。');
        console.error('  稍后重试：直接重跑本命令（会再次弹出扫码窗口），或先单独执行 node collector.js --login');
        c.addError('login', spec.ERROR_TYPE.LOGIN_REQUIRED, '采集前等待扫码登录超时，未进行采集');
        try {
          c.save();
        } catch {
          /* ignore */
        }
        process.exitCode = 1;
        return;
      }
    }
    c.log.options.logged_in = true;
    console.log('[STEP 1] 登录态: 已登录 ✓（已确认，开始采集）');

    if (flags['from-plan']) {
      // ======== 两段式第二段：从已确认的选样计划续跑详情 ========
      if (!loggedIn) {
        console.error('\n续跑详情需要登录态。先执行: node collector.js --login');
        await c.close();
        process.exitCode = 1;
        return;
      }
      c.restoreFromDataDir(String(flags['from-plan']));
      const targets = c.selectTargets(detailLimit, sampling);
      console.log(`\n[STEP 7-10] 逐个进入 ${targets.length} 条代表视频（依据已确认的选样计划）`);
      for (let i = 0; i < targets.length; i += 1) {
        const v = targets[i];
        console.log(`\n  [${i + 1}/${targets.length}] ${v.sample_group} | ${v.likes} 赞 | ${(v.title || '').slice(0, 30)}`);
        await c.collectVideoDetail(v);
      }
      console.log('\n[STEP 11] 记录错误与状态');
      const result = c.save();
      const reportPath = buildReport(c, result);
      console.log(`\n[STEP 12] 采集结果摘要`);
      console.log(JSON.stringify(c.log.summary, null, 2));
      console.log(`\n[STEP 14] HTML 数据查看页: ${reportPath}`);
      console.log(`          原始数据目录: ${c.dataDir}`);
    } else {
      // ======== 第一段（及单段式全流程）—— URL 已在入口校验过 ========
      // -------- STEP 2/3 访问主页 + 账号信息 --------
      const ok = await c.openHomepage(opts.url);
      if (!ok) {
        console.error('\n主页打开失败，终止。');
        c.save();
        await c.close();
        process.exitCode = 1;
        return;
      }

      // -------- STEP 2（B）内容结构 --------
      await c.collectContentStructure();

      // -------- STEP 4 作品列表（默认全量：滚到接口 has_more=0）--------
      await c.collectWorksList();

      // -------- STEP 5 保存主页结果 --------
      console.log('\n[STEP 5] 保存主页采集结果');
      c.save();

      if (flags['plan-only']) {
        // ======== 两段式第一段：出选样计划，停下等确认 ========
        await c.presentSelectionPlan(detailLimit, sampling);
        console.log('\n[已暂停] 确认或调整后，执行第二段：');
        console.log(`  node collector.js --from-plan=${c.dataDir} --detail-limit=${detailLimit}`);
        console.log(`  可选: --sampling=high:12,mid:4,low:4,latest:8,pinned:all 覆盖分层标准`);
      } else {
        // -------- STEP 6~10 单段式全流程 --------
        console.log('\n[STEP 6] 点赞分层与代表视频选择（依据=点赞表现，不是播放表现）');
        const targets = c.selectTargets(detailLimit, sampling);
        console.log(`\n[STEP 7-10] 逐个进入 ${targets.length} 条代表视频`);
        for (let i = 0; i < targets.length; i += 1) {
          const v = targets[i];
          console.log(`\n  [${i + 1}/${targets.length}] ${v.sample_group} | ${v.likes} 赞 | ${(v.title || '').slice(0, 30)}`);
          await c.collectVideoDetail(v);
        }

        console.log('\n[STEP 11] 记录错误与状态');
        const result = c.save();
        const reportPath = buildReport(c, result);
        console.log(`\n[STEP 12] 采集结果摘要`);
        console.log(JSON.stringify(c.log.summary, null, 2));
        console.log(`\n[STEP 14] HTML 数据查看页: ${reportPath}`);
        console.log(`          原始数据目录: ${c.dataDir}`);
      }
    }
  } catch (e) {
    console.error('\n未捕获异常:', e);
    c.addError('main', spec.ERROR_TYPE.UNKNOWN, String(e.stack || e.message));
    try {
      c.save();
    } catch {
      /* ignore */
    }
    process.exitCode = 1;
  } finally {
    // Spec §22 要求：异常也不终止整体，这里负责清理浏览器
    await c.close();
    console.log('\n完成。');
  }
}

main();
