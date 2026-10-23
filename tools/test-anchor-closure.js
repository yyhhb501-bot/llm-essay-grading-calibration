#!/usr/bin/env node
/**
 * tools/test-anchor-closure.js —— 闭环可复算覆盖率实机验收（消耗模型额度，手动运行）
 *
 * 用 .runtime/shared-model.json 里的真实模型跑完整两阶段链路：
 *   Stage A   逐组判定考生作答对共识锚点的命中（ANCHOR_MATCH_PROMPT，低温、关思考）
 *   Program   coverage-score.js 算共识加权覆盖率与要点完整度
 *   Stage B   主批改提示词注入【共识锚点程序核算】块生成报告
 * 断言：报告 scores 里「要点完整度」的 score/max 与程序核算值一致（闭环成立）。
 *
 * Usage:
 *   node tools/test-anchor-closure.js
 *   node tools/test-anchor-closure.js --paper=source_1609326280828523 --no=3 --answer-file=my.txt
 *
 * 可选参数：
 *   --groups=16,17,18   只取共识分组的下标子集（默认全取；现有部分共识数据存在错对齐，
 *                       属 P1 待修数据问题，验收时可先用下标挑出与题干自洽的分组）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const cs = require('./coverage-score.js');
const prompts = require('../skill/prompts.js');
const references = require('../skill/references.js');

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true];
}));

const PAPER = String(args.paper || 'source_1609326280828523');
const NO = String(args.no || '3');

/** 默认用例：2021 苏A 第三题（青年干部论坛思路，共识分组与题干自洽、材料齐全） */
const DEFAULT_ANSWER = [
  '办好第三届青年干部论坛，我的思路如下：',
  '一是保持论坛特色。继续从基层一线、贴近群众的岗位中选取有工作经验的90后青年干部参加，主旨发言延续「职务上调一级」的模拟身份方式，让选手立足更高站位谈工作。',
  '二是创新主题与形式。主旨发言和辩论赛选题从当下热点和群众关心的接地气工作中选取；征文评选邀请机关领导和专家学者科学规范评审；辩论赛采取轮次晋级赛制。',
  '三是扩大活动影响。邀请机关领导、媒体和群众参加并参与评选，与电视、报社等当地媒体加大合作、共同联办，同时通过微信、微博、抖音等新媒体直播宣传。',
  '四是做出活动品牌。把活动流程制度化，形成长效机制，定期举办，持续擦亮论坛招牌。'
].join('\n');

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, '.runtime/shared-model.json'), 'utf8'));
const BASE = (cfg.baseURL || 'https://open.bigmodel.cn/api/paas/v4').replace(/\/$/, '');
const cnNo = { 一: '1', 二: '2', 三: '3', 四: '4', 五: '5', 六: '6', 七: '7', 八: '8', 九: '9', 十: '10' };

/** 与 tools 里其它实机脚本一致的重试策略：先关思考，失败再来不带 thinking 的请求 */
async function chat(bodyBase, timeoutMs) {
  const variants = [{ ...bodyBase, thinking: { type: 'disabled' } }, bodyBase];
  let lastErr = null;
  for (const body of variants) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const r = await fetch(BASE + '/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.apiKey },
          body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs)
        });
        if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
        return (await r.json()).choices[0].message.content || '';
      } catch (e) {
        lastErr = e;
        if (/HTTP 4\d\d/.test(String(e.message))) break;
        if (attempt < 2) await new Promise(res => setTimeout(res, 3000));
      }
    }
  }
  throw lastErr;
}

/** 从题干里推断资料范围（「给定资料6」「材料1～3」→ ['6'] / ['1','2','3']） */
function inferMaterialNos(stem) {
  const s = String(stem || '');
  const out = [];
  const re = /(?:给定资料|材料)\s*([0-9一二三四五六七八九十]+)(?:\s*[～~-]\s*([0-9一二三四五六七八九十]+))?/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const from = Number(cnNo[m[1]] || m[1]);
    const to = m[2] ? Number(cnNo[m[2]] || m[2]) : from;
    if (isFinite(from) && isFinite(to)) {
      for (let i = from; i <= to; i++) if (out.indexOf(String(i)) === -1) out.push(String(i));
    }
  }
  return out;
}

/** 宽容解析报告里的 scores 围栏（取最后一个） */
function parseScoresBlock(text) {
  const raw = String(text || '');
  const matches = [...raw.matchAll(/```scores\s*([\s\S]*?)```/g)];
  if (!matches.length) return null;
  const seg = matches[matches.length - 1][1].trim().replace(/,\s*([\]}])/g, '$1');
  try {
    return JSON.parse(seg);
  } catch (e) {
    return null;
  }
}

async function main() {
  // ---- 读数据 ----
  const consPath = path.join(ROOT, 'data/consensus-points', PAPER + '.json');
  const cons = JSON.parse(fs.readFileSync(consPath, 'utf8'));
  const q = (cons.questions || []).find(x => (cnNo[x.no] || String(x.no)).replace(/[^0-9]/g, '') === NO.replace(/[^0-9]/g, ''));
  if (!q) { console.error('找不到该题的共识数据：' + PAPER + ' no=' + NO); process.exit(1); }
  let groups = q.groups.map((g, i) => ({ id: i, text: g.text, count: g.count, level: g.level }));
  if (args.groups) {
    const pick = String(args.groups).split(',').map(x => Number(x.trim())).filter(x => isFinite(x));
    groups = pick.filter(i => groups[i]).map(i => groups[i]);
    groups.forEach((g, i) => { g.id = i; });
  }

  const fullPath = path.join(ROOT, 'data/papers-full', PAPER + '.json');
  const doc = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
  const nos = inferMaterialNos(q.stem);
  let materials = doc.materials || [];
  if (nos.length) {
    const picked = materials.filter(m => nos.indexOf(String(m.no)) !== -1);
    if (picked.length) materials = picked;
  }
  const materialText = materials.map(m => '材料' + m.no + '\n' + m.text).join('\n\n');

  const answer = args['answer-file'] ? fs.readFileSync(String(args['answer-file']), 'utf8') : DEFAULT_ANSWER;
  if (!answer.trim()) { console.error('考生作答为空'); process.exit(1); }

  console.log('[closure] 卷：' + (cons.title || PAPER) + '  题：第' + q.no + '题（' + (q.type || '未知') + '）');
  console.log('[closure] 共识分组 ' + groups.length + ' 组；材料 ' + materials.length + ' 份（' + materialText.length + ' 字）；作答 ' + answer.length + ' 字');

  // ---- Stage A：逐组判定命中 ----
  const tA = Date.now();
  const stageAUser = '【采分点组】\n' + JSON.stringify(groups.map(g => ({
    id: g.id, text: g.text, consensus: g.count >= 2 ? g.count + '家机构' : '单源'
  })), null, 1) + '\n\n【考生作答】\n' + answer;
  const stageAResp = await chat({
    model: cfg.model || 'glm-4-flash',
    messages: [{ role: 'system', content: prompts.ANCHOR_MATCH_PROMPT }, { role: 'user', content: stageAUser }],
    temperature: 0.1, max_tokens: 3000, stream: false
  }, 180000);
  const hits = cs.parseHits(stageAResp);
  if (!hits) {
    console.error('FAIL Stage A 没有返回可解析的 hits JSON，原始输出：\n' + String(stageAResp).slice(0, 500));
    process.exit(1);
  }
  console.log('[closure] Stage A 判定完成（' + (Date.now() - tA) + 'ms）');
  groups.forEach((g, i) => {
    const h = hits.find(x => x.groupId === i) || { hit: 'missing' };
    console.log('  ' + String(i).padStart(2) + '. [' + h.hit + '] ' + (h.evidence ? '“' + h.evidence + '”' : '—') + '  ← ' + g.text.slice(0, 42));
  });

  // ---- Program：程序核算 ----
  const pointMax = cs.pointDimensionMax(q.type);
  const cov = cs.coverage(groups, hits);
  const pointScore = cs.pointDimensionScore(cov, pointMax);
  const block = cs.renderAnchorBlock(groups, hits, { dimensionMax: pointMax });
  console.log('[closure] 程序核算：覆盖率 ' + (Math.round(cov * 1000) / 10) + '%，要点完整度 ' + pointScore + ' / ' + pointMax);

  // ---- Stage B：报告必须采用核算分值 ----
  const tB = Date.now();
  let system = prompts.GRADE_PROMPT;
  const guifan = references.REF && references.REF['guifan-biaoda'];
  if (typeof guifan === 'string' && guifan) system += '\n\n【规范表达速查】评「语言规范」与给修改建议时参考：\n' + guifan;
  system += '\n\n' + prompts.QUALITY_RULES;
  const stageBUser = [
    '【题型】' + (q.type || '归纳概括'),
    '【题目】' + q.stem,
    '【给定资料】' + materialText,
    '【参考答案】（未提供）',
    '【考生作答】' + answer
  ].join('\n\n') + '\n\n【共识锚点程序核算】\n' + block;
  const stageBResp = await chat({
    model: cfg.model || 'glm-4-flash',
    messages: [{ role: 'system', content: system }, { role: 'user', content: stageBUser }],
    temperature: 1, max_tokens: 16384, stream: false
  }, 600000);
  console.log('[closure] Stage B 报告完成（' + (Date.now() - tB) + 'ms，' + stageBResp.length + ' 字）');

  const scores = parseScoresBlock(stageBResp);
  if (!scores || !Array.isArray(scores.dimensions)) {
    console.error('FAIL 报告里没有可解析的 scores 块。报告开头：\n' + String(stageBResp).slice(0, 600));
    process.exit(1);
  }
  const dim = scores.dimensions.find(d => String(d.name || '').indexOf('要点完整度') !== -1);
  if (!dim) {
    console.error('FAIL scores 里找不到「要点完整度」。dimensions=' + JSON.stringify(scores.dimensions));
    process.exit(1);
  }
  const okScore = Math.abs(Number(dim.score) - pointScore) < 0.05;
  const okMax = Number(dim.max) === pointMax;
  console.log('[closure] 报告要点完整度：' + dim.score + ' / ' + dim.max + '（程序核算 ' + pointScore + ' / ' + pointMax + '）');
  if (!okScore || !okMax) {
    console.error('FAIL 报告没有采用程序核算分值（闭环断裂）。dim.comment=' + JSON.stringify(dim.comment));
    console.error('报告 scores：' + JSON.stringify(scores).slice(0, 800));
    process.exit(1);
  }
  console.log('通过：Stage A 判定 → 程序核算 → Stage B 报告采用核算分值，闭环可复算覆盖率实机验证成立。');
}

main().catch(function (e) {
  console.error('FAIL', (e && e.message) || e);
  process.exit(1);
});
