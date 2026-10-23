/**
 * app.js —— 小程序入口
 * 启动时从本地存储读取模型配置、自定义 Skill、历史记录、备考计划到 globalData，
 * 供各页面直接读取，避免每页重复读 storage。
 */

var storage = require('./utils/storage.js');
var auth = require('./utils/auth.js');

App({
  globalData: {
    // 模型接入配置 {presetId, baseURL, apiKey, model}
    config: null,
    // 自定义 Skill 覆盖 {enabled, text}
    skillCustom: null,
    // 历史记录（新的在前，封顶 50 条）
    history: [],
    // 备考计划 {form, content, checkins}
    plan: null,
    // 启动时间戳
    launchAt: 0,
    // 批改页的流式请求 {task, recordId}，结果页 onUnload 据此中止（pages/grade/grade.js）
    gradeStream: null,
    // 结果页「再批一篇」时置位，批改页 onShow 读到后清空表单
    gradeReset: false,
    // 结果页退出中止了共享流时置位，批改页 onShow 读到后放开提交按钮
    gradeStreamStopped: false,
    // 真题页「去作答」传题目 id（tabBar 页带不了 query，批改页 onShow 取用）
    gradePrefillId: '',
    gradePrefillPayload: null,
    // 首页/历史页回看某段对话时传记录 id（解题页 onShow 取用）
    chatViewId: ''
  },

  onLaunch: function () {
    if (typeof wx.onNeedPrivacyAuthorization === 'function') {
      wx.onNeedPrivacyAuthorization(function (resolve) {
        var pages = getCurrentPages();
        var current = pages[pages.length - 1];
        var dialog = current && current.selectComponent('#privacy-dialog');
        if (dialog) dialog.requestConsent(resolve);
        else resolve({ event: 'disagree' });
      });
    }
    this.globalData.launchAt = Date.now();
    this.refreshGlobalData();
  },

  onShow: function () {
    // 从后台回到前台时同步一次，保证历史记录等数据是新的
    this.refreshGlobalData();
    auth.refresh();
  },

  /**
   * 从 storage 重新装载 globalData，返回装载结果
   * @returns {{config:object, skillCustom:object, history:Array, plan:object}}
   */
  refreshGlobalData: function () {
    var data = {
      config: storage.getConfig(),
      skillCustom: storage.getSkillCustom(),
      history: storage.getHistory(),
      plan: storage.getPlan()
    };
    this.globalData.config = data.config;
    this.globalData.skillCustom = data.skillCustom;
    this.globalData.history = data.history;
    this.globalData.plan = data.plan;
    return data;
  },

  /** 便捷方法：是否已完成模型接入配置 */
  isConfigured: function () {
    var c = storage.getConfig();
    this.globalData.config = c;
    return !!auth.getSession() || !!(c && c.baseURL && c.apiKey && c.model &&
      String(c.baseURL).trim() && String(c.apiKey).trim() && String(c.model).trim());
  }
});
