'use strict';

/**
 * probe-expand.js —— A/B 对照：expandCollapsedComments() 是不是元凶
 *
 * 生产日志里的分水岭（19 条视频，4 条只采到 5 条，全部形如）：
 *     评论 +5 (本条累计 5)
 *     点击展开按钮 1 次
 *     评论采集 5 条          ← 此后再无一条
 * 而正常的视频是：
 *     评论 +5 (本条累计 5)
 *     点击展开按钮 1 次
 *     评论 +10 ... 一直涨
 *
 * 即 expandCollapsedComments() 是唯一在循环前发生的、且每条视频都会执行的动作。
 *
 * 该函数的判定条件有漏洞：
 *     const box = el.closest('[data-e2e*="comment"]') || el.parentElement;
 *     if (!box) continue;
 * parentElement 永远为真 → "只在评论区里点"的保险形同虚设，
 * 视频简介区那个「展开」（展开完整文案）也会被点。
 *
 * 本脚本在同一视频上跑两个阶段：
 *   A：进页面 → 等 readyState>=2 → 直接滚（不点展开）
 *   B：重新进页面 → 等 readyState>=2 → 点展开 → 再滚
 * 同时打印"到底点到了哪个元素"，确认是否误点简介。
 *
 * 用法: node test/probe-expand.js <videoId>
 */

const path = require('path');
const { chromium } = require('playwright');

const vid = process.argv[2];
if (!vid || !/^\d+$/.test(vid)) {
  console.error('用法: node test/probe-expand.js <videoId>');
  process.exit(1);
}
const url = `https://www.douyin.com/video/${vid}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randDelay = ([a, b]) => a + Math.floor(Math.random() * (b - a + 1));

let page = null;
let batches = [];
const t0 = Date.now();
const ts = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;

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
    return { mode: withC.length ? 'comment-container' : 'fallback-container', moved: t.scrollTop !== before, cn: withC.length };
  });

/** 复刻生产实现，额外返回"点了什么" */
const expandCollapsedComments = () =>
  page.evaluate(() => {
    const texts = ['展开更多评论', '展开', '查看更多评论', '查看更多回复'];
    const hits = [];
    let clicked = 0;
    for (const el of document.querySelectorAll('div, span, button')) {
      if (el.children.length !== 0) continue;
      const t = (el.textContent || '').trim();
      if (!texts.includes(t)) continue;
      const box = el.closest('[data-e2e*="comment"]') || el.parentElement;
      if (!box) continue;
      hits.push({
        text: t,
        insideCommentNode: !!el.closest('[data-e2e*="comment"]'),
        parentE2e: el.parentElement ? el.parentElement.getAttribute('data-e2e') : null,
        // 往上找最近的 data-e2e，判断点的是简介还是评论区
        nearestE2e:
          (el.closest('[data-e2e]') && el.closest('[data-e2e]').getAttribute('data-e2e')) || null,
      });
      el.click();
      clicked += 1;
      if (clicked >= 2) break;
    }
    return { clicked, hits };
  });

const total = () => batches.reduce((s, b) => s + (b.n || 0), 0);

async function loadFresh() {
  batches = [];
  await page.goto('about:blank');
  await sleep(400);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  const tR = Date.now();
  while (Date.now() - tR < 9000) {
    const r = await page.evaluate(() => {
      const v = document.querySelector('video');
      return v ? v.readyState : -1;
    });
    if (r >= 2) break;
    await sleep(300);
  }
  return ((Date.now() - tR) / 1000).toFixed(1);
}

async function runLoop(rounds, label) {
  let idle = 0;
  for (let r = 1; r <= rounds; r += 1) {
    const before = total();
    const s = await scrollCommentAreaGradual();
    await sleep(randDelay([900, 1600]));
    const after = total();
    idle = after === before ? idle + 1 : 0;
    console.log(
      `      ${ts()} 轮${r} mode=${s.mode} 评论节点=${s.cn} moved=${s.moved} 累计=${after} (+${after - before}) idle=${idle}`
    );
    if (idle >= 3) {
      console.log(`      → idle>=3，生产代码在此退出`);
      return after;
    }
  }
  return total();
}

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
  page = context.pages()[0] || (await context.newPage());
  page.on('response', async (res) => {
    if (!res.url().includes('/aweme/v1/web/comment/list/')) return;
    try {
      const j = await res.json();
      batches.push({ n: (j.comments || []).length, cursor: j.cursor, has_more: j.has_more });
    } catch {
      batches.push({ n: 0, err: 'body-lost' });
    }
  });

  try {
    console.log(`\n目标视频: ${vid}`);

    // ---------- 阶段 A：不点展开 ----------
    console.log(`\n=== 阶段 A：不点展开，直接滚 ===`);
    console.log(`  加载耗时 ${await loadFresh()}s，初始批次 ${JSON.stringify(batches)}`);
    const a = await runLoop(8, 'A');
    console.log(`  >>> 阶段 A 结果: ${a} 条`);

    // ---------- 阶段 B：点展开后再滚 ----------
    console.log(`\n=== 阶段 B：先点展开，再滚 ===`);
    console.log(`  加载耗时 ${await loadFresh()}s，初始批次 ${JSON.stringify(batches)}`);
    const ex = await expandCollapsedComments();
    console.log(`  点击了 ${ex.clicked} 次，明细:`);
    ex.hits.forEach((h) => {
      console.log(
        `    - 文本「${h.text}」 在评论节点内=${h.insideCommentNode} ` +
          `最近data-e2e=${h.nearestE2e} 父data-e2e=${h.parentE2e}`
      );
    });
    await sleep(1200);
    const b = await runLoop(8, 'B');
    console.log(`  >>> 阶段 B 结果: ${b} 条`);

    console.log(`\n=== 结论 ===`);
    console.log(`  A(不点展开) = ${a} 条`);
    console.log(`  B(点展开后) = ${b} 条`);
    if (b < 20 && a >= 20) console.log(`  >>> 实锤：expandCollapsedComments() 误点简介，打断了评论加载`);
    else if (a < 20 && b < 20) console.log(`  >>> 两阶段都失败，元凶不是展开点击（需查页面现场状态）`);
    else console.log(`  >>> 两阶段都正常，未复现（需考虑"主页前置流程"造成的状态污染）`);
  } catch (e) {
    console.log('异常: ' + String(e.message).split('\n')[0]);
  } finally {
    await context.close();
  }
})();
