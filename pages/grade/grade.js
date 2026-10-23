/**
 * pages/grade/grade.js —— 智能批改页（方案 §4 批改页）
 *
 * 职责：
 *   1. 题型 picker（归纳概括/综合分析/提出对策/公文写作/文章写作）+ 题目 / 给定资料 / 我的作答三个输入区，
 *      我的作答实时统计中文字数（utils/format.js countWords）；
 *   2. 支持 onLoad(options.id) 从 data/papers.js 预填真题（deepFind 容错查找，题库字段名变化也不怕）；
 *   3. 「开始批改」：校验非空 → 组装 messages（system 取 skill/prompts.js 的 GRADE_PROMPT，
 *      若 storage 里的自定义 Skill 开启则用自定义文本覆盖）→ 先写 history 拿到 id →
 *      wx.navigateTo 到结果页 → 在本页发起 utils/api.js 的 chatStream，
 *      onDelta 把累计文本节流写回 storage 中该记录。
 *   4. 「拍照识别」（方案 §4.5）：showActionSheet 选拍照/相册 → chooseMedia → compressImage(quality 50)
 *      → readFile(base64) → 大小校验 → utils/api.js 的 transcribeSheet 流式转录，
 *      完成后把文本填入「我的作答」框（已有内容则空行追加）。
 *
 * 约定：
 *   - 只依赖 utils/storage.js、utils/api.js、utils/format.js、utils/md.js、skill/prompts.js，
 *     data/papers.js 用 try/catch 延迟 require（题库尚未就位时不阻塞本页）；
 *   - 流式 RequestTask 挂在自身，并在 app.globalData.gradeStreamTask 上留一份，
 *     供结果页 onUnload 中止同一请求（见下方 registerTask）。
 */

var storage = require('../../utils/storage.js');
var api = require('../../utils/api.js');
var format = require('../../utils/format.js');
var md = require('../../utils/md.js');
var prompts = require('../../skill/prompts.js');
var refs = require('../../skill/references.js');
var privacy = require('../../utils/privacy.js');

/** 五类题型（方案 §4） */
var TYPE_OPTIONS = ['归纳概括', '综合分析', '提出对策', '公文写作', '文章写作'];

/** 写回 storage 的节流间隔（毫秒），避免每个分块都落盘 */
var FLUSH_INTERVAL = 500;

/**
 * base64 图片长度上限（方案 §4.5：约 4,500,000，对应 ≈3.4MB 原图）。
 * base64 约为原图体积的 4/3，超过即认为图片过大，提示重拍或裁剪。
 */
var MAX_BASE64_LENGTH = 4500000;

/** 压缩图片的质量档（方案 §4.5 明确 quality: 50） */
var COMPRESS_QUALITY = 50;

/**
 * OCR 指令里约定的「整图没有可识别文字」哨兵（方案 §4.5）。
 * 模型命中它时等于没识别出内容，不能当作答填进文本框。
 */
var OCR_EMPTY_MARK = '（未识别到文字）';
var auth = require('../../utils/auth.js');

Page({
  data: {
    typeOptions: TYPE_OPTIONS,
    typeIndex: 0,
    question: '',
    material: '',
    referenceAnswer: '',
    answer: '',
    answerWords: 0,
    lengthHint: format.judgeLength(0),
    paperTitle: '',
    paperSourceLabel: '内置改编练习 · 非原卷',
    paperSourceNote: '题目与材料为摘要改编练习，不是完整原卷。',
    configured: false,
    submitting: false,
    scanning: false,   // 拍照识别进行中
    scanStatus: '',    // 识别状态文案（随 onDelta 追加已转录字数）
    scanError: ''      // 识别错误条
  },

  onLoad: function (options) {
    this._alive = true;
    this._full = '';
    this._recordId = '';
    this._task = null;
    this._lastFlush = 0;
    this._scanTask = null; // 拍照识别的流式 RequestTask
    this._scanText = '';
    this._scanCanceled = false; // 用户主动取消标记：让中止后的 onError 不再改页面状态
    this.refreshConfig();
    var id = options && options.id ? decodeURIComponent(options.id) : '';
    if (id) this.prefillFromPapers(id);
  },

  /** 回到本页时刷新模型配置状态（用户可能刚去设置页配好） */
  onShow: function () {
    this.refreshConfig();
    var app = getApp();
    var g = app && app.globalData;
    if (!g) return;
    // 结果页「再批一篇」时会把重置标记放在 globalData 上
    if (g.gradeReset) {
      g.gradeReset = false;
      this.resetForm();
    }
    // 真题页「去作答」时传 id：批改页是 tabBar 页，switchTab 带不了 query，
    // 故真题页把 id 放在 globalData 上（pages/papers/papers.js onAnswer）
    if (g.gradePrefillId) {
      var prefillId = g.gradePrefillId;
      g.gradePrefillId = '';
      this.prefillFromPapers(prefillId);
    }
    // 结果页退出时中止了本页发起的流式请求，这里把按钮状态放开
    if (g.gradeStreamStopped) {
      g.gradeStreamStopped = false;
      this._task = null;
      if (this.data.submitting) this.setData({ submitting: false });
    }
    if (g.gradePrefillPayload) {
      var prefill = g.gradePrefillPayload;
      g.gradePrefillPayload = null;
      this.offerPaperPrefill(prefill);
    }
  },

  onUnload: function () {
    this._alive = false;
    this.abortStream();
    this.abortScan();
  },

  // ---------------- 输入交互 ----------------

  onTypeChange: function (e) {
    var idx = Number(e.detail.value);
    if (!isFinite(idx)) return;
    var curType = TYPE_OPTIONS[idx] || '';
    this.setData({
      typeIndex: idx,
      lengthHint: format.judgeLength(this.data.answerWords, curType)
    });
  },

  onQuestionInput: function (e) {
    this.setData({ question: e.detail.value });
  },

  onMaterialInput: function (e) {
    this.setData({ material: e.detail.value });
  },
  onReferenceInput: function (e) {
    this.setData({ referenceAnswer: e.detail.value });
  },

  onAnswerInput: function (e) {
    var v = e.detail.value;
    var words = format.countWords(v);
    var curType = TYPE_OPTIONS[this.data.typeIndex] || '';
    this.setData({
      answer: v,
      answerWords: words,
      lengthHint: format.judgeLength(words, curType),
      scanError: '' // 手动编辑时撤下 OCR 错误提示
    });
  },

  goSettings: function () {
    wx.navigateTo({ url: '/pages/settings/settings' });
  },

  // ---------------- 真题预填 ----------------

  offerPaperPrefill: function (payload) {
    var self = this;
    if (!payload || payload.owner !== auth.version()) return;
    function apply() {
      if (!self._alive || payload.owner !== auth.version()) return;
      self.resetForm();
      var idx = matchType(payload.type);
      self._prefillSource = { title: payload.paperTitle, label: payload.sourceLabel, note: payload.sourceNote, url: payload.sourceUrl };
      self.setData({ question: payload.question, material: payload.material, referenceAnswer: '',
        typeIndex: idx >= 0 ? idx : 0, paperTitle: payload.paperTitle,
        paperSourceLabel: payload.sourceLabel, paperSourceNote: payload.sourceNote });
    }
    if (this.data.answer || this.data.question || this.data.material || this.data.referenceAnswer) {
      wx.showModal({ title: '替换当前作答草稿？', content: '载入所选题目会清空当前题目、材料和作答。取消可保留原草稿。',
        confirmText: '载入题目', success: function (res) { if (res.confirm) apply(); } });
    } else apply();
  },

  /**
   * 按 id 从 data/papers.js 深查找任意节点（题或题的子对象），
   * 字段名用 pickText 容错，题库结构小幅变化也能预填。
   */
  prefillFromPapers: function (id) {
    this._prefillSource = null;
    var papers = loadPapers();
    if (!papers) return;
    var found = deepFind(papers, id);
    if (!found) return;

    var node = found.node;
    var question = pickText(node, ['question', 'stem', 'task', 'title', 'content', '题目', '题干', 'questionText']);
    var material = pickText(node, ['material', 'materials', 'passage', 'given', 'source', 'text', '资料', '给定资料', 'materialText']);
    var typeIdx = matchType(pickText(node, ['type', 'typeName', 'category', 'questionType', '题型']));
    var title = pickPaperTitle(found.chain);

    var patch = { paperSourceLabel: '内置改编练习 · 非原卷', paperSourceNote: '题目与材料为摘要改编练习，不是完整原卷。' };
    patch.referenceAnswer = pickText(node, ['referenceAnswer', '参考答案']);
    if (question) patch.question = question;
    if (material) patch.material = material;
    if (typeIdx >= 0) patch.typeIndex = typeIdx;
    if (title) patch.paperTitle = title;
    if (Object.keys(patch).length === 0) return;
    this.setData(patch);
  },

  resetForm: function () {
    this._prefillSource = null;
    this.abortStream();
    this.abortScan();
    this._full = '';
    this._recordId = '';
    this.setData({
      question: '',
      material: '',
      referenceAnswer: '',
      answer: '',
      answerWords: 0,
      lengthHint: format.judgeLength(0),
      paperTitle: '',
      paperSourceLabel: '内置改编练习 · 非原卷',
      paperSourceNote: '题目与材料为摘要改编练习，不是完整原卷。',
      submitting: false,
      scanning: false,
      scanStatus: '',
      scanError: ''
    });
  },

  // ---------------- 配置与提交 ----------------

  refreshConfig: function () {
    var cfg = storage.getConfig();
    var ok = api.isConfigured(cfg);
    if (ok !== this.data.configured) this.setData({ configured: ok });
    return ok;
  },

  onGoAccount: function () { wx.navigateTo({ url: '/pages/account/account' }); },

  /** 组装 messages：system 用批改 Skill（附规范表达速查），user 按四段标签分段 */
  buildMessages: function () {
    var skill = storage.getSkillCustom();
    var system;
    if (skill && skill.enabled && skill.text) {
      system = skill.text;
    } else {
      system = prompts.GRADE_PROMPT;
      // 注入正版参考库的规范表达速查，帮「语言规范」维度扣得更准
      var guifan = refs.REF && refs.REF['guifan-biaoda'];
      if (typeof guifan === 'string' && guifan) {
        system += '\n\n【规范表达速查】评「语言规范」与给修改建议时参考：\n' + guifan;
      }
      system += '\n\n' + prompts.QUALITY_RULES;
    }
    var d = this.data;
    var user = [
      '【题型】' + TYPE_OPTIONS[d.typeIndex],
      '【题目】' + (d.question || '').trim(),
      '【给定资料】' + (d.material ? d.material.trim() : '（未提供）'),
      '【参考答案】' + ((d.referenceAnswer || '').trim() || '（未提供）'),
      '【考生作答】' + (d.answer || '').trim()
    ].join('\n\n');
    return [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ];
  },

  onStart: function () {
    if (this.data.submitting) return;
    var d = this.data;
    if (!d.question.trim()) {
      wx.showToast({ title: '请先填写题目', icon: 'none' });
      return;
    }
    if (!d.answer.trim()) {
      wx.showToast({ title: '请先粘贴你的作答', icon: 'none' });
      return;
    }
    if (!this.refreshConfig()) {
      var self = this;
      wx.showModal({
        title: '还没有配置模型',
        content: '作文批改大人的申论专项调用你填写的模型 API，请先去设置页填写地址、密钥与模型名。',
        confirmText: '去设置',
        cancelText: '再等等',
        success: function (res) {
          if (res.confirm) wx.navigateTo({ url: '/pages/settings/settings' });
        }
      });
      return;
    }

    var typeName = TYPE_OPTIONS[d.typeIndex];
    var entry = storage.addHistory({
      type: 'grade',
      title: typeName + '·' + format.brief(d.question, 16),
      payload: {
        paperSource: this._prefillSource || null,
        questionType: typeName,
        question: d.question,
        material: d.material,
        referenceAnswer: d.referenceAnswer || '',
        answer: d.answer,
        content: '',
        scores: null,
        status: 'streaming',
        error: '',
        createdAt: Date.now()
      }
    });

    var self = this;
    this.setData({ submitting: true });
    // 先落记录拿到 id，再跳结果页（结果页按 id 读 storage）
    wx.navigateTo({
      url: '/pages/result/result?id=' + entry.id,
      fail: function () {
        wx.redirectTo({
          url: '/pages/result/result?id=' + entry.id,
          fail: function () {
            self.setData({ submitting: false });
            wx.showToast({ title: '结果页打开失败', icon: 'none' });
          }
        });
      }
    });
    this.startStream(entry.id);
  },

  // ---------------- 拍照识别作答（方案 §4.5） ----------------

  /**
   * 「拍照识别」入口：先弹 actionSheet 选拍照 / 从相册选。
   * 识别中再次点击会中止当前请求（方案 §4.5）。
   */
  onScanAnswer: function () {
    if (this.data.scanning) {
      this.abortScan();
      wx.showToast({ title: '已取消识别', icon: 'none' });
      return;
    }
    if (!this.refreshConfig()) {
      wx.showModal({
        title: '尚无可用模型',
        content: '可以在“我的”登录使用账号共享模型，或到设置填写自己的 API Key 与视觉模型。图片识别是否可用取决于实际模型。',
        confirmText: '去设置',
        cancelText: '再等等',
        success: function (res) {
          if (res.confirm) wx.navigateTo({ url: '/pages/settings/settings' });
        }
      });
      return;
    }
    var self = this;
    wx.showActionSheet({
      itemList: ['拍照', '从相册选'],
      success: function (res) {
        if (res.tapIndex === 0) self.pickImage(['camera']);
        else if (res.tapIndex === 1) self.pickImage(['album']);
      }
    });
  },

  /** 选图（拍照或相册）：先过隐私授权，再选图 */
  pickImage: function (sourceType) {
    var self = this;
    // 相机/相册属隐私接口：需用户同意《用户隐私保护指引》；已同意或未配置指引时直接放行
    privacy.ensurePrivacy(function () {
      self.doPickImage(sourceType);
    }, '需要同意《用户隐私保护指引》后才能使用拍照识别');
  },

  /** 真正的选图逻辑（隐私授权通过后调用） */
  doPickImage: function (sourceType) {
    var self = this;
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sizeType: ['compressed'],
      sourceType: sourceType,
      success: function (res) {
        var files = res.tempFiles || [];
        if (!files.length) {
          wx.showToast({ title: '没有选到图片', icon: 'none' });
          return;
        }
        self.compressAndRead(files[0].tempFilePath);
      },
      fail: function (res) {
        // 区分用户主动取消、未授权与其他失败（评审发现 #3）
        var msg = (res && res.errMsg) || '';
        if (/cancel/i.test(msg)) return; // 用户取消，静默
        if (/auth|deny/i.test(msg)) {
          wx.showToast({ title: '未授权相机/相册，请在手机设置中开启权限', icon: 'none', duration: 2500 });
          return;
        }
        wx.showToast({ title: '选图失败，请重试', icon: 'none' });
      }
    });
  },

  /** 压缩到 quality 50（失败退回原图），再读成 base64 */
  compressAndRead: function (filePath) {
    var self = this;
    this.setData({ scanning: true, scanStatus: '正在压缩图片…', scanError: '' });
    wx.compressImage({
      src: filePath,
      quality: COMPRESS_QUALITY,
      success: function (res) {
        self.readAsBase64(res.tempFilePath);
      },
      fail: function () {
        // 压缩失败（部分机型不支持）就用原图
        self.readAsBase64(filePath);
      }
    });
  },

  /** 按文件后缀推断 data URL 的 MIME（评审发现 #2）：png 用 image/png，其余按 jpeg 处理 */
  guessMime: function (filePath) {
    return /\.png$/i.test(String(filePath || '')) ? 'image/png' : 'image/jpeg';
  },

  /** 读 base64 → 大小校验 → 发起转录 */
  readAsBase64: function (filePath) {
    var self = this;
    var fs = wx.getFileSystemManager();
    if (!fs || typeof fs.readFile !== 'function') {
      this.failScan('当前环境不支持读取本地图片，请换真机或更新微信后再试。');
      return;
    }
    fs.readFile({
      filePath: filePath,
      encoding: 'base64',
      success: function (res) {
        var base64 = String(res.data || '');
        if (!base64) {
          self.failScan('图片读取失败，请重新拍照。');
          return;
        }
        if (base64.length > MAX_BASE64_LENGTH) {
          self.failScan('图片过大，请重拍或裁剪（建议单张答题卡、分辨率适中）。');
          return;
        }
        self.startTranscribe(base64, self.guessMime(filePath));
      },
      fail: function () {
        self.failScan('图片读取失败，请重新拍照。');
      }
    });
  },

  /** 发起视觉模型转录（流式），onDelta 实时显示已转录字数 */
  startTranscribe: function (base64, mimeType) {
    var self = this;
    if (!this.data.scanning) return; // 读图期间页面被重置或离开，丢弃这次迟到的结果
    this._scanText = '';
    this._scanCanceled = false;
    this.setData({ scanStatus: '识别中…', scanError: '' });

    var cfg = storage.getConfig();
    var task = api.transcribeSheet(cfg, base64, {
      onDelta: function (delta) {
        if (self._scanCanceled) return;
        self._scanText += delta;
        self.setData({ scanStatus: '识别中…已转录 ' + format.countWords(self._scanText) + ' 字' });
      },
      onDone: function (full) {
        var text = String(full || self._scanText || '').trim();
        self._scanTask = null;
        if (self._scanCanceled) return; // 已取消：迟到的结果不写回作答框
        self.setData({ scanning: false, scanStatus: '', scanError: '' });
        if (!text || text === OCR_EMPTY_MARK) {
          wx.showToast({ title: '未识别到文字，请重拍', icon: 'none' });
          return;
        }
        self.fillAnswer(text);
        wx.showToast({ title: '识别完成，可手动修改', icon: 'none', duration: 2000 });
      },
      onError: function (msg) {
        self.failScan(msg);
      }
    }, mimeType);
    this._scanTask = task || null;
  },

  /** 回填作答框：已有内容则用空行追加，否则直接填入（方案 §4.5） */
  fillAnswer: function (text) {
    var cur = this.data.answer || '';
    var next = cur && cur.trim() ? cur.replace(/\s+$/, '') + '\n\n' + text : text;
    var words = format.countWords(next);
    this.setData({
      answer: next,
      answerWords: words,
      lengthHint: format.judgeLength(words)
    });
  },

  /** 识别出错：收尾并展示页面内错误条（用户主动取消时不再改页面） */
  failScan: function (msg) {
    this._scanTask = null;
    if (this._scanCanceled) return;
    this.setData({
      scanning: false,
      scanStatus: '',
      scanError: String(msg || '识别失败，请重试。')
    });
  },

  /** 中止进行中的识别请求 */
  abortScan: function () {
    this._scanCanceled = true;
    if (this._scanTask) {
      try {
        this._scanTask.abort();
      } catch (e) {
        console.error('[grade] 中止识别请求失败：', e);
      }
      this._scanTask = null;
    }
    if (this.data.scanning) {
      this.setData({ scanning: false, scanStatus: '', scanError: '' });
    }
  },

  // ---------------- 流式请求 ----------------

  startStream: function (recordId) {
    var self = this;
    this.abortStream();
    this._full = '';
    this._recordId = recordId;
    this._lastFlush = 0;

    var cfg = storage.getConfig();
    var messages = this.buildMessages();
    var task = api.chatStream(cfg, messages, {
      onDelta: function (delta) {
        self._full += delta;
        self.flushToStorage(); // 节流写回
      },
      onReplace: function (full) {
        self._full = full || '';
        self.flushToStorage();
      },
      onDone: function (full) {
        self._full = full || self._full;
        self.flushToStorage(true, '', 'done');
        self.setData({ submitting: false });
      },
      onError: function (msg) {
        self.flushToStorage(true, msg, 'error');
        self.setData({ submitting: false });
      }
    });
    this._task = task || null;
    registerTask(task, recordId);
  },

  /** 把累计文本写回 history 中该条 grade 记录 */
  flushToStorage: function (force, error, status) {
    var id = this._recordId;
    if (!id) return;
    var now = Date.now();
    if (!force && now - this._lastFlush < FLUSH_INTERVAL) return;
    this._lastFlush = now;

    var item = storage.getHistoryById(id);
    if (!item) return;
    var payload = item.payload || {};
    var text = this._full || '';
    payload.content = text;
    payload.updatedAt = now;
    if (error) payload.error = error;
    if (status) payload.status = status;
    if (status === 'done') {
      payload.scores = md.parseScores(text); // 存一份快照，历史列表可直接读
      payload.error = '';
    }
    storage.updateHistory(id, { payload: payload });
  },

  abortStream: function () {
    if (this._task) {
      try {
        this._task.abort();
      } catch (e) {
        console.error('[grade] 中止请求失败：', e);
      }
      this._task = null;
    }
    clearGlobalTask(this._recordId);
  }
});

// ---------------- 模块内工具函数 ----------------

/**
 * 把 RequestTask 挂到 app.globalData.gradeStream = {task, recordId}，
 * 结果页 onUnload 可据此中止同一个请求（跨页共用一个流）。
 */
function registerTask(task, recordId) {
  var app = getApp();
  if (app && app.globalData) {
    app.globalData.gradeStream = { task: task || null, recordId: recordId };
  }
}

/** 只在属于同一条记录时才中止共享任务，避免误杀别人发起的流 */
function clearGlobalTask(recordId) {
  var app = getApp();
  var g = app && app.globalData;
  if (!g || !g.gradeStream) return;
  if (recordId && g.gradeStream.recordId !== recordId) return;
  if (g.gradeStream.task) {
    try {
      g.gradeStream.task.abort();
    } catch (e) {
      // 任务已结束，忽略
    }
  }
  g.gradeStream = null;
}

/** 延迟加载题库，取不到就返回 null（题库由真题页负责，不阻塞本页） */
function loadPapers() {
  try {
    return require('../../data/papers.js');
  } catch (e) {
    return null;
  }
}

/**
 * 在任意结构里深查找 id 命中的节点。
 * @returns {{node:object, chain:Array}|null} chain 为从根到该节点的祖先数组
 */
function deepFind(root, id) {
  if (!root || id == null) return null;
  if (Array.isArray(root)) {
    for (var i = 0; i < root.length; i++) {
      var hit = deepFind(root[i], id);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof root !== 'object') return null;
  if (String(root.id) === String(id)) return { node: root, chain: [] };
  var keys = Object.keys(root);
  for (var j = 0; j < keys.length; j++) {
    var v = root[keys[j]];
    if (!v || typeof v !== 'object') continue;
    var sub = deepFind(v, id);
    if (sub) {
      sub.chain = [root].concat(sub.chain);
      return sub;
    }
  }
  return null;
}

/** 按候选字段名依次取第一个非空字符串 */
function pickText(obj, keys) {
  if (!obj || typeof obj !== 'object') return '';
  for (var i = 0; i < keys.length; i++) {
    var v = obj[keys[i]];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

/** 把题型字符串落到五个选项的下标，认不出返回 -1 */
function matchType(text) {
  if (!text) return -1;
  for (var i = 0; i < TYPE_OPTIONS.length; i++) {
    if (text.indexOf(TYPE_OPTIONS[i]) !== -1) return i;
  }
  return -1;
}

/** 从祖先链里取套题名（真题页传 id 时的来源提示） */
function pickPaperTitle(chain) {
  for (var i = chain.length - 1; i >= 0; i--) {
    var t = pickText(chain[i], ['name', 'paperName', 'paperTitle', 'title', 'source', 'year']);
    if (t) return format.brief(t, 28);
  }
  return '';
}
