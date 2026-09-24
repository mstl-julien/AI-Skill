'use strict';

/**
 * probe-container.js —— 定向诊断：评论区真正的滚动容器是哪一个
 *
 * 背景（已用日志时间线锁定）：
 *   评论只采到 5 条的视频，整段耗时 11.2~11.5s（≈3 轮空转后 idle>=3 提前退出）；
 *   采到 50+ 条的视频耗时 17.2~20.3s。
 *   即：不是"滚了 20 轮没结果"，而是"选了错误的容器，滚 3 轮零加载就放弃了"。
 *
 * 怀疑点：scrollCommentAreaGradual() 的排序
 *   pool.sort((a,b) => score(b)-score(a) || b.scrollHeight-a.scrollHeight)
 *   score 相同时挑 scrollHeight 更大者 —— 那是外层包裹元素，
 *   而真正的 scroller 是最内层那个。滚外层推不动内层列表。
 *
 * 本脚本做三件事：
 *   1) 打印所有"可滚且含评论节点"的容器拓扑（含层级深度、是否嵌套在别的可滚容器里）
 *   2) 逐个容器实测：写 scrollTop → 读回，验证到底动没动（moved）
 *   3) 逐个容器实测：滚动后是否触发了新的 comment/list 请求（真·有效滚动）
 *   4) 兜底：鼠标真实滚轮悬停在评论区中心
 *
 * 用法: node test/probe-container.js <videoId>
 */

const path = require('path');
const { chromium } = require('playwright');

const vid = process.argv[2];
if (!vid || !/^\d+$/.test(vid)) {
  console.error('用法: node test/probe-container.js <videoId>');
  process.exit(1);
}
const url = `https://www.douyin.com/video/${vid}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

  // ---- 被动监听：只统计"浏览器自己发出"的评论请求 ----
  const reqLog = [];
  page.on('response', async (res) => {
    if (!res.url().includes('/aweme/v1/web/comment/list/')) return;
    const entry = { at: Date.now(), ok: true };
    try {
      const j = await res.json();
      entry.n = (j.comments || []).length;
      entry.total = j.total;
      entry.cursor = j.cursor;
      entry.has_more = j.has_more;
    } catch {
      entry.ok = false;
      entry.err = 'body-lost';
    }
    reqLog.push(entry);
  });

  // ---- 拓扑快照：所有可滚 + 含评论节点的容器 ----
  const TOPOLOGY = () =>
    page.evaluate(() => {
      const all = [];
      for (const el of document.querySelectorAll('div')) {
        const st = getComputedStyle(el);
        if (!(st.overflowY === 'auto' || st.overflowY === 'scroll')) continue;
        if (el.scrollHeight - el.clientHeight <= 80) continue;
        if (el.clientHeight < 150) continue;
        all.push(el);
      }
      const depthOf = (el) => {
        let d = 0;
        let p = el.parentElement;
        while (p) {
          d += 1;
          p = p.parentElement;
        }
        return d;
      };
      return all.map((el, i) => {
        // 直接子代里有评论节点的后代数量（区分"自己就是评论列表"和"只是外层包裹"）
        const cn = el.querySelectorAll('[data-e2e*="comment"]').length;
        // 是否被另一个可滚容器包住
        const nestedIn = all.findIndex((o, j) => j !== i && o.contains(el));
        const e2e = [...new Set(
          [...el.querySelectorAll('[data-e2e]')].map((n) => n.getAttribute('data-e2e')).filter(Boolean)
        )].slice(0, 6);
        return {
          i,
          depth: depthOf(el),
          cn,
          sh: el.scrollHeight,
          ch: el.clientHeight,
          top: el.scrollTop,
          nestedIn,
          e2e,
          cls: (el.className || '').toString().slice(0, 46),
        };
      });
    });

  // ---- 对指定索引容器做一次真实滚动，返回"动没动" ----
  const scrollIdx = (idx, frac = 0.8) =>
    page.evaluate(
      ({ idx, frac }) => {
        const all = [];
        for (const el of document.querySelectorAll('div')) {
          const st = getComputedStyle(el);
          if (!(st.overflowY === 'auto' || st.overflowY === 'scroll')) continue;
          if (el.scrollHeight - el.clientHeight <= 80) continue;
          if (el.clientHeight < 150) continue;
          all.push(el);
        }
        const el = all[idx];
        if (!el) return { missing: true };
        const before = el.scrollTop;
        el.scrollTop = Math.min(before + el.clientHeight * frac, el.scrollHeight);
        return {
          before,
          after: el.scrollTop,
          moved: el.scrollTop !== before,
          ch: el.clientHeight,
          sh: el.scrollHeight,
        };
      },
      { idx, frac }
    );

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(9000);

    console.log(`\n目标视频: ${vid}`);
    console.log(`首次加载已捕获评论请求 ${reqLog.length} 次:`);
    console.log(`  ${JSON.stringify(reqLog)}`);

    const topo = await TOPOLOGY();
    console.log(`\n=== 可滚容器拓扑（共 ${topo.length} 个）===`);
    console.log('  idx  depth  评论节点  scrollH  clientH  top  被谁包  data-e2e');
    topo.forEach((c) => {
      console.log(
        `  [${String(c.i).padStart(2)}]  ${String(c.depth).padStart(3)}  ` +
          `${String(c.cn).padStart(6)}  ${String(c.sh).padStart(7)}  ${String(c.ch).padStart(6)}  ` +
          `${String(c.top).padStart(4)}  ${String(c.nestedIn).padStart(5)}   ${c.e2e.join(',') || '-'}`
      );
    });

    // 当前代码会选中哪一个？（复刻 scrollCommentAreaGradual 的排序）
    const picked = await page.evaluate(() => {
      const isScrollable = (el) => {
        const st = getComputedStyle(el);
        if (!(st.overflowY === 'auto' || st.overflowY === 'scroll')) return false;
        if (el.scrollHeight <= el.clientHeight + 80) return false;
        return el.clientHeight >= 150;
      };
      const all = [];
      for (const el of document.querySelectorAll('div')) if (isScrollable(el)) all.push(el);
      const score = (el) => {
        let n = 0;
        n += el.querySelectorAll('[data-e2e*="comment"]').length * 10;
        n += Math.min(el.querySelectorAll('img').length, 12);
        return n;
      };
      const withC = all.filter((el) => el.querySelectorAll('[data-e2e*="comment"]').length > 0);
      const pool = withC.length ? withC : all;
      pool.sort((a, b) => score(b) - score(a) || b.scrollHeight - a.scrollHeight);
      return all.indexOf(pool[0]);
    });
    console.log(`\n>>> 当前代码选中的容器索引: [${picked}]`);

    // ---- 逐容器实测：动没动 + 是否触发新请求 ----
    console.log(`\n=== 逐容器实测（深度从深到浅）===`);
    const order = [...topo].sort((a, b) => b.depth - a.depth).map((c) => c.i);
    let winner = -1;
    for (const idx of order) {
      const t = topo.find((c) => c.i === idx);
      const beforeN = reqLog.length;
      const r = await scrollIdx(idx);
      await sleep(1700);
      const delta = reqLog.length - beforeN;
      const tag = t.i === picked ? '  <= 当前选中' : '';
      console.log(
        `  [${String(idx).padStart(2)}] depth=${t.depth} 评论节点=${t.cn} moved=${r.moved} ` +
          `top ${r.before}→${Math.round(r.after)} 新请求=${delta}${tag}`
      );
      if (delta > 0 && winner < 0) {
        winner = idx;
        console.log(`       ↑ 有效！索引 [${idx}] 才是真正的滚动容器`);
        if (reqLog.length >= 4) break; // 已经证明有效，不必再试
      }
    }
    if (winner < 0) console.log('  → 所有容器直接写 scrollTop 均无效，试鼠标滚轮');

    // ---- 兜底：鼠标真实滚轮 ----
    if (winner < 0) {
      console.log(`\n=== 兜底：鼠标滚轮 ===`);
      const best = topo.filter((c) => c.cn > 0).sort((a, b) => b.depth - a.depth)[0] || topo[0];
      const box = await page.evaluate((idx) => {
        const all = [];
        for (const el of document.querySelectorAll('div')) {
          const st = getComputedStyle(el);
          if (!(st.overflowY === 'auto' || st.overflowY === 'scroll')) continue;
          if (el.scrollHeight - el.clientHeight <= 80) continue;
          if (el.clientHeight < 150) continue;
          all.push(el);
        }
        const el = all[idx];
        if (!el) return null;
        el.scrollTop = 0;
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      }, best ? best.i : 0);
      if (box) {
        await page.mouse.move(box.x, box.y);
        for (let i = 0; i < 12; i += 1) {
          const beforeN = reqLog.length;
          await page.mouse.wheel(0, 700);
          await sleep(900);
          if (reqLog.length > beforeN) {
            console.log(`  轮${i + 1} 触发新请求 ${reqLog.length - beforeN} 次  (x=${box.x},y=${box.y})`);
          }
        }
        console.log(`  滚轮后累计请求 ${reqLog.length} 次`);
      } else {
        console.log('  未取到容器坐标');
      }
    }

    console.log(`\n=== 最终 ===`);
    console.log(`  请求批次: ${JSON.stringify(reqLog.map((r) => ({ n: r.n, has_more: r.has_more })))}`);
    console.log(`  累计捕获评论: ${reqLog.reduce((s, r) => s + (r.n || 0), 0)}`);
  } catch (e) {
    console.log('异常: ' + String(e.message).split('\n')[0]);
  } finally {
    await context.close();
  }
})();
