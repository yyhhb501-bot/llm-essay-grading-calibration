'use strict';
// One-off patch: switch prefill to the gzip papers bundle with per-paper fallback.
const fs = require('fs');
const p = 'site/js/app.js';
let s = fs.readFileSync(p, 'utf8');
const marker = '  /** 把真题题干+对应材料+非官方参考答案预填进批改表单 */';
if (s.includes('loadPapersBundle')) { console.log('already patched'); process.exit(0); }
const idx = s.indexOf(marker);
if (idx < 0) { console.error('marker not found'); process.exit(1); }
const oldBlock = s.slice(idx, s.indexOf(']).then(function(res) {', idx) + ']).then(function(res) {'.length);
const newBlock = `  /** 全量卷子包：单文件 gzip，浏览器解压后按 id 取用（部署体积小、请求少） */
  var __papersBundlePromise = null;
  function loadPapersBundle() {
    if (root.__papersBundle) return Promise.resolve(root.__papersBundle);
    if (__papersBundlePromise) return __papersBundlePromise;
    __papersBundlePromise = root.fetch('js/vendor/papers-bundle.json.gz')
      .then(function(res) {
        if (!res.ok) throw new Error('bundle http ' + res.status);
        if (typeof DecompressionStream === 'undefined') throw new Error('no DecompressionStream');
        var ds = new DecompressionStream('gzip');
        var stream = res.body.pipeThrough(ds);
        return new Response(stream).text();
      })
      .then(function(text) {
        root.__papersBundle = JSON.parse(text);
        return root.__papersBundle;
      })
      .catch(function(e) {
        __papersBundlePromise = null;
        throw e;
      });
    return __papersBundlePromise;
  }

  /** 把真题题干+对应材料+非官方参考答案预填进批改表单 */
  function prefillFromPaperQuestion(paperId, questionIndex) {
    var meta = (root.PapersFullIndex || {})[paperId];
    if (!meta || !meta.qs || !meta.qs[questionIndex]) { toast('没有这道题'); return; }
    var q = meta.qs[questionIndex];
    var docPromise = loadPapersBundle()
      .then(function(bundle) { return bundle[paperId] || null; })
      .catch(function() {
        // 回退：逐卷文件（本地开发环境仍可用）
        return root.fetch('js/vendor/papers/' + paperId + '.json').then(function(r){ return r.ok ? r.json() : null; }).catch(function(){ return null; });
      });
    Promise.all([
      docPromise,
      root.fetch('js/vendor/consensus-points/' + paperId + '.json').then(function(r){ return r.ok ? r.json() : null; }).catch(function(){ return null; }),
      root.fetch('js/vendor/answer-points/' + paperId + '.json').then(function(r){ return r.ok ? r.json() : null; }).catch(function(){ return null; })
    ]).then(function(res) {`;
s = s.slice(0, idx) + newBlock + s.slice(idx + oldBlock.length);
fs.writeFileSync(p, s);
console.log('patched');
