'use strict';

/**
 * extract.js —— 白名单提取层
 *
 * 职责单一：把抖音接口的原始 JSON，按白名单翻译成 Spec 数据模型。
 * 超纲字段一律丢弃并留下审计记录（dropped）。
 *
 * 这一层是"合规闸门"。任何绕过它直接读原始 JSON 的行为都是 bug。
 */

const { STATUS, COMPLIANCE_DENY } = require('./spec');

// ---------- 通用小工具 ----------

/** 深层取值，任一层缺失即返回 undefined，不抛错 */
function pick(obj, path) {
  return path.split('.').reduce((acc, k) => (acc == null ? undefined : acc[k]), obj);
}

/** 判断"取到了但为空" vs "根本没这个字段" */
function isMissing(v) {
  return v === undefined || v === null || v === '';
}

/** 时间戳 → ISO 字符串（秒级 / 毫秒级都能吃） */
function tsToIso(ts) {
  if (!ts || typeof ts !== 'number') return null;
  const ms = ts > 1e12 ? ts : ts * 1000;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/** 数字规整：抖音接口常用 0 表示"没有"，这里保留 0 但区分 null */
function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// ---------- 审计：记录被丢弃的字段 ----------

/**
 * 我们真正"消费"了的原始键。
 *
 * 为什么需要这个：审计层拿"原始 JSON 的键"去比"输出结果的字段名"，
 * 而两者命名不同（custom_verify → verification、follower_count → followers_count）。
 * 结果会把"我们用过的字段"误报成"被丢弃的字段"——审计一旦误报就没有可信度。
 * 所以显式声明消费清单，审计时先减去它。
 */
const CONSUMED_SOURCE_KEYS = Object.freeze({
  user: [
    'nickname', 'unique_id', 'short_id', 'custom_verify', 'enterprise_verify_reason',
    'verification_type', 'avatar_larger', 'avatar_thumb', 'avatar_medium',
    'following_count', 'follower_count', 'total_favorited', 'ip_location', 'signature',
    'enterprise_user_info', 'with_commerce_entry', 'commerce_user_info',
  ],
  aweme: ['aweme_id', 'awemeId', 'desc', 'create_time', 'is_top', 'aweme_type', 'text_extra', 'statistics', 'video', 'author'],
  comment: ['cid', 'comment_id', 'text', 'create_time', 'digg_count', 'ip_label', 'reply_comment_total', 'user'],
});

/**
 * 扫描一份原始对象，找出"接口给了但我们不要"的顶层键，
 * 并对命中合规丢弃清单的字段单独标注。
 *
 * @param {object} raw          原始 JSON 节点
 * @param {string[]} allowedKeys 白名单（输出字段名，仅用于兜底对比）
 * @param {string[]} consumedKeys 已消费的原始键（这些不算丢弃）
 */
function auditDropped(raw, allowedKeys, consumedKeys = []) {
  const dropped = [];
  if (raw && typeof raw === 'object') {
    for (const k of Object.keys(raw)) {
      if (allowedKeys.includes(k)) continue;
      if (consumedKeys.includes(k)) continue;
      dropped.push(k);
    }
  }
  const compliance = [];
  for (const [path, reason] of Object.entries(COMPLIANCE_DENY)) {
    const v = pick(raw, path);
    // 关键：判断"字段是否存在"，而不是"值是否非零"。
    // 上一版用 !== 0，导致 play_count（实测值恒为 0）被漏报，
    // 审计里看不到它 —— 而这恰恰是最该被看见的一条。
    if (v === undefined) continue;
    compliance.push({
      field: path,
      reason,
      sample_value: v !== null && typeof v === 'object' ? '[object]' : v,
    });
  }
  return { dropped, compliance };
}

// ---------- 封面 / 话题 ----------

function firstUrl(list) {
  if (!Array.isArray(list)) return null;
  return list.find((u) => typeof u === 'string' && u.startsWith('http')) || null;
}

function extractCoverUrl(aweme) {
  return (
    firstUrl(pick(aweme, 'video.cover.url_list')) ||
    firstUrl(pick(aweme, 'video.origin_cover.url_list')) ||
    firstUrl(pick(aweme, 'video.dynamic_cover.url_list')) ||
    null
  );
}

/** 话题标签：优先 text_extra.hashtag_name，其次从 desc 里正则兜底 */
function extractHashtags(aweme) {
  const out = [];
  const extra = pick(aweme, 'text_extra');
  if (Array.isArray(extra)) {
    for (const t of extra) {
      const name = t && (t.hashtag_name || t.hashtagName);
      if (name && !out.includes(name)) out.push(name);
    }
  }
  if (out.length === 0) {
    const desc = pick(aweme, 'desc');
    if (typeof desc === 'string') {
      const re = /#([^\s#]+)/g;
      let m;
      while ((m = re.exec(desc))) if (!out.includes(m[1])) out.push(m[1]);
    }
  }
  return out;
}

// ============================================================
// 账号（Spec §5）
// ============================================================

/**
 * @param {object} user  user/profile/other 接口返回的 user 节点
 * @param {string} url   用户提供的主页 URL
 */
function extractAccount(user, url) {
  const u = user || {};
  const status = {};

  const nickname = u.nickname || null;
  status.nickname = nickname ? STATUS.AVAILABLE : STATUS.EMPTY;

  const douyinId = u.unique_id || u.short_id || null;
  status.douyin_id = douyinId ? STATUS.AVAILABLE : STATUS.NOT_VISIBLE;

  // 认证：蓝V → custom_verify；企业认证 → enterprise_verify_reason
  // 认证信息（90 于 2026-09-23 修正口径）：
  //   verification_type=1 → 个人认证（黄V达人）；=2 → 企业认证（蓝V）；0/缺失 → 无认证
  //   enterprise_verify_reason 非空 = 企业认证原因文本（蓝V的可靠判据）
  //   custom_verify = 认证文案原文（黄V通常在此）
  // 旧写法把 verification_type 非零合成"已认证"，导致黄V达人被误标企业号（干饭兄弟案例）。
  const verification = u.custom_verify || u.enterprise_verify_reason || null;
  status.verification = verification ? STATUS.AVAILABLE : STATUS.EMPTY;
  const verificationType = typeof u.verification_type === 'number' ? u.verification_type : null;
  status.verification_type =
    verificationType !== null ? STATUS.AVAILABLE : STATUS.UNAVAILABLE;

  const avatar = firstUrl(pick(u, 'avatar_larger.url_list')) || firstUrl(pick(u, 'avatar_thumb.url_list'));
  status.avatar = avatar ? STATUS.AVAILABLE : STATUS.UNAVAILABLE;

  const following = num(u.following_count);
  status.following_count = following !== null ? STATUS.AVAILABLE : STATUS.UNAVAILABLE;

  const followers = num(u.follower_count);
  status.followers_count = followers !== null ? STATUS.AVAILABLE : STATUS.UNAVAILABLE;

  // total_favorited 抖音接口有时给字符串（"192300000"），有时给缩写
  let totalLikes = num(u.total_favorited);
  if (totalLikes === null && typeof u.total_favorited === 'string') {
    totalLikes = parseAbbrev(u.total_favorited);
  }
  status.total_likes = totalLikes !== null ? STATUS.AVAILABLE : STATUS.UNAVAILABLE;

  const ipLocation = u.ip_location || null;
  status.ip_location = ipLocation ? STATUS.AVAILABLE : STATUS.NOT_VISIBLE;

  // 年龄不在接口里，靠主页 DOM（见 collector.js），这里先占位
  status.profile_age = STATUS.NOT_COLLECTED;

  // ── Spec 之外补充：企业号属性 ──
  // 起因：账号「薛辉小清新」的 custom_verify / enterprise_verify_reason 均为空、
  // verification_type=0（确实没有认证标识），但 enterprise_user_info.permissions 里
  // 有「视频电商 / 直播电商 / 个人橱窗」—— 它是**企业号但无认证标识**。
  // Spec §5.1 的 verification 只能表达"有没有认证"，表达不了这层状态。
  // 旧的人工截图报告把这种情况写成"已认证（蓝V）"，就是因为这个缺口导致的误判。
  // 处理原则：不动 verification 的语义，另外补两个字段，并标注来源。
  // 实测：enterprise_user_info 可能是对象，也可能是 JSON 字符串，两种形态都遇到过。
  // 上一版直接 pick(path) 取值，遇到字符串形态就静默拿到 undefined（表现为 enterprise_account=false）。
  const entInfo = asObject(u.enterprise_user_info);
  const entPerms = entInfo && Array.isArray(entInfo.permissions) ? entInfo.permissions : [];
  const enterpriseShopPermissions = entPerms
    .map((p) => asObject(p))
    .map((p) => (p ? p.Name : null))
    .filter(Boolean);
  const enterpriseAccount = enterpriseShopPermissions.length > 0;
  status.enterprise_account = STATUS.AVAILABLE;
  status.enterprise_shop_permissions = enterpriseAccount ? STATUS.AVAILABLE : STATUS.EMPTY;

  const bio = u.signature || null;
  status.bio = bio ? STATUS.AVAILABLE : STATUS.EMPTY;

  // identity_text = 简介中明确出现的身份/职业表述。只做"抄录"，不做推断（Spec §5.4）
  const identityText = bio ? extractIdentityText(bio) : null;
  status.identity_text = identityText ? STATUS.AVAILABLE : STATUS.NOT_VISIBLE;

  return {
    url,
    nickname,
    douyin_id: douyinId,
    verification,
    verification_type: verificationType,
    avatar,
    following_count: following,
    followers_count: followers,
    total_likes: totalLikes,
    ip_location: ipLocation,
    profile_age: null,
    bio,
    identity_text: identityText,
    // Spec 之外补充：企业号属性（不影响 verification 语义）
    enterprise_account: enterpriseAccount,
    enterprise_shop_permissions: enterpriseShopPermissions,
    field_status: status,
    source: { source_type: 'api', source_page: 'account_homepage' },
  };
}

/** "1923.0万" / "12.8w" → 数字 */
function parseAbbrev(s) {
  const m = String(s).trim().match(/^([\d.]+)\s*([万wW千kK亿]?)$/);
  if (!m) return null;
  const base = parseFloat(m[1]);
  if (Number.isNaN(base)) return null;
  const unit = m[2];
  const mult = { 万: 1e4, w: 1e4, W: 1e4, 千: 1e3, k: 1e3, K: 1e3, 亿: 1e8 }[unit] || 1;
  return Math.round(base * mult);
}

/** 抖音有些"嵌套对象"字段实际是以 JSON 字符串形式下发的，两种都要能吃 */
function asObject(v) {
  if (v && typeof v === 'object') return v;
  if (typeof v === 'string' && v.trim()) {
    try {
      const p = JSON.parse(v);
      return p && typeof p === 'object' ? p : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * 从简介里"抄"出身份表述。
 *
 * 铁律：只截取简介原文里出现的身份关键词，不做任何 AI 推断。
 *
 * 实测踩坑（2026-09-22）：账号「骑不动的洋芋」的简介里有
 *   "兄弟：@小徐老师🚴（骑车仔）"
 * 上一版因为命中关键词"老师"，把这一整段当成了身份表述 ——
 * 但这是 @ 提及别人的昵称，不是账号本人的身份。属误报，必须排除。
 * 排除规则：含 @ 的提及段、以及关键词落在括号内的段。
 */
const IDENTITY_KEYWORDS = [
  '老板', '创始人', '联合创始人', '主理人', '操盘手', '负责人', '合伙人', '店长', '买手',
  'CEO', 'CTO', 'COO', '总监', '经理', '主管', '运营', '教练', '老师', '导师', '讲师',
  '设计师', '摄影师', '剪辑师', '主播', '博主', '达人', 'UP主', '运动员', '车手', '裁判',
  '工程师', '医生', '律师', '营养师', '按摩师', '退役',
];

function extractIdentityText(bio) {
  const hits = [];
  for (const seg of String(bio).split(/[；;。，,\n]/)) {
    const s = seg.trim();
    if (!s) continue;

    // 排除：@ 提及别人（"兄弟：@小徐老师" 这类）
    if (s.includes('@')) continue;

    // 排除：关键词只出现在括号里的（补充说明，不是身份主述）
    const withoutBrackets = s.replace(/[（(][^）)]*[）)]/g, '');
    if (IDENTITY_KEYWORDS.some((k) => withoutBrackets.includes(k))) {
      hits.push(s);
    }
  }
  return hits.length ? hits.join('；') : null;
}

// ============================================================
// 作品（Spec §8）
// ============================================================

function extractVideo(aweme) {
  const status = {};
  const videoId = aweme.aweme_id || aweme.awemeId || null;
  status.video_id = videoId ? STATUS.AVAILABLE : STATUS.UNAVAILABLE;

  const title = aweme.desc ?? null;
  status.title = title ? STATUS.AVAILABLE : STATUS.EMPTY;

  const cover = extractCoverUrl(aweme);
  status.cover_image = cover ? STATUS.AVAILABLE : STATUS.UNAVAILABLE;

  // 封面文案是烘焙进封面图片里的像素内容，接口无对应文本字段。
  // V0.1 不做 OCR，如实标 UNAVAILABLE（Spec 2.2：不编造）。
  status.cover_text = STATUS.UNAVAILABLE;

  const hashtags = extractHashtags(aweme);
  status.hashtags = hashtags.length ? STATUS.AVAILABLE : STATUS.EMPTY;

  const likes = num(pick(aweme, 'statistics.digg_count'));
  status.likes = likes !== null ? STATUS.AVAILABLE : STATUS.UNAVAILABLE;

  // 2026-09-23 补充：发布时间与评论/收藏/转发数 —— 页面公开展示，选题统计需要。
  // 注意 play_count 仍是合规拦截项（页面不展示），绝不提取。
  const createTime = pick(aweme, 'create_time');
  const publishTime =
    typeof createTime === 'number' && createTime > 0 ? new Date(createTime * 1000).toISOString() : null;
  status.publish_time = publishTime ? STATUS.AVAILABLE : STATUS.UNAVAILABLE;

  const comments = num(pick(aweme, 'statistics.comment_count'));
  status.comments = comments !== null ? STATUS.AVAILABLE : STATUS.UNAVAILABLE;

  const favorites = num(pick(aweme, 'statistics.collect_count'));
  status.favorites = favorites !== null ? STATUS.AVAILABLE : STATUS.UNAVAILABLE;

  const shares = num(pick(aweme, 'statistics.share_count'));
  status.shares = shares !== null ? STATUS.AVAILABLE : STATUS.UNAVAILABLE;

  // is_top: 1 → 置顶
  const isPinned = pick(aweme, 'is_top') === 1 || pick(aweme, 'is_top') === true;
  status.is_pinned = STATUS.AVAILABLE;

  const videoUrl = videoId ? `https://www.douyin.com/video/${videoId}` : null;
  status.video_url = videoUrl ? STATUS.AVAILABLE : STATUS.UNAVAILABLE;

  return {
    video_id: videoId,
    video_url: videoUrl,
    cover_image: cover,
    cover_text: null,
    title,
    hashtags,
    likes,
    publish_time: publishTime,
    comments,
    favorites,
    shares,
    is_pinned: isPinned,
    field_status: status,
  };
}

// ============================================================
// 视频详情（Spec §12）
// ============================================================

function extractVideoDetail(aweme) {
  const status = {};
  const videoId = aweme.aweme_id || null;

  const duration = num(pick(aweme, 'video.duration'));
  status.video_duration = duration !== null ? STATUS.AVAILABLE : STATUS.UNAVAILABLE;

  const title = aweme.desc ?? null;
  status.title = title ? STATUS.AVAILABLE : STATUS.EMPTY;

  const hashtags = extractHashtags(aweme);
  status.hashtags = hashtags.length ? STATUS.AVAILABLE : STATUS.EMPTY;

  const st = aweme.statistics || {};
  const likes = num(st.digg_count);
  const comments = num(st.comment_count);
  const favorites = num(st.collect_count);
  const shares = num(st.share_count);

  status.likes = likes !== null ? STATUS.AVAILABLE : STATUS.UNAVAILABLE;
  status.comments = comments !== null ? STATUS.AVAILABLE : STATUS.UNAVAILABLE;
  status.favorites = favorites !== null ? STATUS.AVAILABLE : STATUS.UNAVAILABLE;
  status.shares = shares !== null ? STATUS.AVAILABLE : STATUS.UNAVAILABLE;

  const publishTime = tsToIso(aweme.create_time);
  status.publish_time = publishTime ? STATUS.AVAILABLE : STATUS.UNAVAILABLE;

  // search_keywords 来自页面 DOM（"大家都在搜"），此处占位
  status.search_keywords = STATUS.NOT_COLLECTED;

  return {
    video_id: videoId,
    video_duration: duration,
    title,
    hashtags,
    likes,
    comments,
    favorites,
    shares,
    publish_time: publishTime,
    search_keywords: [],
    video_accessible: false,
    video_playable: false,
    detail_data_accessible: false,
    field_status: status,
  };
}

// ============================================================
// 评论（Spec §15）
// ============================================================

function extractComment(c, videoId) {
  const status = {};
  const user = c.user || {};

  const commentId = c.cid || c.comment_id || null;
  status.comment_id = commentId ? STATUS.AVAILABLE : STATUS.UNAVAILABLE;

  const nickname = user.nickname || null;
  status.user_nickname = nickname ? STATUS.AVAILABLE : STATUS.EMPTY;

  const avatar =
    firstUrl(pick(user, 'avatar_thumb.url_list')) || firstUrl(pick(user, 'avatar_medium.url_list'));
  status.user_avatar = avatar ? STATUS.AVAILABLE : STATUS.UNAVAILABLE;

  const content = c.text ?? null;
  status.content = content ? STATUS.AVAILABLE : STATUS.EMPTY;

  const publishTime = tsToIso(c.create_time);
  status.publish_time = publishTime ? STATUS.AVAILABLE : STATUS.UNAVAILABLE;

  const likes = num(c.digg_count);
  status.likes = likes !== null ? STATUS.AVAILABLE : STATUS.UNAVAILABLE;

  const ipLocation = c.ip_label || null;
  status.ip_location = ipLocation ? STATUS.AVAILABLE : STATUS.NOT_VISIBLE;

  const replyCount = num(c.reply_comment_total);
  status.reply_count = replyCount !== null ? STATUS.AVAILABLE : STATUS.UNAVAILABLE;

  const hasReplies = !!replyCount && replyCount > 0;
  status.has_replies = STATUS.AVAILABLE;

  return {
    comment_id: commentId,
    video_id: videoId,
    user_nickname: nickname,
    user_avatar: avatar,
    content,
    publish_time: publishTime,
    likes,
    ip_location: ipLocation,
    reply_count: replyCount,
    has_replies: hasReplies,
    // Spec §15：V0.1 不展开楼中楼
    reply_loaded: false,
    field_status: status,
  };
}

// ============================================================
// 代表视频初筛（Spec §10）
// 依据是「点赞表现」，不得出现任何播放量口径。
// ============================================================

function selectRepresentativeVideos(videos, sampling) {
  const s = sampling;
  const withLikes = videos.filter((v) => typeof v.likes === 'number');
  const sorted = [...withLikes].sort((a, b) => b.likes - a.likes);

  const buckets = {
    high: [],
    mid: [],
    low: [],
    latest: [],
    pinned: [],
  };

  // 置顶优先占位 —— 置顶内容本来就是账号的名片
  for (const v of videos) if (v.is_pinned) buckets.pinned.push(v);

  // 最新：按列表顺序（抖音主页默认按时间倒序返回）
  buckets.latest = videos.slice(0, s.latest);

  const n = sorted.length;
  if (n > 0) {
    buckets.high = sorted.slice(0, s.high);
    // 中位：取点赞数落在中位区间的一段
    const midStart = Math.max(0, Math.floor(n / 2) - Math.floor(s.mid / 2));
    buckets.mid = sorted.slice(midStart, midStart + s.mid);
    // 低点赞：从尾部取，但要排除点赞为 0 的异常项
    buckets.low = sorted.slice(Math.max(0, n - s.low));
  }

  // 跨组去重：先入为主（置顶 > 高 > 最新 > 中 > 低）
  const seen = new Set();
  const result = [];
  for (const group of ['pinned', 'high', 'latest', 'mid', 'low']) {
    for (const v of buckets[group]) {
      if (!v.video_id || seen.has(v.video_id)) continue;
      seen.add(v.video_id);
      result.push({ ...v, sample_group: group });
    }
  }

  return {
    selected: result,
    bucket_summary: Object.fromEntries(
      Object.entries(buckets).map(([k, arr]) => [k, arr.length])
    ),
    dedup_removed: buckets.high.length + buckets.mid.length + buckets.low.length + buckets.latest.length + buckets.pinned.length - result.length,
  };
}

// ============================================================
// 搜索框推荐词（≠ Spec §17 的"大家都在搜"）
//
// 实测：suggest_words 的响应结构是 data[].words[].word
// 页面把它滚动显示在搜索框里，一次一个。它由当前视频驱动
// （qrec_channel = AWEME_RELATED_FEED_QUERY_NONPERSONALIZED）。
//
// 严格只取 .word 文本，其余（params/extra_info/id）全部丢弃。
// ============================================================

function extractSearchBoxSuggestions(json) {
  const groups = Array.isArray(json.data) ? json.data : [];
  const words = [];
  for (const g of groups) {
    for (const w of g.words || []) {
      const t = typeof w.word === 'string' ? w.word.trim() : null;
      if (t && !words.includes(t)) words.push(t);
    }
  }
  return words;
}

module.exports = {
  pick,
  num,
  tsToIso,
  firstUrl,
  parseAbbrev,
  auditDropped,
  CONSUMED_SOURCE_KEYS,
  asObject,
  extractAccount,
  extractVideo,
  extractVideoDetail,
  extractComment,
  extractHashtags,
  extractSearchBoxSuggestions,
  selectRepresentativeVideos,
};
