/**
 * pages/study/study —— 备考计划（方案 §4「备考」页）
 *
 * 职责：
 *   1. 表单：基础水平 / 每日可用时长 / 目标岗位 / 距离考试周数；
 *   2. 调 utils/api.js 的 chatStream，system = skill/prompts.js 的 COACH_PROMPT + 附加备考规划指令，
 *      流式生成计划；
 *   3. 用 utils/md.js 的 parseBlocks 渲染 markdown（流式期间每 300ms 节流重解析）；
 *   4. 按周打卡列表，勾选状态存 utils/storage.js（key: slz_plan 的 checkins），重进回显。
 *
 * 依赖签名（均已核对源码）：
 *   api.chatStream(cfg, messages, handlers) -> RequestTask；handlers: {onDelta, onDone, onError}
 *   storage.getPlan() / storage.setPlan(patch) / storage.toggleCheckin(week) -> boolean
 *   md.parseBlocks(text) -> [{type, text, segments:[{text,bold}]}]
 *   prompts.COACH_PROMPT / storage.getSkillCustom()
 */

var api = require('../../utils/api.js');
var storage = require('../../utils/storage.js');
var md = require('../../utils/md.js');
var prompts = require('../../skill/prompts.js');
var refs = require('../../skill/references.js');
var privacy = require('../../utils/privacy.js');
var aigc = require('../../utils/aigc.js');

/** 基础水平候选 */
var LEVELS = [
  '零基础：没考过，材料读不懂',
  '入门：考过但没方向，题型不分',
  '中等：归纳概括能写，综合分析与大作文没底',
  '较好：能写满字数，主要问题是要点覆盖不全'
];

/** 每日可用时长候选（单位：小时） */
var DAILY_HOURS = [
  { label: '0.5 小时', value: 0.5 },
  { label: '1 小时', value: 1 },
  { label: '1.5 小时', value: 1.5 },
  { label: '2 小时', value: 2 },
  { label: '3 小时以上', value: 3 }
];
var DAILY_LABELS = DAILY_HOURS.map(function (h) { return h.label; });

/** 目标岗位候选 */
var TARGETS = [
  '国考（副省级/地市级）',
  '省考（申论 A/B/C 类）',
  '事业单位综合应用能力',
  '选调生',
  '其他公考岗位'
];

/** 距离考试周数候选 */
var WEEK_OPTIONS = ['4 周', '8 周', '12 周', '16 周', '24 周', '32 周'];

/** 流式重解析的节流间隔（毫秒），与结果页保持一致 */
var PARSE_THROTTLE = 300;

/** 打卡周次上限，防止周数填错后生成超长列表 */
var MAX_WEEKS = 32;

/**
 * 附加备考规划指令。
 * COACH_PROMPT 的任务五要求「必须先反问三个问题再出计划」，但本表单已一次性收集完毕，
 * 所以这里显式解除反问、并规定按周标题输出，便于页面按周拆分打卡。
 */
var PLAN_INSTRUCTION = [
  '（本次为「备考计划生成」模式，用户已在表单中一次性回答了你需要反问的全部问题，',
  '请不要再反问，直接按下面四步输出计划：）',
  '',
  '第一步：用一句话复述你理解到的备考者画像（基础、每日时长、目标岗位、剩余周数），',
  '第二步：按「第X周：本周主题」作为二级标题逐周排布计划，覆盖全部剩余周数；',
  '第三步：每周必须写清四项内容——训练量（练什么题型、几道、每天多少分钟）、',
  '背诵清单（背什么，如四类找点词、公文格式）、复盘动作（批改后怎么改）、打卡节点；',
  '第四步：末尾给出三条「本周最重要的三件事」与一句打卡提醒。',
  '',
  '前期做专项突破，中期做套题训练，后期限时与背诵；周数少时按比例合并，不要输出超过 ' +
  MAX_WEEKS + ' 周。',
  '只用受限 markdown 子集：二级标题、三级标题、加粗、无序列表、有序列表、引用块与普通段落；',
  '禁止表格、图片、链接、emoji。不要输出 scores 代码块。'
].join('\n');

/**
 * 决定本次使用的系统提示词：开启自定义 Skill 覆盖时用用户粘贴的文本。
 * @returns {string}
 */
function buildSystemPrompt() {
  var custom = storage.getSkillCustom();
  var base;
  if (custom.enabled && custom.text && custom.text.length > 0) {
    base = custom.text;
  } else {
    base = prompts.COACH_PROMPT + '\n\n' + prompts.SKILL_ROUTER;
    // 注入正版参考库的备考规划专题
    var beikao = refs.REF && refs.REF['beikao-jihua'];
    if (typeof beikao === 'string' && beikao) {
      base += '\n\n【名师专题参考】以下为备考规划参考，请结合用户情况取用：\n\n' + beikao;
    }
  }
  return base + '\n\n' + PLAN_INSTRUCTION;
}

/** 给块数组补一个渲染用的 class 字段，简化 WXML */
function decorateBlocks(blocks) {
  var out = [];
  for (var i = 0; i < blocks.length; i++) {
    var b = blocks[i];
    var cls = 'md-p';
    if (b.type === 'h2') cls = 'md-h2';
    else if (b.type === 'h3') cls = 'md-h3';
    else if (b.type === 'li') cls = 'md-li';
    else if (b.type === 'quote') cls = 'quote-red';
    else if (b.type === 'hr') cls = 'md-hr';
    out.push({
      type: b.type,
      text: b.text,
      segments: b.segments || [],
      cls: cls
    });
  }
  return out;
}

Page({
  data: {
    // ---- 表单 ----
    levels: LEVELS,
    levelIndex: 1,
    dailyLabels: DAILY_LABELS,
    dailyIndex: 1,
    targets: TARGETS,
    targetIndex: 0,
    weekOptions: WEEK_OPTIONS,
    weekIndex: 1,
    weeks: 8, // 解析后的周数（数字）

    // ---- 生成状态 ----
    generating: false,
    content: '',
    blocks: [],
    errorMsg: '',
    hasPlan: false,
    updatedAt: '',

    // ---- 打卡 ----
    checkins: [],
    doneCount: 0
  },

  onLoad: function () {
    this.loadPlan();
  },

  onShow: function () {
    if (this.data.hasPlan) this.loadPlan(); // 重进回显打卡状态
  },

  onUnload: function () {
    // 生成中途离开：先把已生成的部分落盘，避免整段丢失
    // （不调用 savePlan，因为它内部有 setData，页面卸载阶段不允许）
    if (this.data.generating && this._pendingContent) {
      try {
        var form = this.currentForm();
        if (form) {
          storage.setPlan({
            form: form,
            content: this._pendingContent,
            checkins: storage.getPlan().checkins
          });
        }
      } catch (e) {
        console.error('[study] 中止时保存部分计划失败：', e);
      }
    }
    if (this._task) {
      try {
        this._task.abort();
      } catch (e) {
        console.error('[study] 中止请求失败：', e);
      }
      this._task = null;
    }
    if (this._throttleTimer) {
      clearTimeout(this._throttleTimer);
      this._throttleTimer = null;
    }
  },

  // ---------------- 计划读取 ----------------

  /** 从 storage 读取已保存的计划与打卡，回显表单 */
  loadPlan: function () {
    var plan = storage.getPlan();
    var form = plan.form || null;
    var content = plan.content || '';
    var weeks = 8;
    if (form) {
      this.applyForm(form);
      weeks = Number(form.weeks) || 8;
    }
    var blocks = content ? decorateBlocks(md.parseBlocks(content)) : [];
    this.setData({
      content: content,
      blocks: blocks,
      hasPlan: content.length > 0,
      updatedAt: content ? (form && form.savedAt ? formatPlanTime(form.savedAt) : '') : '',
      weeks: weeks
    });
    this.buildCheckins(weeks, plan.checkins);
  },

  /** 把 storage 里的 form 回填到各 picker */
  applyForm: function (form) {
    var levelIndex = LEVELS.indexOf(form.level);
    if (levelIndex === -1) levelIndex = this.data.levelIndex;
    var dailyIndex = -1;
    for (var i = 0; i < DAILY_HOURS.length; i++) {
      if (DAILY_HOURS[i].value === Number(form.dailyHours)) {
        dailyIndex = i;
        break;
      }
    }
    if (dailyIndex === -1) dailyIndex = this.data.dailyIndex;
    var targetIndex = TARGETS.indexOf(form.target);
    if (targetIndex === -1) targetIndex = 0;
    var weekIndex = WEEK_OPTIONS.indexOf(form.weekLabel);
    if (weekIndex === -1) weekIndex = 1;

    this.setData({
      levelIndex: levelIndex,
      dailyIndex: dailyIndex,
      targetIndex: targetIndex,
      weekIndex: weekIndex
    });
  },

  // ---------------- 表单事件 ----------------

  onLevelChange: function (e) {
    this.setData({ levelIndex: Number(e.detail.value) });
  },

  onDailyChange: function (e) {
    this.setData({ dailyIndex: Number(e.detail.value) });
  },

  onTargetChange: function (e) {
    this.setData({ targetIndex: Number(e.detail.value) });
  },

  onWeekChange: function (e) {
    var idx = Number(e.detail.value);
    var label = WEEK_OPTIONS[idx] || WEEK_OPTIONS[1];
    var weeks = parseInt(label, 10) || 8;
    this.setData({
      weekIndex: idx,
      weeks: weeks
    });
  },

  // ---------------- 生成计划 ----------------

  /** 取当前表单值 */
  currentForm: function () {
    return {
      level: LEVELS[this.data.levelIndex] || LEVELS[1],
      dailyHours: (DAILY_HOURS[this.data.dailyIndex] || DAILY_HOURS[1]).value,
      dailyLabel: DAILY_LABELS[this.data.dailyIndex] || DAILY_LABELS[1],
      target: TARGETS[this.data.targetIndex] || TARGETS[0],
      weeks: this.data.weeks,
      weekLabel: WEEK_OPTIONS[this.data.weekIndex] || WEEK_OPTIONS[1],
      savedAt: Date.now()
    };
  },

  /** 组织用户消息：把表单答案一次说清，解除 COACH 的反问 */
  buildUserMessage: function (form) {
    return [
      '请为我制定一份申论备考计划。以下信息我已经全部回答，请直接出计划，不要再反问：',
      '',
      '一、基础水平：' + form.level,
      '二、每日可用时长：' + form.dailyLabel + '（约 ' + form.dailyHours + ' 小时）',
      '三、目标岗位：' + form.target,
      '四、距离考试：还剩 ' + form.weeks + ' 周',
      '',
      '要求：按周排布，每周写清训练量、背诵清单、复盘动作与打卡节点；',
      '重点围绕归纳概括与综合分析的找点方法、大作文结构、公文格式三块落地；',
      '计划要匹配我每天 ' + form.dailyHours + ' 小时的现实投入，不要写成每天学八小时。'
    ].join('\n');
  },

  /** 生成计划：流式请求 + 300ms 节流重解析 */
  onGenerate: function () {
    if (this.data.generating) return;
    var cfg = storage.getConfig();
    var form = this.currentForm();
    var self = this;

    this.setData({
      generating: true,
      errorMsg: '',
      content: '',
      blocks: []
    });
    this._lastParseAt = 0;
    this._pendingContent = '';

    var task = api.chatStream(cfg, [
      { role: 'system', content: buildSystemPrompt() },
      { role: 'user', content: this.buildUserMessage(form) }
    ], {
      onDelta: function (delta) {
        // 降级成功时也会走 onDelta（一次性吐全文），此时撤下错误卡
        if (self.data.errorMsg) self.setData({ errorMsg: '' });
        self._pendingContent += delta;
        self.scheduleParse();
      },
      onDone: function (fullText) {
        var text = typeof fullText === 'string' && fullText ? fullText : self._pendingContent;
        self.flushParse(text);
        self.setData({ generating: false });
        self.savePlan(form, text);
        if (self._task) {
          try { self._task.abort(); } catch (e) { /* 已结束，忽略 */ }
          self._task = null;
        }
      },
      onError: function (msg) {
        self.setData({
          errorMsg: msg || '请求失败，请稍后重试。',
          generating: false
        });
      }
    });

    this._task = task;
    if (!task) {
      this.setData({ generating: false });
    }
  },

  /** 节流重解析：距上次解析不足 300ms 就延后 */
  scheduleParse: function () {
    var now = Date.now();
    var wait = this._lastParseAt ? PARSE_THROTTLE - (now - this._lastParseAt) : 0;
    var self = this;
    if (this._throttleTimer) clearTimeout(this._throttleTimer);
    if (wait <= 0) {
      this.flushParse(this._pendingContent);
      return;
    }
    this._throttleTimer = setTimeout(function () {
      self.flushParse(self._pendingContent);
    }, wait);
  },

  /** 立即重解析并渲染 */
  flushParse: function (text) {
    this._lastParseAt = Date.now();
    if (this._throttleTimer) {
      clearTimeout(this._throttleTimer);
      this._throttleTimer = null;
    }
    var content = text || '';
    this._pendingContent = content;
    this.setData({
      content: content,
      blocks: decorateBlocks(md.parseBlocks(content))
    });
  },

  /** 保存计划到 storage（key: slz_plan） */
  savePlan: function (form, text) {
    storage.setPlan({
      form: form,
      content: text || '',
      checkins: {} // 重新生成的计划重置打卡
    });
    this.setData({
      hasPlan: true,
      updatedAt: formatPlanTime(form.savedAt)
    });
    this.buildCheckins(form.weeks || 8, {});
  },

  /** 重新生成：先中止旧请求 */
  onRegenerate: function () {
    if (this._task) {
      try {
        this._task.abort();
      } catch (e) {
        console.error('[study] 中止请求失败：', e);
      }
      this._task = null;
    }
    this.onGenerate();
  },

  /** 错误卡里的「去设置」：跳模型设置页 */
  onGoSettings: function () {
    wx.navigateTo({ url: '/pages/settings/settings' });
  },

  /** 复制计划全文 */
  onCopyPlan: function () {
    var self = this;
    // 剪贴板属隐私接口：先过隐私授权
    privacy.ensurePrivacy(function () {
      self.doCopyPlan();
    }, '需要同意《用户隐私保护指引》后才能复制');
  },

  doCopyPlan: function () {
    var text = this.data.content;
    if (!text) {
      wx.showToast({ title: '还没有生成计划', icon: 'none' });
      return;
    }
    wx.setClipboardData({
      data: aigc.forClipboard(text),
      success: function () {
        wx.showToast({ title: '已复制计划', icon: 'none', duration: 1500 });
      }
    });
  },

  // ---------------- 打卡 ----------------

  /**
   * 生成打卡列表
   * @param {number} weeks 周数
   * @param {object} checkins 已有打卡映射 {week: true}
   */
  buildCheckins: function (weeks, checkins) {
    var n = Math.min(Math.max(parseInt(weeks, 10) || 0, 0), MAX_WEEKS);
    var map = checkins || {};
    var list = [];
    var done = 0;
    for (var i = 1; i <= n; i++) {
      var checked = !!map[String(i)];
      if (checked) done++;
      list.push({
        week: i,
        label: '第 ' + i + ' 周',
        checked: checked
      });
    }
    this.setData({
      checkins: list,
      doneCount: done
    });
  },

  /** 勾选某一周打卡（状态存 storage，重进回显） */
  onToggleCheckin: function (e) {
    var week = Number(e.currentTarget.dataset.week);
    if (!week) return;
    var now = storage.toggleCheckin(week);
    var plan = storage.getPlan();
    var list = this.data.checkins.map(function (item) {
      return {
        week: item.week,
        label: item.label,
        checked: item.week === week ? !!now : item.checked
      };
    });
    var done = 0;
    for (var i = 0; i < list.length; i++) {
      if (list[i].checked) done++;
    }
    this.setData({ checkins: list, doneCount: done });
  },

  /** 清空本周计划的打卡 */
  onResetCheckins: function () {
    var self = this;
    wx.showModal({
      title: '重置打卡',
      content: '将清空全部周次的打卡记录，确认继续？',
      confirmText: '重置',
      confirmColor: '#B03A2E',
      cancelText: '取消',
      success: function (res) {
        if (!res.confirm) return;
        storage.setPlan({ checkins: {} });
        var plan = storage.getPlan();
        self.buildCheckins(plan.form && plan.form.weeks ? plan.form.weeks : self.data.weeks, {});
      }
    });
  }
});

/**
 * 计划生成时间格式化（不引 utils/format.js，避免与页面职责混杂，这里内联一个极简版）
 * @param {number} ts 时间戳
 * @returns {string}
 */
function formatPlanTime(ts) {
  var d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  function p(n) {
    return n < 10 ? '0' + n : '' + n;
  }
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
