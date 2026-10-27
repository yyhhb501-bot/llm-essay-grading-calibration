/** Portable Ridge inference. No bundled synthetic weights are used for real essays. */
(function (root) {
  'use strict';
  var model = null;
  var types = ['归纳概括', '综合分析', '提出对策', '公文写作', '文章写作'];
  var features = ['raw_llm_score', 'key_point_coverage', 'dim_keypoints', 'dim_logic',
    'dim_language', 'dim_policy', 'dim_format', 'word_count', 'type_guina',
    'type_zonghe', 'type_duice', 'type_gongwen', 'type_wenzhang'];
  function finite(n) { return typeof n === 'number' && isFinite(n); }
  function score(n) { return finite(n) && n >= 0 && n <= 100; }
  function configure(value) {
    model = null;
    if (!value || value.schema_version !== 1 || value.model_type !== 'ridge' ||
        value.approved_for_runtime !== true || !value.training_provenance ||
        value.training_provenance.data_kind !== 'human' ||
        value.training_provenance.human_labels_verified !== true ||
        !/^[a-f0-9]{64}$/.test(value.training_provenance.source_sha256 || '') ||
        JSON.stringify(value.feature_names) !== JSON.stringify(features) ||
        !value.feature_transform || value.feature_transform.word_count !== 'divide_by_100' ||
        !value.weights || !finite(value.weights.intercept)) return false;
    if (!features.every(function (name) { return finite(value.weights[name]); })) return false;
    model = JSON.parse(JSON.stringify(value));
    return true;
  }
  function reliability(scores) {
    if (!Array.isArray(scores) || scores.length < 2 || !scores.every(score)) {
      return { n: Array.isArray(scores) ? scores.length : 0, variance: null, std: null,
        badge: '重复评分不足，一致性待验证' };
    }
    var mean = scores.reduce(function (s, n) { return s + n; }, 0) / scores.length;
    var variance = scores.reduce(function (s, n) { return s + Math.pow(n - mean, 2); }, 0) / (scores.length - 1);
    return { n: scores.length, variance: variance, std: Math.sqrt(variance),
      badge: scores.length + ' 次评分，标准差 ' + Math.sqrt(variance).toFixed(1) + ' 分（仅表示稳定性）' };
  }
  function featureValues(params) {
    if (!params || !score(params.raw_total) || types.indexOf(params.question_type) < 0 ||
        !finite(params.word_count) || params.word_count < 1 || params.word_count > 100000 ||
        !finite(params.coverage) || params.coverage < 0 || params.coverage > 1) return null;
    var dims = params.dimensions || {};
    var names = ['要点完整度', '逻辑结构', '语言规范', '政策素养', '卷面格式'];
    var values = names.map(function (name, i) {
      return Object.prototype.hasOwnProperty.call(dims, name) ? dims[name] : dims[features[i + 2]];
    });
    if (!values.every(score)) return null;
    return [params.raw_total, params.coverage].concat(values, [params.word_count / 100],
      types.map(function (name) { return name === params.question_type ? 1 : 0; }));
  }
  function calibrateScore(params) {
    if (!model) return null;
    var values = featureValues(params);
    if (!values) return null;
    var prediction = features.reduce(function (s, name, i) { return s + model.weights[name] * values[i]; }, model.weights.intercept);
    var result = Math.round(Math.max(0, Math.min(100, prediction)) * 10) / 10;
    return { calibrated_score: result, raw_score: params.raw_total,
      score_diff: Math.round((result - params.raw_total) * 10) / 10,
      reliability: reliability(params.repeated_scores) };
  }
  var api = { configure: configure, calibrateScore: calibrateScore, reliability: reliability,
    featureValues: featureValues, isReady: function () { return !!model; }, FEATURE_NAMES: features.slice() };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ScoreCalibrator = api;
})(typeof window !== 'undefined' ? window : globalThis);
