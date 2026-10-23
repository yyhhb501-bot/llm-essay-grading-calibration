'use strict';
// Stage A 命中判定：考生作答 × 共识采分点组 → 每组 hit 等级 + 依据短引。
// 窄任务设计：只判"这条要点考生写没写、写全没写全"，不打总分——总分由 coverage-score.js 算。
// 提示词与网站共用 skill/prompts.js 的 ANCHOR_MATCH_PROMPT；JSON 宽容解析用 coverage-score.js 的 parseHits。
// 输出 JSON 契约：{hits:[{groupId, hit, evidence}]}
//   hit: full|partial|deviated|missing   evidence: 考生作答原文短引（未写为空串）
//
// Usage: node tools/match-student-points.js --paper=source_xxx --no=1 --answer-file=path.txt
//        （--stdin 从管道读作答）
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true];
}));
const cs = require('./coverage-score.js');
const prompts = require('../skill/prompts.js');

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, '.runtime/shared-model.json'), 'utf8'));
const BASE = (cfg.baseURL || 'https://open.bigmodel.cn/api/paas/v4').replace(/\/$/, '');

async function chat(userPrompt, systemPrompt, maxTokens) {
  const payload = {
    model: cfg.model || 'glm-4-flash',
    messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
    temperature: 0.1, max_tokens: maxTokens || 3000, stream: false
  };
  for (const body of [{ ...payload, thinking: { type: 'disabled' } }, payload]) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const r = await fetch(BASE + '/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.apiKey },
          body: JSON.stringify(body), signal: AbortSignal.timeout(180000)
        });
        if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (await r.text()).slice(0, 150));
        return (await r.json()).choices[0].message.content || '';
      } catch (e) {
        if (/HTTP 4\d\d/.test(String(e.message))) break;
        if (attempt < 2) await new Promise(res => setTimeout(res, 3000)); else throw e;
      }
    }
  }
}

const SYS = prompts.ANCHOR_MATCH_PROMPT;

function main() {
  const consDir = path.join(ROOT, 'data/consensus-points');
  const paperId = args.paper;
  const doc = JSON.parse(fs.readFileSync(path.join(consDir, paperId + '.json'), 'utf8'));
  const no = String(args.no);
  const cn = { 一: '1', 二: '2', 三: '3', 四: '4', 五: '5' };
  const q = doc.questions.find(q => (cn[q.no] || String(q.no)) === no.replace(/[^0-9]/g, ''));
  if (!q) { console.error('找不到该题'); process.exit(1); }
  let answer = '';
  if (args['answer-file']) answer = fs.readFileSync(args['answer-file'], 'utf8');
  else if (args.stdin) answer = fs.readFileSync(0, 'utf8');
  else { console.error('用 --answer-file=path.txt 或 --stdin 提供考生作答'); process.exit(1); }

  const groups = q.groups.map((g, i) => ({ id: i, text: g.text, consensus: g.count >= 2 ? g.count + '家机构' : '单源' }));
  const user = '【采分点组】\n' + JSON.stringify(groups, null, 1) + '\n\n【考生作答】\n' + answer;
  chat(user, SYS, 3000).then(resp => {
    const hits = cs.parseHits(resp);
    if (!hits) { console.error('FAIL 模型没有按 JSON 契约返回，原始输出：\n' + String(resp).slice(0, 400)); process.exit(1); }
    const pointMax = cs.pointDimensionMax(q.type);
    const c = cs.coverage(q.groups, hits);
    console.log(JSON.stringify({
      paperId, no: q.no, stem: q.stem, questionScore: q.score || null, typeName: q.type || '',
      coverage: Math.round(c * 1000) / 1000,
      pointDimension: cs.pointDimensionScore(c, pointMax),
      pointMax: pointMax,
      estimatedExam: cs.estimateExamScore(c, q.score),
      anchorTable: cs.renderAnchorTable(q.groups, hits),
      hits: hits
    }, null, 1));
  }).catch(e => { console.error('FAIL', e.message); process.exit(1); });
}
main();
