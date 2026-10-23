'use strict';
// Extract structured 采分点 (answer points) from crawled zhihu answer articles.
// Reads matched papers from data/paper-catalog.json (answerSources kind 知乎参考答案),
// calls the local-configured GLM model to split each article into per-question records
// with semantic point units. Output: data/answer-points/{paperId}.json + index.json.
//
// Usage:
//   node tools/extract-answer-points.js --list                 # show what would run
//   node tools/extract-answer-points.js --region=国考 --limit=2 # pilot
//   node tools/extract-answer-points.js --region=国考          # full region run
// Resumable: existing data/answer-points/{paperId}.json with done=true is skipped unless --force.
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'data/answer-points');

// ---- args ----
const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true];
}));
const REGION = args.region || null;
const LIMIT = Number(args.limit || 0);
const FORCE = !!args.force;

// ---- model config (local shared config of this app) ----
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, '.runtime/shared-model.json'), 'utf8'));
const BASE = (cfg.baseURL || 'https://open.bigmodel.cn/api/paas/v4').replace(/\/$/, '');
const KEY = cfg.apiKey;
const MODEL = cfg.model || 'glm-4-flash';

async function chat(userPrompt, systemPrompt, maxTokens) {
  const payload = {
    model: MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    temperature: 0.2,
    max_tokens: maxTokens || 4000,
    stream: false
  };
  const variants = [{ ...payload, thinking: { type: 'disabled' } }, payload];
  let lastErr = null;
  for (const body of variants) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const r = await fetch(BASE + '/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + KEY },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(180000)
        });
        if (!r.ok) {
          const t = await r.text();
          throw new Error('HTTP ' + r.status + ' ' + t.slice(0, 200));
        }
        const j = await r.json();
        return j.choices[0].message.content || '';
      } catch (e) {
        lastErr = e;
        const msg = String(e.message || '');
        if (/HTTP 4\d\d/.test(msg)) break; // payload problem: try next variant
        if (attempt < 2) await new Promise(res => setTimeout(res, 3000 * attempt));
      }
    }
  }
  throw lastErr;
}

// Escape raw control characters (literal newlines/tabs) inside JSON string values,
// which GLM tends to emit in multi-line 要点 text.
function sanitizeJson(raw) {
  let out = '';
  let inStr = false, esc = false;
  for (const ch of raw) {
    if (inStr) {
      if (esc) { out += ch; esc = false; continue; }
      if (ch === '\\') { out += ch; esc = true; continue; }
      if (ch === '"') { inStr = false; out += ch; continue; }
      if (ch === '\n') { out += '\\n'; continue; }
      if (ch === '\r') { out += '\\r'; continue; }
      if (ch === '\t') { out += '\\t'; continue; }
      out += ch;
    } else {
      if (ch === '"') { inStr = true; out += ch; continue; }
      // strip trailing commas heuristically: ",]" or ",}"
      out += ch;
    }
  }
  return out.replace(/,\s*([\]}])/g, '$1');
}

function parseJsonLoose(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fence ? fence[1] : text;
  const start = raw.indexOf('{');
  const arrStart = raw.indexOf('[');
  let s;
  if (start === -1 || (arrStart !== -1 && arrStart < start)) s = raw.slice(arrStart);
  else s = raw.slice(start);
  const lastBrace = Math.max(raw.lastIndexOf('}'), raw.lastIndexOf(']'));
  if (lastBrace > 0) s = raw.slice(0, lastBrace + 1);
  try {
    return JSON.parse(s);
  } catch (e) {
    return JSON.parse(sanitizeJson(s));
  }
}

const SYSTEM = `你是申论真题答案数据标注员。输入是一篇包含申论真题参考答案的文章文本（可能含给定材料、多道题、多家机构答案）。
任务：把文章拆成"题目级"结构，并为每题拆出语义采分点。只输出一个 JSON 对象，不要任何其他文字。

拆分规则：
1. 每道题一条记录：题号（一/二/三…或1/2/3）、题干原文、分值（数字，题干写了"（15分）"就是15，没写为 null）、题型（归纳概括/综合分析/提出对策/公文写作/文章写作）、材料范围（如"给定资料1"，无法判断为 null）。
2. 参考答案按来源拆分：文中明确标注机构名（如"某笔""粉笔""远志""华图""中公""明哲"等）就分开记录；没标注的合并为 name:"未标注"。
3. 对每份参考答案拆语义要点：每条要点是一句"主体+动作/观点+对象+条件/结果"的表述，尽量保留原文信息量；要点数组 points 为字符串数组。
4. 跨机构等价要点不需要你合并，逐机构罗列即可。
5. 文中的"评分标准""评分细则""赋分说明"原文放入 rubric；没有为 null。
6. 文中的给定材料原文不要输出。
7. 无法确定字段用 null，不要编造。文章不是答案内容时输出 {"questions":[]}。`;

const USER_TMPL = (paperTitle, articleTitle, text) =>
  `【所属试卷】${paperTitle}\n【文章标题】${articleTitle}\n【文章正文】\n${text}\n\n请输出 JSON：{"questions":[{"no":"","stem":"","score":null,"type":"","materialRange":"","rubric":null,"institutionAnswers":[{"name":"","points":[""]}]}]}。要求：单行紧凑 JSON（不要缩进和多余换行）；字符串内不得出现未转义的英文双引号；要点表述中的引号请用「」代替。`;

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/paper-catalog.json'), 'utf8'));
  const byPaperIdx = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/answers-crawled/by-paper.json'), 'utf8')).papers;

  // target papers
  let targets = catalog.papers.filter(p => (byPaperIdx[p.id] || []).length);
  if (REGION) targets = targets.filter(p => p.region === REGION);
  if (LIMIT) targets = targets.slice(0, LIMIT);

  if (args.list) {
    for (const p of targets) {
      const arts = byPaperIdx[p.id] || [];
      console.log(`${p.id} | ${p.title.slice(0, 45)} | ${arts.length}篇 | ${arts.reduce((s, a) => s + a.chars, 0)}字`);
    }
    console.log('total:', targets.length);
    return;
  }

  // article text loader (dedupe by url)
  const articleCache = new Map();
  function loadArticleText(batchFile, url) {
    const key = batchFile + '|' + url;
    if (articleCache.has(key)) return articleCache.get(key);
    let text = null;
    try {
      const full = batchFile.includes('/') ? batchFile : path.join('data/answers-crawled', batchFile);
      const j = JSON.parse(fs.readFileSync(path.join(ROOT, full), 'utf8'));
      for (const it of (j.items || [])) {
        if (it.url === url && it.ok) { text = it.text; break; }
      }
    } catch (e) { /* missing batch file */ }
    articleCache.set(key, text);
    return text;
  }

  let done = 0, failed = [];
  for (const p of targets) {
    const outFile = path.join(OUT_DIR, p.id + '.json');
    if (!FORCE && fs.existsSync(outFile)) {
      try {
        const prev = JSON.parse(fs.readFileSync(outFile, 'utf8'));
        if (prev.done) { console.log('SKIP', p.id); continue; }
      } catch (e) { /* re-extract */ }
    }
    const arts = byPaperIdx[p.id] || [];
    const questions = [];
    let ok = true, note = [];
    for (const a of arts) {
      const text = loadArticleText(a.batchFile, a.url);
      if (!text) { note.push('正文缺失: ' + a.title.slice(0, 30)); continue; }
      process.stdout.write(`RUN ${p.id.slice(7, 15)} art ${a.chars}字 ... `);
      try {
        let resp = await chat(USER_TMPL(p.title, a.title, text.slice(0, 26000)), SYSTEM, 8000);
        let parsed = null;
        try {
          parsed = parseJsonLoose(resp);
        } catch (e1) {
          // one repair pass: model re-emits strictly valid JSON from its own broken output
          const repair = await chat(
            '下面的 JSON 有语法错误（可能是未转义引号、裸换行或被截断）。请修复并输出严格合法的单行紧凑 JSON，结构与原意保持不变，不要添加解释：\n' + resp.slice(0, 12000),
            '只输出修复后的 JSON。', 8000);
          parsed = parseJsonLoose(repair);
        }
        for (const q of (parsed.questions || [])) {
          q.sourceArticle = { title: a.title, url: a.url, batchFile: a.batchFile, author: a.author || '' };
          questions.push(q);
        }
        console.log('ok', (parsed.questions || []).length, '题');
      } catch (e) {
        console.log('FAIL', e.message.slice(0, 120));
        note.push('抽取失败: ' + a.title.slice(0, 30) + ' (' + e.message.slice(0, 80) + ')');
        ok = false;
      }
      await new Promise(r => setTimeout(r, 1500));
    }
    const doc = {
      paperId: p.id, title: p.title, year: p.year, region: p.region,
      extractedAt: new Date().toISOString(), done: ok && questions.length > 0,
      note, questions
    };
    fs.writeFileSync(outFile, JSON.stringify(doc, null, 1) + '\n');
    if (ok) done++; else failed.push(p.id);
  }
  // index
  const idx = { updatedAt: new Date().toISOString(), papers: {} };
  for (const f of fs.readdirSync(OUT_DIR).filter(f => f.endsWith('.json') && f !== 'index.json')) {
    try { const j = JSON.parse(fs.readFileSync(path.join(OUT_DIR, f), 'utf8')); idx.papers[j.paperId] = { title: j.title, done: j.done, questions: j.questions.length }; } catch (e) {}
  }
  fs.writeFileSync(path.join(OUT_DIR, 'index.json'), JSON.stringify(idx, null, 1) + '\n');
  console.log('DONE', JSON.stringify({ done, failed }));
}
main().catch(e => { console.error(e); process.exitCode = 1; });
