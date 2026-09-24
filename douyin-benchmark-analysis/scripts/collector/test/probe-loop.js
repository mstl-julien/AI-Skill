'use strict';

/**
 * probe-loop.js —— 定向诊断：评论循环到底是"滚不动"还是"开始太早"
 *
 * 已排除（probe-container.js 实测）：
 *   - 容器选错：页面上只有 1 个可滚且含评论节点的容器，代码选中的就是它
 *   - 滚动无效：写 scrollTop 确实移动了（top 0→1233），且真的触发了新请求
 *
 * 剩余嫌疑：**时序**。生产流程在 `video.readyState>=2`（视频元素就绪）后
 * 立刻开始滚评论，而评论面板的挂载晚于 video 元素。probe-container 硬等 9s
 * 所以一次滚动就拿到 5→15。
 *
 * 本脚本做对照实验：
 *   阶段 1：复刻生产时序（readyState>=2 即开始），跑 6 轮，逐轮打点
 *   阶段 2：若零进展，再等 6 秒后跑 6 轮
 *   若阶段 2 立刻有效 → 时序问题实锤
 *
 * 用法: node test/probe-loop.js <videoId>
 */

const path = require('path');
const { chromium } = require('playwright');

const vid = process.argv[2];
if (!vid || !/^\d+$/.test(vid)) {
  console.error('用法: node test/probe-loop.js <videoId>');
  process.exit(1);
}
const url = `https://www.douyin.com/video/${vid}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randDelay = ([a, b]) => a + Math.floor(Math.random() * (b - a + 1));

(async () => {
  const context = await chromium.launchPersistentContext(
    path.resolve(__dirname, '..', 'browser-profile'),
    {
      channel: 'msedge',
      headless: false,
      viewport: null,
      args: ['--disable-blink-features=AutomationControlled', '--start-maximized'],
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      ignoreDefaultArgs: ['--enable-automation'],
    }
  );
  context.setDefaultTimeout(45000);
  const page = context.pages()[0] || (await context.newPage());

  const t0 = Date.now();
  const ts = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
  const batches = [];
  page.on('response', async (res) => {
    if (!res.url().includes('/aweme/v1/web/comment/list/')) return;
    try {
      const j = await res.json();
      batches.push({ at: ts(), n: (j.comments || []).length, total: j.total, cursor: j.cursor, has_more: j.has_more });
    } catch {
      batches.push({ at: ts(), err: 'body-lost' });
    }
  });

  // 复刻生产：scrollCommentAreaGradual 的完整实现
  const scrollCommentAreaGradual = () =>
    page.evaluate(() => {
      const isScrollable = (el) => {
        const st = getComputedStyle(el);
        if (!(st.overflowY === 'auto' || st.overflowY === 'scroll')) return false;
        if (el.scrollHeight <= el.clientHeight + 80) return false;
        return el.clientHeight >= 150;
      };
      const all = [];
      for (const el of document.querySelectorAll('div')) if (isScrollable(el)) all.push(el);
      if (!all.length) {
        window.scrollBy(0, 700);
        return { mode: 'window', moved: null, cn: 0 };
      }
      const score = (el) => {
        let n = 0;
        n += el.querySelectorAll('[data-e2e*="comment"]').length * 10;
        n += Math.min(el.querySelectorAll('img').length, 12);
        return n;
      };
      const withC = all.filter((el) => el.querySelectorAll('[data-e2e*="comment"]').length > 0);
      const pool = withC.length ? withC : all;
      pool.sort((a, b) => score(b) - score(a) || b.scrollHeight - a.scrollHeight);
      const t = pool[0];
      const before = t.scrollTop;
      t.scrollTop = Math.min(t.scrollTop + t.clientHeight * 0.8, t.scrollHeight);
      return {
        mode: withC.length ? 'comment-container' : 'fallback-container',
        moved: t.scrollTop !== before,
        cn: withC.length,
        before,
        after: t.scrollTop,
        sh: t.scrollHeight,
        ch: t.clientHeight,
      };
    });

  const totalCaptured = () => batches.reduce((s, b) => s + (b.n || 0), 0);

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });

    // 复刻生产：等 readyState>=2
    let ready = -1;
    const tR = Date.now();
    while (Date.now() - tR < 9000) {
      ready = await page.evaluate(() => {
        const v = document.querySelector('video');
        return v ? v.readyState : -1;
      });
      if (ready >= 2) break;
      await sleep(300);
    }
    console.log(`\n目标视频: ${vid}`);
    console.log(`readyState>=2 用时 ${((Date.now() - tR) / 1000).toFixed(1)}s  → 生产流程此刻就会开始滚评论`);
    console.log(`此刻已捕获评论请求: ${JSON.stringify(batches)}`);

    const runPhase = async (label, rounds) => {
      console.log(`\n=== ${label} ===`);
      let idle = 0;
      for (let r = 1; r <= rounds; r += 1) {
        const before = totalCaptured();
        const s = await scrollCommentAreaGradual();
        await sleep(randDelay([900, 1600]));
        const after = totalCaptured();
        if (after === before) idle += 1;
        else idle = 0;
        console.log(
          `  ${ts()} 轮${r} mode=${s.mode} 评论节点=${s.cn} moved=${s.moved} ` +
            `top ${Math.round(s.before || 0)}→${Math.round(s.after || 0)} ` +
            `| 累计 ${after} (+${after - before}) idle=${idle}`
        );
        if (idle >= 3) {
          console.log(`  → idle>=3，生产代码在此退出（第 ${r} 轮）`);
          return { broke: true, idle, total: after };
        }
      }
      return { broke: false, idle, total: totalCaptured() };
    };

    // ---- 阶段 1：复刻生产时序 ----
    const p1 = await runPhase('阶段 1：生产时序（readyState>=2 立即开始）', 6);

    // ---- 阶段 2：等 6 秒后再来 ----
    let p2 = null;
    if (p1.total < 20) {
      console.log(`\n  [等待 6s，模拟"评论面板充分挂载"]`);
      await sleep(6000);
      p2 = await runPhase('阶段 2：延迟 6s 后（同一循环逻辑）', 6);
    }

    console.log(`\n=== 结论 ===`);
    console.log(`  阶段1 结果: ${p1.total} 条${p1.broke ? `（第 ${p1.idle} 轮前置就 idle>=3 退出）` : ''}`);
    if (p2) console.log(`  阶段2 结果: ${p2.total} 条${p2.broke ? `（idle>=3 退出）` : ''}`);
    if (p2 && p2.total > p1.total) {
      console.log(`  >>> 时序问题实锤：同一逻辑、同一页面，晚开始就采得到`);
    } else if (p1.total >= 20) {
      console.log(`  >>> 阶段1 就正常，需扩大样本重测`);
    } else {
      console.log(`  >>> 两阶段都失败，问题不在时序（需查接口层/去重）`);
    }
    console.log(`\n  请求批次明细: ${JSON.stringify(batches)}`);
  } catch (e) {
    console.log('异常: ' + String(e.message).split('\n')[0]);
  } finally {
    await context.close();
  }
})();
