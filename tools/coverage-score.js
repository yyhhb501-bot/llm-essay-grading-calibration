'use strict';
// 覆盖率评分模块 v1（训练锚点口径）
// 用共识采分点组把"要点完整度"从 LLM 印象分改造成可复算的加权覆盖率。
// 纯函数、零依赖：工具（node require）、网站（build-site.js 打包为 window.CoverageScore）共用同一份。
//
// 设计（对应 skill/CALIBRATION.md 第二轮 P1）：
// - 每个共识组一个权重：core(>=2家机构都写) 1.0 起，每多一家 +0.25，封顶 2.0；
//   single(仅一家写) 0.4 —— 漏写小扣，写了不白写。
// - 命中度 hit：完整1 / 部分0.5 / 偏差0.2 / 未写0（由 Stage A 逐组判定，程序只汇总）。
// - 覆盖率 = Σ(权重×命中) / Σ(权重)，0..1。
// - 要点完整度分 = 维度满分 × 覆盖率（部分命中已在 hit 里体现，不再二次打折）。
// - 若题目有分值，可输出「估算卷面分」= 题目分值 × 覆盖率，必须标注非官方估算。

var HIT_LEVEL = { full: 1, partial: 0.5, deviated: 0.2, missing: 0 };

/** 题型 → 要点完整度维度满分（必须与 skill/prompts.js 第四节五维表一致） */
var POINT_DIMENSION_MAX = {
  '归纳概括': 60,
  '综合分析': 45,
  '提出对策': 40,
  '公文写作': 40,
  '文章写作': 35
};

function pointDimensionMax(typeName) {
  return POINT_DIMENSION_MAX[String(typeName || '').trim()] || 60;
}

function groupWeight(group) {
  var count = Math.max(1, Number(group.count) || (group.institutions ? group.institutions.length : 1));
  if (group.level === 'core' || count >= 2) return Math.min(2, 1 + 0.25 * (count - 2));
  return 0.4;
}

/** groups: [{count, level?, institutions?}], hits: [{groupId或index, hit: 'full'|'partial'|'deviated'|'missing'}]
 *  hits 允许稀疏：未列出的组按 missing 计。 */
function coverage(groups, hits) {
  var hitMap = {};
  (hits || []).forEach(function(h, i) { hitMap[h.groupId !== undefined ? h.groupId : i] = h.hit; });
  var sumW = 0, sumWH = 0;
  (groups || []).forEach(function(g, i) {
    var w = groupWeight(g);
    var lvl = hitMap[i] || 'missing';
    var hv = HIT_LEVEL[lvl] !== undefined ? HIT_LEVEL[lvl] : 0;
    sumW += w; sumWH += w * hv;
  });
  return sumW ? sumWH / sumW : 0;
}

/** coverage → 要点完整度分。curve 可选 'linear'（默认）。
 *  说明：部分命中在 hit 里已计 0.5，此处保持线性，避免双重惩罚；
 *  档位感来自覆盖率本身（0.9+≈A档要点水平，0.6≈C档）。 */
function pointDimensionScore(coverageRatio, dimensionMax) {
  return Math.round(dimensionMax * Math.max(0, Math.min(1, coverageRatio)) * 10) / 10;
}

/** 估算卷面分（非官方）：题目分值 × 覆盖率，四舍五入到 0.5 */
function estimateExamScore(coverageRatio, questionScore) {
  if (!questionScore) return null;
  return Math.round(questionScore * Math.max(0, Math.min(1, coverageRatio)) * 2) / 2;
}

/** 给 Stage B（报告生成）用的命中表文本：LLM 拿到后据此写要点核对与失分归纳 */
function renderAnchorTable(groups, hits, opts) {
  opts = opts || {};
  var hitMap = {};
  (hits || []).forEach(function(h, i) { hitMap[h.groupId !== undefined ? h.groupId : i] = h.hit; });
  var lines = [];
  (groups || []).forEach(function(g, i) {
    var lvl = hitMap[i] || 'missing';
    var tag = { full: '[完整命中]', partial: '[部分命中]', deviated: '[语义偏差]', missing: '[未写]' }[lvl] || '[未写]';
    var cons = g.count >= 2 ? '共识点(' + g.count + '家)' : '单源点';
    lines.push(tag + cons + ' ' + (g.text || ''));
  });
  return lines.join('\n');
}

/** 给 Stage B 注入用的完整核算块：覆盖率、要点完整度分、逐组命中表。
 *  opts.dimensionMax 缺省按题型表取；opts.typeName 可直接传题型名。 */
function renderAnchorBlock(groups, hits, opts) {
  opts = opts || {};
  var max = Number(opts.dimensionMax) > 0 ? Number(opts.dimensionMax) : pointDimensionMax(opts.typeName);
  var cov = coverage(groups, hits);
  var score = pointDimensionScore(cov, max);
  var pct = Math.round(cov * 1000) / 10;
  return '程序核算：共识加权覆盖率 ' + pct + '%，要点完整度 = ' + score + ' / ' + max + '。\n' + renderAnchorTable(groups, hits);
}

/** 宽容解析 Stage A 的 JSON 输出 → 规范命中数组；失败返回 null。
 *  返回：[{groupId:Number, hit:'full|partial|deviated|missing', evidence:String}] */
function parseHits(text) {
  var raw = String(text == null ? '' : text);
  var fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) raw = fence[1];
  var start = raw.indexOf('{');
  var end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  var seg = raw.slice(start, end + 1);
  var obj = null;
  try { obj = JSON.parse(seg); } catch (e) {
    try { obj = JSON.parse(sanitizeJsonStrings(seg)); } catch (e2) { return null; }
  }
  if (!obj || !Array.isArray(obj.hits)) return null;
  return obj.hits.map(function(h, i) {
    var hit = String((h && h.hit) || '').trim().toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(HIT_LEVEL, hit)) hit = 'missing';
    var id = h && h.id !== undefined && h.id !== null && h.id !== '' ? Number(h.id) : i;
    if (!isFinite(id)) id = i;
    return { groupId: id, hit: hit, evidence: String((h && h.evidence) || '') };
  });
}

/** 把字符串里的裸换行/制表符转义，容忍模型输出的“未转义换行 JSON” */
function sanitizeJsonStrings(raw) {
  var out = '', inStr = false, esc = false;
  for (var i = 0; i < raw.length; i++) {
    var ch = raw.charAt(i);
    if (inStr) {
      if (esc) { out += ch; esc = false; continue; }
      if (ch === '\\') { out += ch; esc = true; continue; }
      if (ch === '"') { inStr = false; out += ch; continue; }
      if (ch === '\n') { out += '\\n'; continue; }
      if (ch === '\r') { out += '\\r'; continue; }
      if (ch === '\t') { out += '\\t'; continue; }
      out += ch;
    } else {
      if (ch === '"') inStr = true;
      out += ch;
    }
  }
  return out.replace(/,\s*([\]}])/g, '$1');
}

module.exports = {
  HIT_LEVEL: HIT_LEVEL,
  POINT_DIMENSION_MAX: POINT_DIMENSION_MAX,
  pointDimensionMax: pointDimensionMax,
  groupWeight: groupWeight,
  coverage: coverage,
  pointDimensionScore: pointDimensionScore,
  estimateExamScore: estimateExamScore,
  renderAnchorTable: renderAnchorTable,
  renderAnchorBlock: renderAnchorBlock,
  parseHits: parseHits
};
