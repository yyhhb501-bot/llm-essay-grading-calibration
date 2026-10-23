/**
 * site/js/store.js —— localStorage 存储层（替代小程序的 wx.storage，方案-网站.md §2 & docs/账号登录实施方案.md）
 *
 * 账号隔离设计：
 *   1. 网站运行（http:/https:）时，按当前登录用户的不可变 user.id 进行命名空间隔离：
 *      slz_u_<userId>_config   当前账号接入配置
 *      slz_u_<userId>_history  当前账号历史记录（最多 50 条）
 *      slz_u_<userId>_plan     当前账号备考计划与打卡
 *   2. 既有未归属账号的原始 slz_* 键完整保留，绝不静默迁移或覆盖；
 *   3. 未登录状态下所有读取均返回安全的空白默认值，不读取或污染任何账号数据；
 *   4. 单文件离线运行（file: 协议）保持原有的全局存储模式，保证离线单机体验。
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
  var boundUserId = null;

  // Bind once per document. A session changing during an old stream must never
  // redirect that stream's writes into the newly logged-in account.
  function bindUser(id) {
    if (boundUserId && boundUserId !== id) return false;
    boundUserId = id || null;
    return !!boundUserId;
  }

  // ---- 内部工具 ----

  function isWebsite() {
    return typeof location !== 'undefined' && (location.protocol === 'http:' || location.protocol === 'https:');
  }

  /**
   * 根据当前运行环境与登录状态获取隔离的存储键名
   * @param {string} baseKey 原始基础键名（如 'slz_config'）
   * @returns {string|null} 隔离后的键名；未登录网站返回 null
   */
  function getUserKey(baseKey) {
    if (!isWebsite()) {
      return baseKey; // 离线单机文件保持原键
    }
    var user = root.Auth && typeof root.Auth.getUser === 'function' ? root.Auth.getUser() : null;
    if (!user || !user.id || user.id !== boundUserId) {
      return null; // 未登录网站隔离返回空
    }
    return 'slz_u_' + user.id + '_' + baseKey.replace(/^slz_/, '');
  }

  function safeGet(key, fallback) {
    if (!key) return fallback;
    try {
      var v = root.localStorage.getItem(key);
      if (v === '' || v === null || v === undefined) return fallback;
      return JSON.parse(v);
    } catch (e) {
      return fallback;
    }
  }

  function safeSet(key, value) {
    if (!key) return false;
    try {
      root.localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      return false;
    }
  }

  function safeRemove(key) {
    if (!key) return false;
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
    var key = getUserKey(KEYS.CONFIG);
    if (!key) return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    var c = safeGet(key, null);
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
    var key = getUserKey(KEYS.CONFIG);
    if (!key) return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    var next = getConfig();
    var p = patch || {};
    if (p.mode !== undefined) next.mode = p.mode === 'selfkey' ? 'selfkey' : 'server';
    if (p.presetId !== undefined) next.presetId = String(p.presetId || '').trim();
    if (p.baseURL !== undefined) next.baseURL = String(p.baseURL || '').trim();
    if (p.apiKey !== undefined) next.apiKey = String(p.apiKey || '').trim();
    if (p.model !== undefined) next.model = String(p.model || '').trim();
    if (p.visionModel !== undefined) next.visionModel = String(p.visionModel || '').trim();
    if (p.accessCode !== undefined) next.accessCode = String(p.accessCode || '').trim();
    safeSet(key, next);
    return next;
  }

  function clearConfig() {
    var key = getUserKey(KEYS.CONFIG);
    if (key) safeRemove(key);
    return getConfig();
  }

  /** 是否已经可以发请求：网站端官方模型只需登录账号，自带 Key 模式要三件套齐全 */
  function isConfigured(cfg) {
    var c = cfg || getConfig();
    if (c.mode === 'selfkey') {
      return !!(c.baseURL && c.apiKey && c.model);
    }
    if (!isWebsite()) {
      return !!c.accessCode;
    }
    return !!(root.Auth && typeof root.Auth.isAuthenticated === 'function' && root.Auth.isAuthenticated());
  }

  // ---- 历史记录 ----

  function getHistory() {
    var key = getUserKey(KEYS.HISTORY);
    if (!key) return [];
    var h = safeGet(key, []);
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
    var key = getUserKey(KEYS.HISTORY);
    var arr = Array.isArray(list) ? list.slice(0, HISTORY_LIMIT) : [];
    if (key) safeSet(key, arr);
    return arr;
  }

  /** 新增一条历史（新的在前，超过 50 条自动丢弃最旧的） */
  function addHistory(item) {
    var entry = normalizeItem(item);
    var key = getUserKey(KEYS.HISTORY);
    if (!key) return entry;
    var list = getHistory();
    list.unshift(entry);
    persistHistory(list);
    return entry;
  }

  /** 按 id 更新局部字段（流式写回批改正文时用） */
  function updateHistory(id, patch) {
    var key = getUserKey(KEYS.HISTORY);
    if (!key) return null;
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
    var key = getUserKey(KEYS.HISTORY);
    if (!key) return [];
    var list = getHistory().filter(function (it) {
      return it.id !== id;
    });
    persistHistory(list);
    return list;
  }

  function clearHistory() {
    var key = getUserKey(KEYS.HISTORY);
    if (key) safeRemove(key);
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
    var key = getUserKey(KEYS.PLAN);
    if (!key) return JSON.parse(JSON.stringify(DEFAULT_PLAN));
    var p = safeGet(key, null);
    return {
      form: p && p.form ? p.form : null,
      content: (p && p.content) || '',
      checkins: (p && p.checkins && typeof p.checkins === 'object') ? p.checkins : {}
    };
  }

  function setPlan(patch) {
    var key = getUserKey(KEYS.PLAN);
    if (!key) return JSON.parse(JSON.stringify(DEFAULT_PLAN));
    var cur = getPlan();
    var p = patch || {};
    if (p.form !== undefined) cur.form = p.form;
    if (p.content !== undefined) cur.content = String(p.content || '');
    if (p.checkins !== undefined) {
      cur.checkins = (p.checkins && typeof p.checkins === 'object') ? p.checkins : {};
    }
    safeSet(key, cur);
    return cur;
  }

  /** 某一周的打卡开关，返回打卡后的状态 */
  function toggleCheckin(week) {
    var key = getUserKey(KEYS.PLAN);
    if (!key) return false;
    var cur = getPlan();
    var k = String(week);
    cur.checkins[k] = !cur.checkins[k];
    safeSet(key, cur);
    return !!cur.checkins[k];
  }

  /** 是否已有本地保存过的配置（区分「首次打开」与用户已自行设置过） */
  function hasStoredConfig() {
    var key = getUserKey(KEYS.CONFIG);
    if (!key) return false;
    return safeGet(key, null) !== null;
  }

  root.Store = {
    bindUser: bindUser,
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
