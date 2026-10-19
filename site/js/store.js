/**
 * site/js/store.js —— localStorage 存储层（替代小程序的 wx.storage，方案-网站.md §2）
 *
 * key 命名沿用小程序版的 slz_ 前缀，历史记录同样「新的在前、封顶 50 条」：
 *   slz_config       接入配置 {mode, presetId, baseURL, apiKey, model, visionModel, accessCode}
 *   slz_history      历史记录数组（批改 grade / 对话 chat）
 *   slz_plan         备考计划 {form, content, checkins}
 *
 * mode 两种取值（方案 §1）：
 *   'server'  服务端模式 —— 朋友只填访问口令，Key 在 Worker 环境变量里；
 *   'selfkey' 自带 Key 模式 —— 朋友自己填 apiKey/baseURL，Worker 只做纯转发。
 *
 * 任何读写异常（隐私模式、配额满）都退化为默认值，绝不抛出。
 */
(function (root) {
  'use strict';

  var KEYS = {
    CONFIG: 'slz_config',
    HISTORY: 'slz_history',
    PLAN: 'slz_plan'
  };

  /** 历史记录条数上限（与小程序版一致） */
  var HISTORY_LIMIT = 50;

  var DEFAULT_CONFIG = {
    mode: 'server',
    presetId: '',
    baseURL: '',
    apiKey: '',
    model: '',
    visionModel: '',
    accessCode: ''
  };

  var DEFAULT_PLAN = { form: null, content: '', checkins: {} };

  // ---- 内部工具 ----

  function safeGet(key, fallback) {
    try {
      var v = root.localStorage.getItem(key);
      if (v === '' || v === null || v === undefined) return fallback;
      return JSON.parse(v);
    } catch (e) {
      return fallback;
    }
  }

  function safeSet(key, value) {
    try {
      root.localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      return false;
    }
  }

  function safeRemove(key) {
    try {
      root.localStorage.removeItem(key);
      return true;
    } catch (e) {
      return false;
    }
  }

  /** 简易唯一 id：时间戳 + 随机串，零依赖 */
  function makeId(prefix) {
    var t = Date.now().toString(36);
    var r = Math.floor(Math.random() * 1679616).toString(36);
    return (prefix || 'id') + '_' + t + r;
  }

  /** 补全历史条目字段，保证结构与小程序版一致 */
  function normalizeItem(item) {
    var it = item || {};
    var type = it.type === 'chat' ? 'chat' : 'grade';
    return {
      id: it.id || makeId(type),
      type: type,
      title: it.title || (type === 'chat' ? '解题对话' : '申论批改'),
      time: it.time || Date.now(),
      payload: it.payload || {}
    };
  }

  // ---- 接入配置 ----

  /** 读取接入配置，永不返回 null */
  function getConfig() {
    var c = safeGet(KEYS.CONFIG, null);
    var out = {};
    out.mode = (c && c.mode === 'selfkey') ? 'selfkey' : 'server';
    out.presetId = (c && c.presetId) || DEFAULT_CONFIG.presetId;
    out.baseURL = (c && c.baseURL) || DEFAULT_CONFIG.baseURL;
    out.apiKey = (c && c.apiKey) || DEFAULT_CONFIG.apiKey;
    out.model = (c && c.model) || DEFAULT_CONFIG.model;
    out.visionModel = (c && c.visionModel) || DEFAULT_CONFIG.visionModel;
    out.accessCode = (c && c.accessCode) || DEFAULT_CONFIG.accessCode;
    return out;
  }

  /** 局部更新接入配置（只覆盖传入的字段） */
  function setConfig(patch) {
    var next = getConfig();
    var p = patch || {};
    if (p.mode !== undefined) next.mode = p.mode === 'selfkey' ? 'selfkey' : 'server';
    if (p.presetId !== undefined) next.presetId = String(p.presetId || '').trim();
    if (p.baseURL !== undefined) next.baseURL = String(p.baseURL || '').trim();
    if (p.apiKey !== undefined) next.apiKey = String(p.apiKey || '').trim();
    if (p.model !== undefined) next.model = String(p.model || '').trim();
    if (p.visionModel !== undefined) next.visionModel = String(p.visionModel || '').trim();
    if (p.accessCode !== undefined) next.accessCode = String(p.accessCode || '').trim();
    safeSet(KEYS.CONFIG, next);
    return next;
  }

  function clearConfig() {
    safeRemove(KEYS.CONFIG);
    return getConfig();
  }

  /** 是否已经可以发请求：服务端模式只要口令，自带 Key 模式要三件套齐全 */
  function isConfigured(cfg) {
    var c = cfg || getConfig();
    if (c.mode === 'selfkey') {
      return !!(c.baseURL && c.apiKey && c.model);
    }
    return !!c.accessCode;
  }

  // ---- 历史记录 ----

  function getHistory() {
    var h = safeGet(KEYS.HISTORY, []);
    if (!Array.isArray(h)) return [];
    return h.map(normalizeItem);
  }

  function getHistoryById(id) {
    var list = getHistory();
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) return list[i];
    }
    return null;
  }

  /** 截断到上限并写回 */
  function persistHistory(list) {
    var arr = Array.isArray(list) ? list.slice(0, HISTORY_LIMIT) : [];
    safeSet(KEYS.HISTORY, arr);
    return arr;
  }

  /** 新增一条历史（新的在前，超过 50 条自动丢弃最旧的） */
  function addHistory(item) {
    var entry = normalizeItem(item);
    var list = getHistory();
    list.unshift(entry);
    persistHistory(list);
    return entry;
  }

  /** 按 id 更新局部字段（流式写回批改正文时用） */
  function updateHistory(id, patch) {
    var list = getHistory();
    var p = patch || {};
    var hit = null;
    for (var i = 0; i < list.length; i++) {
      if (list[i].id !== id) continue;
      var merged = {
        id: list[i].id,
        type: list[i].type,
        title: p.title !== undefined ? p.title : list[i].title,
        time: p.time !== undefined ? p.time : list[i].time,
        payload: p.payload !== undefined ? p.payload : list[i].payload
      };
      list[i] = normalizeItem(merged);
      hit = list[i];
      break;
    }
    persistHistory(list);
    return hit;
  }

  function removeHistory(id) {
    var list = getHistory().filter(function (it) {
      return it.id !== id;
    });
    persistHistory(list);
    return list;
  }

  function clearHistory() {
    safeRemove(KEYS.HISTORY);
    return [];
  }

  function filterHistory(type) {
    var list = getHistory();
    if (!type || type === 'all') return list;
    return list.filter(function (it) {
      return it.type === type;
    });
  }

  // ---- 备考计划 ----

  function getPlan() {
    var p = safeGet(KEYS.PLAN, null);
    return {
      form: p && p.form ? p.form : null,
      content: (p && p.content) || '',
      checkins: (p && p.checkins && typeof p.checkins === 'object') ? p.checkins : {}
    };
  }

  function setPlan(patch) {
    var cur = getPlan();
    var p = patch || {};
    if (p.form !== undefined) cur.form = p.form;
    if (p.content !== undefined) cur.content = String(p.content || '');
    if (p.checkins !== undefined) {
      cur.checkins = (p.checkins && typeof p.checkins === 'object') ? p.checkins : {};
    }
    safeSet(KEYS.PLAN, cur);
    return cur;
  }

  /** 某一周的打卡开关，返回打卡后的状态 */
  function toggleCheckin(week) {
    var cur = getPlan();
    var key = String(week);
    cur.checkins[key] = !cur.checkins[key];
    safeSet(KEYS.PLAN, cur);
    return !!cur.checkins[key];
  }

  /** 是否已有本地保存过的配置（区分「首次打开」与用户已自行设置过） */
  function hasStoredConfig() {
    return safeGet(KEYS.CONFIG, null) !== null;
  }

  root.Store = {
    KEYS: KEYS,
    HISTORY_LIMIT: HISTORY_LIMIT,
    DEFAULT_CONFIG: DEFAULT_CONFIG,
    makeId: makeId,
    getConfig: getConfig,
    setConfig: setConfig,
    clearConfig: clearConfig,
    isConfigured: isConfigured,
    hasStoredConfig: hasStoredConfig,
    getHistory: getHistory,
    getHistoryById: getHistoryById,
    addHistory: addHistory,
    updateHistory: updateHistory,
    removeHistory: removeHistory,
    clearHistory: clearHistory,
    filterHistory: filterHistory,
    getPlan: getPlan,
    setPlan: setPlan,
    toggleCheckin: toggleCheckin
  };
})(typeof window !== 'undefined' ? window : this);