/**
 * utils/format.js —— 时间与字数格式化（零依赖）
 * 供历史列表、结果页、批改页实时字数等场景使用。
 */

var MS_MIN = 60 * 1000;
var MS_HOUR = 60 * MS_MIN;
var MS_DAY = 24 * MS_HOUR;

function pad2(n) {
  n = Math.floor(Math.abs(n));
  return n < 10 ? '0' + n : '' + n;
}

function toDate(input) {
  if (input === null || input === undefined || input === '') return null;
  if (input instanceof Date) {
    return isNaN(input.getTime()) ? null : input;
  }
  if (typeof input === 'number') {
    var d = new Date(input);
    return isNaN(d.getTime()) ? null : d;
  }
  var s = String(input).trim();
  if (/^\d+$/.test(s)) {
    var d2 = new Date(Number(s));
    return isNaN(d2.getTime()) ? null : d2;
  }
  var iso = s.indexOf('T') !== -1 ? s : s.replace(/-/g, '/');
  var t = Date.parse(iso);
  return isNaN(t) ? null : new Date(t);
}

/**
 * 格式化为「2026-10-03 16:20」
 * @param {number|string|Date} input 时间戳或可解析的时间字符串
 * @returns {string} 解析失败返回空串
 */
function formatTime(input) {
  var d = toDate(input);
  if (!d) return '';
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
    ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

/**
 * 格式化为「10月03日」
 * @param {number|string|Date} input
 * @returns {string}
 */
function formatDate(input) {
  var d = toDate(input);
  if (!d) return '';
  return pad2(d.getMonth() + 1) + '月' + pad2(d.getDate()) + '日';
}

/**
 * 相对时间：刚刚 / 12分钟前 / 3小时前 / 10月03日 / 2025年10月03日
 * @param {number|string|Date} input
 * @param {number} [now] 当前时间戳，便于测试
 * @returns {string}
 */
function fromNow(input, now) {
  var d = toDate(input);
  if (!d) return '';
  var base = typeof now === 'number' ? now : Date.now();
  var diff = base - d.getTime();
  if (diff < 0) diff = 0;
  if (diff < MS_MIN) return '刚刚';
  if (diff < MS_HOUR) return Math.floor(diff / MS_MIN) + '分钟前';
  if (diff < MS_DAY) return Math.floor(diff / MS_HOUR) + '小时前';
  var today = new Date(base);
  var sameYear = d.getFullYear() === today.getFullYear();
  if (sameYear) return formatDate(d);
  return d.getFullYear() + '年' + formatDate(d);
}

/**
 * 按「天」轮换取今日金句：东八区零点准时轮换。
 * @param {string[]} list 金句数组
 * @param {number} [seed] 可选的日期偏移，便于测试
 * @returns {string} 数组为空返回空串
 */
function todayOf(list, seed) {
  if (!Array.isArray(list) || list.length === 0) return '';
  var base = typeof seed === 'number' ? seed : Date.now();
  // 东八区偏移 +8 小时，确保中国时间午夜 00:00 准时切换
  var days = Math.floor((base + 8 * MS_HOUR) / MS_DAY);
  return list[((days % list.length) + list.length) % list.length];
}

/**
 * 中文字数统计：汉字与全角标点按字计（申论格子标准），英文单词按词计，忽略空白。
 * 用于批改页「我的作答」实时字数。
 * @param {string} text
 * @returns {number}
 */
function countWords(text) {
  if (!text) return 0;
  var s = String(text);
  var cn = s.match(/[\u4e00-\u9fa5\u3000-\u303f\uff01-\uff5e]/g);
  var en = s.match(/[A-Za-z0-9]+/g);
  return (cn ? cn.length : 0) + (en ? en.length : 0);
}

/**
 * 按字数和题型给出作答长度评价（申论卷面提示）。
 * @param {number} words
 * @param {string} [type] 题型（归纳概括/文章写作等）
 * @returns {string}
 */
function judgeLength(words, type) {
  var n = Number(words) || 0;
  if (n <= 0) return '尚未落笔';
  return '已输入约 ' + n + ' 字，请对照本题字数要求';
}

/**
 * 平均分格式化：保留一位小数，无数据返回「—」。
 * @param {number} value
 * @returns {string}
 */
function formatScore(value) {
  if (value === null || value === undefined || value === '') return '—';
  var n = Number(value);
  if (!isFinite(n)) return '—';
  return (Math.round(n * 10) / 10).toFixed(1);
}

/**
 * 截断长文本用于列表摘要。
 * @param {string} text
 * @param {number} [len] 默认 40
 * @returns {string}
 */
function brief(text, len) {
  var n = typeof len === 'number' ? len : 40;
  var s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}

module.exports = {
  formatTime: formatTime,
  formatDate: formatDate,
  fromNow: fromNow,
  todayOf: todayOf,
  countWords: countWords,
  judgeLength: judgeLength,
  formatScore: formatScore,
  brief: brief
};
