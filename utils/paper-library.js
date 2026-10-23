'use strict';
var index = require('../data/mp-papers-index.js');
var auth = require('./auth.js');
var cache = [], owner = -1;

function findMeta(id) {
  for (var i = 0; i < index.papers.length; i++) if (index.papers[i].id === id) return index.papers[i];
  return null;
}
function loadPaper(id) {
  var meta = findMeta(id), session = auth.getSession(), started = auth.version();
  if (!meta) return Promise.reject(new Error('这套试卷未通过本地数据检查。'));
  if (!session || auth.isSwitching()) return Promise.reject(new Error('请先登录账号，再读取收录试卷。'));
  if (owner !== started) { cache = []; owner = started; }
  for (var i = 0; i < cache.length; i++) if (cache[i].id === id) {
    var hit = cache.splice(i, 1)[0]; cache.unshift(hit); return Promise.resolve(hit.paper);
  }
  return new Promise(function (resolve, reject) {
    wx.request({
      url: auth.ORIGIN + '/api/mp/papers/' + id,
      method: 'GET', header: { Authorization: 'Bearer ' + session.token }, timeout: 20000,
      success: function (res) {
        if (started !== auth.version() || auth.isSwitching()) { reject(new Error('账号已切换，已丢弃旧请求。')); return; }
        if (res.statusCode === 401) { auth.invalidate(session.token); reject(new Error('登录已失效，请重新登录。')); return; }
        if (res.statusCode !== 200) { reject(new Error(res.statusCode === 404 ? '试卷接口或数据尚未上线，请稍后重试。' : '试卷暂时无法读取，请重试。')); return; }
        var paper = res.data;
        if (!paper || paper.id !== id || !Array.isArray(paper.materials) || paper.materials.length !== meta.materials ||
            !Array.isArray(paper.questions) || paper.questions.length !== meta.questions ||
            paper.materials.some(function (m) { return !m || typeof m.text !== 'string' || !m.text.trim(); }) ||
            paper.questions.some(function (q) { return !q || typeof q.stem !== 'string' || !q.stem.trim(); })) {
          reject(new Error('返回的试卷内容不完整或格式不正确。')); return;
        }
        cache.unshift({ id: id, paper: paper }); cache = cache.slice(0, 3);
        resolve(paper);
      },
      fail: function (err) { reject(new Error(/domain|合法域名/i.test((err && err.errMsg) || '')
        ? '请先配置 request 合法域名 https://shenlundawang.asia。' : '读取失败，请检查网络后重试。')); }
    });
  });
}
function guessType(stem) {
  if (/写一篇文章|自拟题目/.test(stem) && /文章|作文/.test(stem)) return '文章写作';
  if (/讲话稿|公开信|倡议书|提纲|简报|通知|报道|评论|宣传|汇报|发言/.test(stem)) return '公文写作';
  if (/对策|建议|措施/.test(stem) && /提出|给出|针对/.test(stem)) return '提出对策';
  if (/谈谈|分析|评价|看法|理解|启示|含义/.test(stem)) return '综合分析';
  return '归纳概括';
}
function prepareQuestion(paper, questionIndex) {
  var q = paper.questions[questionIndex];
  if (!q) throw new Error('找不到这道题。');
  var requirements = Array.isArray(q.requirements) ? q.requirements.filter(function (s) { return typeof s === 'string' && s.trim(); }) : [];
  var meta = findMeta(paper.id);
  return {
    id: paper.id + ':q:' + questionIndex, paperTitle: paper.title,
    question: q.stem + (requirements.length ? '\n\n作答要求：\n' + requirements.join('\n') : ''),
    material: paper.materials.map(function (m, i) { return '【给定资料' + (m.no || i + 1) + '】\n' + m.text; }).join('\n\n'),
    type: guessType(q.stem), sourceLabel: meta && meta.recalled ? '收录试卷 · 回忆版' : '收录试卷 · 第三方来源',
    sourceNote: (paper.copyrightNote || '第三方收录内容，非官方发布版本，请核对来源。') + '\n已载入整卷材料，请按题干确定适用范围。题型为自动建议，可手动调整。',
    sourceUrl: paper.sourceUrl || '', referenceAnswer: ''
  };
}
module.exports = { index: index, findMeta: findMeta, loadPaper: loadPaper, prepareQuestion: prepareQuestion };
