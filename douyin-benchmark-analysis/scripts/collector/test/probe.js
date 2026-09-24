'use strict';

/**
 * probe.js —— 环境探针（不做完整采集，只验证链路是否通）
 *
 * 用法:
 *   node test/probe.js                                        # 只探环境
 *   node test/probe.js "https://www.douyin.com/user/XXXX"     # 探主页
 *   node test/probe.js "https://www.douyin.com/video/XXXX"    # 探视频页（含评论区）
 *
 * 它会把页面发出的所有 /aweme/v1/web/* 接口都列出来，
 * 用于反推"我们该监听什么"，而不是靠猜。
 */

const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const url = process.argv.find((a) => /^https?:\/\//.test(a)) || 'https://www.douyin.com/';
const isVideo = /\/video\//.test(url);
const profileDir = path.resolve(__dirname, '..', 'browser-profile');

const PATTERNS = {
  USER_PROFILE: '/aweme/v1/web/user/profile/other/',
  AWEME_POST: '/aweme/v1/web/aweme/post/',
  AWEME_DETAIL: '/aweme/v1/web/aweme/detail/',
  COMMENT_LIST: '/aweme/v1/web/comment/list/',
  SUGGEST_WORDS: '/aweme/v1/web/api/suggest_words/',
  SEARCH_SUG: '/aweme/v1/web/search/sug/',
};

const hits = [];
const allEndpoints = {};
const savedBodies = {};

(async () => {
  console.log('=== 探针启动 ===');
  console.log('目标 URL:', url);
  console.log('模式:', isVideo ? '视频页（重点看评论区）' : '主页');

  const context = await chromium.launchPersistentContext(profileDir, {
    channel: 'msedge',
    headless: false,
    viewport: null,
    args: ['--disable-blink-features=AutomationControlled', '--start-maximized'],
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    ignoreDefaultArgs: ['--enable-automation'],
  });

  context.setDefaultTimeout(45000);
  const page = context.pages()[0] || (await context.newPage());

  page.on('response', async (res) => {
    let u;
    try {
      u = res.url();
    } catch {
      return;
    }
    const m = u.match(/\/aweme\/v1\/web\/([a-z0-9_\/]+)/i);
    if (!m) return;
    const ep = m[1].replace(/\/$/, '');
    allEndpoints[ep] = (allEndpoints[ep] || 0) + 1;

    for (const [kind, frag] of Object.entries(PATTERNS)) {
      if (!u.includes(frag)) continue;
      let shape = null;
      let body = null;
      try {
        const j = await res.json();
        body = j;
        if (kind === 'USER_PROFILE') {
          const usr = j.user || {};
          shape = { nickname: usr.nickname, follower_count: usr.follower_count };
        } else if (kind === 'AWEME_POST') {
          const l = j.aweme_list || [];
          shape = {
            page_len: l.length,
            has_more: j.has_more,
            max_cursor: j.max_cursor,
            is_top_count: l.filter((x) => x.is_top === 1).length,
            sample: l.slice(0, 6).map((x) => ({
              id: x.aweme_id,
              is_top: x.is_top,
              digg: x.statistics?.digg_count,
              desc: (x.desc || '').slice(0, 24),
            })),
          };
        } else if (kind === 'AWEME_DETAIL') {
          const a = j.aweme_detail || {};
          shape = {
            has_detail: !!j.aweme_detail,
            aweme_id: a.aweme_id,
            desc: (a.desc || '').slice(0, 40),
            duration: a.video?.duration,
            create_time: a.create_time,
            statistics: a.statistics ? {
              digg: a.statistics.digg_count,
              comment: a.statistics.comment_count,
              collect: a.statistics.collect_count,
              share: a.statistics.share_count,
              play: a.statistics.play_count,
            } : null,
          };
        } else if (kind === 'COMMENT_LIST') {
          const c = j.comments || [];
          shape = {
            page_len: c.length,
            total: j.total,
            has_more: j.has_more,
            cursor: j.cursor,
            first: c[0]
              ? {
                  cid: c[0].cid,
                  text: (c[0].text || '').slice(0, 30),
                  digg: c[0].digg_count,
                  ip: c[0].ip_label,
                  replies: c[0].reply_comment_total,
                  has_user: !!c[0].user,
                }
              : null,
            keys_of_first: c[0] ? Object.keys(c[0]) : null,
          };
        } else if (kind === 'SUGGEST_WORDS' || kind === 'SEARCH_SUG') {
          shape = {
            top_keys: Object.keys(j),
            body_preview: JSON.stringify(j).slice(0, 700),
          };
        }
      } catch (e) {
        shape = { parse_error: String(e.message).split('\n')[0] };
      }
      hits.push({ kind, status: res.status(), shape });
      if (body && !savedBodies[kind]) savedBodies[kind] = body;
      console.log(`  ▸ 捕获 ${kind}  status=${res.status()}`);
      console.log('     ', JSON.stringify(shape));
      return;
    }
  });

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(7000);

    const cookies = await context.cookies('https://www.douyin.com');
    const logged = cookies.some((c) => ['sessionid', 'sessionid_ss', 'sid_tt'].includes(c.name) && c.value);
    console.log(`\n登录态: ${logged ? '已登录' : '未登录（访客态）'}   Cookie: ${cookies.length}`);

    const snap0 = await page.evaluate(() => {
      const t = document.body ? document.body.innerText : '';
      return {
        hasVideo: !!document.querySelector('video'),
        readyState: (document.querySelector('video') || {}).readyState ?? -1,
        hasSearchBlock: t.includes('大家都在搜'),
        headText: t.slice(0, 260).replace(/\n+/g, ' | '),
      };
    });
    console.log(`video 元素: ${snap0.hasVideo}  readyState=${snap0.readyState}`);
    console.log(`页面含"大家都在搜": ${snap0.hasSearchBlock}`);
    console.log(`页面首屏: ${snap0.headText}`);

    if (isVideo) {
      console.log('\n--- 尝试滚动展开评论区 ---');
      for (let i = 0; i < 5; i += 1) {
        await page.evaluate(() => {
          const cands = [];
          for (const el of document.querySelectorAll('div')) {
            const st = getComputedStyle(el);
            if ((st.overflowY === 'auto' || st.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 80 && el.clientHeight > 150) {
              cands.push(el);
            }
          }
          if (cands.length) {
            cands.sort((a, b) => b.scrollHeight - a.scrollHeight);
            cands[0].scrollTop = cands[0].scrollHeight;
            return 'container';
          }
          window.scrollTo(0, document.body.scrollHeight);
          return 'window';
        });
        await page.waitForTimeout(1800);
      }

      const kw = await page.evaluate(() => {
        const LABEL = '大家都在搜';
        for (const n of document.querySelectorAll('*')) {
          if (n.children.length === 0 && n.textContent && n.textContent.trim() === LABEL) {
            let box = n.parentElement;
            for (let d = 0; d < 4 && box; d += 1) {
              const texts = Array.from(box.querySelectorAll('*'))
                .filter((x) => x.children.length === 0)
                .map((x) => (x.textContent || '').trim())
                .filter((t) => t && t !== LABEL && t.length <= 24);
              const uniq = [...new Set(texts)];
              if (uniq.length >= 1 && uniq.length <= 10) return { found: true, keywords: uniq, depth: d };
              box = box.parentElement;
            }
            return { found: true, keywords: [], note: 'label 存在但未解出词条' };
          }
        }
        return { found: false };
      });
      console.log('"大家都在搜" 提取结果:', JSON.stringify(kw));
    }

    console.log('\n--- 页面发出的全部 /aweme/v1/web/* 接口 ---');
    console.log(JSON.stringify(allEndpoints, null, 2));

    console.log('\n--- 关键接口命中 ---');
    for (const h of hits) console.log(`  ${h.kind}: status=${h.status}`);

    const outDir = path.resolve(__dirname, '..', 'data', '_probe');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(
      path.join(outDir, `probe-${Date.now()}${isVideo ? '-video' : '-user'}.json`),
      JSON.stringify({ url, isVideo, allEndpoints, hits, savedBodies }, null, 2),
      'utf8'
    );
    console.log(`\n原始响应样本已存: ${outDir}`);
  } catch (e) {
    console.log(`\n✗ 探针异常: ${String(e.message).split('\n')[0]}`);
  } finally {
    await context.close();
    console.log('浏览器已关闭。');
  }
})();
