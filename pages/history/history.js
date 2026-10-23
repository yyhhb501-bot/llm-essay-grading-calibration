/**
 * pages/history/history —— 批改与对话历史（方案 §4「历史」页）
 *
 * 职责：类型筛选（全部/批改/对话）、列表（标题/时间/摘要）、点击回看、长按删除、空态引导。
 *
 * 依赖签名（均已核对源码）：
 *   storage.filterHistory('all'|'grade'|'chat') -> Array<{id,type,title,time,payload}>
 *   storage.removeHistory(id) -> Array
 *   storage.getHistory() -> Array
 *   format.fromNow(time) / format.formatTime(time) / format.brief(text, len)
 *
 * 记录结构由批改页与解题页写入（storage.addHistory），payload 字段以各页实际写入为准；
 * 这里用 pickSummary 做多字段兜底取摘要，避免因字段名不一致而显示空白。
 */

var storage = require('../../utils/storage.js');
var format = require('../../utils/format.js');

/** 筛选标签 */
var FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'grade', label: '批改' },
  { key: 'chat', label: '对话' }
];

/** 摘要最大字数 */
var SUMMARY_LEN = 48;

/**
 * 从 payload 里尽力取一段可读摘要
 * @param {object} item 历史条目
 * @returns {string}
 */
function pickSummary(item) {
  var p = (item && item.payload) || {};
  // 对话记录没有单独的摘要字段（pages/chat/chat.js 写入的是 messages 数组），
  // 取第一条用户提问当摘要，否则每条对话都会显示同一句「解题对话记录」
  if (Array.isArray(p.messages)) {
    for (var i = 0; i < p.messages.length; i++) {
      var msg = p.messages[i];
      if (msg && msg.role === 'user' && typeof msg.content === 'string' && msg.content.trim()) {
        return format.brief(msg.content, SUMMARY_LEN);
      }
    }
  }
  var candidates = [
    p.summary,
    p.preview,
    p.brief,
    p.answer,
    p.question,
    p.content,
    p.title,
    p.firstQuestion,
    p.lastAnswer,
    p.report
  ];
  for (var i = 0; i < candidates.length; i++) {
    var v = candidates[i];
    if (typeof v === 'string' && v.replace(/\s+/g, '').length > 0) {
      return format.brief(v, SUMMARY_LEN);
    }
  }
  return item && item.type === 'chat' ? '解题对话记录' : '申论批改记录';
}

/** 把一条历史转成列表展示对象 */
function toViewItem(item) {
  var p = (item && item.payload) || {};
  var scores = p.scores;
  var scoreText = '';
  var gradeLabel = '';
  if (scores && isFinite(Number(scores.total))) {
    scoreText = Number(scores.total) + '分';
    gradeLabel = scores.grade || '';
  }
  return {
    id: item.id,
    type: item.type,
    typeLabel: item.type === 'chat' ? '对话' : '批改',
    title: item.title || (item.type === 'chat' ? '解题对话' : '申论批改'),
    timeText: format.fromNow(item.time),
    fullTime: format.formatTime(item.time),
    summary: pickSummary(item),
    scoreText: scoreText,
    gradeLabel: gradeLabel
  };
}

Page({
  data: {
    filters: FILTERS,
    filter: 'all',
    list: [],
    total: 0,
    empty: false
  },

  onShow: function () {
    // 每次进入都刷新，便于回看后删除的结果立即反映
    this.loadList();
  },

  /** 读取并渲染列表 */
  loadList: function () {
    var all = storage.filterHistory('all');
    var list = storage.filterHistory(this.data.filter).map(toViewItem);
    this.setData({
      list: list,
      total: all.length,
      empty: list.length === 0
    });
  },

  /** 切换筛选 */
  onFilterTap: function (e) {
    var key = e.currentTarget.dataset.key;
    if (!key || key === this.data.filter) return;
    this.setData({ filter: key });
    this.loadList();
  },

  /** 点击记录：批改进结果页，对话进解题页 */
  onItemTap: function (e) {
    // 防止长按手指抬起时误触 tap 跳转
    if (this._longPressAt && Date.now() - this._longPressAt < 500) {
      return;
    }
    var id = e.currentTarget.dataset.id;
    var type = e.currentTarget.dataset.type;
    if (!id) return;
    if (type === 'chat') {
      var app = getApp();
      if (app && app.globalData) app.globalData.chatViewId = id;
      wx.switchTab({ url: '/pages/chat/chat' });
      return;
    }
    wx.navigateTo({ url: '/pages/result/result?id=' + id });
  },

  /** 长按删除单条 */
  onItemLongPress: function (e) {
    this._longPressAt = Date.now();
    var id = e.currentTarget.dataset.id;
    var title = e.currentTarget.dataset.title || '这条记录';
    if (!id) return;
    var self = this;
    wx.showModal({
      title: '删除记录',
      content: '确定删除「' + title + '」吗？删除后不可恢复。',
      confirmText: '删除',
      confirmColor: '#B03A2E',
      cancelText: '取消',
      success: function (res) {
        if (!res.confirm) return;
        storage.removeHistory(id);
        self.loadList();
        wx.showToast({ title: '已删除', icon: 'none', duration: 1200 });
      }
    });
  },

  /** 空态：去批改（批改页是 tabBar 页，必须 switchTab，navigateTo 打不开） */
  onGoGrade: function () {
    wx.switchTab({ url: '/pages/grade/grade' });
  },

  /** 空态：去解题 */
  onGoChat: function () {
    wx.switchTab({ url: '/pages/chat/chat' });
  },

  /** 清空全部历史（带确认弹窗） */
  onClearAll: function () {
    var self = this;
    wx.showModal({
      title: '清空历史',
      content: '将删除本机保存的全部批改与对话记录，且不可恢复，确认继续？',
      confirmText: '清空',
      confirmColor: '#B03A2E',
      cancelText: '取消',
      success: function (res) {
        if (!res.confirm) return;
        storage.clearHistory();
        self.loadList();
        wx.showToast({ title: '已清空', icon: 'none', duration: 1200 });
      }
    });
  }
});