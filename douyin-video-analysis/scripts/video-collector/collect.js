'use strict';

/**
 * 抖音单视频采集器 MVP —— douyin-video-analysis V0.2
 *
 * 用法：
 *   node collect.js --url=https://www.douyin.com/video/xxxx
 *   node collect.js --url=<短链> --out=<产物目录>
 *   node collect.js --login                 # 只登录不采集
 *
 * 产出：<out>/data.json（Schema 见 skill references/spec-v0.2.md §10）+ video.mp4（可选）
 *
 * 原则：只采公开可见信息 / 不编造 / 采集与分析分离 / 采不到的如实标 PARTIAL。
 */

const fs = require('fs');
const path = require('path');

// ---- playwright 解析：优先本目录 node_modules，回退到实验版 douyin-collector ----
function loadPlaywright() {
  const candidates = [
    path.join(__dirname, 'node_modules', 'playwright'),
    'D:/julien/workbuddy/临时任务/douyin-collector/node_modules/playwright',
  ];
  for (const p of candidates) {
    try { return require(p); } catch (e) { /* try next */ }
  }
  console.error('找不到 playwright。请先在 scripts/video-collector/ 下 npm install，或确认 douyin-collector/node_modules 存在。');
  process.exit(1);
}
const { chromium } = loadPlaywright();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();

// ------------------------------------------------------------
// 参数
// ------------------------------------------------------------
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

/** 从 URL 提取视频 id；短链返回 null 待解析 */
function extractVideoId(url) {
  const m = String(url).match(/douyin\.com\/(?:video|note|modal)\/(\d+)/);
  return m ? m[1] : null;
}

async function resolveShortLink(url) {
  if (!/v\.douyin\.com|iesdouyin\.com\/share/.test(url)) return url;
  let current = url;
  for (let i = 0; i < 5; i++) {
    try {
      const res = await fetch(current, { redirect: 'manual' });
      const loc = res.headers.get('location');
      if (!loc) break;
      if (/douyin\.com\/(?:video|note|modal)\/(\d+)/.test(loc)) return loc;
      current = loc.startsWith('http') ? loc : new URL(loc, current).href;
    } catch (e) {
      console.log(`  短链解析失败(尝试 ${i + 1}): ${e.message}`);
      break;
    }
  }
  return current;
}

// ------------------------------------------------------------
// 采集器
// ------------------------------------------------------------
class VideoCollector {
  constructor(opts) {
    this.opts = opts;
    this.runId = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    this.outDir = path.resolve(opts.out || path.join('D:/julien/workbuddy/临时任务/video-analysis', this.runId));
    fs.mkdirSync(this.outDir, { recursive: true });

    // 登录态 profile：默认复用 douyin-collector 的（658M，勿拷贝，直接指向）
    this.profileDir = process.env.DVA_PROFILE_DIR
      || 'D:/julien/workbuddy/临时任务/douyin-collector/browser-profile';

    this.videoId = opts.videoId || null;
    this.detail = null;          // aweme/detail 接口 JSON
    this.comments = new Map();   // cid → comment（顶层）
    this.replies = new Map();    // cid → reply（扁平，含 parent_cid）
    this.replyMeta = new Map();  // 顶层cid → { expected: reply_comment_total, collected: n, has_more }
    this.commentHasMore = null;
    this.commentTotal = null;    // 接口给的 total（含楼中楼，不能当顶层分母 —— 口径红线）
    this.searchKeywords = [];    // 大家都在搜
    this.errors = [];
    this.debug = !!process.env.DEBUG_COMMENTS;
    this._newCommentCount = 0;   // 自上次检查以来的新增数（竞态消除）
    this._newReplyCount = 0;
  }

  log(...a) { console.log(...a); }

  addError(stage, type, msg) {
    this.errors.push({ at: nowIso(), stage, type, message: String(msg).slice(0, 500) });
  }

  // ---------------- 启动 ----------------
  async launch() {
    const args = ['--disable-blink-features=AutomationControlled', '--start-maximized'];
    const channels = ['msedge', 'chrome', null];
    let lastErr = null;
    for (const channel of channels) {
      try {
        this.log(`  尝试启动浏览器: ${channel || 'bundled-chromium'}`);
        this.context = await chromium.launchPersistentContext(this.profileDir, {
          channel: channel || undefined,
          headless: !!this.opts.headless,
          viewport: null,
          args,
          locale: 'zh-CN',
          timezoneId: 'Asia/Shanghai',
          ignoreDefaultArgs: ['--enable-automation'],
        });
        break;
      } catch (e) {
        lastErr = e;
        this.log(`  启动失败(${channel || 'chromium'}): ${String(e.message).split('\n')[0]}`);
      }
    }
    if (!this.context) throw lastErr || new Error('无法启动任何浏览器');
    this.context.setDefaultTimeout(30000);
    const pages = this.context.pages();
    this.page = pages.length ? pages[0] : await this.context.newPage();
    this.attachInterceptors();
  }

  async close() {
    try { await this.context.close(); } catch (e) { /* ignore */ }
  }

  // ---------------- 被动监听（核心） ----------------
  attachInterceptors() {
    this.page.on('response', async (res) => {
      let url;
      try { url = res.url(); } catch { return; }
      try {
        if (url.includes('/aweme/v1/web/aweme/detail/')) {
          const json = await res.json();
          if (json && json.aweme_detail) {
            this.detail = json.aweme_detail;
            this.log(`  [拦截] aweme/detail ✓ (${String(json.aweme_detail.desc || '').slice(0, 30)}...)`);
          }
        } else if (url.includes('/aweme/v1/web/comment/list/reply/')) {
          const json = await res.json();
          const n = this.consumeReplies(json);
          this._newReplyCount += n;
          if (this.debug) this.log(`    [reply] +${n}`);
        } else if (url.includes('/aweme/v1/web/comment/list/')) {
          const json = await res.json();
          const n = this.consumeComments(json);
          this._newCommentCount += n;
          if (this.debug) this.log(`    [comment] +${n} has_more=${json.has_more}`);
        }
      } catch (e) {
        // 响应体可能已被页面消费或非 JSON，忽略
      }
    });
  }

  normalizeComment(c, parentId) {
    return {
      comment_id: String(c.cid ?? ''),
      parent_comment_id: parentId ? String(parentId) : null,
      user_nickname: c.user?.nickname ?? null,
      user_avatar: c.user?.avatar_thumb?.url_list?.[0] ?? null,
      content: c.text ?? '',
      publish_time: c.create_time ? new Date(c.create_time * 1000).toISOString() : null,
      likes: typeof c.digg_count === 'number' ? c.digg_count : null,
      ip_location: c.ip_label ?? null,
      reply_count: typeof c.reply_comment_total === 'number' ? c.reply_comment_total : null,
      has_replies: (c.reply_comment_total || 0) > 0,
      collected_at: nowIso(),
    };
  }

  consumeComments(json) {
    if (!json || !Array.isArray(json.comments)) return 0;
    if (json.total != null) this.commentTotal = json.total;
    if (json.has_more != null) this.commentHasMore = json.has_more;
    let added = 0;
    for (const c of json.comments) {
      if (!c || c.cid == null) continue;
      const key = String(c.cid);
      if (!this.comments.has(key)) {
        this.comments.set(key, this.normalizeComment(c, null));
        added++;
        const expected = c.reply_comment_total || 0;
        if (!this.replyMeta.has(key)) {
          this.replyMeta.set(key, { expected, collected: 0 });
        }
      }
    }
    return added;
  }

  consumeReplies(json) {
    if (!json || !Array.isArray(json.comments)) return 0;
    let added = 0;
    for (const c of json.comments) {
      if (!c || c.cid == null) continue;
      const key = String(c.cid);
      if (!this.replies.has(key)) {
        const parentId = String(c.reply_id ?? '');
        this.replies.set(key, this.normalizeComment(c, parentId));
        const meta = this.replyMeta.get(parentId);
        if (meta) meta.collected++;
        added++;
      }
    }
    // 回复分页 has_more 记到所属顶层
    if (json.has_more != null && json.comments.length) {
      const pid = String(json.comments[0].reply_id ?? '');
      const meta = this.replyMeta.get(pid);
      if (meta) meta.has_more = json.has_more;
    }
    return added;
  }

  // ---------------- 登录 ----------------
  async isLoggedIn() {
    try {
      const cookies = await this.context.cookies('https://www.douyin.com');
      return cookies.some((c) => ['sessionid', 'sessionid_ss', 'sid_tt'].includes(c.name) && c.value);
    } catch { return false; }
  }

  async waitForManualLogin(timeoutMs = 600000) {
    this.log('\n[登录] 请在浏览器窗口扫码登录抖音。登录成功后自动继续（最长等 10 分钟）。');
    try {
      await this.page.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded' });
    } catch (e) { /* ignore */ }
    await sleep(3000);
    await this.dismissOverlays();
    for (let i = 0; i < 3 && !(await this.isLoggedIn()); i++) {
      await this.page.evaluate(() => {
        const els = Array.from(document.querySelectorAll('div, span, button, a'));
        const el = els.find((e) => e.children.length === 0 && e.textContent && e.textContent.trim() === '登录');
        if (el) el.click();
      }).catch(() => {});
      await sleep(2000);
    }
    const t0 = Date.now();
    let lastReport = 0;
    while (Date.now() - t0 < timeoutMs) {
      if (await this.isLoggedIn()) {
        const cookies = await this.context.cookies('https://www.douyin.com');
        const nick = cookies.find((c) => c.name === 'nickname');
        this.log(`[登录] ✓ 登录成功${nick ? `（${decodeURIComponent(nick.value)}）` : ''}`);
        return true;
      }
      const elapsed = Math.round((Date.now() - t0) / 1000);
      if (elapsed - lastReport >= 30) {
        lastReport = elapsed;
        this.log(`[登录] 仍在等待... (${elapsed}s)`);
      }
      await sleep(3000);
    }
    this.log('[登录] ✗ 等待超时，未检测到登录态。');
    return false;
  }

  async dismissOverlays() {
    await this.page.evaluate(() => {
      // 关闭常见弹层：登录引导、红包、青少年模式
      const sels = [
        '[data-e2e="channel-login-close"]',
        '.login-guide-container [aria-label="关闭"]',
        '[class*="login-guide"] [class*="close"]',
        '[class*="redeem"] [class*="close"]',
      ];
      for (const s of sels) {
        document.querySelectorAll(s).forEach((el) => { try { el.click(); } catch (e) { /* */ } });
      }
    }).catch(() => {});
  }

  // ---------------- 视频页 ----------------
  async openVideoPage() {
    const url = `https://www.douyin.com/video/${this.videoId}`;
    this.log(`  打开 ${url}`);
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => {
      this.addError('video_page', 'NAV_FAIL', e.message);
    });
    await sleep(4000);
    await this.dismissOverlays();
    // 等 detail 接口（最多 20s）
    for (let i = 0; i < 10 && !this.detail; i++) await sleep(2000);
    if (!this.detail) {
      // 兜底：从 SSR 数据里抠
      await this.scrapeDetailFromDom();
    }
  }

  async scrapeDetailFromDom() {
    try {
      const data = await this.page.evaluate(() => {
        const el = document.getElementById('RENDER_DATA');
        if (!el) return null;
        try {
          const obj = JSON.parse(decodeURIComponent(el.textContent));
          const flat = JSON.stringify(obj);
          const m = flat.match(/"aweme_id":"(\d+)"/);
          const detailKey = Object.values(obj).find?.((v) => v && v.item_list && v.item_list.length);
          return flat.slice(0, 200000);
        } catch (e) { return null; }
      });
      if (data) {
        // 宽松提取关键字段
        const pick = (re) => { const m = data.match(re); return m ? m[1] : null; };
        this.detail = this.detail || {
          aweme_id: this.videoId,
          desc: pick(/"desc":"((?:[^"\\]|\\.)*)"/),
          create_time: Number(pick(/"create_time":(\d{10})/)) || null,
          statistics: {
            digg_count: Number(pick(/"digg_count":(\d+)/)) || null,
            comment_count: Number(pick(/"comment_count":(\d+)/)) || null,
            collect_count: Number(pick(/"collect_count":(\d+)/)) || null,
            share_count: Number(pick(/"share_count":(\d+)/)) || null,
          },
          _source: 'RENDER_DATA_FALLBACK',
        };
        this.log('  [兜底] 从 RENDER_DATA 提取到部分详情');
      }
    } catch (e) {
      this.addError('video_page', 'RENDER_DATA_FAIL', e.message);
    }
  }

  async scrapePageFallback() {
    // DOM 兜底：标题/话题/计数（公开页面可见就记）
    return this.page.evaluate(() => {
      const txt = (sel) => { const el = document.querySelector(sel); return el ? el.textContent.trim() : null; };
      const hashtags = Array.from(document.querySelectorAll('[data-e2e="video-tag"] a, .video-tag a'))
        .map((a) => a.textContent.replace(/^#/, '').trim()).filter(Boolean);
      const num = (s) => { if (!s) return null; const m = s.match(/([\d.]+)([万亿kKwW])?/); if (!m) return null; let n = parseFloat(m[1]); const u = m[2] || ''; if (u === '万' || u === 'w' || u === 'W') n *= 10000; if (u === '亿') n *= 100000000; if (u === 'k' || u === 'K') n *= 1000; return Math.round(n); };
      const counters = {};
      document.querySelectorAll('[data-e2e="video-player-digg"], [data-e2e="video-player-comment"], [data-e2e="video-player-collect"], [data-e2e="video-player-share"]').forEach((el) => {
        const key = el.getAttribute('data-e2e');
        counters[key] = el.textContent.trim();
      });
      return {
        title: txt('[data-e2e="video-desc"], .video-info-detail .title') || document.title,
        hashtags,
        counters,
      };
    }).catch(() => null);
  }

  // ---------------- 全量评论 ----------------
  async collectAllComments() {
    this.log(`\n[评论] 开始全量采集（接口 total=${this.commentTotal ?? '?'}，含楼中楼，仅作参考）`);

    // 打开评论区面板（视频详情页右侧通常已展开；否则点击评论按钮）
    await this.page.evaluate(() => {
      const btn = document.querySelector('[data-e2e="video-player-comment"]');
      if (btn) btn.click();
    }).catch(() => {});
    await sleep(2500);

    const MAX_ROUNDS = 400;
    let idleRounds = 0;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const before = this.comments.size;

      // 真实滚轮悬停评论容器滚动
      await this.scrollCommentAreaByWheel();
      // 等"新的分页请求 + 响应"落地（竞态消除：不等响应就数数会静默少采）
      await this.waitCommentProgress(6000, before);

      const after = this.comments.size;
      if (after > before) {
        idleRounds = 0;
        if (round % 5 === 0) this.log(`  [评论] 第 ${round + 1} 轮：+${after - before} → 累计顶层 ${after}`);
      } else {
        idleRounds++;
      }

      if (this.commentHasMore === 0) {
        this.log(`  [评论] 接口 has_more=0，顶层遍历完成`);
        break;
      }
      if (idleRounds >= 6) {
        this.log(`  [评论] 连续 ${idleRounds} 轮无新增且无请求，停止滚动`);
        break;
      }
    }
    this.log(`  [评论] 顶层共 ${this.comments.size} 条`);

    // 展开全部回复
    await this.expandAllReplies();
  }

  async scrollCommentAreaByWheel() {
    try {
      const box = await this.findCommentContainerBox();
      if (box) {
        await this.page.mouse.move(box.x + box.width / 2, Math.min(box.y + box.height / 2, 700));
      } else {
        await this.page.mouse.move(1400, 500);
      }
      await this.page.mouse.wheel(0, 900 + Math.floor(Math.random() * 500));
    } catch (e) { /* ignore */ }
    await sleep(600 + Math.floor(Math.random() * 500));
  }

  async findCommentContainerBox() {
    return this.page.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll('div'))
        .filter((el) => el.querySelectorAll('[data-e2e="comment-item"]').length > 0
          || el.querySelectorAll('[data-e2e*="comment"]').length > 3);
      if (!candidates.length) return null;
      const el = candidates[candidates.length - 1];
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    }).catch(() => null);
  }

  /** 等"评论进度"：新增评论或新的分页响应，二者出现其一即返回 */
  async waitCommentProgress(maxMs, beforeCount) {
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
      if (this.comments.size > beforeCount) return true;
      await sleep(300);
    }
    return false;
  }

  async expandAllReplies() {
    this.log('  [回复] 展开全部可访问回复...');
    const MAX_PASSES = 30;
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      // 找所有"展开 N 条回复 / 展开更多回复"按钮并逐个点击
      const clicked = await this.page.evaluate(() => {
        const texts = ['展开', '展开更多'];
        let n = 0;
        const els = Array.from(document.querySelectorAll('[data-e2e="comment-reply"], span, div, p'))
          .filter((el) => el.children.length === 0 && el.textContent
            && /展开\s*\d*\s*条?回复|展开更多/.test(el.textContent.trim())
            && el.textContent.trim().length < 20);
        for (const el of els.slice(0, 8)) {
          try { el.click(); n++; } catch (e) { /* */ }
        }
        return n;
      }).catch(() => 0);

      if (!clicked) {
        // 也可能还有未采满的回复（接口预期 > 已采），再滚一屏
        const incomplete = Array.from(this.replyMeta.values())
          .filter((m) => m.expected > 0 && (m.collected < Math.min(m.expected, 3))).length;
        const totalExpected = Array.from(this.replyMeta.values()).reduce((s, m) => s + m.expected, 0);
        const totalCollected = this.replies.size;
        if (totalCollected >= totalExpected || incomplete === 0) {
          this.log(`  [回复] 没有更多可展开的回复按钮，结束（按钮点击通道）`);
          break;
        }
        await this.scrollCommentAreaByWheel();
        await sleep(1500);
        continue;
      }
      // 等回复响应落地
      const before = this.replies.size;
      await this.waitReplyProgress(5000, before);
      this.log(`  [回复] pass ${pass + 1}: 点击 ${clicked} 个按钮，回复累计 ${this.replies.size}`);
    }
  }

  async waitReplyProgress(maxMs, beforeCount) {
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
      if (this.replies.size > beforeCount) return true;
      await sleep(300);
    }
    return false;
  }

  // ---------------- 大家都在搜 ----------------
  async scrapeEveryoneSearch() {
    try {
      const kws = await this.page.evaluate(() => {
        const out = [];
        // 定位包含"大家都在搜"文案的容器，收集其内的关键词链接
        const all = Array.from(document.querySelectorAll('div, section, aside'));
        const host = all.find((el) => {
          const head = el.querySelector(':scope > div, :scope > h3, :scope > header');
          return head && /大家都在搜/.test(head.textContent) && head.textContent.length < 30;
        });
        if (host) {
          host.querySelectorAll('a, span, p').forEach((el) => {
            const t = el.textContent.trim();
            if (t && t.length <= 30 && !/大家都在搜/.test(t) && !out.includes(t)) out.push(t);
          });
        } else {
          // 兜底：页面上出现"大家都在搜"字样的兄弟节点
          document.querySelectorAll('[data-e2e*="search"]').forEach((el) => {
            const t = el.textContent.trim();
            if (t && t.length <= 30) out.push(t);
          });
        }
        return out.slice(0, 20);
      });
      this.searchKeywords = kws;
      this.log(`  [搜索] 大家都在搜：${kws.length ? kws.join(' | ') : '未在页面找到（记 PARTIAL）'}`);
      if (!kws.length) this.addError('search', 'NOT_FOUND', '页面未找到"大家都在搜"容器（可能已下线或未加载）');
    } catch (e) {
      this.addError('search', 'SCRAPE_FAIL', e.message);
    }
  }

  // ---------------- 视频下载 ----------------
  async downloadVideo() {
    try {
      const urls = this.detail?.video?.play_addr?.url_list || this.detail?.video?.download_addr?.url_list || [];
      if (!urls.length) {
        this.addError('video_download', 'NO_URL', '详情中无 play_addr.url_list');
        return false;
      }
      for (const u of urls) {
        try {
          const res = await this.context.request.get(u, {
            headers: { referer: 'https://www.douyin.com/', 'user-agent': this._ua || undefined },
          });
          if (!res.ok()) continue;
          const buf = await res.body();
          if (buf.length < 10000) continue; // 太小多半是风控页
          const p = path.join(this.outDir, 'video.mp4');
          fs.writeFileSync(p, buf);
          this.log(`  [视频] 已下载 ${(buf.length / 1048576).toFixed(1)} MB → ${p}`);
          return true;
        } catch (e) { /* try next */ }
      }
      this.addError('video_download', 'DOWNLOAD_FAIL', '所有 url_list 地址均下载失败');
      return false;
    } catch (e) {
      this.addError('video_download', 'ERROR', e.message);
      return false;
    }
  }

  // ---------------- 落盘 ----------------
  buildData() {
    const d = this.detail || {};
    const stats = d.statistics || {};
    const top = Array.from(this.comments.values());
    const reps = Array.from(this.replies.values());
    const hashtags = (d.text_extra || [])
      .filter((t) => t.hashtag_name)
      .map((t) => t.hashtag_name);
    const partialComment = this.commentHasMore !== 0;
    return {
      task: {
        video_url: this.opts.url,
        video_id: this.videoId,
        analysis_mode: 'public_competitor',
        run_id: this.runId,
        collected_at: nowIso(),
        user_context: this.opts.userContext || null,
      },
      login: {
        required: true,
        status: this._loggedIn ? 'LOGGED_IN' : 'UNKNOWN',
        verified_at: this._loginVerifiedAt || null,
      },
      video: {
        video_id: this.videoId,
        title: d.desc || this._pageFallback?.title || null,
        hashtags,
        duration: d.video?.duration ? d.video.duration / 1000 : null, // ms → s
        publish_time: d.create_time ? new Date(d.create_time * 1000).toISOString() : null,
        author: d.author ? { nickname: d.author.nickname, sec_uid: d.author.sec_uid } : null,
      },
      metrics: {
        likes: stats.digg_count ?? null,
        comments: stats.comment_count ?? null,
        favorites: stats.collect_count ?? null,
        shares: stats.share_count ?? null,
        source: d._source === 'RENDER_DATA_FALLBACK' ? 'VIDEO_PAGE_RENDER_DATA' : 'VIDEO_PAGE_API',
      },
      media: {
        visual_accessible: !!this._videoDownloaded,
        audio_accessible: !!this._videoDownloaded,
        video_file: this._videoDownloaded ? 'video.mp4' : null,
        frame_rate_analysis: 10,
        frames_count: 0, // 抽帧脚本回填
      },
      transcript: [],  // ASR：V0.2 如实留空
      ocr: [],         // OCR：关键帧多模态分析时由 agent 补
      shots: [],
      comments: {
        top_level: top,
        replies: reps,
        total_top_level: top.length,
        total_replies: reps.length,
        total_nodes: top.length + reps.length,
        api_total_including_nested: this.commentTotal, // 含楼中楼，不能当分母（口径红线）
        collection_status: partialComment ? 'PARTIAL' : 'COMPLETE',
        partial_reason: partialComment ? 'has_more 未归零/滚动无新增，未遍历到接口声明的全部评论' : null,
        expected_reply_summary: Array.from(this.replyMeta.entries())
          .filter(([, m]) => m.expected > 0)
          .map(([cid, m]) => ({ comment_id: cid, expected: m.expected, collected: m.collected }))
          .slice(0, 50),
      },
      search: {
        keywords: this.searchKeywords,
        collection_status: this.searchKeywords.length ? 'COMPLETE' : 'PARTIAL',
      },
      collection: {
        coverage: {
          video_page: this.detail ? 1 : (this._pageFallback ? 0.5 : 0),
          video_visual: this._videoDownloaded ? 1 : 0,
          audio: this._videoDownloaded ? 0 : 0, // 下载了文件但未做 ASR
          ocr: 0,
          comments: partialComment ? 0 : 1,
          replies: null,
          search: this.searchKeywords.length ? 1 : 0,
          user_backend: null, // 未提供
        },
        errors: this.errors,
      },
    };
  }

  save() {
    const data = this.buildData();
    const p = path.join(this.outDir, 'data.json');
    fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
    this.log(`\n[产出] ${p}`);
    this.log(`  顶层评论 ${data.comments.total_top_level} | 回复 ${data.comments.total_replies} | 状态 ${data.comments.collection_status}`);
    this.log(`  大家都在搜 ${data.search.keywords.length} 条 | 视频文件 ${data.media.video_file || '无'}`);
    if (this.errors.length) this.log(`  ⚠ ${this.errors.length} 条采集异常已记录在 collection.errors`);
    return p;
  }

  // ---------------- 主流程 ----------------
  async run() {
    this.log('==============================================');
    this.log(' 抖音单视频采集器 MVP（douyin-video-analysis V0.2）');
    this.log(' 原则：只采公开信息 / 不编造 / 采集与分析分离');
    this.log('==============================================');
    this.log(`  产物目录: ${this.outDir}`);

    await this.launch();
    try {
      // Stage 01 登录（强制）
      let loggedIn = await this.isLoggedIn();
      if (!loggedIn) {
        this.log('[登录] 未登录。访客态评论会被限流，不允许访客态出数。');
        loggedIn = await this.waitForManualLogin();
        if (!loggedIn) {
          this.addError('login', 'LOGIN_REQUIRED', '等待登录超时，未进行采集');
          this._loggedIn = false;
          this.save();
          return 1;
        }
      }
      this._loggedIn = true;
      this._loginVerifiedAt = nowIso();
      this.log('[登录] ✓ 已确认登录态，开始采集\n');

      // Stage 02 视频页
      await this.openVideoPage();
      if (!this.detail) {
        this._pageFallback = await this.scrapePageFallback();
        this.log('  ⚠ detail 接口未捕获，使用 DOM 兜底（字段可能不全）');
      }

      // Stage 06 全量评论
      await this.collectAllComments();

      // Stage 07 大家都在搜
      await this.scrapeEveryoneSearch();

      // Stage 03 视频文件
      this._videoDownloaded = await this.downloadVideo();

      // 落盘
      this.save();
      return 0;
    } finally {
      await this.close();
    }
  }
}

// ------------------------------------------------------------
async function main() {
  const { flags, url } = parseArgs(process.argv);
  const videoUrl = url || flags.url || null;
  if (!videoUrl && !flags.login) {
    console.error('用法: node collect.js --url=https://www.douyin.com/video/xxxx [--out=目录] [--headless] [--login]');
    process.exit(1);
  }

  let finalUrl = videoUrl;
  let videoId = null;
  if (videoUrl) {
    finalUrl = await resolveShortLink(videoUrl);
    videoId = extractVideoId(finalUrl);
    if (!videoId) {
      console.error(`无法从 URL 提取视频 id: ${videoUrl}`);
      process.exit(1);
    }
  }

  const c = new VideoCollector({
    url: finalUrl,
    videoId,
    headless: !!flags.headless,
    out: flags.out || null,
  });
  const code = await c.run();
  process.exit(code);
}

main().catch((e) => {
  console.error('采集器异常:', e);
  process.exit(1);
});
