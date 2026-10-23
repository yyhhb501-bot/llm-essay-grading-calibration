/**
 * pages/index/index —— 首页（方案 §4「首页」页）
 *
 * 职责：品牌区「申论朱批」+ 今日金句（内置数组按天轮换）、四宫格入口
 * （智能批改/解题陪练/真题练习/备考计划）、最近记录（读历史，空态文案
 * 「还没有批改记录，去写第一篇吧」）。
 *
 * 依赖签名（均已核对源码）：
 *   storage.filterHistory('all') -> Array<{id,type,title,time,payload}>
 *   format.todayOf(list)         -> string   按天轮换，同一天同一句
 *   format.fromNow(time)         -> string
 *   format.brief(text, len)      -> string
 *
 * 跳转说明：grade / chat 是 app.json 里的 tabBar 页，必须用 wx.switchTab；
 * papers / study / result 是普通页，用 wx.navigateTo（见 app.json:26-50）。
 */

var storage = require('../../utils/storage.js');
var format = require('../../utils/format.js');

/** 今日金句：内置数组，按天轮换（format.todayOf） */
var QUOTES = [
  '申论不是写得多，是要点写得准。',
  '归纳概括先找点，再加工；先分类，再成文。',
  '大作文的分论点，永远长在材料里。',
  '对策题三条腿：主体、手段、效果，缺一不可。',
  '综合分析别急着下结论，先答「是什么—为什么—怎么办」。',
  '卷面分是白送给你的，别丢。',
  '公文写作先定文种，再定格式，最后填内容。',
  '每天一篇，比考前一周刷十篇有用。'
];

/** 四宫格入口；url 以 key 形式给出，实际跳转在 onEntranceTap 里按类型分发 */
var ENTRANCES = [
  { key: 'grade', icon: '批', title: '申论批改', desc: '申论专项评分与逐句建议' },
  { key: 'chat', icon: '讲', title: '解题陪练', desc: '名师方法随时问' },
  { key: 'papers', icon: '题', title: '试卷练习', desc: '收录试卷与离线示例' },
  { key: 'study', icon: '规', title: '备考计划', desc: '按周打卡推进' }
];

/** 首页最近记录最多展示条数 */
var RECENT_LIMIT = 3;

/** 从 payload 里取一段可读摘要（字段兜底，避免显示空白） */
function pickSummary(item) {
  var p = (item && item.payload) || {};
  // 对话记录存的是 messages 数组，没有摘要字段，取第一条用户提问当摘要
  if (Array.isArray(p.messages)) {
    for (var m = 0; m < p.messages.length; m++) {
      var msg = p.messages[m];
      if (msg && msg.role === 'user' && typeof msg.content === 'string' && msg.content.trim()) {
        return format.brief(msg.content, 40);
      }
    }
  }
  var candidates = [p.summary, p.preview, p.answer, p.question, p.content, p.title];
  for (var i = 0; i < candidates.length; i++) {
    var v = candidates[i];
    if (typeof v === 'string' && v.replace(/\s+/g, '').length > 0) {
      return format.brief(v, 40);
    }
  }
  return item && item.type === 'chat' ? '解题对话记录' : '申论批改记录';
}

/** 一条历史 → 首页展示对象 */
function toRecent(item) {
  return {
    id: item.id,
    type: item.type,
    typeLabel: item.type === 'chat' ? '对话' : '批改',
    title: item.title || (item.type === 'chat' ? '解题对话' : '申论批改'),
    timeText: format.fromNow(item.time),
    summary: pickSummary(item)
  };
}

Page({
  data: {
    quote: '',
    entrances: ENTRANCES,
    recent: [],
    recentCount: 0,
    hasRecent: false
  },

  onShow: function () {
    // 每次进入都刷新，保证跨天金句更新且最近记录立刻可见
    this.setData({ quote: format.todayOf(QUOTES) });
    this.loadRecent();
  },

  /** 读取历史并截取最近几条 */
  loadRecent: function () {
    var all = storage.filterHistory('all');
    var recent = all.slice(0, RECENT_LIMIT).map(toRecent);
    this.setData({
      recent: recent,
      recentCount: all.length,
      hasRecent: all.length > 0
    });
  },

  onLoad: function () {
    this.setData({ quote: format.todayOf(QUOTES) });
  },

  /** 四宫格入口跳转 */
  onEntranceTap: function (e) {
    var key = e.currentTarget.dataset.key;
    if (key === 'grade') {
      wx.switchTab({ url: '/pages/grade/grade' });
      return;
    }
    if (key === 'chat') {
      wx.switchTab({ url: '/pages/chat/chat' });
      return;
    }
    if (key === 'papers') {
      wx.navigateTo({ url: '/pages/papers/papers' });
      return;
    }
    if (key === 'study') {
      wx.navigateTo({ url: '/pages/study/study' });
    }
  },

  /** 最近记录点击：批改进结果页，对话进解题页 */
  onRecentTap: function (e) {
    var id = e.currentTarget.dataset.id;
    var type = e.currentTarget.dataset.type;
    if (!id) return;
    if (type === 'chat') {
      // chat 是 tabBar 页，不能带参数 navigateTo；借 globalData 传 id 后 switchTab，
      // 由 chat 页 onShow 取用并进入只读回看
      var app = getApp();
      if (app && app.globalData) app.globalData.chatViewId = id;
      wx.switchTab({ url: '/pages/chat/chat' });
      return;
    }
    wx.navigateTo({ url: '/pages/result/result?id=' + id });
  },

  /** 查看全部记录 */
  onViewAll: function () {
    wx.navigateTo({ url: '/pages/history/history' });
  },

  /** 空态：去写第一篇 */
  onGoGrade: function () {
    wx.switchTab({ url: '/pages/grade/grade' });
  }
});
