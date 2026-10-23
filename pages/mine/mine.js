/**
 * pages/mine/mine —— 我的（方案 §4「我的」页）
 *
 * 职责：统计卡（累计批改篇数 / 最近平均分）；列表入口
 * （模型设置 / 批改历史 / 清空历史(确认弹窗) / 关于(免责声明))。
 *
 * 依赖签名（均已核对源码）：
 *   storage.filterHistory('grade') -> Array      批改记录，payload.scores 为结构化分数
 *   storage.clearHistory()         -> []
 *   storage.getConfig()            -> {presetId, baseURL, apiKey, model}
 *   format.formatScore(n)         -> string      一位小数，无数据返回「—」
 *   prompts.SKILL_VERSION / SKILL_META           关于弹窗的版本与免责声明
 *
 * 关于分数来源：批改页流式结束后把解析出的 scores 写回 payload.scores
 * （pages/grade/grade.js 落库字段），这里优先读它；历史里若是早期记录没有 scores，
 * 则回退解析正文里最后一个 ```scores 围栏（与结果页 parseScores 同一约定）。
 */

var storage = require('../../utils/storage.js');
var format = require('../../utils/format.js');
var md = require('../../utils/md.js');
var prompts = require('../../skill/prompts.js');
var modelRequest = require('../../utils/model-request.js');
var auth = require('../../utils/auth.js');
var api = require('../../utils/api.js');

/** 计算「最近平均分」时最多取最近多少篇 */
var AVG_SAMPLE = 10;

/** 从一条批改记录里取总分，取不到返回 null */
function pickTotal(item) {
  var p = (item && item.payload) || {};
  var scores = p.scores;
  if (scores && isFinite(Number(scores.total))) return Number(scores.total);
  var fromText = md.parseScores(p.content || '');
  if (fromText && isFinite(Number(fromText.total))) return Number(fromText.total);
  return null;
}

Page({
  data: {
    authenticated: false,
    accountName: '',
    gradeCount: 0,
    chatCount: 0,
    avgScoreText: '—',
    avgLabelText: '最近平均分',
    scoredCount: 0,
    configured: false,
    configText: '尚未配置模型',
    skillVersion: '',
    disclaimer: ''
  },

  onShow: function () {
    var session = auth.getSession();
    this.setData({ authenticated: !!session, accountName: session ? session.user.username : '' });
    // 每次进入刷新，批改完返回立即看到最新统计；
    // 同时刷新模型配置状态——本页是 tabBar 页，onLoad 只跑一次，
    // 用户在设置页配好模型回来时，不刷新会一直显示「尚未配置模型」。
    this.loadStats();
    this.loadConfigStatus();
  },

  /** 模型配置状态（列表入口右侧文案） */
  loadConfigStatus: function () {
    var cfg = storage.getConfig();
    var configured = api.isConfigured(cfg);
    this.setData({
      configured: configured,
      configText: configured ? (cfg.apiKey ? cfg.model + ' · 自带密钥' : '账号共享模型') : '登录账号或配置模型'
    });
  },

  onGoAccount: function () { wx.navigateTo({ url: '/pages/account/account' }); },
  onChangePassword: function () { wx.navigateTo({ url: '/pages/account/account?mode=password' }); },
  onLogout: function () {
    var session = auth.getSession();
    var token = session && session.token;
    if (!token) return;
    wx.showModal({
      title: '退出账号', content: '将撤销当前会话并回到未登录本机模式。此账号的本机记录保留，其他账号无法查看。',
      success: function (res) {
        if (!res.confirm) return;
        auth.logout(false, token).catch(function (error) {
          wx.showModal({ title: '服务端退出未完成', content: error.message + ' 可重试；也可仅清除此设备登录，服务端会话会保留至到期。',
            confirmText: '本机退出', success: function (answer) {
              if (answer.confirm) auth.logout(true, token).catch(function (err) { wx.showToast({ title: err.message, icon: 'none' }); });
            }
          });
        });
      }
    });
  },

  /** 统计卡：累计批改篇数 / 最近平均分 */
  loadStats: function () {
    var grades = storage.filterHistory('grade');
    var chats = storage.filterHistory('chat');

    var totals = [];
    for (var i = 0; i < grades.length && totals.length < AVG_SAMPLE; i++) {
      var t = pickTotal(grades[i]);
      if (t !== null) totals.push(t);
    }
    var sum = 0;
    for (var j = 0; j < totals.length; j++) sum += totals[j];

    this.setData({
      gradeCount: grades.length,
      chatCount: chats.length,
      avgScoreText: totals.length ? format.formatScore(sum / totals.length) : '—',
      avgLabelText: totals.length ? '最近平均分（' + totals.length + ' 篇）' : '最近平均分',
      scoredCount: totals.length
    });
  },

  /** 模型设置 */
  onGoService: function () {
    wx.navigateTo({ url: '/pages/service/service' });
  },

  onRevokeModelConsent: function () {
    wx.showModal({
      title: '撤回数据传输同意',
      content: '下一次模型请求将重新询问。已经发送给服务商的数据不会因此删除。',
      success: function (res) {
        if (!res.confirm) return;
        try {
          modelRequest.abortAll();
          wx.removeStorageSync(storage.scopeKey(modelRequest.CONSENT_KEY));
          wx.showToast({ title: '已撤回', icon: 'none' });
        } catch (e) { wx.showToast({ title: '操作失败，请重试', icon: 'none' }); }
      }
    });
  },

  onDeleteLocalData: function () {
    wx.showModal({
      title: '删除全部本地数据',
      content: '将退出当前账号，并删除此设备所有账号及未登录模式的密钥、设置、历史、计划与传输同意，无法恢复。服务器账号和服务商端数据不会因此删除。',
      confirmText: '删除',
      confirmColor: '#B03A2E',
      success: function (res) {
        if (!res.confirm) return;
        auth.deleteLocalData().then(function (revoked) {
          wx.showModal({ title: '本机数据已删除', showCancel: false,
            content: revoked ? '此设备的全部账号缓存、配置、历史和计划已删除。服务器账号仍然保留。' :
              '本机数据已删除，但服务端会话撤销未确认，将在到期后失效。服务器账号仍然保留。'
          });
        }).catch(function (error) { wx.showToast({ title: error.message || '删除未完成，请重试', icon: 'none' }); });
      }
    });
  },

  onGoSettings: function () {
    wx.navigateTo({ url: '/pages/settings/settings' });
  },

  /** 批改历史 */
  onGoHistory: function () {
    wx.navigateTo({ url: '/pages/history/history' });
  },

  /** 备考计划（tabBar 外的普通页） */
  onGoStudy: function () {
    wx.navigateTo({ url: '/pages/study/study' });
  },

  /** 清空历史（二次确认） */
  onClearHistory: function () {
    var self = this;
    if (this.data.gradeCount + this.data.chatCount === 0) {
      wx.showToast({ title: '暂无记录', icon: 'none', duration: 1200 });
      return;
    }
    wx.showModal({
      title: '清空历史',
      content: '将删除本机保存的全部批改与对话记录，且不可恢复，确认继续？',
      confirmText: '清空',
      confirmColor: '#B03A2E',
      cancelText: '取消',
      success: function (res) {
        if (!res.confirm) return;
        storage.clearHistory();
        var app = getApp();
        if (app && typeof app.refreshGlobalData === 'function') {
          app.refreshGlobalData();
        }
        self.loadStats();
        wx.showToast({ title: '已清空', icon: 'none', duration: 1200 });
      }
    });
  },

  /** 关于：版本 + 免责声明 */
  onShowAbout: function () {
    wx.showModal({
      title: '关于作文批改大人',
      content: '版本 ' + (this.data.skillVersion || '1.0.0') + '\n' + this.data.disclaimer,
      showCancel: false,
      confirmText: '知道了',
      confirmColor: '#B03A2E'
    });
  },

  onLoad: function () {
    this.setData({
      skillVersion: prompts.SKILL_VERSION,
      disclaimer: prompts.SKILL_META.disclaimer
    });
  }
});
