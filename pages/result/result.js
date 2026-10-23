/**
 * pages/result/result.js —— 批改结果页（方案 §4 结果页）
 *
 * 职责：
 *   1. onLoad(options.id) 从 utils/storage.js 读回该条 grade 记录；
 *   2. 顶部分数卡：本文件内实现 parseScores(text)（取文本中最后一个 ```scores 围栏的 JSON）
 *      → total / grade / dimensions，总分大数字朱红 + 五维分数条；
 *   3. 批改报告正文用 utils/md.js 解析成块数组渲染；流式期间每 300ms 节流重解析，onDone 后最终解析；
 *   4. 批注列表卡（quote 引文 + type 标签 + comment + suggestion）与升格示范；
 *   5. 底部：复制全文（wx.setClipboardData）/ 再批一篇（回批改页）；
 *      未配置 API 时引导去设置页；流式失败给错误卡 + 重试；onUnload 里 RequestTask.abort()。
 *
 * 说明：流式请求由批改页发起并把累计文本写回 storage，本页以 300ms 轮询 storage 的方式
 *      跟随进度（这正是「流式期间每 300ms 节流重解析」的落点）；本页的「重试」会自己重新
 *      发起 chatStream 并覆盖同一条记录。
 */

var storage = require('../../utils/storage.js');
var api = require('../../utils/api.js');
var md = require('../../utils/md.js');
var format = require('../../utils/format.js');
var prompts = require('../../skill/prompts.js');
var refs = require('../../skill/references.js');
var privacy = require('../../utils/privacy.js');
var aigc = require('../../utils/aigc.js');

/** 流式期间的节流间隔（毫秒），方案 §4 要求 */
var STREAM_THROTTLE = 300;

/** 批注类型 → 标签配色 */
var ISSUE_TAG_CLASS = {
  '要点缺失': 'tag-red',
  '要点完整度': 'tag-red',
  '表述不规范': 'tag-gold',
  '语言规范': 'tag-gold',
  '逻辑': 'tag-ink',
  '逻辑结构': 'tag-ink',
  '政策素养': 'tag-gold',
  '卷面': 'tag-sub',
  '卷面格式': 'tag-sub'
};

Page({
  data: {
    id: '',
    ready: false,
    missing: false,
    needConfig: false,

    title: '',
    typeName: '',
    timeText: '',
    reportTab: 'all', // 'all' | 'issues' | 'upgrade'

    streaming: false,
    done: false,
    errorMsg: '',

    hasScore: false,
    totalText: '',
    gradeLabel: '',
    dimensions: [],
    issues: [],
    upgrade: '',

    blocks: [],
    rawText: '',
    charCount: 0,
    showPaper: false,
    paper: { question: '', material: '', answer: '' }
  },

  onLoad: function (options) {
    this._timer = null;
    this._task = null;
    this._lastText = '';
    this._retryPayload = null;
    var id = options && options.id ? decodeURIComponent(options.id) : '';
    this.setData({ id: id });
  },

  onShow: function () {
    if (!this.data.id) {
      this.setData({ ready: true, missing: true });
      return;
    }
    this.loadRecord();
  },

  onUnload: function () {
    this.stopPolling();
    this.abortStream();
  },

  // ---------------- 读取记录与渲染 ----------------

  loadRecord: function () {
    var cfg = storage.getConfig();
    var configured = api.isConfigured(cfg);
    this._configured = configured;
    var item = storage.getHistoryById(this.data.id);
    if (!item) {
      this.stopPolling();
      this.setData({
        ready: true,
        missing: true,
        needConfig: !configured,
        streaming: false
      });
      return;
    }
    this._retryPayload = item.payload || {};
    this.applyItem(item, configured);
  },

  /** 把一条 history 记录渲染进页面 */
  applyItem: function (item, configured) {
    var payload = item.payload || {};
    var text = payload.content || '';
    var status = payload.status || (text ? 'done' : '');
    var scores = parseScores(text) || payload.scores || null;
    var view = buildScoreView(scores);

    var streaming = status === 'streaming';
    var changed = text !== this._lastText;
    this._lastText = text;

    var patch = {
      ready: true,
      missing: false,
      needConfig: !configured,
      title: item.title || '申论批改',
      typeName: payload.questionType || '',
      timeText: format.formatTime(item.time),
      streaming: streaming,
      done: status === 'done' || (!streaming && !!text),
      errorMsg: payload.error || '',
      hasScore: view.hasScore,
      totalText: view.totalText,
      gradeLabel: view.gradeLabel,
      dimensions: view.dimensions,
      issues: view.issues,
      upgrade: view.upgrade,
      rawText: text,
      charCount: format.countWords(text),
      paper: {
        question: payload.question || '',
        material: payload.material || '',
        referenceAnswer: payload.referenceAnswer || '',
        answer: payload.answer || ''
      }
    };
    // 正文块只在新文本到达时重解析（300ms 节流），避免空转
    patch.blocks = changed ? buildBlocks(text) : this.data.blocks;
    this.setData(patch);

    if (streaming) this.startPolling();
    else this.stopPolling();
  },

  // ---------------- 300ms 节流轮询 ----------------

  startPolling: function () {
    if (this._timer) return;
    var self = this;
    this._timer = setInterval(function () {
      var item = storage.getHistoryById(self.data.id);
      if (!item) {
        self.stopPolling();
        return;
      }
      self.applyItem(item, self._configured);
      // applyItem 内部在 status 变为 done 时会停掉轮询（最终解析）
    }, STREAM_THROTTLE);
  },

  stopPolling: function () {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  },

  // ---------------- 交互 ----------------

  goSettings: function () {
    wx.navigateTo({ url: '/pages/settings/settings' });
  },

  onTogglePaper: function () {
    this.setData({ showPaper: !this.data.showPaper });
  },

  /** 复制报告全文（去掉 ```scores 结构化围栏，只留给人看的正文） */
  onCopy: function () {
    var self = this;
    // 剪贴板属隐私接口：先过隐私授权
    privacy.ensurePrivacy(function () {
      self.doCopy();
    }, '需要同意《用户隐私保护指引》后才能复制');
  },

  doCopy: function () {
    var text = stripScoresBlocks(this.data.rawText || '');
    if (!text.trim()) {
      wx.showToast({ title: '还没有可复制的内容', icon: 'none' });
      return;
    }
    // wx.setClipboardData 会自动弹出系统 Toast「内容已复制」，不重复弹自定义 Toast
    wx.setClipboardData({
      data: aigc.forClipboard(text),
      fail: function () {
        wx.showToast({ title: '复制失败，请手动长按选择', icon: 'none' });
      }
    });
  },

  onReportTab: function (e) {
    var tab = e.currentTarget.dataset.tab;
    if (tab) this.setData({ reportTab: tab });
  },

  /** 再批一篇：回到批改页（tabBar 页，用 switchTab）并清空表单 */
  onGradeAnother: function () {
    var app = getApp();
    if (app && app.globalData) {
      app.globalData.gradeReset = true;
      app.globalData.gradeStreamStopped = true;
      if (app.globalData.gradeStream) {
        app.globalData.gradeStream = null;
      }
    }
    this.stopPolling();
    wx.switchTab({
      url: '/pages/grade/grade',
      fail: function () {
        wx.showToast({ title: '返回批改页失败', icon: 'none' });
      }
    });
  },

  /** 错误卡上的重试：用记录里的题目/作答重新发起一次流式批改 */
  onRetry: function () {
    if (this._task) return;
    var cfg = storage.getConfig();
    if (!api.isConfigured(cfg)) {
      this.setData({ needConfig: true });
      wx.showToast({ title: '请先配置模型', icon: 'none' });
      return;
    }
    var itemObj = storage.getHistoryById(this.data.id);
    var payload = this._retryPayload || (itemObj && itemObj.payload) || {};
    var question = (payload.question || '').trim();
    var answer = (payload.answer || '').trim();
    if (!question || !answer) {
      wx.showModal({
        title: '无法重试',
        content: '这条记录里没有保存完整的题目与作答，请回批改页重新提交一次。',
        showCancel: false,
        confirmText: '知道了'
      });
      return;
    }

    var self = this;
    var id = this.data.id;
    var messages = buildMessages(payload);
    var full = '';
    var lastFlush = 0;

    this.setData({ streaming: true, errorMsg: '', done: false });
    this._lastText = '';
    this.writeBack(id, '', '', 'streaming'); // 清空上一轮内容，避免新旧混排
    var task = api.chatStream(cfg, messages, {
      onDelta: function (delta) {
        full += delta;
        var now = Date.now();
        if (now - lastFlush < STREAM_THROTTLE) return;
        lastFlush = now;
        self.writeBack(id, full, '', 'streaming');
        self.setData({
          blocks: buildBlocks(full),
          rawText: full,
          charCount: format.countWords(full),
          streaming: true,
          errorMsg: ''
        });
      },
      onDone: function (doneText) {
        self.writeBack(id, doneText || full, '', 'done');
        var item = storage.getHistoryById(id);
        if (item) self.applyItem(item, self._configured);
      },
      onError: function (msg) {
        self.writeBack(id, full, msg, 'error');
        var item = storage.getHistoryById(id);
        if (item) self.applyItem(item, self._configured);
      }
    });
    this._task = task || null;
  },

  /** 重试期间把累计文本写回同一条记录（沿用批改页的记录，不新建） */
  writeBack: function (id, text, error, status) {
    var item = storage.getHistoryById(id);
    if (!item) return;
    var payload = item.payload || {};
    payload.content = text;
    payload.updatedAt = Date.now();
    payload.error = error || '';
    if (status) payload.status = status;
    if (status === 'done') {
      payload.scores = parseScores(text);
      payload.error = '';
    }
    storage.updateHistory(id, { payload: payload });
  },

  abortStream: function () {
    if (this._task) {
      try {
        this._task.abort();
      } catch (e) {
        console.error('[result] 中止请求失败：', e);
      }
      this._task = null;
    }
    // 批改页发起的同一条流也一并中止（recordId 对得上才动）
    var app = getApp();
    var g = app && app.globalData;
    if (g && g.gradeStream && g.gradeStream.recordId === this.data.id) {
      if (g.gradeStream.task) {
        try {
          g.gradeStream.task.abort();
        } catch (e) {
          console.error('[result] 中止共享流失败：', e);
        }
      }
      g.gradeStream = null;
      g.gradeStreamStopped = true;
      // 把记录从 streaming 落回 error，否则历史里会永远停在「批改中」
      var item = storage.getHistoryById(this.data.id);
      if (item && (item.payload || {}).status === 'streaming') {
        this.writeBack(this.data.id, (item.payload || {}).content || '',
          '批改被中断（离开了结果页），已保留已生成的内容，可点重试重新批改。', 'error');
      }
    }
  }
});

// ---------------- 模块内纯函数 ----------------

/**
 * 解析文本中最后一个 ```scores 围栏里的 JSON。
 * 流式期间围栏可能还没闭合，JSON 解析失败一律返回 null。
 * @param {string} text
 * @returns {object|null}
 */
function parseScores(text) {
  if (!text) return null;
  var s = String(text);
  var marker = '```scores';
  var start = s.toLowerCase().lastIndexOf(marker); // 取最后一个围栏
  if (start === -1) return null;
  var bodyStart = start + marker.length;
  var end = s.indexOf('```', bodyStart);
  var body = (end === -1 ? s.slice(bodyStart) : s.slice(bodyStart, end)).trim();
  if (!body) return null;
  body = body.replace(/^json\s*/i, '');
  body = body.replace(/,\s*([}\]])/g, '$1'); // 容忍模型多写的尾随逗号
  try {
    var obj = JSON.parse(body);
    return (obj && typeof obj === 'object') ? obj : null;
  } catch (e) {
    return null;
  }
}

/**
 * 去掉正文里所有 ```scores 围栏（模型偶尔会吐两遍，复制给人看时不能带 JSON）。
 * @param {string} text
 * @returns {string}
 */
function stripScoresBlocks(text) {
  var s = String(text == null ? '' : text);
  var out = '';
  var guard = 0;
  while (guard++ < 20) {
    var start = s.toLowerCase().indexOf('```scores');
    if (start === -1) break;
    var bodyStart = start + '```scores'.length;
    var end = s.indexOf('```', bodyStart);
    if (end === -1) { // 围栏没闭合，流式中途复制
      out += s.slice(0, start);
      return out;
    }
    out += s.slice(0, start);
    s = s.slice(end + 3);
  }
  return out + s;
}

/**
 * 解析 markdown 并补上 WXML 需要的稳定 key（块与行内片段各一层）。
 * @param {string} text
 * @returns {Array}
 */
function buildBlocks(text) {
  var blocks = md.parseBlocks(text);
  var out = [];
  for (var i = 0; i < blocks.length; i++) {
    var b = blocks[i] || {};
    var segs = [];
    var raw = b.segments || [];
    for (var j = 0; j < raw.length; j++) {
      segs.push({
        key: 'seg_' + i + '_' + j,
        text: String(raw[j] ? raw[j].text : ''),
        bold: !!(raw[j] && raw[j].bold)
      });
    }
    out.push({
      key: 'blk_' + i,
      type: b.type,
      text: String(b.text == null ? '' : b.text),
      segments: segs
    });
  }
  return out;
}

/** 组装重试用的 messages（与批改页保持一致的分段格式） */
function buildMessages(payload) {
  var skill = storage.getSkillCustom();
  var system = (skill && skill.enabled && skill.text) ? skill.text : prompts.GRADE_PROMPT;
  var guifan = refs.REF && refs.REF['guifan-biaoda'];
  if (!(skill && skill.enabled && skill.text) && typeof guifan === 'string' && guifan) {
    system += '\n\n【规范表达速查】评「语言规范」与给修改建议时参考：\n' + guifan;
  }
  if (!(skill && skill.enabled && skill.text)) system += '\n\n' + prompts.QUALITY_RULES;
  var user = [
    '【题型】' + (payload.questionType || '归纳概括'),
    '【题目】' + (payload.question || ''),
    '【给定资料】' + (payload.material ? payload.material : '（未提供）'),
    '【参考答案】' + (payload.referenceAnswer || '（未提供）'),
    '【考生作答】' + (payload.answer || '')
  ].join('\n\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: user }
  ];
}

/** 把 scores 对象整理成页面要的视图数据 */
function buildScoreView(scores) {
  var out = {
    hasScore: false,
    totalText: '—',
    gradeLabel: '',
    dimensions: [],
    issues: [],
    upgrade: ''
  };
  if (!scores || typeof scores !== 'object') return out;
  if (scores.total == null || scores.total === '') return out;

  var dims = [];
  var sum = 0;
  var hasDims = false;
  var list = Array.isArray(scores.dimensions) ? scores.dimensions : [];
  for (var i = 0; i < list.length; i++) {
    var d = list[i] || {};
    var name = String(d.name == null ? '' : d.name).trim() || ('维度' + (i + 1));
    var score = Number(d.score);
    if (!isFinite(score)) score = 0;
    var max = Number(d.max);
    if (!isFinite(max) || max <= 0) max = 100;
    sum += score;
    hasDims = true;
    dims.push({
      key: 'dim_' + i,
      name: name,
      scoreText: format.formatScore(score),
      max: max,
      percent: Math.max(0, Math.min(100, Math.round((score / max) * 100))),
      comment: String(d.comment == null ? '' : d.comment)
    });
  }

  var total = Number(scores.total);
  if (!isFinite(total) && hasDims) total = sum;
  if (isFinite(total)) {
    out.totalText = String(Math.round(total * 10) / 10);
    out.hasScore = true;
  }
  out.gradeLabel = String(scores.grade == null ? '' : scores.grade).trim();
  out.dimensions = dims;

  var issues = Array.isArray(scores.issues) ? scores.issues : [];
  var view = [];
  for (var k = 0; k < issues.length; k++) {
    var it = issues[k] || {};
    var type = String(it.type == null ? '' : it.type).trim();
    view.push({
      key: 'issue_' + k,
      quote: String(it.quote == null ? '' : it.quote),
      type: type,
      tagClass: ISSUE_TAG_CLASS[type] || 'tag-sub',
      comment: String(it.comment == null ? '' : it.comment),
      suggestion: String(it.suggestion == null ? '' : it.suggestion)
    });
  }
  out.issues = view;
  out.upgrade = String(scores.upgrade == null ? '' : scores.upgrade);
  return out;
}
