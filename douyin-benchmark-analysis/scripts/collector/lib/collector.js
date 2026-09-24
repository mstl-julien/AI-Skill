'use strict';

/**
 * collector.js（核心）—— 抖音公开数据采集器 V0.1
 *
 * 架构（已与 90 确认）：
 *   触发侧 = 自动化驱动（滚动 / 点击 / 等待）
 *   取数侧 = 被动监听浏览器自身发出的 XHR 响应
 *
 * 红线（务必不要改）：
 *   1. 只监听，绝不 replay。不截获签名、不自己拼 URL 调接口。
 *   2. 所有数据走 extract.js 的白名单闸门，超纲字段丢弃并留审计。
 *   3. 不推测：页面没有的，就是 NOT_VISIBLE / UNAVAILABLE。
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const {
  STATUS,
  ERROR_TYPE,
  API_PATTERN,
  API_WATCH_LIST,
  WHITELIST,
  DEFAULTS,
  DEFAULT_SAMPLING,
  DEFAULT_COMMENT_SAMPLING,
} = require('./spec');

const E = require('./extract');

/**
 * 检测系统默认浏览器（90 于 2026-09-23 定：启动浏览器时采用默认浏览器）。
 *
 * 只在默认浏览器是 Chromium 系（Edge/Chrome）时返回对应 channel；
 * Firefox/Safari 等非 Chromium 内核 Playwright 无法驱动（CDP 不通用），返回 null 走通用回退链。
 *
 * 实现：
 *   Windows: 注册表 HKCU\...\UrlAssociations\https\UserChoice 的 ProgId（MSEdgeHTM 系 / ChromeHTML 系）
 *   Linux:   xdg-settings get default-web-browser（*.desktop 名含 edge/chrome）
 *   macOS:   Playwright 无系统级 channel 概念且读取 LaunchServices 需要额外解析，
 *            直接返回 null 走 Edge→Chrome→Chromium 回退链（macOS 自带 Edge 无、Chrome 需自装，
 *            内置 Chromium 兜底，不影响可用性）
 */
function detectDefaultBrowserChannel() {
  const { spawnSync } = require('child_process');
  const run = (cmd, args) => {
    try {
      const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 5000, shell: process.platform === 'win32' });
      return r.status === 0 ? String(r.stdout || '') : '';
    } catch {
      return '';
    }
  };
  try {
    if (process.platform === 'win32') {
      const out = run(
        'reg',
        ['query', 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice', '/v', 'ProgId']
      );
      const m = out.match(/ProgId\s+REG_SZ\s+(\S+)/);
      if (!m) return null;
      const progId = m[1].toLowerCase();
      if (progId.startsWith('msedge')) return 'msedge';
      if (progId.startsWith('chrome')) return 'chrome';
      return null; // Firefox/Brave 等：Brave 无官方 channel，Firefox 内核不可驱动
    }
    if (process.platform === 'linux') {
      const out = run('xdg-settings', ['get', 'default-web-browser']).toLowerCase();
      if (out.includes('microsoft-edge') || out.includes('edge')) return 'msedge';
      if (out.includes('google-chrome') || out.includes('chrome')) return 'chrome';
      return null; // chromium.desktop / firefox 等：chromium 走内置，firefox 不可驱动
    }
  } catch {
    /* 检测失败不阻塞启动 */
  }
  return null;
}

// ------------------------------------------------------------
// 小工具
// ------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function randDelay([min, max]) {
  return Math.floor(min + Math.random() * (max - min));
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

function nowIso() {
  return new Date().toISOString();
}

/** 把一串对象里出现过的字段名收集起来，用于生成"字段覆盖度"统计 */
function coverageOf(rows, fields) {
  const total = rows.length;
  const out = {};
  for (const f of fields) {
    if (!f.startsWith('hashtags') && !f.startsWith('search_keywords')) continue;
  }
  for (const f of fields) {
    const ok = rows.filter((r) => {
      if (!r.field_status) return false;
      const s = r.field_status[f];
      return s === STATUS.AVAILABLE;
    }).length;
    out[f] = { available: ok, total, ok: total > 0 && ok === total };
  }
  return out;
}

// ------------------------------------------------------------
// 采集器
// ------------------------------------------------------------

class DouyinCollector {
  constructor(opts = {}) {
    this.opts = {
      ...DEFAULTS,
      ...opts,
    };

    this.rootDir = path.resolve(__dirname, '..');
    this.profileDir = path.join(this.rootDir, 'browser-profile');
    this.runId = opts.runId || new Date().toISOString().replace(/[:.]/g, '-');
    this.dataDir = ensureDir(path.join(this.rootDir, 'data', this.runId));

    // ---- 采集结果容器 ----
    this.account = null;
    this.contentStructure = null;
    this.videosMap = new Map(); // video_id → video
    this.videoOrder = []; // 保持主页返回顺序
    this.postMeta = { has_more: null, max_cursor: null, page_count: 0, cursors: [] };
    this.videoDetails = new Map(); // video_id → detail
    this.comments = []; // 扁平评论数组
    this.commentsByVideo = new Map();

    // ---- 审计 ----
    this.log = {
      run_id: this.runId,
      input_url: this.opts.url || null,
      options: {
        max_videos: this.opts.maxVideos,
        detail_limit: this.opts.detailLimit,
        headless: !!this.opts.headless,
        comment_range: [this.opts.commentMin, this.opts.commentMax],
      },
      started_at: nowIso(),
      finished_at: null,
      status: 'RUNNING',
      errors: [],
      dropped_fields: [], // 合规审计：接口给了但白名单不要的
      api_seen: {}, // 侦测到的接口调用次数
      not_watched_apis: {}, // 页面发了但我们没在听的接口
      stages: {},
    };

    // ---- 内部 ----
    this.context = null;
    this.page = null;
    this.waiters = []; // 等待特定接口响应的 promise
    this._inflight = 0; // 正在读取响应体的数量（用于消除导航竞态）
    this.stageTimes = {};

    // ---- 诊断开关（默认关闭，不影响正常采集）----
    // DEBUG_COMMENTS=1 时输出评论滚动的逐轮打点。
    // 起因：19 条视频里有 4 条评论只采到 5 条，容器/滚动/时序/展开点击四个假设
    // 都被独立探针推翻，只能回到生产流程里装仪表。
    this.debug = !!process.env.DEBUG_COMMENTS;

    // 关键：只统计"响应"无法区分[没发请求]与[发了被中止]。
    // 必须同时统计 request 侧，并从 URL 里解析 aweme_id / cursor，
    // 才能确认"滚动是否真的触发了分页请求"以及"请求属于哪条视频"。
    this.commentReq = []; // { at, aweme_id, cursor, count }
    this.commentRes = []; // { at, n, cursor, has_more, ok }
  }

  /** 从评论接口 URL 里取出 aweme_id / cursor / count —— 判断请求归属与分页位置 */
  static parseCommentUrl(url) {
    try {
      const u = new URL(url);
      return {
        aweme_id: u.searchParams.get('aweme_id'),
        cursor: Number(u.searchParams.get('cursor')),
        count: Number(u.searchParams.get('count')),
      };
    } catch {
      return { aweme_id: null, cursor: null, count: null };
    }
  }

  /**
   * 等待在途的响应体读取完成。
   *
   * 解决什么问题：跳转到下一个视频时，上一条评论响应可能还在传输中，
   * 页面一导航，响应就被销毁，于是报
   *   "Protocol error (Network.getResponseBody): No resource with given identifier found"
   * 实测这个竞态会吞掉 2~5 次响应（约 10~25 条评论）。
   *
   * 上一版靠"导航前 sleep 800ms"糊，不稳定（同一账号两次运行 2 次 vs 5 次）。
   * 改为计数：读体前 +1，读完 -1，导航前等到 0。
   */
  async waitInflight(maxMs = 3000) {
    const t0 = Date.now();
    while (this._inflight > 0 && Date.now() - t0 < maxMs) {
      await sleep(120);
    }
    return this._inflight;
  }

  /**
   * 等一次"评论分页请求"真的发生并拿到响应。
   *
   * 为什么要替换固定 sleep：
   *   旧实现是滚完 sleep(900~1600ms) 就去数评论条数。若响应比 sleep 慢，
   *   条数没变 → 记为"空转"，连续 3 轮就判定"到底了"。
   *   而接口明明返回 has_more=1，于是静默少采（实测 4/19 条视频只采到 5 条）。
   *
   * 现在的语义：
   *   - 已发出分页请求 → 最多等 commentPageWaitMs 拿响应（不放弃）
   *   - 迟迟没发出请求 → 说明"这一滚没触发加载"，快速返回 false 让上层换策略
   *
   * 返回值：true=拿到新分页响应；false=没触发/超时。
   */
  async waitCommentPage(maxMs = this.opts.commentPageWaitMs) {
    const t0 = Date.now();
    const resStart = this.commentRes.length;
    const reqStart = this.commentReq.length;
    while (Date.now() - t0 < maxMs) {
      if (this.commentRes.length > resStart) return true;
      const requestFired = this.commentReq.length > reqStart;
      if (!requestFired && Date.now() - t0 > this.opts.commentPageProbeMs) {
        return false; // 压根没发出分页请求
      }
      await sleep(100);
    }
    return false;
  }

  /**
   * 兜底滚动：鼠标真实滚轮悬停在评论区上。
   *
   * 为什么需要它：抖音的懒加载同时挂在 scroll 事件与 IntersectionObserver 上。
   * 直接写 scrollTop 在多数情况下有效，但在少数页面状态下不触发。
   * 滚轮是"最接近真人"的输入，作为升级策略。
   */
  async scrollCommentAreaByWheel() {
    const box = await this.page.evaluate(() => {
      const isScrollable = (el) => {
        const st = getComputedStyle(el);
        if (!(st.overflowY === 'auto' || st.overflowY === 'scroll')) return false;
        if (el.scrollHeight <= el.clientHeight + 80) return false;
        return el.clientHeight >= 150;
      };
      const all = [];
      for (const el of document.querySelectorAll('div')) if (isScrollable(el)) all.push(el);
      const withC = all.filter((el) => el.querySelectorAll('[data-e2e*="comment"]').length > 0);
      // 兜底时选"最内层"的候选（深度最大），而不是最外层的大包裹
      const pool = withC.length ? withC : all;
      const depth = (el) => {
        let d = 0;
        let p = el.parentElement;
        while (p) {
          d += 1;
          p = p.parentElement;
        }
        return d;
      };
      pool.sort((a, b) => depth(b) - depth(a) || b.scrollHeight - a.scrollHeight);
      const t = pool[0];
      if (!t) return null;
      const r = t.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + Math.min(r.height / 2, 300)) };
    });
    if (!box) return false;
    await this.page.mouse.move(box.x, box.y);
    await this.page.mouse.wheel(0, 700);
    return true;
  }

  // ==========================================================
  // 日志
  // ==========================================================

  addError(stage, errorType, message, extra = {}) {
    this.log.errors.push({
      stage,
      error_type: errorType,
      message,
      timestamp: nowIso(),
      ...extra,
    });
    console.error(`  [ERR][${stage}][${errorType}] ${message}`);
  }

  addDropped(stage, ref, dropped, compliance) {
    if (dropped.length || compliance.length) {
      this.log.dropped_fields.push({
        stage,
        ref,
        unknown_dropped_count: dropped.length,
        unknown_dropped: dropped.slice(0, 60), // 留样本即可，避免日志爆掉
        compliance_dropped: compliance,
        timestamp: nowIso(),
      });
    }
  }

  markStage(name, status, note) {
    this.stageTimes[name] = nowIso();
    this.log.stages[name] = { status, at: this.stageTimes[name], note: note || null };
  }

  // ==========================================================
  // 浏览器会话
  // ==========================================================

  async launch() {
    ensureDir(this.profileDir);

    const launchArgs = [
      '--disable-blink-features=AutomationControlled',
      '--start-maximized',
    ];

    // 启动优先级（90 于 2026-09-23 定：优先用系统默认浏览器）：
    //   1) 系统默认浏览器 —— 仅当它是 Playwright 能驱动的 Chromium 系（Edge/Chrome）时生效；
    //      默认浏览器是 Firefox/Safari 等非 Chromium 内核时无法自动化，回退到通用链
    //   2) 通用链：本机 Edge > 本机 Chrome > Playwright 内置 Chromium
    const defaultChannel = detectDefaultBrowserChannel();
    if (defaultChannel) {
      console.log(`  检测到系统默认浏览器: ${defaultChannel === 'msedge' ? 'Edge' : 'Chrome'} → 优先使用`);
    }
    const preferred = ['msedge', 'chrome'];
    const channels = defaultChannel
      ? [defaultChannel, ...preferred.filter((c) => c !== defaultChannel), null]
      : [...preferred, null];
    let lastErr = null;

    for (const channel of channels) {
      try {
        console.log(`  尝试启动浏览器: ${channel || 'bundled-chromium'}`);
        this.context = await chromium.launchPersistentContext(this.profileDir, {
          channel: channel || undefined,
          headless: !!this.opts.headless,
          viewport: null, // 跟随窗口，避免被指纹识别
          args: launchArgs,
          locale: 'zh-CN',
          timezoneId: 'Asia/Shanghai',
          ignoreDefaultArgs: ['--enable-automation'],
        });
        console.log(`  浏览器已启动: ${channel || 'bundled-chromium'}`);
        break;
      } catch (e) {
        lastErr = e;
        console.log(`  启动失败(${channel || 'chromium'}): ${String(e.message).split('\n')[0]}`);
      }
    }

    if (!this.context) throw lastErr || new Error('无法启动任何浏览器');

    this.context.setDefaultTimeout(this.opts.pageTimeoutMs);
    const pages = this.context.pages();
    this.page = pages.length ? pages[0] : await this.context.newPage();
    this.attachInterceptors();
    return this.context;
  }

  /**
   * 被动监听层 —— 本项目的技术核心。
   * 只读浏览器自己发出的请求响应，不修改、不重放。
   */
  attachInterceptors() {
    // ---- 请求侧计数（诊断用）----
    // 响应侧统计不到"发了但被中止"的请求，会导致误判"滚动没触发请求"。
    this.page.on('request', (req) => {
      let url;
      try {
        url = req.url();
      } catch {
        return;
      }
      if (!url.includes('/aweme/v1/web/comment/list/')) return;
      const p = DouyinCollector.parseCommentUrl(url);
      this.commentReq.push({ at: Date.now(), ...p });
    });

    this.page.on('response', async (res) => {
      let url;
      try {
        url = res.url();
      } catch {
        return;
      }
      const kind = this.matchApi(url);
      if (!kind) {
        for (const w of API_WATCH_LIST) {
          if (url.includes(w)) {
            this.log.not_watched_apis[w] = (this.log.not_watched_apis[w] || 0) + 1;
            return;
          }
        }
        return;
      }

      this.log.api_seen[kind] = (this.log.api_seen[kind] || 0) + 1;

      if (res.status() !== 200) {
        this.resumeWaiters(kind, null);
        this.addError(kind, res.status() === 429 ? ERROR_TYPE.RATE_LIMIT : ERROR_TYPE.NETWORK_ERROR, `接口非 200: ${res.status()}`, { url });
        return;
      }

      let json = null;
      this._inflight += 1;
      try {
        json = await res.json();
      } catch (e) {
        this.resumeWaiters(kind, null);
        this.addError(kind, ERROR_TYPE.DATA_NOT_VISIBLE, `响应体非 JSON 或已被丢弃: ${String(e.message).split('\n')[0]}`, { url });
        if (kind === 'COMMENT_LIST') {
          this.commentRes.push({ at: Date.now(), ok: false, err: 'body-lost' });
        }
        return;
      } finally {
        this._inflight -= 1;
      }

      if (kind === 'COMMENT_LIST') {
        this.commentRes.push({
          at: Date.now(),
          ok: true,
          n: (json.comments || []).length,
          cursor: json.cursor,
          has_more: json.has_more,
        });
      }

      try {
        this.consume(kind, json, url);
      } catch (e) {
        this.addError(kind, ERROR_TYPE.UNKNOWN, `解析响应异常: ${e.message}`, { url });
      }
      this.resumeWaiters(kind, json);
    });

    // 页面自身 JS 报错（React minified error 之类）属于噪音：
    // 抖音自己页面就一直在报。单独归档，不污染失败项统计。
    this.pageErrors = [];
    this.page.on('pageerror', (e) => {
      if (this.pageErrors.length >= 50) return;
      this.pageErrors.push({
        message: String(e && e.message ? e.message : e).slice(0, 200),
        timestamp: nowIso(),
      });
    });
  }

  matchApi(url) {
    for (const [kind, frag] of Object.entries(API_PATTERN)) {
      if (url.includes(frag)) return kind;
    }
    return null;
  }

  waitForApi(kind, timeoutMs = 20000) {
    return new Promise((resolve) => {
      const w = { kind, resolve, done: false };
      this.waiters.push(w);
      setTimeout(() => {
        if (!w.done) {
          w.done = true;
          this.waiters = this.waiters.filter((x) => x !== w);
          resolve(null);
        }
      }, timeoutMs);
    });
  }

  resumeWaiters(kind, payload) {
    for (const w of this.waiters) {
      if (!w.done && w.kind === kind) {
        w.done = true;
        w.resolve(payload);
      }
    }
    this.waiters = this.waiters.filter((w) => !w.done);
  }

  // ==========================================================
  // 响应消费 —— 全部经白名单闸门
  // ==========================================================

  consume(kind, json, url) {
    switch (kind) {
      case 'USER_PROFILE':
        return this.consumeProfile(json);
      case 'AWEME_POST':
        return this.consumePost(json);
      case 'AWEME_DETAIL':
        return this.consumeDetail(json);
      case 'COMMENT_LIST':
        return this.consumeComments(json);
      case 'SUGGEST_WORDS':
        return this.consumeSuggestWords(json);
      default:
        return undefined;
    }
  }

  consumeSuggestWords(json) {
    const words = E.extractSearchBoxSuggestions(json);
    if (!words.length) return;
    if (!this.searchBoxSuggestions) this.searchBoxSuggestions = [];
    for (const w of words) if (!this.searchBoxSuggestions.includes(w)) this.searchBoxSuggestions.push(w);
    console.log(`      搜索框推荐词: ${words.join(' / ')}`);
  }

  consumeProfile(json) {
    const user = json.user || json.data?.user;
    if (!user) {
      this.addError('account_homepage', ERROR_TYPE.DATA_NOT_VISIBLE, 'user/profile 响应中无 user 节点', { url: json.__url });
      return;
    }
    const account = E.extractAccount(user, this.opts.url);
    this.account = account;
    const { dropped, compliance } = E.auditDropped(user, WHITELIST.account, E.CONSUMED_SOURCE_KEYS.user);
    this.addDropped('account_homepage', 'user', dropped, compliance);
  }

  consumePost(json) {
    const list = json.aweme_list || [];
    this.postMeta.page_count += 1;
    this.postMeta.has_more = json.has_more ?? this.postMeta.has_more;
    this.postMeta.max_cursor = json.max_cursor ?? this.postMeta.max_cursor;
    this.postMeta.cursors.push(json.max_cursor ?? null);

    let added = 0;
    this.postMeta.aweme_type_seen = this.postMeta.aweme_type_seen || {};
    for (const raw of list) {
      // 记录 aweme_type 分布，而不是盲目过滤 —— 避免"静默丢数据"
      const t = raw.aweme_type == null ? 'null' : String(raw.aweme_type);
      this.postMeta.aweme_type_seen[t] = (this.postMeta.aweme_type_seen[t] || 0) + 1;

      if (!raw.aweme_id) continue;
      if (this.videosMap.has(raw.aweme_id)) continue;

      const v = E.extractVideo(raw);
      v.homepage_collected_at = nowIso();
      v.source = { source_type: 'api', source_page: 'account_homepage' };
      this.videosMap.set(v.video_id, v);
      this.videoOrder.push(v.video_id);
      added += 1;

      if (!this._postAudited) {
        const { dropped, compliance } = E.auditDropped(raw, WHITELIST.video, E.CONSUMED_SOURCE_KEYS.aweme);
        this.addDropped('works_list', `aweme:${raw.aweme_id}`, dropped, compliance);
        this._postAudited = true;
      }
    }
    if (added > 0) {
      console.log(`    +${added} 条 (累计 ${this.videosMap.size}) has_more=${this.postMeta.has_more}`);
    }
  }

  consumeDetail(json) {
    const aweme = json.aweme_detail;
    if (!aweme) {
      this.addError('video_detail', ERROR_TYPE.DATA_NOT_VISIBLE, 'aweme/detail 响应中无 aweme_detail', {});
      return;
    }
    const d = E.extractVideoDetail(aweme);
    d.detail_data_accessible = true;
    d.collected_at = nowIso();
    d.source = { source_type: 'api', source_page: 'video_detail' };
    this.videoDetails.set(d.video_id, d);

    if (!this._detailAudited) {
      const { dropped, compliance } = E.auditDropped(aweme, WHITELIST.videoDetail, E.CONSUMED_SOURCE_KEYS.aweme);
      this.addDropped('video_detail', `aweme:${aweme.aweme_id}`, dropped, compliance);
      this._detailAudited = true;
    }
  }

  consumeComments(json) {
    const list = json.comments || [];
    const vid = this.currentVideoId || null;

    // 记录接口声称的评论总量 —— 这是"评论覆盖率"的分母。
    // 没有它，报告只能写"采到 N 条"，无法回答"到底采全了没有"。
    if (typeof json.total === 'number') {
      this.commentTotals = this.commentTotals || {};
      const prev = this.commentTotals[vid];
      if (prev === undefined || json.total > prev) this.commentTotals[vid] = json.total;
    }

    // 记录 has_more / cursor —— 用于诚实性检查与"续采"能力。
    // 只看"连续 N 轮没新增"就判定到底，在接口明说 has_more=1 时会谎报完成。
    this.commentHasMore = this.commentHasMore || {};
    this.commentCursor = this.commentCursor || {};
    if (typeof json.has_more === 'number') this.commentHasMore[vid] = json.has_more;
    if (typeof json.cursor === 'number') this.commentCursor[vid] = json.cursor;

    let added = 0;
    for (const raw of list) {
      const c = E.extractComment(raw, vid);
      if (!c.comment_id) continue;
      const key = c.comment_id;
      if (this._seenComments && this._seenComments.has(key)) continue;
      this._seenComments.add(key);
      c.source = { source_type: 'api', source_page: 'comment_area' };
      c.collected_at = nowIso();
      this.comments.push(c);
      if (vid) {
        if (!this.commentsByVideo.has(vid)) this.commentsByVideo.set(vid, []);
        this.commentsByVideo.get(vid).push(c);
      }
      added += 1;
    }
    if (added > 0) console.log(`      评论 +${added} (本条累计 ${this.commentsByVideo.get(vid)?.length || 0})`);
  }

  // ==========================================================
  // Stage 00-A / B / C：主页
  // ==========================================================

  async openHomepage(url) {
    console.log(`\n[Stage 00-A] 打开账号主页: ${url}`);
    let lastErr = null;

    for (let attempt = 1; attempt <= this.opts.retryTimes; attempt += 1) {
      try {
        this._seenComments = new Set();
        const profileWait = this.waitForApi('USER_PROFILE', this.opts.pageTimeoutMs);
        await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.opts.pageTimeoutMs });
        await this.dismissOverlays();
        const prof = await profileWait;
        if (prof) {
          console.log('  已捕获 user/profile 响应');
        } else {
          this.addError('account_homepage', ERROR_TYPE.TIMEOUT, '未在超时内捕获 user/profile 接口响应，尝试从 DOM 兜底');
          await this.fallbackAccountFromDom(url);
        }
        await sleep(randDelay(this.opts.actionDelayMs));
        this.markStage('00A_account_homepage', 'OK');
        return true;
      } catch (e) {
        lastErr = e;
        const et = this.classifyError(e);
        this.addError('account_homepage', et, `第 ${attempt} 次打开主页失败: ${String(e.message).split('\n')[0]}`);
        if (et === ERROR_TYPE.LOGIN_REQUIRED || et === ERROR_TYPE.CAPTCHA) break;
        await sleep(1500 * attempt);
      }
    }

    this.markStage('00A_account_homepage', 'FAILED', String(lastErr?.message || ''));
    return false;
  }

  /**
   * DOM 兜底：只读页面已渲染文本。
   * 用它的唯一理由是"接口没捕获到"，数据口径仍然是页面可见信息。
   */
  async fallbackAccountFromDom(url) {
    console.log('  使用 DOM 兜底提取账号信息');
    const dom = await this.page.evaluate(() => {
      const t = (sel) => {
        const el = document.querySelector(sel);
        return el ? el.textContent.trim() : null;
      };
      return {
        bodyText: document.body ? document.body.innerText.slice(0, 6000) : '',
        nickname: t('h1') || t('[data-e2e="user-name"]'),
      };
    });
    const m = dom.bodyText.match(/抖音号[:：]\s*([A-Za-z0-9_.\-]+)/);
    const followers = dom.bodyText.match(/([\d.]+[万亿]?)\s*粉丝/);
    const likes = dom.bodyText.match(/([\d.]+[万亿]?)\s*获赞/);
    const following = dom.bodyText.match(/([\d.]+[万亿]?)\s*关注/);

    this.account = this.account || {
      url,
      nickname: dom.nickname || null,
      douyin_id: m ? m[1] : null,
      verification: null,
      avatar: null,
      following_count: following ? E.parseAbbrev(following[1]) : null,
      followers_count: followers ? E.parseAbbrev(followers[1]) : null,
      total_likes: likes ? E.parseAbbrev(likes[1]) : null,
      ip_location: (dom.bodyText.match(/IP属地[:：]\s*(\S+)/) || [])[1] || null,
      profile_age: null,
      bio: null,
      identity_text: null,
      field_status: {},
      source: { source_type: 'dom_fallback', source_page: 'account_homepage' },
    };
    for (const k of WHITELIST.account) {
      if (!this.account.field_status[k]) {
        this.account.field_status[k] = this.account[k] ? STATUS.AVAILABLE : STATUS.UNAVAILABLE;
      }
    }
  }

  /** 关闭登录弹窗 / 引导浮层，避免挡住滚动 */
  async dismissOverlays() {
    for (const key of ['Escape']) {
      try {
        await this.page.keyboard.press(key);
        await sleep(200);
      } catch {
        /* ignore */
      }
    }
    try {
      const closers = await this.page.$$('[aria-label="关闭"], .dy-account-close, [data-e2e="close-modal"]');
      for (const c of closers.slice(0, 3)) await c.click({ timeout: 1500 }).catch(() => {});
    } catch {
      /* ignore */
    }
  }

  // ==========================================================
  // Stage 00-B：内容结构
  // ==========================================================

  async collectContentStructure() {
    console.log('\n[Stage 00-B] 采集内容结构（tab 入口）');
    const s = await this.page.evaluate(() => {
      const txt = document.body ? document.body.innerText : '';
      const has = (w) => txt.includes(w);
      const numMatch = txt.match(/作品\s*([\d.]+[万亿]?)/) || txt.match(/作品\s*·\s*([\d.]+[万亿]?)/);
      return {
        works_tab: has('作品'),
        recommend_tab: has('推荐'),
        liked_tab: has('喜欢'),
        collections_tab: has('合集'),
        short_drama_tab: has('短剧'),
        works_count_text: numMatch ? numMatch[1] : null,
        // 年龄：只抄页面显示的，不推测（Spec §5.3）
        age_text: (txt.match(/(\d{1,3})\s*岁/) || [])[1] || null,
      };
    });

    this.contentStructure = {
      works_tab: s.works_tab,
      recommend_tab: s.recommend_tab,
      liked_tab: s.liked_tab,
      collections_tab: s.collections_tab,
      short_drama_tab: s.short_drama_tab,
      works_count: s.works_count_text ? E.parseAbbrev(s.works_count_text) : null,
    };

    if (this.account) {
      if (s.age_text) {
        this.account.profile_age = Number(s.age_text);
        this.account.field_status.profile_age = STATUS.AVAILABLE;
      } else {
        this.account.profile_age = null;
        this.account.field_status.profile_age = STATUS.NOT_VISIBLE;
      }
    }
    console.log('  ', JSON.stringify(this.contentStructure));
    this.markStage('00B_content_structure', 'OK');
  }

  // ==========================================================
  // Stage 00-C：作品列表滚动
  // ==========================================================

  /**
   * 深度滚动 —— 实测教训（2026-09-22）：
   * 抖音用户主页的作品列表**不在 window 上滚动**，而在一个内部可滚动容器里。
   * 只调 window.scrollTo 会导致：滚了 3 轮一条新的都没加载，但接口 has_more=1，
   * 也就是"静默漏数据"。
   *
   * 这里的策略是"全部滚一遍"：最大可滚动容器 + documentElement + body。
   * 宁可多滚，不可漏滚。
   */
  async scrollPageDeep() {
    // ---- 第一步：发真实滚轮事件 ----
    // 实测教训：抖音的懒加载挂在 wheel/scroll 事件 + IntersectionObserver 上。
    // 上一版只设置 scrollTop（container/window 都试了），结果接口 has_more=1
    // 但一条新的都没加载 —— 静默漏数据。改用真实滚轮事件。
    let vp = { width: 1280, height: 800 };
    try {
      vp = await this.page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    } catch {
      /* ignore */
    }
    try {
      await this.page.mouse.move(Math.round(vp.width / 2), Math.round(vp.height / 2));
      for (let i = 0; i < 4; i += 1) {
        await this.page.mouse.wheel(0, 900);
        await sleep(200);
      }
    } catch {
      /* ignore */
    }

    // ---- 第二步：程序化滚动兜底 ----
    const probe = await this.page.evaluate(() => {
      const result = { container: null };
      const cands = [];
      for (const el of document.querySelectorAll('div, main, section, ul')) {
        const st = getComputedStyle(el);
        if (!(st.overflowY === 'auto' || st.overflowY === 'scroll')) continue;
        if (el.scrollHeight <= el.clientHeight + 80) continue;
        if (el.clientHeight < 200) continue;
        cands.push(el);
      }
      if (cands.length) {
        cands.sort((a, b) => b.scrollHeight - a.scrollHeight);
        const t = cands[0];
        t.scrollTop = t.scrollHeight;
        result.container = { scrollHeight: t.scrollHeight, clientHeight: t.clientHeight };
      }
      window.scrollTo(0, document.documentElement.scrollHeight);
      document.documentElement.scrollTop = document.documentElement.scrollHeight;
      if (document.body) document.body.scrollTop = document.body.scrollHeight;
      return result;
    });

    // ---- 第三步：侦测登录墙（这可能是分页卡住的真正原因）----
    probe.loginWall = await this.page.evaluate(() => {
      const t = document.body ? document.body.innerText : '';
      return /登录后查看|登录查看更多|登录后可查看|扫码登录|立即登录/.test(t);
    });
    return probe;
  }

  async collectWorksList() {
    // maxVideos=0（或 Infinity）= 全量模式：滚到接口 has_more=0 为止。
    // 全量模式必须同时放大轮次上限，否则 1283 条作品（约 72 页）会在 40 轮处被截断。
    const fullMode = this.opts.maxVideos === 0 || !isFinite(this.opts.maxVideos);
    const roundCap = fullMode ? Math.max(this.opts.maxScrollRounds, 3000) : this.opts.maxScrollRounds;
    console.log(
      `\n[Stage 00-C] 滚动采集作品列表${fullMode ? '（全量模式：滚到接口 has_more=0 为止）' : `（上限 ${this.opts.maxVideos} 条）`}`
    );
    let idleRounds = 0;
    let round = 0;
    let lastScroll = null;

    while (round < roundCap) {
      round += 1;
      const before = this.videosMap.size;

      lastScroll = await this.scrollPageDeep();
      await sleep(randDelay(this.opts.actionDelayMs));
      await this.dismissOverlays().catch(() => {});

      const after = this.videosMap.size;

      // 条件A/D：没有新增
      if (after === before) {
        idleRounds += 1;
        console.log(`  第 ${round} 轮无新增 (idle ${idleRounds}/${this.opts.scrollIdleRounds}) 滚动模式=${lastScroll.container ? 'container' : 'window'}`);
      } else {
        idleRounds = 0;
      }

      // 条件B：达到指定数量（全量模式跳过）
      if (!fullMode && after >= this.opts.maxVideos) {
        console.log(`  已达采集上限 ${this.opts.maxVideos}`);
        break;
      }
      // 条件A：连续空闲
      if (idleRounds >= this.opts.scrollIdleRounds) {
        if (lastScroll && lastScroll.loginWall) {
          console.log('  连续无新增，且页面出现登录墙 → 判定为访客态分页受阻');
        } else {
          console.log('  连续无新增，判定列表已到底');
        }
        break;
      }
      // 接口明确说没有了（被动监听的最大优势：不用猜）
      if (this.postMeta.has_more === 0 && after > 0) {
        console.log('  接口 has_more=0，列表确实到底');
        break;
      }
    }

    // ——— 关键诚实性检查 ———
    // 如果接口说 has_more=1 但我们没再拿到新数据，那就是"我们没采全"，不是"到底了"。
    // 必须显式记录，绝不能让下游误以为这就是全部作品。
    // 注意：不看已采数量大小 —— 大账号滚了 200 条后停下，同样要标记未采全。
    if (this.postMeta.has_more === 1 && idleRounds >= this.opts.scrollIdleRounds) {
      const wall = !!(lastScroll && lastScroll.loginWall);
      this.log.list_incomplete = {
        reason: wall ? 'GUEST_LOGIN_WALL_BLOCKS_PAGINATION' : 'SCROLL_DID_NOT_TRIGGER_PAGINATION',
        has_more_from_api: 1,
        collected: this.videosMap.size,
        works_count_on_page: this.contentStructure ? this.contentStructure.works_count : null,
        login_wall_detected: wall,
        last_scroll_probe: lastScroll,
        note: wall
          ? '页面出现登录墙，访客态无法继续加载后续分页。已采集数量并非该账号全部作品，需登录后重跑。'
          : '接口 has_more=1 表示仍有后续分页，但滚动未触发下一次加载。已采集数量并非该账号全部作品。',
      };
      this.addError(
        'works_list',
        wall ? ERROR_TYPE.LOGIN_REQUIRED : ERROR_TYPE.DATA_NOT_VISIBLE,
        `接口 has_more=1 但${wall ? '撞到登录墙，' : ''}滚动未触发分页，仅采到 ${this.videosMap.size} 条（页面显示共 ${this.contentStructure ? this.contentStructure.works_count : '?'} 条）`,
        { has_more: this.postMeta.has_more, login_wall: wall, scroll_probe: lastScroll }
      );
    }

    console.log(`  作品列表采集完成：${this.videosMap.size} 条，滚了 ${round} 轮`);
    console.log(`  接口分页：page_count=${this.postMeta.page_count}, has_more=${this.postMeta.has_more}`);
    console.log(`  aweme_type 分布：${JSON.stringify(this.postMeta.aweme_type_seen || {})}`);
    this.markStage('00C_works_list', this.videosMap.size > 0 ? 'OK' : 'FAILED', `${this.videosMap.size} 条`);
    return this.videosMap.size;
  }

  // ==========================================================
  // 选样计划（两段式采集：先出计划供确认，再续跑详情）
  // ==========================================================

  /**
   * 生成本次采集的代表视频选样计划。
   *
   * 为什么要独立出"计划"这一步（90 于 2026-09-23 定）：
   *   代表视频的入选标准和数量必须在真正进入详情采集**之前**让用户确认，
   *   而不是采完才让人发现"为什么采的是这几条"。
   *
   * 标准本身（Spec §10.2，代码实现见 lib/extract.js selectRepresentativeVideos）：
   *   分层依据是「点赞表现」，不出现任何播放量口径。
   *   五组：pinned(置顶全收) / high(点赞Top N) / mid(点赞中位区间) / low(低点赞尾部) / latest(最新N条)
   *   跨组去重顺序：pinned > high > latest > mid > low（先入为主）
   */
  buildSelectionPlan(detailLimit, sampling) {
    const videos = this.videoOrder.map((id) => this.videosMap.get(id)).filter(Boolean);
    const smp = sampling || { ...DEFAULT_SAMPLING };
    const sel = E.selectRepresentativeVideos(videos, smp);

    const fullMode = this.opts.maxVideos === 0 || !isFinite(this.opts.maxVideos);
    const worksComplete = this.postMeta.has_more === 0;
    const plan = {
      built_at: nowIso(),
      account: this.account
        ? { nickname: this.account.nickname, douyin_id: this.account.douyin_id, followers_count: this.account.followers_count }
        : null,
      works: {
        total_on_page: this.contentStructure ? this.contentStructure.works_count : null,
        collected: videos.length,
        full_mode: fullMode,
        api_has_more: this.postMeta.has_more,
        complete: worksComplete,
        note: worksComplete
          ? '作品列表已全量采集（接口 has_more=0）'
          : '作品列表未到列表尽头（接口 has_more=1），以下选样仅基于已采部分',
      },
      criteria: {
        basis: '点赞表现分层（不使用播放量等非公开口径）',
        groups: {
          pinned: `置顶作品全收（上限配置：${smp.pinned === Infinity ? '全部' : smp.pinned}）`,
          high: `点赞最高的 ${smp.high} 条`,
          latest: `最新发布的 ${smp.latest} 条（按主页默认时间倒序）`,
          mid: `点赞中位区间的 ${smp.mid} 条`,
          low: `点赞最低的 ${smp.low} 条（排除 0 赞异常项）`,
        },
        dedup_order: 'pinned > high > latest > mid > low',
        comment_sampling: `每条视频公开评论抽 ${DEFAULT_COMMENT_SAMPLING.minPerVideo}~${DEFAULT_COMMENT_SAMPLING.maxPerVideo} 条（按页面顺序，非全量）`,
      },
      bucket_summary_raw: sel.bucket_summary,
      dedup_removed: sel.dedup_removed,
      selected_count: sel.selected.length,
      detail_limit: detailLimit,
      preview: sel.selected.slice(0, Math.min(detailLimit || sel.selected.length, 60)).map((v, i) => ({
        order: i + 1,
        group: v.sample_group,
        video_id: v.video_id,
        likes: v.likes,
        is_pinned: !!v.is_pinned,
        title: (v.title || '').slice(0, 40),
      })),
    };
    return { plan, selection: sel };
  }

  /**
   * 从一次 --plan-only 运行的数据目录恢复作品列表状态，
   * 跳过主页/作品列表阶段，直接进入详情采集。
   * 这样"确认选样计划"与"执行详情采集"可以分两次运行。
   */
  restoreFromDataDir(dataDir) {
    const abs = path.resolve(dataDir);
    const videos = JSON.parse(fs.readFileSync(path.join(abs, 'videos.json'), 'utf8'));
    let account = null;
    try {
      account = JSON.parse(fs.readFileSync(path.join(abs, 'account.json'), 'utf8'));
    } catch {
      /* account.json 缺失不阻塞恢复 */
    }

    this.videoOrder = [];
    this.videosMap = new Map();
    for (const v of videos) {
      if (!v.video_id || this.videosMap.has(v.video_id)) continue;
      this.videosMap.set(v.video_id, v);
      this.videoOrder.push(v.video_id);
    }
    if (account) {
      this.account = account;
      this.contentStructure = account.content_structure || null;
      if (account.homepage_meta) {
        this.postMeta.has_more = account.homepage_meta.has_more ?? null;
        this.postMeta.max_cursor = account.homepage_meta.max_cursor ?? null;
        this.postMeta.page_count = account.homepage_meta.post_api_page_count ?? 0;
      }
    }
    this.log.input_url = this.log.input_url || (account && account.url) || null;
    this.log.options.restored_from = abs;
    this.log.options.restored_works = this.videoOrder.length;
    console.log(`\n[恢复] 从 ${abs} 读入作品列表 ${this.videoOrder.length} 条（has_more=${this.postMeta.has_more}）`);
    return this.videoOrder.length;
  }

  /** 把选样计划落盘并打印成表格，供用户确认 */
  async presentSelectionPlan(detailLimit, sampling) {
    const { plan, selection } = this.buildSelectionPlan(detailLimit, sampling);
    const p = path.join(this.dataDir, 'selection_plan.json');
    fs.writeFileSync(p, JSON.stringify({ plan, selection: selection.selected.map((v) => ({ video_id: v.video_id, sample_group: v.sample_group, likes: v.likes, title: v.title })) }, null, 2), 'utf8');

    const b = plan.bucket_summary_raw;
    console.log('\n  ┌─ 选样计划（请确认后再进入详情采集）──────────────');
    console.log(`  │ 账号: ${plan.account ? `${plan.account.nickname}（${plan.account.douyin_id}）` : '未知'}`);
    console.log(`  │ 作品: 已采 ${plan.works.collected} / 主页显示 ${plan.works.total_on_page ?? '?'}  [${plan.works.note}]`);
    console.log(`  │ 标准: ${plan.criteria.basis}`);
    console.log(`  │   pinned=${b.pinned}  high=${b.high}  latest=${b.latest}  mid=${b.mid}  low=${b.low}  跨组去重移除 ${plan.dedup_removed}`);
    console.log(`  │ 去重后候选 ${plan.selected_count} 条，本轮拟采 ${plan.detail_limit} 条`);
    console.log(`  │ 评论: ${plan.criteria.comment_sampling}`);
    console.log('  └───────────────────────────────────────────');
    console.log('  序  分组     点赞      标题');
    for (const v of plan.preview) {
      console.log(`  ${String(v.order).padStart(3)}  ${v.group.padEnd(7)} ${String(v.likes).padStart(8)}  ${v.title}`);
    }
    console.log(`\n  计划已落盘: ${p}`);
    this.markStage('00D_selection_plan', 'OK', `候选 ${plan.selected_count} / 拟采 ${plan.detail_limit}`);
    return plan;
  }

  /**
   * 选出本轮要进入详情采集的代表视频。
   * 单段式与 --from-plan 续跑共用此入口，保证两边标准一致。
   */
  selectTargets(detailLimit, sampling) {
    const videos = this.videoOrder.map((id) => this.videosMap.get(id)).filter(Boolean);
    const sel = E.selectRepresentativeVideos(videos, sampling || { ...DEFAULT_SAMPLING });
    console.log('  分层:', JSON.stringify(sel.bucket_summary), `去重后 ${sel.selected.length} 条`);
    this.log.options.sampling = sampling || { ...DEFAULT_SAMPLING };
    return sel.selected.slice(0, detailLimit);
  }

  // ==========================================================
  // Stage 00-E/F/G：单视频
  // ==========================================================

  async collectVideoDetail(video) {
    const vid = video.video_id;
    const url = video.video_url;
    this.currentVideoId = vid;
    this._seenComments = new Set();
    this.searchBoxSuggestions = [];
    this.markStage(`00E_video_${vid}`, 'START');

    // 上一个视频的响应可能还在传输中。立刻跳走会导致响应体被销毁
    // （"Network.getResponseBody: No resource with given identifier found"）。
    // 先等在途读取归零，再留一点沉降时间。
    const stillInflight = await this.waitInflight(3000);
    if (stillInflight > 0) {
      this.log.inflight_timeout = (this.log.inflight_timeout || 0) + 1;
    }
    await sleep(300);

    const detail = {
      video_id: vid,
      // 选样分组随详情落盘 —— 报告要标注"这条为什么被选中"
      sample_group: video.sample_group || null,
      homepage_likes: typeof video.likes === 'number' ? video.likes : null,
      homepage_collected_at: video.homepage_collected_at || null,
      ...nullDetailStub(),
    };

    // ---- 重试打开 ----
    let opened = false;
    for (let attempt = 1; attempt <= this.opts.retryTimes; attempt += 1) {
      try {
        const detailWait = this.waitForApi('AWEME_DETAIL', 25000);
        await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.opts.pageTimeoutMs });
        const json = await detailWait;
        if (json) opened = true;

        // 页面状态判定（含等待视频就绪，见 probeVideoPageState）
        const probe = await this.probeVideoPageState();

        if (probe.captcha) {
          throw Object.assign(new Error('触发安全验证'), { __type: ERROR_TYPE.CAPTCHA });
        }
        if (probe.not_found) {
          throw Object.assign(new Error('视频不可访问'), { __type: ERROR_TYPE.PAGE_NOT_FOUND });
        }
        if (probe.need_login && !opened) {
          throw Object.assign(new Error('该视频需要登录后查看'), { __type: ERROR_TYPE.LOGIN_REQUIRED });
        }

        detail.video_accessible = true;
        detail.video_playable = probe.ready_state >= 2;
        detail.field_status = detail.field_status || {};
        detail.field_status.video_accessible = STATUS.AVAILABLE;
        detail.field_status.video_playable =
          detail.video_playable ? STATUS.AVAILABLE : STATUS.UNAVAILABLE;
        break;      } catch (e) {
        const et = e.__type || this.classifyError(e);
        this.addError('video_detail', et, `视频 ${vid} 第 ${attempt} 次打开失败: ${String(e.message).split('\n')[0]}`, { video_id: vid });
        if (et === ERROR_TYPE.LOGIN_REQUIRED || et === ERROR_TYPE.CAPTCHA || et === ERROR_TYPE.PAGE_NOT_FOUND) {
          detail.video_accessible = false;
          break;
        }
        await sleep(1200 * attempt);
      }
    }

    if (!opened) {
      detail.video_accessible = detail.video_accessible || false;
      detail.detail_data_accessible = false;
      detail.field_status = detail.field_status || {};
      detail.field_status.video_accessible = STATUS.FAILED;
      this.videoDetails.set(vid, detail);
      this.markStage(`00E_video_${vid}`, 'FAILED');
      return detail;
    }

    // ---- 合并接口数据 ----
    await sleep(randDelay(this.opts.actionDelayMs));
    const apiDetail = this.videoDetails.get(vid);
    if (apiDetail) {
      // 页面状态字段必须先存后并 —— Object.assign 会用接口对象里的 false 覆盖掉它
      const pageState = {
        video_accessible: detail.video_accessible,
        video_playable: detail.video_playable,
      };
      Object.assign(detail, apiDetail);
      detail.video_accessible = pageState.video_accessible;
      detail.video_playable = pageState.video_playable;
      detail.homepage_likes = video.likes ?? null; // 双写不覆盖（Spec §13）
      detail.homepage_collected_at = video.homepage_collected_at || null;
      detail.detail_likes = apiDetail.likes;
      detail.detail_collected_at = apiDetail.collected_at;
    }

    // ---- Stage 00-F：评论 ----
    await this.collectCommentsForVideo(vid, detail);

    // ---- Stage 00-G：大家都在搜（Spec §17）----
    // 实测结论：抖音视频页**不存在**"大家都在搜"模块，因此通常为 NOT_VISIBLE。
    // 页面上真实存在的是搜索框滚动推荐词，单独存入 search_box_suggestions，
    // 与 search_keywords 严格分开（Spec §18）。
    detail.search_keywords = await this.collectSearchKeywords(vid);
    detail.search_box_suggestions = {
      status: this.searchBoxSuggestions.length ? STATUS.AVAILABLE : STATUS.NOT_VISIBLE,
      value: [...this.searchBoxSuggestions],
      source: { source_type: 'api', source_page: 'video_detail', note: '搜索框滚动推荐词，非"大家都在搜"模块' },
    };
    detail.field_status = detail.field_status || {};
    detail.field_status.search_keywords = detail.search_keywords.status;
    detail.field_status.search_box_suggestions = detail.search_box_suggestions.status;

    detail.collected_at = nowIso();
    detail.source = { source_type: 'api+dom', source_page: 'video_detail' };
    this.videoDetails.set(vid, detail);
    this.markStage(`00E_video_${vid}`, detail.detail_data_accessible ? 'OK' : 'PARTIAL');
    return detail;
  }

  /**
   * 探测视频页状态。
   *
   * 两个教训都在这里：
   * 1) 正则必须只匹配"拦截性"文案。抖音导航栏长期有「登录」按钮、页脚有「安全」字样，
   *    用宽松正则必然误报（实测已踩过）。
   * 2) readyState 必须"等"。上一版拿完 domcontentloaded 立刻读，结果 15/15 全是
   *    video_playable=false —— 不是视频不能播，是我们问得太早。
   */
  async probeVideoPageState(maxWaitMs = 9000) {
    const t0 = Date.now();
    let last = null;
    while (Date.now() - t0 < maxWaitMs) {
      last = await this.page.evaluate(() => {
        const txt = document.body ? document.body.innerText : '';
        const v = document.querySelector('video');
        return {
          text_len: txt.length,
          need_login: /登录后查看|请先登录|登录查看更多|登录后参与|扫码登录后/.test(txt),
          captcha:
            /请输入验证码|完成安全验证|拖动滑块|滑动验证|请完成下方验证|访问过于频繁|操作过于频繁|验证码校验/.test(
              txt
            ),
          not_found: /内容不存在|作品已删除|无法查看|该作品已被删除/.test(txt),
          has_video: !!v,
          ready_state: v ? v.readyState : -1,
        };
      });
      if (last.ready_state >= 2 || last.not_found || last.captcha) break;
      await sleep(700);
    }
    return last;
  }

  async collectCommentsForVideo(vid, detail) {
    const want = this.opts.commentMax;
    const minWant = this.opts.commentMin;
    let round = 0;
    let idle = 0;

    // 评论响应按 currentVideoId 归属，必须显式绑定，否则并发/延迟响应会挂错视频
    this.currentVideoId = vid;
    // has_more / cursor 每次进入新视频都要重新取，避免沿用一个旧值
    this.commentHasMore = this.commentHasMore || {};
    this.commentCursor = this.commentCursor || {};
    delete this.commentHasMore[vid];
    delete this.commentCursor[vid];

    // 先确认评论区在不在
    const initial = await this.page.evaluate(() => {
      const txt = document.body ? document.body.innerText : '';
      return {
        has_comment_word: /评论/.test(txt),
        need_login: /登录后查看评论|登录查看更多评论|登录后参与评论|登录后可查看/.test(txt),
      };
    });

    if (initial.need_login) {
      this.addError('comment_area', ERROR_TYPE.LOGIN_REQUIRED, `视频 ${vid} 评论区需登录后查看`, { video_id: vid });
      return;
    }

    let loginWallHit = false;
    const scrollModes = new Set();
    const clickedExpand = await this.expandCollapsedComments();
    if (clickedExpand) console.log(`      点击展开按钮 ${clickedExpand} 次`);

    while (round < this.opts.commentScrollRounds) {
      round += 1;
      const got = this.commentsByVideo.get(vid)?.length || 0;
      if (got >= want) break;

      const before = got;
      const reqBefore = this.commentReq.length;
      const resBefore = this.commentRes.length;
      // 连续多轮没触发加载时，升级为"鼠标真实滚轮"
      const useWheel = idle >= this.opts.commentWheelFallback;
      let diag;
      if (useWheel) {
        const ok = await this.scrollCommentAreaByWheel();
        diag = { mode: ok ? 'mouse-wheel' : 'mouse-wheel-miss', moved: null, cn: null, before: null, after: null, sh: null, ch: null };
      } else {
        diag = await this.scrollCommentAreaGradual();
      }
      scrollModes.add(diag.mode);
      // 必须等"针对本条视频"的分页请求，而不是干等固定毫秒。
      // 固定 sleep 在响应稍慢时会把"还没回来"误判成"到底了"。
      // LEGACY_SLEEP=1 可回退到旧的固定 sleep，仅用于单变量隔离实验。
      let arrived;
      if (process.env.LEGACY_SLEEP) {
        await sleep(randDelay([900, 1600]));
        arrived = true;
      } else {
        arrived = await this.waitCommentPage();
        await sleep(randDelay([300, 700]));
      }

      // 滚动过程中可能才弹出登录墙 —— 必须边滚边查
      if (round % 2 === 0) {
        const wall = await this.page.evaluate(() => {
          const t = document.body ? document.body.innerText : '';
          return /登录后查看评论|登录查看更多评论|登录后参与评论|登录后可查看/.test(t);
        });
        if (wall) {
          loginWallHit = true;
          this.addError(
            'comment_area',
            ERROR_TYPE.LOGIN_REQUIRED,
            `视频 ${vid} 滚动 ${round} 轮后出现登录墙，访客态评论止步于 ${before} 条`,
            { video_id: vid, comments_before_wall: before }
          );
          break;
        }
      }

      const after = this.commentsByVideo.get(vid)?.length || 0;
      this._commentDiag = this._commentDiag || {};
      this._commentDiag[vid] = this._commentDiag[vid] || [];
      this._commentDiag[vid].push({
        round,
        mode: diag.mode,
        moved: diag.moved,
        cn: diag.cn,
        top: [Math.round(diag.before ?? -1), Math.round(diag.after ?? -1)],
        sh: diag.sh,
        ch: diag.ch,
        req: this.commentReq.length - reqBefore,
        res: this.commentRes.length - resBefore,
        gave_up_waiting: arrived === false,
        got_before: before,
        got_after: after,
      });
      if (this.debug) {
        console.log(
          `      [dbg] 轮${round} mode=${diag.mode} moved=${diag.moved} 评论节点=${diag.cn} ` +
            `top ${Math.round(diag.before ?? -1)}→${Math.round(diag.after ?? -1)}/${diag.sh} ` +
            `| req+${this.commentReq.length - reqBefore} res+${this.commentRes.length - resBefore}` +
            `${arrived === false ? '  ⚠等待分页超时' : ''} | 评论 ${before}→${after}`
        );
      }

      if (after === before) {
        idle += 1;
        // 放弃的判据：连续 commentGiveUpRounds 轮无新增。
        // 必须大于 commentWheelFallback，否则"换滚轮"那条路永远走不到。
        if (idle >= this.opts.commentGiveUpRounds) {
          const hm = this.commentHasMore[vid];
          // 诚实性检查：接口明确说 has_more=1 时，绝不能判定"到底了"。
          // 旧的 idle>=3 逻辑在这里会谎报完成 —— 实测有 4 条视频因此静默少采。
          if (hm === 1) {
            this.log.comment_list_incomplete = this.log.comment_list_incomplete || [];
            this.log.comment_list_incomplete.push({
              video_id: vid,
              got: after,
              total_on_page: (this.commentTotals && this.commentTotals[vid]) ?? null,
              rounds_without_progress: idle,
              has_more: hm,
              last_cursor: this.commentCursor[vid] ?? null,
              tried_wheel: scrollModes.has('mouse-wheel'),
              note: '接口 has_more=1，但连续多轮无新增；未判定为"到底"，标记为采集不完整',
            });
            this.addError(
              'comment_area',
              ERROR_TYPE.DATA_NOT_VISIBLE,
              `视频 ${vid} 评论列表未采完：接口 has_more=1，但连续 ${idle} 轮无新增（已采 ${after} 条）`,
              { video_id: vid, has_more: hm }
            );
          }
          break;
        }
      } else {
        idle = 0;
      }
    }

    const finalCount = this.commentsByVideo.get(vid)?.length || 0;
    const totalOnPage = (this.commentTotals && this.commentTotals[vid]) ?? null;

    // 把"采到多少 / 页面声称多少"同时落盘，方便判断完整度而不是只看绝对条数
    detail.comments_collected = finalCount;
    detail.comments_total_on_page = totalOnPage;
    detail.comments_scroll_modes = [...scrollModes];
    detail.comments_rounds = round;
    detail.comments_has_more_at_exit = (this.commentHasMore && this.commentHasMore[vid]) ?? null;
    detail.comments_last_cursor = (this.commentCursor && this.commentCursor[vid]) ?? null;
    // 逐轮滚动诊断 —— 出问题时不必再靠猜
    if (this._commentDiag && this._commentDiag[vid]) {
      detail.comments_scroll_diag = this._commentDiag[vid];
    }
    if (totalOnPage !== null) {
      detail.comments_coverage_pct = Math.round((finalCount / totalOnPage) * 1000) / 10;
    }
    // 是否采完整：要区分三种停止原因，不能把"采到采样上限而停"当成失败。
    //   REACHED_SAMPLING_CAP —— 按 Spec 的采样区间(20~50)主动停，属正常
    //   LIST_EXHAUSTED       —— 接口 has_more=0，列表真的到底了
    //   NO_PROGRESS_HAS_MORE —— 接口说还有，却怎么滚都不出新，属**异常**
    const hitCap = finalCount >= want;
    const hasMoreAtExit = (this.commentHasMore && this.commentHasMore[vid]) ?? null;
    detail.comments_stop_reason = hitCap
      ? 'REACHED_SAMPLING_CAP'
      : hasMoreAtExit === 0
        ? 'LIST_EXHAUSTED'
        : 'NO_PROGRESS_HAS_MORE';
    detail.comments_complete =
      hitCap || hasMoreAtExit === 0 || finalCount >= (totalOnPage ?? Infinity);

    if (finalCount === 0) {
      this.addError('comment_area', ERROR_TYPE.DATA_NOT_VISIBLE, `视频 ${vid} 未捕获到公开评论`, { video_id: vid });
    }
    if (finalCount > 0 && finalCount < minWant) {
      this.log.comment_depth_shortfall = this.log.comment_depth_shortfall || [];
      this.log.comment_depth_shortfall.push({
        video_id: vid,
        got: finalCount,
        total_on_page: totalOnPage,
        target_min: minWant,
        login_wall: loginWallHit,
      });
    }
    console.log(
      `    评论采集 ${finalCount} 条 (目标 ${minWant}~${want})${totalOnPage !== null ? ` / 页面声称 ${totalOnPage}` : ''}${loginWallHit ? '  ⚠ 撞到登录墙' : ''}`
    );
  }

  /**
   * 渐进滚动评论区。
   *
   * 两个实测教训：
   * 1) 直接把 scrollTop 拉到底会"跳过"懒加载触发点，一条都加载不出来 → 每轮推 80% 视口。
   * 2) 不能按"最大可滚动容器"挑目标。实测同一账号下，有的视频页侧边
   *    还有更大的推荐流容器，被选中后滚的是它，评论一条不涨
   *    （出现 5 条 vs 57 条这种 10 倍差异）。
   *    → 改为优先挑"包含评论元素的容器"，容器选错是一切评论问题的根源。
   */
  async scrollCommentAreaGradual() {
    return this.page.evaluate(() => {
      const isScrollable = (el) => {
        const st = getComputedStyle(el);
        if (!(st.overflowY === 'auto' || st.overflowY === 'scroll')) return false;
        if (el.scrollHeight <= el.clientHeight + 80) return false;
        return el.clientHeight >= 150;
      };

      const all = [];
      for (const el of document.querySelectorAll('div')) {
        if (isScrollable(el)) all.push(el);
      }
      if (!all.length) {
        window.scrollBy(0, 700);
        return { mode: 'window', moved: null, cn: 0, before: null, after: null, sh: null, ch: null };
      }

      // 优先：包含评论元素的容器
      const score = (el) => {
        let n = 0;
        n += el.querySelectorAll('[data-e2e*="comment"]').length * 10;
        // 退化启发式：评论项通常文本短、数量多、带头像图
        n += Math.min(el.querySelectorAll('img').length, 12);
        return n;
      };
      const withCommentNodes = all.filter((el) => el.querySelectorAll('[data-e2e*="comment"]').length > 0);
      const pool = withCommentNodes.length ? withCommentNodes : all;
      pool.sort((a, b) => score(b) - score(a) || b.scrollHeight - a.scrollHeight);

      const t = pool[0];
      const before = t.scrollTop;
      t.scrollTop = Math.min(t.scrollTop + t.clientHeight * 0.8, t.scrollHeight);
      // 关键诊断：必须回读 scrollTop，确认"真的动了"。
      // 只写不读的话，"写了个不可滚动的元素"会被静默当成"滚过了"。
      const after = t.scrollTop;
      return {
        mode: withCommentNodes.length ? 'comment-container' : 'fallback-container',
        moved: after !== before,
        cn: withCommentNodes.length,
        before,
        after,
        sh: t.scrollHeight,
        ch: t.clientHeight,
        // 该容器在候选池里的位置与总数，用于判断"选中的是最外层还是最内层"
        idx: all.indexOf(t),
        total: all.length,
      };
    });
  }

  /** 评论可能被折叠在"展开"按钮后面，先点掉 */
  async expandCollapsedComments() {
    try {
      return await this.page.evaluate(() => {
        const texts = ['展开更多评论', '展开', '查看更多评论', '查看更多回复'];
        let clicked = 0;
        for (const el of document.querySelectorAll('div, span, button')) {
          if (el.children.length !== 0) continue;
          const t = (el.textContent || '').trim();
          if (!texts.includes(t)) continue;
          // 只点评论区里的，别把视频简介的"展开"也点了。
          // 旧实现写成 `el.closest('[data-e2e*="comment"]') || el.parentElement`，
          // 而 parentElement 永远为真 —— 这道保险完全失效。
          // 实测它点的是「展开」且最近 data-e2e=detail-video-info（简介区）。
          // LEGACY_EXPAND=1 可回退旧行为，仅用于单变量隔离实验。
          const box = process.env.LEGACY_EXPAND ? el.closest('[data-e2e*="comment"]') || el.parentElement : el.closest('[data-e2e*="comment"]');
          if (!box) continue;
          el.click();
          clicked += 1;
          if (clicked >= 2) break;
        }
        return clicked;
      });
    } catch {
      return 0;
    }
  }

  /** Stage 00-G：大家都在搜（页面 DOM，与 hashtags 严格分开） */
  async collectSearchKeywords(vid) {
    const kw = await this.page.evaluate(() => {
      const LABEL = '大家都在搜';
      const nodes = Array.from(document.querySelectorAll('*'));
      for (const n of nodes) {
        if (n.children.length === 0 && n.textContent && n.textContent.trim() === LABEL) {
          let box = n.parentElement;
          for (let depth = 0; depth < 4 && box; depth += 1) {
            const texts = Array.from(box.querySelectorAll('*'))
              .filter((x) => x.children.length === 0)
              .map((x) => (x.textContent || '').trim())
              .filter((t) => t && t !== LABEL && t.length <= 24);
            const uniq = [...new Set(texts)];
            if (uniq.length >= 1 && uniq.length <= 10) return uniq;
            box = box.parentElement;
          }
        }
      }
      return null;
    });

    if (!kw || kw.length === 0) {
      return { status: STATUS.NOT_VISIBLE, value: [] };
    }
    return { status: STATUS.AVAILABLE, value: kw };
  }

  // ==========================================================
  // 错误分类
  // ==========================================================

  classifyError(e) {
    const m = String(e && e.message ? e.message : e).toLowerCase();
    if (m.includes('timeout')) return ERROR_TYPE.TIMEOUT;
    if (m.includes('net::err') || m.includes('econnreset') || m.includes('socket hang up')) return ERROR_TYPE.NETWORK_ERROR;
    if (m.includes('net::err_name_not_resolved') || m.includes('dns')) return ERROR_TYPE.NETWORK_ERROR;
    if (m.includes('登录')) return ERROR_TYPE.LOGIN_REQUIRED;
    if (m.includes('验证')) return ERROR_TYPE.CAPTCHA;
    if (m.includes('429') || m.includes('too many')) return ERROR_TYPE.RATE_LIMIT;
    if (m.includes('404') || m.includes('not found')) return ERROR_TYPE.PAGE_NOT_FOUND;
    return ERROR_TYPE.UNKNOWN;
  }

  // ==========================================================
  // 登录态
  // ==========================================================

  async isLoggedIn() {
    try {
      const cookies = await this.context.cookies('https://www.douyin.com');
      return cookies.some((c) => ['sessionid', 'sessionid_ss', 'sid_tt'].includes(c.name) && c.value);
    } catch {
      return false;
    }
  }

  /** 等用户在浏览器里完成扫码登录 */
  async waitForManualLogin(timeoutMs = 600000) {
    console.log('\n==============================================');
    console.log('[登录] 浏览器窗口已打开，请扫码登录抖音。');
    console.log('[登录] 手机抖音 → 右上角「我的」→ 顶部扫码图标 → 扫浏览器里的二维码');
    console.log('[登录] 若窗口没弹出二维码，请手动点页面右上角的「登录」按钮。');
    console.log('[登录] 登录成功后本程序自动继续（最长等 10 分钟）。');
    console.log('==============================================\n');

    await this.page.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded' }).catch(() => {});
    await sleep(3000);
    await this.dismissOverlays().catch(() => {});

    // 尝试自动点开登录二维码
    for (let i = 0; i < 3; i += 1) {
      const clicked = await this.page
        .evaluate(() => {
          const els = Array.from(document.querySelectorAll('div, span, button, a'));
          const el = els.find(
            (e) => e.children.length === 0 && e.textContent && e.textContent.trim() === '登录'
          );
          if (el) {
            el.click();
            return true;
          }
          return false;
        })
        .catch(() => false);
      console.log(`  尝试唤起登录框: ${clicked ? '已点击「登录」' : '未找到按钮（请手动点）'}`);
      if (clicked) break;
      await sleep(2000);
    }

    const t0 = Date.now();
    let lastReport = 0;
    while (Date.now() - t0 < timeoutMs) {
      if (await this.isLoggedIn()) {
        const cookies = await this.context.cookies('https://www.douyin.com');
        const nick = cookies.find((c) => c.name === 'nickname');
        console.log(`[登录] ✓ 检测到登录态${nick ? `（${decodeURIComponent(nick.value)}）` : ''}，已保存到本地 profile。`);
        return true;
      }
      const elapsed = Math.round((Date.now() - t0) / 1000);
      if (elapsed - lastReport >= 30) {
        lastReport = elapsed;
        console.log(`[登录] 仍在等待扫码... (${elapsed}s)`);
      }
      await sleep(3000);
    }
    console.log('[登录] ✗ 等待超时，未检测到登录态。可重试 node collector.js --login');
    return false;
  }

  // ==========================================================
  // 落盘
  // ==========================================================

  buildOutputs() {
    const videos = this.videoOrder.map((id) => this.videosMap.get(id)).filter(Boolean);
    const details = Array.from(this.videoDetails.values());
    return { videos, details, comments: this.comments };
  }

  save() {
    const { videos, details, comments } = this.buildOutputs();
    const w = (name, obj) => {
      const p = path.join(this.dataDir, name);
      fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
      console.log(`  已写出 ${name} (${(fs.statSync(p).size / 1024).toFixed(1)} KB)`);
      return p;
    };

    const accountOut = {
      ...(this.account || { url: this.opts.url }),
      content_structure: this.contentStructure,
      homepage_meta: {
        post_api_page_count: this.postMeta.page_count,
        has_more: this.postMeta.has_more,
        max_cursor: this.postMeta.max_cursor,
      },
      field_status_all: WHITELIST.account,
    };
    w('account.json', accountOut);
    w('videos.json', videos);
    w('video_details.json', details);
    w('comments.json', comments);

    this.log.finished_at = nowIso();
    this.log.status = this.log.errors.length === 0 ? 'SUCCESS' : 'PARTIAL';
    this.log.page_errors = this.pageErrors || []; // 页面自身 JS 噪音，单独归档
    // 评论接口的 request/response 双侧流水 —— 用于区分
    // [没发出分页请求]（滚动没触发）与 [发出但响应丢失]（竞态/中止）
    this.log.comment_traffic = {
      requests: this.commentReq,
      responses: this.commentRes,
    };
    this.log.coverage = this.computeCoverage(videos, details, comments);
    this.log.summary = this.computeSummary(videos, details, comments);
    w('collection_log.json', this.log);

    return { videos, details, comments };
  }

  computeCoverage(videos, details, comments) {
    const rate = (rows, field) => {
      const total = rows.length;
      if (!total) return { available: 0, total: 0, pct: 0 };
      const ok = rows.filter((r) => r.field_status && r.field_status[field] === STATUS.AVAILABLE).length;
      return { available: ok, total, pct: Math.round((ok / total) * 100) };
    };

    const accountFields = WHITELIST.account;
    const accountTotal = accountFields.length + 1; // + content_structure
    let accountOk = 0;
    if (this.account) {
      for (const f of accountFields) {
        const v = this.account[f];
        if (v !== null && v !== undefined && v !== '') accountOk += 1;
      }
    }
    if (this.contentStructure) accountOk += 1;

    return {
      account: { available: accountOk, total: accountTotal, pct: Math.round((accountOk / accountTotal) * 100) },
      video_fields: {
        cover_image: rate(videos, 'cover_image'),
        title: rate(videos, 'title'),
        hashtags: rate(videos, 'hashtags'),
        likes: rate(videos, 'likes'),
        is_pinned: rate(videos, 'is_pinned'),
        video_url: rate(videos, 'video_url'),
        cover_text: rate(videos, 'cover_text'),
      },
      video_detail_fields: {
        video_duration: rate(details, 'video_duration'),
        likes: rate(details, 'likes'),
        comments: rate(details, 'comments'),
        favorites: rate(details, 'favorites'),
        shares: rate(details, 'shares'),
        publish_time: rate(details, 'publish_time'),
        hashtags: rate(details, 'hashtags'),
      },
      comment_fields: {
        content: rate(comments, 'content'),
        publish_time: rate(comments, 'publish_time'),
        likes: rate(comments, 'likes'),
        ip_location: rate(comments, 'ip_location'),
        reply_count: rate(comments, 'reply_count'),
        user_nickname: rate(comments, 'user_nickname'),
      },
    };
  }

  computeSummary(videos, details, comments) {
    const accessible = details.filter((d) => d.video_accessible).length;
    const withData = details.filter((d) => d.detail_data_accessible).length;
    const withComments = details.filter((d) => (this.commentsByVideo.get(d.video_id)?.length || 0) > 0).length;
    const withSearchKw = details.filter((d) => d.search_keywords && d.search_keywords.status === STATUS.AVAILABLE).length;
    const withSearchBox = details.filter(
      (d) => d.search_box_suggestions && d.search_box_suggestions.status === STATUS.AVAILABLE
    ).length;

    // 评论覆盖率：以接口声称的 total 为分母，而不是只看采到多少条
    const withTotal = details.filter((d) => typeof d.comments_total_on_page === 'number' && d.comments_total_on_page > 0);
    const sumCollected = withTotal.reduce((s, d) => s + (d.comments_collected || 0), 0);
    const sumTotal = withTotal.reduce((s, d) => s + d.comments_total_on_page, 0);

    return {
      account: this.account ? this.account.nickname : null,
      作品数_主页显示: this.contentStructure ? this.contentStructure.works_count : null,
      作品数_已采集: videos.length,
      代表视频数: details.length,
      视频可访问: accessible,
      单视频数据获取成功: withData,
      评论获取成功视频数: withComments,
      评论总条数: comments.length,
      评论覆盖率: sumTotal ? `${sumCollected}/${sumTotal} (${Math.round((sumCollected / sumTotal) * 1000) / 10}%)` : 'UNAVAILABLE',
      '大家都在搜_命中视频数': withSearchKw,
      搜索框推荐词_命中视频数: withSearchBox,
      失败项数: this.log.errors.length,
      api_seen: this.log.api_seen,
      not_watched_apis: this.log.not_watched_apis,
      aweme_type_seen: this.postMeta.aweme_type_seen || {},
    };
  }

  async close() {
    try {
      if (this.context) await this.context.close();
    } catch {
      /* ignore */
    }
  }
}

function nullDetailStub() {
  return {
    video_duration: null,
    title: null,
    hashtags: [],
    likes: null,
    comments: null,
    favorites: null,
    shares: null,
    publish_time: null,
    search_keywords: { status: STATUS.NOT_COLLECTED, value: [] },
    video_accessible: false,
    video_playable: false,
    detail_data_accessible: false,
    field_status: {},
  };
}

module.exports = { DouyinCollector, sleep, randDelay, ensureDir, nowIso, detectDefaultBrowserChannel };
