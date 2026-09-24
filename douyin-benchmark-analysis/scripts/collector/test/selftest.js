'use strict';

/**
 * selftest.js —— 离线自检（不需要浏览器）
 *
 * 目的：在真机跑之前，先证明三件事是对的——
 *   1. 白名单闸门有效：接口多给的字段进不来
 *   2. 合规丢弃有效：接口若返回 play_count，必须被丢弃并留审计
 *   3. 状态机语义正确：页面没展示的字段不会被"猜"出来
 *
 * 用法: node test/selftest.js
 */

const assert = require('assert');
const E = require('../lib/extract');
const { STATUS, WHITELIST } = require('../lib/spec');

let pass = 0;
let fail = 0;

function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail += 1;
    console.log(`  ✗ ${name}\n      ${e.message}`);
  }
}

// ------------------------------------------------------------
// 模拟一份"比 Spec 允许的字段多得多"的接口响应
// 注意：里面故意塞了 play_count，检验合规闸门
// ------------------------------------------------------------
const MOCK_AWEME = {
  aweme_id: '7621402181954930810',
  desc: '第一次穿骑行服的羞耻感 #骑行 #骑行服 #公路车',
  create_time: 1757000000,
  is_top: 1,
  aweme_type: 0,
  text_extra: [
    { hashtag_name: '骑行' },
    { hashtag_name: '骑行服' },
    { hashtag_name: '公路车' },
  ],
  statistics: {
    digg_count: 1400000,
    comment_count: 8231,
    collect_count: 45012,
    share_count: 33120,
    // ↓↓↓ 以下都是"接口有、页面不展示"的非公开数据，必须被丢弃
    play_count: 9800000,
    forward_count: 1200,
    download_count: 321,
    whatsapp_share_count: 8,
  },
  video: {
    duration: 18500,
    ratio: '720p',
    cover: { url_list: ['https://p3-sign.douyinpic.com/cover-demo.jpeg'] },
    play_addr: { url_list: ['https://v3-web.douyinvod.com/xxx'] },
    bit_rate: [{ bit_rate: 1200000 }],
  },
  author: { uid: '1234567890', sec_uid: 'MS4wLjABAAAAfake', nickname: '不该进白名单' },
  aweme_control: { can_comment: true },
};

const MOCK_USER = {
  nickname: '进击的90',
  unique_id: 'jjsj90',
  custom_verify: '',
  enterprise_verify_reason: '',
  avatar_larger: { url_list: ['https://p3-pc.douyinpic.com/avatar-demo.jpeg'] },
  following_count: 320,
  follower_count: 128000,
  total_favorited: '11630000',
  ip_location: '广东',
  signature: '骑行装备操盘手；每天分享一件骑行穿搭。不接私活。',
  // 超纲字段
  uid: '9999999',
  sec_uid: 'MS4wLjABAAAAsomething',
  is_star: false,
  mix_count: 2,
};

const MOCK_COMMENT = {
  cid: '7300000000000000001',
  text: '这套骑行服在哪买？链接发我一下',
  create_time: 1757100000,
  digg_count: 2731,
  ip_label: '广东',
  reply_comment_total: 6,
  user: {
    nickname: '骑不动的小王',
    avatar_thumb: { url_list: ['https://p3-pc.douyinpic.com/avatar-c.jpeg'] },
    uid: '555555',
    sec_uid: 'MS4wLjABAAAAxxx',
  },
  // 超纲
  label_list: [{ text: '作者赞过' }],
  reply_comment: [{ cid: '1', text: '楼中楼不该进 V0.1' }],
};

console.log('\n=== 离线自检：白名单闸门 / 合规丢弃 / 状态机 ===\n');

// ------------------------------------------------------------
check('作品：白名单字段全部正确提取', () => {
  const v = E.extractVideo(MOCK_AWEME);
  assert.strictEqual(v.video_id, '7621402181954930810');
  assert.strictEqual(v.likes, 1400000);
  assert.strictEqual(v.is_pinned, true, 'is_top=1 应识别为置顶');
  assert.deepStrictEqual(v.hashtags, ['骑行', '骑行服', '公路车']);
  assert.ok(v.cover_image.startsWith('https://'), '封面 URL 应取到');
  assert.strictEqual(v.video_url, 'https://www.douyin.com/video/7621402181954930810');
  assert.strictEqual(v.field_status.likes, STATUS.AVAILABLE);
});

check('作品：cover_text 如实标 UNAVAILABLE（不编造）', () => {
  const v = E.extractVideo(MOCK_AWEME);
  assert.strictEqual(v.cover_text, null);
  assert.strictEqual(v.field_status.cover_text, STATUS.UNAVAILABLE);
});

check('合规：play_count 被识别为"合规丢弃"且带原因', () => {
  const { compliance } = E.auditDropped(MOCK_AWEME, WHITELIST.video);
  const stolen = compliance.find((c) => c.field === 'statistics.play_count');
  assert.ok(stolen, 'play_count 必须命中合规丢弃清单');
  assert.ok(stolen.reason.includes('非公开数据'), '丢弃原因必须说明是公开性问题');
  assert.strictEqual(stolen.sample_value, 9800000);
});

check('合规：审计发现的丢弃字段数 > 0（说明闸门真的在拦）', () => {
  const { dropped, compliance } = E.auditDropped(MOCK_AWEME, WHITELIST.video);
  assert.ok(dropped.length > 0, '应有一批超纲顶层字段被丢弃');
  assert.ok(compliance.length >= 4, 'play_count/forward_count/download_count/whatsapp_share_count 应全部命中');
});

check('账号：简介身份表述只做"抄录"，不做推断', () => {
  const a = E.extractAccount(MOCK_USER, 'https://www.douyin.com/user/mock');
  assert.strictEqual(a.nickname, '进击的90');
  assert.strictEqual(a.followers_count, 128000);
  assert.strictEqual(a.total_likes, 11630000, '总获赞应能从字符串解析');
  assert.strictEqual(a.ip_location, '广东');
  assert.ok(a.identity_text && a.identity_text.includes('操盘手'), '应从简介抄出身份表述');
  assert.ok(!a.identity_text.includes('不接私活'), '非身份段落不应被抄进来');
});

check('账号：total_likes 的 "1923.0万" 形式能解析', () => {
  const a = E.extractAccount({ ...MOCK_USER, total_favorited: '1923.0万' }, 'u');
  assert.strictEqual(a.total_likes, 19230000);
});

check('账号：页面不展示的 profile_age 不被推测', () => {
  const a = E.extractAccount(MOCK_USER, 'u');
  assert.strictEqual(a.profile_age, null);
  assert.strictEqual(a.field_status.profile_age, STATUS.NOT_COLLECTED);
});

check('评论：楼中楼不进 V0.1，reply_loaded 恒为 false', () => {
  const c = E.extractComment(MOCK_COMMENT, '7621402181954930810');
  assert.strictEqual(c.comment_id, '7300000000000000001');
  assert.strictEqual(c.likes, 2731);
  assert.strictEqual(c.ip_location, '广东');
  assert.strictEqual(c.reply_count, 6);
  assert.strictEqual(c.has_replies, true);
  assert.strictEqual(c.reply_loaded, false);
  assert.ok(!('reply_comment' in c), '楼中楼内容不得进入评论对象');
});

check('详情：四项公开互动数据齐备', () => {
  const d = E.extractVideoDetail(MOCK_AWEME);
  assert.strictEqual(d.likes, 1400000);
  assert.strictEqual(d.comments, 8231);
  assert.strictEqual(d.favorites, 45012);
  assert.strictEqual(d.shares, 33120);
  assert.strictEqual(d.video_duration, 18500);
  assert.ok(d.publish_time && d.publish_time.startsWith('2025-'), '发布时间应 ISO 化');
});

check('详情：接口未返回的字段标 UNAVAILABLE，不填 0', () => {
  const d = E.extractVideoDetail({ aweme_id: 'x', statistics: {} });
  assert.strictEqual(d.likes, null);
  assert.strictEqual(d.field_status.likes, STATUS.UNAVAILABLE);
});

check('初筛：分层依据是点赞，不产生任何播放量字段', () => {
  const videos = Array.from({ length: 40 }, (_, i) => ({
    video_id: `${i}`,
    likes: (i + 1) * 100,
    is_pinned: i === 3,
    title: `t${i}`,
  }));
  const sel = E.selectRepresentativeVideos(videos, { high: 10, mid: 5, low: 5, latest: 10, pinned: Infinity });
  assert.ok(sel.selected.length > 0);
  assert.strictEqual(sel.dedup_removed, sel.bucket_summary.pinned + sel.bucket_summary.high + sel.bucket_summary.latest + sel.bucket_summary.mid + sel.bucket_summary.low - sel.selected.length);
  for (const v of sel.selected) {
    assert.ok(!('play_count' in v) && !('plays' in v), '结果中不得出现播放量字段');
  }
  const pinned = sel.selected.filter((v) => v.sample_group === 'pinned');
  assert.strictEqual(pinned.length, 1, '置顶应被单独分为一组');
});

check('初筛：去重生效，同一 video_id 不重复入样', () => {
  const videos = [
    { video_id: 'a', likes: 900, is_pinned: true },
    { video_id: 'a', likes: 900 },
    { video_id: 'b', likes: 500 },
  ];
  const sel = E.selectRepresentativeVideos(videos, { high: 5, mid: 5, low: 5, latest: 5, pinned: Infinity });
  const ids = sel.selected.map((v) => v.video_id);
  assert.strictEqual(ids.length, new Set(ids).size, '去重后 video_id 必须唯一');
});

check('合规：play_count 值为 0 时也必须被报出（不能因"值是 0"就漏报）', () => {
  // 实测：抖音真实返回的 play_count 恒为 0。上一版用 "值非零" 判断存在性，
  // 结果最该被看见的那条审计记录反而消失了。
  const { compliance } = E.auditDropped({ statistics: { play_count: 0, digg_count: 5 } }, WHITELIST.video);
  const hit = compliance.find((c) => c.field === 'statistics.play_count');
  assert.ok(hit, 'play_count 只要存在就必须上报，与取值无关');
  assert.strictEqual(hit.sample_value, 0);
});

check('审计：已消费的原始键不被误报为"丢弃"', () => {
  const { dropped } = E.auditDropped(MOCK_USER, WHITELIST.account, E.CONSUMED_SOURCE_KEYS.user);
  for (const k of ['custom_verify', 'follower_count', 'signature', 'total_favorited', 'unique_id']) {
    assert.ok(!dropped.includes(k), `${k} 已被消费（映射进白名单字段），不该出现在丢弃列表`);
  }
  assert.ok(dropped.includes('uid'), '未消费的 uid 仍应被报出');
});

check('合规：recommend_count / admire_count 已纳入丢弃清单', () => {
  const { compliance } = E.auditDropped(
    { statistics: { recommend_count: 1343, admire_count: 7, digg_count: 100 } },
    WHITELIST.video
  );
  const fields = compliance.map((c) => c.field);
  assert.ok(fields.includes('statistics.recommend_count'));
  assert.ok(fields.includes('statistics.admire_count'));
  assert.ok(!fields.includes('statistics.digg_count'), 'digg_count 是公开数据，不该被拦');
});

check('账号：@ 提及别人的昵称不应被当成自己的身份表述', () => {
  // 实测踩坑：简介里 "兄弟：@小徐老师🚴（骑车仔）" 命中关键词"老师"，
  // 被误当成账号本人的身份。实际那是 @ 提及，不是身份自述。
  const bio = '我爱骑车，单纯瘾大\n轮组：Scom Voso\n兄弟：@小徐老师🚴（骑车仔）\n日常：@洋芋的朋友圈';
  const a = E.extractAccount({ ...MOCK_USER, signature: bio }, 'u');
  assert.strictEqual(a.identity_text, null, '@ 提及段不应产生 identity_text');
  assert.strictEqual(a.field_status.identity_text, STATUS.NOT_VISIBLE);
});

check('账号：真身份表述仍应被抄出（排除规则不能误伤）', () => {
  const a = E.extractAccount({ ...MOCK_USER, signature: '骑行装备操盘手；联系助理@小王' }, 'u');
  assert.ok(a.identity_text && a.identity_text.includes('操盘手'), '身份主述应保留');
  assert.ok(!a.identity_text.includes('@小王'), '提及段应被剔除');
});

check('账号：企业号但无认证标识时，verification 为空但 enterprise_account 为真', () => {
  // 实测踩坑：账号「薛辉小清新」custom_verify / enterprise_verify_reason 均为空、
  // verification_type=0，但 enterprise_user_info.permissions 有视频电商等权限。
  // 旧的人工截图报告把这种情况误写成"已认证（蓝V）"。
  const u = {
    ...MOCK_USER,
    custom_verify: '',
    enterprise_verify_reason: '',
    verification_type: 0,
    enterprise_user_info: {
      permissions: [{ Name: '视频电商' }, { Name: '直播电商' }, { Name: '个人橱窗' }],
    },
  };
  const a = E.extractAccount(u, 'u');
  assert.strictEqual(a.verification, null, '没有认证标识时 verification 必须为空');
  assert.strictEqual(a.enterprise_account, true, '有企业权限时应标为企业号');
  assert.deepStrictEqual(a.enterprise_shop_permissions, ['视频电商', '直播电商', '个人橱窗']);
});

check('账号：非企业号的 enterprise_shop_permissions 为空数组，不编造', () => {
  const a = E.extractAccount({ ...MOCK_USER, enterprise_user_info: undefined }, 'u');
  assert.strictEqual(a.enterprise_account, false);
  assert.deepStrictEqual(a.enterprise_shop_permissions, []);
});

check('账号：enterprise_user_info 是 JSON 字符串形态时也能正确解析', () => {
  // 实测：抖音这个字段下发的是 string，不是 object。
  // 上一版直接按对象路径取值，静默拿到 undefined，表现为 enterprise_account=false（采空了）。
  const u = {
    ...MOCK_USER,
    enterprise_user_info: JSON.stringify({
      permissions: [{ Id: 3, Name: '视频电商' }, { Id: 4, Name: '直播电商' }, { Id: 5, Name: '个人橱窗' }],
    }),
  };
  const a = E.extractAccount(u, 'u');
  assert.strictEqual(a.enterprise_account, true, 'JSON 字符串形态必须也能解析出来');
  assert.deepStrictEqual(a.enterprise_shop_permissions, ['视频电商', '直播电商', '个人橱窗']);
});

check('账号：enterprise_user_info 是对象形态时同样能解析', () => {
  const u = { ...MOCK_USER, enterprise_user_info: { permissions: [{ Name: '视频电商' }] } };
  const a = E.extractAccount(u, 'u');
  assert.strictEqual(a.enterprise_account, true);
  assert.deepStrictEqual(a.enterprise_shop_permissions, ['视频电商']);
});

check('账号：enterprise_user_info 是坏 JSON 字符串时不抛错、不编造', () => {
  const u = { ...MOCK_USER, enterprise_user_info: '{不是合法JSON' };
  const a = E.extractAccount(u, 'u');
  assert.strictEqual(a.enterprise_account, false);
  assert.deepStrictEqual(a.enterprise_shop_permissions, []);
});

console.log(`\n结果: ${pass} 通过 / ${fail} 失败\n`);
process.exitCode = fail === 0 ? 0 : 1;
