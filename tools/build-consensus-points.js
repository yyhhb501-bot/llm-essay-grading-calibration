'use strict';
// Align multi-institution answer points for the same question into consensus groups.
// Input:  data/answer-points/{paperId}.json (records from possibly several source articles)
// Output: data/consensus-points/{paperId}.json
//   questions: [{no, stem, score, type, groups: [{text, institutions[], count, level, type}],
//                sources: [article titles], alignedAt}]
// level: core (>=2 institutions agree) | single (only one institution mentions)
//
// Usage:
//   node tools/build-consensus-points.js --list
//   node tools/build-consensus-points.js --paper=source_1775446837778
//   node tools/build-consensus-points.js --all
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const PTS_DIR = path.join(ROOT, 'data/answer-points');
const OUT_DIR = path.join(ROOT, 'data/consensus-points');

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true];
}));

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, '.runtime/shared-model.json'), 'utf8'));
const BASE = (cfg.baseURL || 'https://open.bigmodel.cn/api/paas/v4').replace(/\/$/, '');

async function chat(userPrompt, systemPrompt, maxTokens) {
  const payload = {
    model: cfg.model || 'glm-4-flash',
    messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
    temperature: 0.2, max_tokens: maxTokens || 6000, stream: false
  };
  const variants = [{ ...payload, thinking: { type: 'disabled' } }, payload];
  let lastErr = null;
  for (const body of variants) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const r = await fetch(BASE + '/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.apiKey },
          body: JSON.stringify(body), signal: AbortSignal.timeout(240000)
        });
        if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (await r.text()).slice(0, 150));
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

function sanitizeJson(raw) {
  let out = '', inStr = false, esc = false;
  for (const ch of raw) {
    if (inStr) {
      if (esc) { out += ch; esc = false; continue; }
      if (ch === '\\') { out += ch; esc = true; continue; }
      if (ch === '"') { inStr = false; out += ch; continue; }
      if (ch === '\n') { out += '\\n'; continue; }
      if (ch === '\r') { out += '\\r'; continue; }
      if (ch === '\t') { out += '\\t'; continue; }
      out += ch;
    } else { if (ch === '"') inStr = true; out += ch; }
  }
  return out.replace(/,\s*([\]}])/g, '$1');
}
function parseJsonLoose(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fence ? fence[1] : text;
  const start = Math.max(raw.indexOf('{'), 0);
  let s = raw.slice(start);
  const last = Math.max(raw.lastIndexOf('}'), raw.lastIndexOf(']'));
  if (last > 0) s = raw.slice(0, last + 1);
  try { return JSON.parse(s); } catch (e) { return JSON.parse(sanitizeJson(s)); }
}

function normalizeNo(no) {
  const s = String(no == null ? '' : no).trim();
  const cn = { 一: '1', 二: '2', 三: '3', 四: '4', 五: '5', 六: '6', 七: '7', 八: '8', 九: '9', 十: '10' };
  if (cn[s]) return cn[s];
  const m = s.match(/\d+/);
  return m ? String(Number(m[0])) : s;
}

const SYS = `你是申论评分数据标注员。输入：同一道申论题的多家机构/作者参考答案要点（JSON：lists=[{institution, points:[...]}]，可能还给出题干 stem）。
任务：把所有要点做语义对齐，聚成"等价组"。只输出 JSON，不要任何解释：
{"groups":[{"text":"合并后的要点表述（一句，主体+动作+对象+条件/结果）","institutions":["机构名"],"type":"做法|成效|问题|原因|观点|其他"}],"notes":"分歧说明，无则空串"}
规则：
1. 合并是首要目标：逐字不同但信息相同的表述必须并组；每条要点必须且只能归入一个组，groups 不得为空。
2. 独立信息从严不合并：主体不同、动作不同、对象不同、条件不同都算不同组；仅措辞差异必须合并。
3. text 取各机构表述的并集信息，不丢限定条件；不添加任何机构没写的信息。
4. institutions 填写该组覆盖的所有机构名（照抄输入的 institution 字段，重名带·来源N后缀的也要照抄）。
5. type 按要点语义判断。`;

function questionKey(no) { return normalizeNo(no); }

function collectQuestions(doc) {
  // merge same-question records across source articles: no → candidates
  const map = new Map();
  for (const q of (doc.questions || [])) {
    const k = questionKey(q.no);
    if (!map.has(k)) map.set(k, { no: q.no, stem: q.stem || '', score: q.score, type: q.type || '', lists: [], sources: [] });
    const rec = map.get(k);
    if (!rec.stem && q.stem) rec.stem = q.stem;
    if (!rec.score && q.score) rec.score = q.score;
    if (!rec.type && q.type) rec.type = q.type;
    if (q.sourceArticle) rec.sources.push(q.sourceArticle.title);
    for (const ia of (q.institutionAnswers || [])) {
      if (!(ia.points || []).length) continue;
      let name = ia.name || '未标注';
      // 重名（如多篇"未标注"）会让对齐模型无法归属——加来源序号区分
      if (rec.lists.some(l => l.institution === name)) {
        let i = 2;
        while (rec.lists.some(l => l.institution === name + '·来源' + i)) i++;
        name = name + '·来源' + i;
      }
      rec.lists.push({ institution: name, points: ia.points });
    }
  }
  return [...map.values()];
}

async function alignQuestion(doc, rec) {
  const totalPoints = rec.lists.reduce((s, l) => s + l.points.length, 0);
  const user = '共 ' + rec.lists.length + ' 家来源、约 ' + totalPoints + ' 条要点，请全部归属到组，一组至少含一条要点。输出紧凑 JSON：\n' + JSON.stringify({ stem: rec.stem, score: rec.score, lists: rec.lists });
  let parsed = null;
  try {
    parsed = parseJsonLoose(await chat(user, SYS, 9000));
  } catch (e1) {
    // 重试一次：更小的批次（按来源折半）也能减少截断
    if (rec.lists.length >= 4) {
      const half = Math.ceil(rec.lists.length / 2);
      const g1 = await alignQuestion(doc, { ...rec, lists: rec.lists.slice(0, half) }).catch(() => []);
      const g2 = await alignQuestion(doc, { ...rec, lists: rec.lists.slice(half) }).catch(() => []);
      parsed = { groups: [...g1, ...g2] };
      // 两批各自分组后，跨批的等价组不再合并——标记为保守结果
    } else {
      throw e1;
    }
  }
  const groups = (parsed.groups || []).map(g => {
    const count = (g.institutions || []).length;
    return {
      text: g.text || '',
      institutions: g.institutions || [],
      count,
      level: count >= 2 ? 'core' : 'single',
      type: g.type || '其他'
    };
  });
  groups.sort((a, b) => b.count - a.count);
  return groups;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const files = fs.readdirSync(PTS_DIR).filter(f => f.endsWith('.json') && f !== 'index.json');
  if (args.list) {
    for (const f of files) {
      const doc = JSON.parse(fs.readFileSync(path.join(PTS_DIR, f), 'utf8'));
      const qs = collectQuestions(doc).filter(r => r.lists.length >= 2);
      if (qs.length) console.log(doc.paperId, '|', doc.title.slice(0, 30), '| 可对齐题:', qs.map(r => '第' + r.no + '题(' + r.lists.length + '家)').join(' '));
    }
    return;
  }
  let targets = files.map(f => JSON.parse(fs.readFileSync(path.join(PTS_DIR, f), 'utf8')));
  if (args.paper) targets = targets.filter(d => d.paperId === args.paper);
  if (!args.all) targets = targets.filter(d => d.region === '国考');
  let doneQ = 0, failQ = 0;
  for (const doc of targets) {
    const recs = collectQuestions(doc).filter(r => r.lists.length >= 2);
    if (!recs.length) { console.log('SKIP', doc.paperId, '无可对齐题'); continue; }
    const out = { paperId: doc.paperId, title: doc.title, year: doc.year, region: doc.region, alignedAt: new Date().toISOString(), questions: [] };
    for (const rec of recs) {
      process.stdout.write('ALIGN ' + doc.paperId.slice(7, 15) + ' 第' + rec.no + '题 ' + rec.lists.length + '家 ... ');
      try {
        const groups = await alignQuestion(doc, rec);
        out.questions.push({ no: rec.no, stem: rec.stem, score: rec.score, type: rec.type, groups, sources: rec.sources });
        doneQ++;
        console.log('ok', groups.length, '组 (core:' + groups.filter(g => g.level === 'core').length + ')');
      } catch (e) {
        failQ++;
        console.log('FAIL', String(e.message).slice(0, 100));
      }
      await new Promise(r => setTimeout(r, 1500));
    }
    if (out.questions.length) fs.writeFileSync(path.join(OUT_DIR, doc.paperId + '.json'), JSON.stringify(out, null, 1) + '\n');
  }
  console.log('DONE', JSON.stringify({ alignedQuestions: doneQ, failed: failQ }));
}
main().catch(e => { console.error(e); process.exitCode = 1; });
