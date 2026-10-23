/**
 * pages/settings/settings —— 模型接入设置 + Skill 管理（方案 §4 / §6）
 *
 * 职责：
 *   1. 供应商预设宫格：读 utils/api.js 的 PRESETS，六选一，选中自动填 baseURL 与模型候选；
 *   2. baseURL / apiKey（密码框）/ model（picker 选候选或手输自定义）；
 *   3. 「视觉模型（用于拍照识别）」：候选来自当前预设的 visionModels + 手输自定义，
 *      存 slz_config.visionModel（空串 = 未配置，识别时回退主模型），
 *      预设切换时自动带出该预设的第一个候选（方案 §4.5）；
 *   4. 「测试连接」调 utils/api.js 的 testConnection，展示 ok / 延迟毫秒 / 中文错误（只测主模型）；
 *   5. 保存到 utils/storage.js（key: slz_config）；
 *   6. Skill 管理区：查看内置 Skill（skill/prompts.js 的 SKILL_META + SHENLUN-SKILL.md 摘要）、
 *      自定义 Skill 覆盖开关与粘贴框、导出（复制到剪贴板），存 storage（key: slz_skill_custom）；
 *   7. 未配置时给新手引导文案。
 *
 * 依赖签名（均已核对源码）：
 *   api.PRESETS / api.normalizeConfig(cfg) / api.testConnection(cfg) -> Promise<{ok,message,latencyMs}>
 *   storage.getConfig() / storage.setConfig(patch) / storage.getSkillCustom() / storage.setSkillCustom(patch)
 *   prompts.SKILL_META / prompts.GRADE_PROMPT / prompts.COACH_PROMPT / prompts.SKILL_VERSION
 */

var api = require('../../utils/api.js');
var storage = require('../../utils/storage.js');
var prompts = require('../../skill/prompts.js');
var format = require('../../utils/format.js');
var privacy = require('../../utils/privacy.js');

/**
 * SHENLUN-SKILL.md 的章节摘要。
 * 小程序运行时无法直接读取 .md 文件，这里按 skill/SHENLUN-SKILL.md 的实际章节结构
 * 写一份静态摘要，用于设置页展示；原文以仓库中的 skill/SHENLUN-SKILL.md 为准。
 */
var SKILL_DOC_OUTLINE = [
  '一、这套 Skill 是什么：角色定位、适用场景与蒸馏来源声明',
  '二、五大题型解题流程：归纳概括、综合分析、提出对策、公文写作、文章写作',
  '三、四类找点词库示例：问题词、原因词、影响词、对策词（含材料例句与提炼要点）',
  '四、公文写作的十五种常用文种格式清单（倡议书至短评）',
  '五、五维评分表：要点完整度 40 / 逻辑结构 20 / 语言规范 15 / 政策素养 15 / 卷面格式 10',
  '六、使用约定与免责声明'
];

/** 自定义 Skill 文本的字数上限提示 */
var SKILL_TEXT_MAX = 8000;

/** 视觉模型 picker 里的「手输自定义」选项文案（方案 §4.5：候选来自预设 visionModels + 可手输） */
var VISION_CUSTOM_OPTION = '手输自定义';

/**
 * 组装视觉模型一行的 setData 补丁。
 * 候选项 = 当前预设的 visionModels + 「手输自定义」；
 * 已保存的视觉模型不在候选项里时，视作手输值并展开输入框。
 *
 * @param {Object|null} preset utils/api.js 的预设对象
 * @param {string} current 已保存/已填的视觉模型名
 * @param {boolean} [autoFirst] 是否带出该预设的第一个候选（预设切换时为 true，方案 §4.5）
 * @returns {Object} 可直接传给 setData 的补丁
 */
function buildVisionState(preset, current, autoFirst) {
  // 还没存过配置时 loadConfig 拿不到预设，此处回落第一家（normalizeConfig 也是这个默认值）
  var p = preset || api.PRESETS[0];
  var visionModels = p && p.visionModels ? p.visionModels.slice(0) : [];
  var options = visionModels.concat([VISION_CUSTOM_OPTION]);
  var value = String(current == null ? '' : current).trim();
  if (autoFirst && !value) value = visionModels[0] || ''; // 带出第一个候选，没有候选则留空
  var idx = visionModels.indexOf(value);

  if (value && idx === -1) {
    // 保存的是预设里没有的名字，按手输处理
    return {
      visionModel: value,
      visionOptions: options,
      visionOptionsText: visionModels.join('、'),
      visionIndex: options.length - 1,
      showVisionInput: true,
      hasVisionModels: visionModels.length > 0
    };
  }
  return {
    visionModel: value,
    visionOptions: options,
    visionOptionsText: visionModels.join('、'),
    visionIndex: idx >= 0 ? idx : 0,
    showVisionInput: false,
    hasVisionModels: visionModels.length > 0
  };
}

Page({
  data: {
    // ---- 供应商预设 ----
    presets: [],
    presetId: '',
    presetName: '',
    presetDoc: '',
    presetIndex: -1,

    // ---- 连接配置 ----
    baseURL: '',
    apiKey: '',
    model: '',
    modelOptions: [],
    modelOptionsText: '', // WXML 不能调用 join()，预先拼好候选模型文案
    modelIndex: 0,
    showModelInput: false, // 候选项里没有当前模型时，允许手输

    // ---- 视觉模型（拍照识别，方案 §4.5） ----
    visionModel: '',
    visionOptions: [VISION_CUSTOM_OPTION], // 当前预设的 visionModels + 「手输自定义」
    visionOptionsText: '',
    visionIndex: 0,
    showVisionInput: false,
    hasVisionModels: false, // 该预设是否提供视觉模型（DeepSeek 为否）

    // ---- 测试连接 ----
    testing: false,
    testResult: null, // {ok, message, latencyMs}

    // ---- 未配置引导 ----
    configured: false,

    // ---- Skill 管理 ----
    skillMeta: {},
    skillDocOutline: SKILL_DOC_OUTLINE,
    skillEnabled: false,
    skillText: '',
    skillTextLen: 0,
    skillOverLimit: false,

    // ---- 交互 ----
    saving: false
  },

  onLoad: function () {
    this.loadConfig();
    this.loadSkill();
  },

  onShow: function () {
    // 从「我的」页返回时同步最新配置
    if (this.data.configured || this.data.baseURL || this.data.apiKey || this.data.model) {
      this.loadConfig();
    }
  },

  // ---------------- 模型配置 ----------------

  /** 读取 storage 中的配置并回填页面 */
  loadConfig: function () {
    var cfg = storage.getConfig();
    var presetId = cfg.presetId;
    var preset = presetId ? api.getPreset(presetId) : null;
    if (!preset) {
      // 没存过预设（或存的是已下线的 id）时回落到第一家，与 normalizeConfig 的默认值一致；
      // 注意不能写 api.getPreset('')——getPreset 按 id 精确匹配，空串永远取不到，会导致
      // 预设宫格无选中、地址与模型候选都空着。
      preset = api.getPreset('deepseek');
      presetId = preset ? preset.id : '';
    }
    var models = preset ? (preset.models || []).slice(0) : [];
    var model = cfg.model || (models.length ? models[0] : '');
    var modelIndex = models.indexOf(model);
    if (modelIndex === -1 && models.length > 0 && !cfg.model) {
      model = models[0];
      modelIndex = 0;
    }

    var vision = buildVisionState(preset, cfg.visionModel || '');

    this.setData({
      presets: api.PRESETS,
      presetId: presetId,
      presetName: preset ? preset.name : '',
      presetDoc: preset ? preset.doc : '',
      presetIndex: preset ? api.PRESETS.indexOf(preset) : -1,
      baseURL: cfg.baseURL || (preset ? preset.baseURL : ''),
      apiKey: cfg.apiKey || '',
      model: model,
      modelOptions: models,
      modelOptionsText: models.join('、'),
      modelIndex: modelIndex === -1 ? 0 : modelIndex,
      showModelInput: models.length === 0 || (modelIndex === -1 && !!cfg.model),
      configured: !!(cfg.baseURL && cfg.apiKey && cfg.model)
    });
    this.setData(vision);
  },

  /** 点击预设宫格：自动带出 baseURL 与模型候选 */
  onPickPreset: function (e) {
    var id = e.currentTarget.dataset.id;
    var preset = api.getPreset(id);
    if (!preset) return;
    var models = (preset.models || []).slice(0);
    this.setData({
      presetId: preset.id,
      presetName: preset.name,
      presetDoc: preset.doc,
      presetIndex: api.PRESETS.indexOf(preset),
      baseURL: preset.baseURL || '',
      modelOptions: models,
      modelOptionsText: models.join('、'),
      model: models[0] || '',
      modelIndex: 0,
      showModelInput: models.length === 0,
      testResult: null
    });
    // 视觉模型跟随预设：切到新预设时带出该预设的第一个候选（方案 §4.5）
    this.setData(buildVisionState(preset, '', true));
  },

  onBaseURLInput: function (e) {
    this.setData({ baseURL: e.detail.value, testResult: null });
  },

  onApiKeyInput: function (e) {
    this.setData({ apiKey: e.detail.value, testResult: null });
  },

  /** picker 选模型候选 */
  onModelChange: function (e) {
    var idx = Number(e.detail.value);
    var list = this.data.modelOptions;
    if (!(idx >= 0 && idx < list.length)) return;
    this.setData({ modelIndex: idx, model: list[idx], showModelInput: false, testResult: null });
  },

  /** 手输自定义模型名 */
  onModelInput: function (e) {
    this.setData({ model: e.detail.value, showModelInput: true, testResult: null });
  },

  /** 显示/隐藏自定义模型输入框 */
  onToggleModelInput: function () {
    this.setData({ showModelInput: !this.data.showModelInput });
  },

  // ---------------- 视觉模型（拍照识别） ----------------

  /** picker 选视觉模型候选；选中「手输自定义」时展开输入框 */
  onVisionChange: function (e) {
    var idx = Number(e.detail.value);
    var list = this.data.visionOptions || [];
    if (!(idx >= 0 && idx < list.length)) return;
    var picked = list[idx];
    if (picked === VISION_CUSTOM_OPTION) {
      this.setData({ visionIndex: idx, showVisionInput: true });
      return;
    }
    this.setData({
      visionIndex: idx,
      visionModel: picked,
      showVisionInput: false
    });
  },

  /** 手输自定义视觉模型名 */
  onVisionInput: function (e) {
    this.setData({ visionModel: e.detail.value, showVisionInput: true });
  },

  /** 显示/隐藏视觉模型的手输框 */
  onToggleVisionInput: function () {
    this.setData({ showVisionInput: !this.data.showVisionInput });
  },

  /** 清空视觉模型（回到「未配置」，识别时回退主模型） */
  onClearVision: function () {
    var self = this;
    wx.showModal({
      title: '清空视觉模型',
      content: '拍照识别将回退使用上面的主模型，确认继续？',
      confirmText: '清空',
      cancelText: '取消',
      success: function (res) {
        if (!res.confirm) return;
        self.setData(buildVisionState(api.getPreset(self.data.presetId), ''));
      }
    });
  },

  /**
   * 组装当前配置（走 api.normalizeConfig 做 trim 与默认值补全）
   * normalizeConfig 不处理 visionModel（保持既有行为不变），这里单独补上，供保存使用；
   * testConnection 内部只读主模型，所以「测试连接」仍然只测主模型。
   */
  buildConfig: function () {
    var conf = api.normalizeConfig({
      presetId: this.data.presetId,
      baseURL: this.data.baseURL,
      apiKey: this.data.apiKey,
      model: this.data.model
    }, true);
    conf.visionModel = String(this.data.visionModel || '').trim();
    return conf;
  },

  /** 测试连接：非流式 ping，展示 ok / 延迟毫秒 / 中文错误 */
  onTestConnection: function () {
    if (this.data.testing) return;
    var cfg = this.buildConfig();
    this.setData({ testing: true, testResult: null });
    var self = this;
    api.testConnection(cfg, true).then(function (res) {
      self.setData({
        testing: false,
        testResult: {
          ok: !!res.ok,
          message: res.message || '',
          latencyMs: Number(res.latencyMs) || 0,
          time: format.formatTime(Date.now())
        }
      });
    }).catch(function (err) {
      // testConnection 正常情况下不会 reject，这里兜底防止页面白屏
      self.setData({
        testing: false,
        testResult: {
          ok: false,
          message: '测试连接失败：' + ((err && err.message) || '未知错误'),
          latencyMs: 0,
          time: format.formatTime(Date.now())
        }
      });
    });
  },

  /** 保存配置 */
  onSave: function () {
    if (this.data.saving) return;
    var cfg = this.buildConfig();
    storage.setConfig(cfg);
    var app = getApp();
    if (app && typeof app.refreshGlobalData === 'function') {
      app.refreshGlobalData();
    }
    this.setData({
      saving: true,
      baseURL: cfg.baseURL,
      model: cfg.model,
      visionModel: cfg.visionModel,
      configured: !!(cfg.baseURL && cfg.apiKey && cfg.model),
      presetId: cfg.presetId
    });
    var self = this;
    setTimeout(function () {
      self.setData({ saving: false });
      wx.showToast({ title: '已保存', icon: 'success', duration: 1500 });
    }, 50);
  },

  /** 清空已填写的密钥与地址 */
  onClearConfig: function () {
    var self = this;
    wx.showModal({
      title: '清空配置',
      content: '将删除本机保存的模型地址、API Key 与模型名，确认继续？',
      confirmText: '清空',
      cancelText: '取消',
      success: function (res) {
        if (!res.confirm) return;
        storage.clearConfig();
        self.loadConfig();
        self.setData({ apiKey: '', testResult: null, configured: false });
      }
    });
  },

  /** 新手引导：跳到批改页直接试一篇（批改页是 tabBar 页，必须 switchTab） */
  onGoGrade: function () {
    wx.switchTab({ url: '/pages/grade/grade' });
  },

  // ---------------- Skill 管理 ----------------

  loadSkill: function () {
    var custom = storage.getSkillCustom();
    var text = custom.text || '';
    this.setData({
      skillMeta: prompts.SKILL_META || {},
      skillEnabled: !!custom.enabled,
      skillText: text,
      skillTextLen: text.length,
      skillOverLimit: text.length > SKILL_TEXT_MAX
    });
  },

  /** 自定义 Skill 覆盖开关 */
  onSkillToggle: function (e) {
    var enabled = !!e.detail.value;
    var cur = storage.setSkillCustom({ enabled: enabled });
    this.setData({ skillEnabled: !!cur.enabled });
    wx.showToast({
      title: cur.enabled ? '已启用自定义 Skill' : '已恢复内置 Skill',
      icon: 'none',
      duration: 1500
    });
  },

  /** 粘贴自定义 Skill 文本 */
  onSkillTextInput: function (e) {
    var text = e.detail.value;
    this.setData({
      skillText: text,
      skillTextLen: text.length,
      skillOverLimit: text.length > SKILL_TEXT_MAX
    });
  },

  /** 从剪贴板粘贴 */
  onSkillPaste: function () {
    var self = this;
    privacy.ensurePrivacy(function () { self.doSkillPaste(); }, '同意隐私指引后才能读取剪贴板');
  },

  doSkillPaste: function () {
    var self = this;
    wx.getClipboardData({
      success: function (res) {
        var text = res.data || '';
        self.setData({
          skillText: text,
          skillTextLen: text.length,
          skillOverLimit: text.length > SKILL_TEXT_MAX
        });
      },
      fail: function () {
        wx.showToast({ title: '读取剪贴板失败，请手动粘贴', icon: 'none' });
      }
    });
  },

  /** 保存自定义 Skill（存 storage，key: slz_skill_custom） */
  onSaveSkill: function () {
    var text = this.data.skillText || '';
    if (text.length > SKILL_TEXT_MAX) {
      wx.showModal({
        title: '文本过长',
        content: '自定义 Skill 最多 ' + SKILL_TEXT_MAX + ' 字，当前 ' + text.length + ' 字，请精简后再保存。',
        showCancel: false
      });
      return;
    }
    var saved = storage.setSkillCustom({
      enabled: this.data.skillEnabled,
      text: text
    });
    this.setData({ skillEnabled: !!saved.enabled });
    wx.showToast({ title: '已保存', icon: 'success', duration: 1500 });
  },

  /** 清空自定义 Skill 文本 */
  onClearSkill: function () {
    var self = this;
    wx.showModal({
      title: '清空自定义 Skill',
      content: '将删除已粘贴的自定义 Skill 文本，确认继续？',
      confirmText: '清空',
      cancelText: '取消',
      success: function (res) {
        if (!res.confirm) return;
        storage.setSkillCustom({ text: '' });
        self.loadSkill();
      }
    });
  },

  /**
   * 组装可导出的 Skill 文本：说明头 + 五维评分要点 + 两套提示词全文。
   * skill/SHENLUN-SKILL.md 原文太长不适合放进剪贴板，这里导出的是可直接粘贴使用的
   * 运行时提示词（GRADE_PROMPT / COACH_PROMPT）与元信息。
   */
  buildExportText: function () {
    var meta = prompts.SKILL_META || {};
    var lines = [];
    lines.push('【' + (meta.name || '申论朱批 Skill') + '】版本 ' + (meta.version || prompts.SKILL_VERSION || ''));
    if (meta.source) lines.push('方法论来源：' + meta.source);
    if (meta.summary) lines.push('概述：' + meta.summary);
    if (meta.disclaimer) lines.push('免责声明：' + meta.disclaimer);
    lines.push('');
    lines.push('=== 批改系统提示词 GRADE_PROMPT ===');
    lines.push(prompts.GRADE_PROMPT || '');
    lines.push('');
    lines.push('=== 陪练系统提示词 COACH_PROMPT ===');
    lines.push(prompts.COACH_PROMPT || '');
    return lines.join('\n');
  },

  /** 导出（复制到剪贴板） */
  onExportSkill: function () {
    var self = this;
    // 剪贴板属隐私接口：先过隐私授权
    privacy.ensurePrivacy(function () {
      self.doExportSkill();
    }, '需要同意《用户隐私保护指引》后才能导出');
  },

  doExportSkill: function () {
    var text = this.buildExportText();
    wx.setClipboardData({
      data: text,
      success: function () {
        wx.showToast({ title: '已复制到剪贴板', icon: 'none', duration: 1800 });
      },
      fail: function () {
        wx.showModal({
          title: '复制失败',
          content: '请检查剪贴板权限，或手动长按选择文本。',
          showCancel: false
        });
      }
    });
  }
});
