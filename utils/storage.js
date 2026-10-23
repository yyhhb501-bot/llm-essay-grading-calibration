/**
 * utils/storage.js —— 本地存储层
 * 所有 key 统一使用 slz_ 前缀（见方案 §7）：
 *   slz_config       模型接入配置 {presetId, baseURL, apiKey, model, visionModel}
 *   slz_skill_custom 自定义 Skill 覆盖 {enabled, text}
 *   slz_history      历史记录数组（封顶 50 条，新的在前）
 *   slz_plan         备考计划 {form, content, checkins:{}}
 * 仅依赖微信小程序 wx.storageSync，零 npm 依赖。
 */

// ---- key 常量 ----
var KEYS = {
  CONFIG: 'slz_config',
  SKILL_CUSTOM: 'slz_skill_custom',
  HISTORY: 'slz_history',
  PLAN: 'slz_plan'
};

// 历史记录条数上限（方案 §7：封顶 50，新的在前）
var HISTORY_LIMIT = 50;

var DEFAULT_CONFIG = {
  presetId: 'deepseek',
  baseURL: 'https://api.deepseek.com',
  apiKey: '',
  model: 'deepseek-flash',
  // 视觉模型（拍照识别用，方案 §4.5），空串表示未配置，识别时回退主模型
  visionModel: 'deepseek-flash'
};

var DEFAULT_SKILL_CUSTOM = {
  enabled: false,
  text: ''
};

var DEFAULT_PLAN = {
  form: null,
  content: '',
  checkins: {}
};

// ---- 内部工具 ----

// Guest records remain untouched; no implicit migration to a signed-in account.
function scopeKey(key) {
  var session;
  try { session = wx.getStorageSync('slz_auth_session_v1'); } catch (_) {}
  var id = session && session.user && session.user.id;
  return typeof id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(id) &&
    /^[a-f0-9]{64}$/.test(session.token) && isFinite(session.expiresAt) && session.expiresAt > 0
    ? 'slz_account_' + id + '_' + key : key;
}

function removeAllLocalData() {
  var keys = wx.getStorageInfoSync().keys;
  keys.forEach(function (key) {
    if (Object.keys(KEYS).some(function (name) { return KEYS[name] === key; }) ||
        /^slz_account_/.test(key) || key === 'slz_auth_session_v1' || key === 'slz_model_consent_v1') {
      wx.removeStorageSync(key);
    }
  });
}

/** 安全读取：storage 中任何异常都退化为默认值，绝不抛出 */
function safeGet(key, fallback) {
  try {
    var v = wx.getStorageSync(scopeKey(key));
    if (v === '' || v === null || v === undefined) return fallback;
    return v;
  } catch (e) {
    return fallback;
  }
}

function safeSet(key, value) {
  try {
    wx.setStorageSync(scopeKey(key), value);
    return true;
  } catch (e) {
    return false;
  }
}

function safeRemove(key) {
  try {
    wx.removeStorageSync(scopeKey(key));
    return true;
  } catch (e) {
    return false;
  }
}

/** 生成简易唯一 id：时间戳 + 随机串，避免依赖第三方库 */
function makeId(prefix) {
  var t = Date.now().toString(36);
  var r = Math.floor(Math.random() * 1679616).toString(36);
  return (prefix || 'id') + '_' + t + r;
}

/** 补全历史条目字段，保证结构一致 */
function normalizeItem(item) {
  var it = item || {};
  return {
    id: it.id || makeId(it.type === 'chat' ? 'chat' : 'grade'),
    type: it.type === 'chat' ? 'chat' : 'grade',
    title: it.title || (it.type === 'chat' ? '解题对话' : '申论批改'),
    time: it.time || Date.now(),
    payload: it.payload || {}
  };
}

// ---- 模型配置 ----

/** 读取模型配置，永不返回 null */
function getConfig() {
  var c = safeGet(KEYS.CONFIG, null);
  var out = {};
  // 默认只用于首次安装；不能把已有其他厂商或自定义配置补成 DeepSeek。
  var source = c && typeof c === 'object' && !Array.isArray(c) ? c : DEFAULT_CONFIG;
  ['presetId', 'baseURL', 'apiKey', 'model', 'visionModel'].forEach(function (key) {
    out[key] = source[key] == null ? '' : String(source[key]);
  });
  return out;
}

/** 局部更新模型配置（只覆盖传入的字段） */
function setConfig(patch) {
  var next = getConfig();
  var p = patch || {};
  if (p.presetId !== undefined) next.presetId = p.presetId;
  if (p.baseURL !== undefined) next.baseURL = String(p.baseURL || '').trim();
  if (p.apiKey !== undefined) next.apiKey = String(p.apiKey || '').trim();
  if (p.model !== undefined) next.model = String(p.model || '').trim();
  if (p.visionModel !== undefined) next.visionModel = String(p.visionModel || '').trim();
  safeSet(KEYS.CONFIG, next);
  return next;
}

/** 清空模型配置（退出登录式重置） */
function clearConfig() {
  safeRemove(KEYS.CONFIG);
  return getConfig();
}

// ---- 自定义 Skill ----

function getSkillCustom() {
  var s = safeGet(KEYS.SKILL_CUSTOM, null);
  return {
    enabled: !!(s && s.enabled),
    text: (s && s.text) || DEFAULT_SKILL_CUSTOM.text
  };
}

/**
 * 保存自定义 Skill
 * @param {{enabled:boolean, text:string}} patch 局部更新
 */
function setSkillCustom(patch) {
  var cur = getSkillCustom();
  var p = patch || {};
  if (p.enabled !== undefined) cur.enabled = !!p.enabled;
  if (p.text !== undefined) cur.text = String(p.text || '');
  safeSet(KEYS.SKILL_CUSTOM, cur);
  return cur;
}

// ---- 历史记录 ----

/** 读取全部历史，新的在前 */
function getHistory() {
  var h = safeGet(KEYS.HISTORY, []);
  if (!Array.isArray(h)) return [];
  return h.map(normalizeItem);
}

/** 按 id 取一条记录，未找到返回 null */
function getHistoryById(id) {
  var list = getHistory();
  for (var i = 0; i < list.length; i++) {
    if (list[i].id === id) return list[i];
  }
  return null;
}

/** 截断到上限并写回；返回写回后的数组 */
function persistHistory(list) {
  var arr = Array.isArray(list) ? list.slice(0, HISTORY_LIMIT) : [];
  safeSet(KEYS.HISTORY, arr);
  return arr;
}

/**
 * 新增一条历史（新的在前，超过 50 条自动丢弃末尾最旧的）
 * @param {{type, title, payload}} item
 * @returns {object} 写入后的完整条目（含生成的 id）
 */
function addHistory(item) {
  var entry = normalizeItem(item);
  var list = getHistory();
  list.unshift(entry);
  persistHistory(list);
  return entry;
}

/**
 * 按 id 更新某条历史的局部字段（流式更新批改文本时使用）
 * @param {string} id
 * @param {object} patch 局部字段，如 {payload: {...}} 或 {title: '新标题'}
 * @returns {object|null} 更新后的条目，未找到返回 null
 */
function updateHistory(id, patch) {
  var list = getHistory();
  var p = patch || {};
  var hit = null;
  for (var i = 0; i < list.length; i++) {
    if (list[i].id !== id) continue;
    var merged = {};
    merged.id = list[i].id;
    merged.type = list[i].type;
    merged.title = p.title !== undefined ? p.title : list[i].title;
    merged.time = p.time !== undefined ? p.time : list[i].time;
    if (p.payload !== undefined) {
      if (typeof p.payload === 'object' && p.payload !== null && typeof list[i].payload === 'object' && list[i].payload !== null) {
        merged.payload = Object.assign({}, list[i].payload, p.payload);
      } else {
        merged.payload = p.payload;
      }
    } else {
      merged.payload = list[i].payload;
    }
    list[i] = normalizeItem(merged);
    hit = list[i];
    break;
  }
  persistHistory(list);
  return hit;
}

/** 删除单条历史 */
function removeHistory(id) {
  var list = getHistory().filter(function (it) {
    return it.id !== id;
  });
  persistHistory(list);
  return list;
}

/** 清空全部历史 */
function clearHistory() {
  safeRemove(KEYS.HISTORY);
  return [];
}

/**
 * 按类型筛选历史
 * @param {'all'|'grade'|'chat'} type
 */
function filterHistory(type) {
  var list = getHistory();
  if (!type || type === 'all') return list;
  return list.filter(function (it) {
    return it.type === type;
  });
}

// ---- 备考计划 ----

/** 读取备考计划，结构恒为 {form, content, checkins} */
function getPlan() {
  var p = safeGet(KEYS.PLAN, null);
  var out = {
    form: p && p.form ? p.form : null,
    content: (p && p.content) || '',
    checkins: (p && p.checkins && typeof p.checkins === 'object') ? p.checkins : {}
  };
  return out;
}

/**
 * 保存备考计划
 * @param {{form?:object, content?:string, checkins?:object}} patch 局部更新
 */
function setPlan(patch) {
  var cur = getPlan();
  var p = patch || {};
  if (p.form !== undefined) cur.form = p.form;
  if (p.content !== undefined) cur.content = String(p.content || '');
  if (p.checkins !== undefined) {
    cur.checkins = (p.checkins && typeof p.checkins === 'object' && !Array.isArray(p.checkins)) ? p.checkins : {};
  }
  safeSet(KEYS.PLAN, cur);
  return cur;
}

/**
 * 某一周的打卡开关
 * @param {string|number} week 周次标识
 * @returns {boolean} 打卡后为 true
 */
function toggleCheckin(week) {
  var cur = getPlan();
  var key = String(week);
  cur.checkins[key] = !cur.checkins[key];
  safeSet(KEYS.PLAN, cur);
  return !!cur.checkins[key];
}

module.exports = {
  scopeKey: scopeKey,
  removeAllLocalData: removeAllLocalData,
  KEYS: KEYS,
  HISTORY_LIMIT: HISTORY_LIMIT,
  DEFAULT_CONFIG: DEFAULT_CONFIG,
  DEFAULT_PLAN: DEFAULT_PLAN,
  makeId: makeId,
  getConfig: getConfig,
  setConfig: setConfig,
  clearConfig: clearConfig,
  getSkillCustom: getSkillCustom,
  setSkillCustom: setSkillCustom,
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
