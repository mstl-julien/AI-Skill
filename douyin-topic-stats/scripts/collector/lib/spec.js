'use strict';

/**
 * spec.js —— V0.1 的"规矩"层
 *
 * 这个文件是整份 Spec 的代码化表达。任何"能不能采、采什么、超纲的怎么办"
 * 都在这里定义，采集逻辑本身不做判断。
 *
 * 关键设计：字段白名单 + 合规丢弃清单。
 * 现实是——抖音接口返回的字段远多于 Spec 允许采集的字段。
 * 如果"截到啥存啥"，就会把非公开数据（如播放量）混进公开数据里，
 * 直接违反 Spec 2.1 / 2.2。所以白名单必须是硬编码的，不靠自觉。
 */

// ============================================================
// 字段状态机（Spec §20）
// ============================================================
const STATUS = Object.freeze({
  AVAILABLE: 'AVAILABLE', // 成功读取
  EMPTY: 'EMPTY', // 页面有该字段，但当前无内容
  UNAVAILABLE: 'UNAVAILABLE', // 理论上存在，当前环境无法获得
  NOT_VISIBLE: 'NOT_VISIBLE', // 页面本身没有公开显示
  NOT_COLLECTED: 'NOT_COLLECTED', // 本轮未要求采集
  FAILED: 'FAILED', // 尝试采集但异常
});

// ============================================================
// 错误类型（Spec §21）
// ============================================================
const ERROR_TYPE = Object.freeze({
  PAGE_NOT_FOUND: 'PAGE_NOT_FOUND',
  LOGIN_REQUIRED: 'LOGIN_REQUIRED',
  CAPTCHA: 'CAPTCHA',
  RATE_LIMIT: 'RATE_LIMIT',
  TIMEOUT: 'TIMEOUT',
  ELEMENT_NOT_FOUND: 'ELEMENT_NOT_FOUND',
  NETWORK_ERROR: 'NETWORK_ERROR',
  DATA_NOT_VISIBLE: 'DATA_NOT_VISIBLE',
  UNKNOWN: 'UNKNOWN',
});

// ============================================================
// 被动监听的接口特征（只匹配，不构造、不重放）
// ============================================================
const API_PATTERN = Object.freeze({
  USER_PROFILE: '/aweme/v1/web/user/profile/other/',
  AWEME_POST: '/aweme/v1/web/aweme/post/',
  AWEME_DETAIL: '/aweme/v1/web/aweme/detail/',
  COMMENT_LIST: '/aweme/v1/web/comment/list/',
  // 实测发现：抖音视频页的搜索框会滚动显示一个"推荐搜索词"，
  // 来源是这个接口。它与 Spec §17 说的"大家都在搜"模块**不是一回事**，
  // 因此单独存放为 search_box_suggestions，绝不混进 search_keywords。
  SUGGEST_WORDS: '/aweme/v1/web/api/suggest_words/',
});

// 仅用于侦测"页面发了什么我们没在听"，不用于采数
const API_WATCH_LIST = Object.freeze([
  '/aweme/v1/web/comment/list/reply/',
  '/aweme/v1/web/search/sug/',
  '/aweme/v1/web/user/profile/self/',
]);

// ============================================================
// 合规丢弃清单
//
// 这些字段接口里"可能有"，但页面不展示 → 按 Spec 2.1 不属于公开数据。
// 即使截获到也必须丢弃，并留下审计记录。
// ============================================================
const COMPLIANCE_DENY = Object.freeze({
  // —— 2026-09-22 实测证实：抖音 aweme/post 接口的 statistics 节点实际返回如下 ——
  // ["recommend_count","comment_count","digg_count","admire_count","play_count","share_count","collect_count"]
  // 其中 3 个是页面不展示的非公开指标，必须拦下：
  'statistics.play_count': '播放量：页面不展示，属非公开数据（Spec 2.1 / 27）',
  'statistics.recommend_count': '推荐数：实测接口返回，但页面不展示',
  'statistics.admire_count': '赞赏数：实测接口返回，但页面不展示',
  'statistics.forward_count': '转发数：页面展示的是分享数，此为内部指标',
  'statistics.whatsapp_share_count': 'WhatsApp 分享数：非页面公开指标',
  'statistics.download_count': '下载数：页面不展示',
  'video.bit_rate': '码率详情：客户端内部字段',
  'video.play_addr': '播放地址：本地不存在公开 URL 场景',
  'video.download_addr': '下载地址：非公开展示信息',
  'video.cover.uri': '封面内部 URI',
  aweme_control: '平台风控字段',
  'author.uid': '作者内部 ID',
  'author.sec_uid': '作者 sec_uid：仅用于构造 URL，不入库',
  comment_list_reply: '评论楼中楼：V0.1 不展开（Spec §15）',
});

// ============================================================
// 字段白名单 —— 只允许这些进入结果数据
// 来源：Spec §5（账号）/ §8（作品）/ §12（视频）/ §15（评论）
// ============================================================
const WHITELIST = Object.freeze({
  account: [
    'url',
    'nickname',
    'douyin_id',
    'verification',
    // 2026-09-23 补充：verification_type 区分黄V(1,个人认证)/蓝V(2,企业认证)，修正企业号误判
    'verification_type',
    'avatar',
    'following_count',
    'followers_count',
    'total_likes',
    'ip_location',
    'profile_age',
    'bio',
    'identity_text',
    // Spec 之外补充（Spec §5.1 的 verification 表达不了"企业号但无认证"这层状态）
    'enterprise_account',
    'enterprise_shop_permissions',
  ],
  video: [
    'video_id',
    'video_url',
    'cover_image',
    'cover_text',
    'title',
    'hashtags',
    'likes',
    'is_pinned',
    // 2026-09-23 补充：均为页面公开展示数据（选题统计需要），play_count 仍在合规拦截清单
    'publish_time',
    'comments',
    'favorites',
    'shares',
  ],
  videoDetail: [
    'video_id',
    'video_duration',
    'title',
    'hashtags',
    'likes',
    'comments',
    'favorites',
    'shares',
    'publish_time',
    'search_keywords',
    'search_box_suggestions',
    'comments_collected',
    'comments_total_on_page',
    'comments_coverage_pct',
    'comments_scroll_modes',
    'video_accessible',
    'video_playable',
    'detail_data_accessible',
  ],
  comment: [
    'comment_id',
    'video_id',
    'user_nickname',
    'user_avatar',
    'content',
    'publish_time',
    'likes',
    'ip_location',
    'reply_count',
    'has_replies',
  ],
});

// ============================================================
// 代表视频初筛策略（Spec §10.2）
// 注意：分层依据是「点赞表现」，不是播放表现。
// ============================================================
const DEFAULT_SAMPLING = Object.freeze({
  high: 10, // 高点赞组
  mid: 5, // 中位表现组
  low: 5, // 低点赞组
  latest: 10, // 最新内容组
  pinned: Infinity, // 置顶内容组（全部）
});

// ============================================================
// 评论采集策略（Spec §14.1）
// ============================================================
const DEFAULT_COMMENT_SAMPLING = Object.freeze({
  minPerVideo: 20,
  maxPerVideo: 50,
});

// ============================================================
// 默认采集参数
// ============================================================
const DEFAULTS = Object.freeze({
  // 作品列表采集数量。0 = 不设上限，一直滚到接口 has_more=0（90 于 2026-09-23 拍板：
  // 对标分析必须基于全量作品，不能用前 200 条抽样）。需要限流时用 --max-videos=N 显式指定。
  maxVideos: 0,
  maxScrollRounds: 40, // 滚动轮次上限，防死循环。全量模式下自动放大（见 collectWorksList）
  scrollIdleRounds: 3, // 连续 N 轮无新增即判定加载完（Spec §7 条件A/D）
  detailLimit: 30, // 最多进入多少条代表视频
  retryTimes: 3, // 单页重试次数（Spec §22.1）
  actionDelayMs: [800, 1800], // 随机延迟，避免高频触发风控
  pageTimeoutMs: 45000,
  commentScrollRounds: 20, // 实测每页只返回 5 条评论，且需渐进滚动才触发加载
  // 评论区"等待分页响应"的参数。
  // 起因：旧的固定 sleep(900~1600ms) 会在响应稍慢时把"还没回来"误判成"到底了"，
  // 实测有 4/19 条视频因此只采到 5 条（接口 has_more 仍为 1）。
  commentPageProbeMs: 1500, // 滚完后多久还没发出分页请求，就认为"这一滚没触发加载"
  commentPageWaitMs: 6000, // 已发出请求时，最多等多久拿响应
  commentWheelFallback: 3, // 连续 N 轮没触发加载时，切换为"鼠标真实滚轮"重试
  commentGiveUpRounds: 6, // 连续 N 轮没新增才放弃（必须 > commentWheelFallback，否则滚轮兜底是死代码）
});

module.exports = {
  STATUS,
  ERROR_TYPE,
  API_PATTERN,
  API_WATCH_LIST,
  COMPLIANCE_DENY,
  WHITELIST,
  DEFAULT_SAMPLING,
  DEFAULT_COMMENT_SAMPLING,
  DEFAULTS,
};
