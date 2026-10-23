'use strict';
// Crawl full paper content (materials + questions) from gkzhenti.cn paper pages.
// Site policy (stated on its block page): >1 request/minute, prefer 00:00-06:00.
// Only fetches publicly served HTML; answer/explain pages are captcha-gated and are not accessed.
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const BASE = 'https://gwy.gkzhenti.cn';
const OUT_DIR = path.join(ROOT, 'data/papers-full');
const RAW_DIR = path.join(ROOT, 'output/crawl-raw');
const DELAY_MS = Number(process.env.CRAWL_DELAY_MS || 65000); // site requires >1 min/request
const STOP_AT = process.env.STOP_AT_ISO ? new Date(process.env.STOP_AT_ISO) : null;
const BLOCK_BACKOFF_MS = 30 * 60000;
const MAX_BLOCK_HITS = 5;
const BLOCK_MARKERS = ['临时黑名单', '访问异常'];

function isBlockPage(html) { return BLOCK_MARKERS.some(m => html.includes(m)); }

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&lsquo;|&rsquo;/g, "'")
    .replace(/&mdash;/g, '—')
    .replace(/&hellip;/g, '……')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function stripTags(html) {
  return decodeEntities(html.replace(/<[^>]*>/g, '')).replace(/[ \t\u00a0]+/g, ' ').trim();
}

// Extract the printcontent block; returns {title, sections:[{heading, paragraphs:[html]}]}
function parsePage(html) {
  let block;
  const m = html.match(/<div id="printcontent" class="container">([\s\S]*?)<\/div><\/div><\/body>/);
  if (m) {
    block = m[1];
  } else {
    const start = html.indexOf('<div id="printcontent"');
    if (start < 0) return null;
    const end = html.indexOf('</div></div></body>', start);
    if (end < 0) return null;
    block = html.slice(start, end);
  }
  const title = (block.match(/<h3[^>]*>([^<]+)<\/h3>/) || [])[1];
  if (!title) return null;
  const sections = [];
  const re = /<h2>([^<]*)<\/h2>/g;
  let h; const heads = [];
  while ((h = re.exec(block))) heads.push({ heading: stripTags(h[1]), at: h.index, end: re.lastIndex });
  for (let i = 0; i < heads.length; i++) {
    const slice = block.slice(heads[i].end, i + 1 < heads.length ? heads[i + 1].at : undefined);
    const paras = [...slice.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)].map(p => p[1]).filter(p => stripTags(p).length);
    sections.push({ heading: heads[i].heading, paragraphs: paras, raw: slice });
  }
  return { title: stripTags(title), sections };
}

const MATERIAL_RE = /^(?:材料|给定资料|资料)\s*([0-9一二三四五六七八九十]+)[：:．.、]?\s*$/;
const QUESTION_RE = /^([一二三四五六七八九十]+)[、.．]\s*/;

function parseMaterials(sections) {
  const mat = sections.find(s => /给定材料|材料/.test(s.heading) && !/作答|要求|试题|答案/.test(s.heading));
  if (!mat) return [];
  const out = [];
  let cur = null;
  for (const p of mat.paragraphs) {
    let text = stripTags(p);
    // 兼容「材料1(3783912)」这类带来源编号后缀的标记
    text = text.replace(/[（(]\s*\d+\s*[）)]\s*$/, '').trim();
    const mm = text.match(MATERIAL_RE);
    if (mm) {
      if (cur) out.push(cur);
      cur = { no: mm[1], text: '' };
    } else if (cur) {
      cur.text += (cur.text ? '\n' : '') + stripTags(p);
    }
  }
  if (cur) out.push(cur);
  return out;
}

function parseQuestions(sections) {
  const qa = sections.find(s => /作答要求|答题要求|回答要求/.test(s.heading));
  if (!qa) return [];
  // 兼容题号在段落外的版式：<b>一</b>、<p>题干</p> → <p><b>一、</b>题干</p>
  // 必须在段落提取之前处理原始 HTML，否则段外题号会丢失
  let raw = qa.raw || '';
  if (raw) {
    raw = raw.replace(/<b>\s*([一二三四五六七八九十]+)\s*<\/b>\s*[、.．]?\s*(?=<p[^>]*>)/g, '<p><b>$1、</b>');
  }
  const paragraphs = raw
    ? [...raw.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)].map(p => p[1]).filter(p => stripTags(p).length)
    : qa.paragraphs;
  const out = [];
  let cur = null;
  for (const p of paragraphs) {
    const text = stripTags(p);
    const qm = text.match(QUESTION_RE);
    if (qm && text.length > qm[0].length) {
      if (cur) out.push(cur);
      cur = { no: qm[1], stem: text.slice(qm[0].length), requirements: [] };
    } else if (cur) {
      if (/^要求[：:]?$/.test(text)) continue;
      if (/^（[一二三四五六七八九十0-9]+）/.test(text)) cur.requirements.push(text);
      else if (text) cur.stem += '\n' + text;
    }
  }
  if (cur) out.push(cur);
  // 兜底：整节没有中文题号时，按含"（N分）"的段落切分题目
  if (!out.length) {
    const cn = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
    let q = null;
    for (const p of paragraphs) {
      const text = stripTags(p);
      if (!text) continue;
      const hasScore = /[（(]\s*\d+\s*分\s*[）)]/.test(text);
      if (hasScore && text.length > 10) {
        if (q) out.push(q);
        q = { no: cn[out.length] || String(out.length + 1), stem: text, requirements: [] };
      } else if (q) {
        if (/^要\s*求[：:]?$/.test(text)) continue;
        if (/^（[一二三四五六七八九十0-9]+）/.test(text)) q.requirements.push(text);
        else if (!/^要\s*求/.test(text)) q.stem += '\n' + text;
        else q.requirements.push(text.replace(/^要\s*求[：:]\s*/, ''));
      }
    }
    if (q) out.push(q);
  }
  for (const q of out) {
    const sm = q.stem.match(/[（(](\d+)\s*分[）)]/);
    if (sm) { q.score = Number(sm[1]); q.stem = q.stem.replace(/[（(]\d+\s*分[）)]/, '（' + sm[1] + '分）'); }
  }
  return out;
}

function saveIndex(index) {
  fs.writeFileSync(path.join(OUT_DIR, 'index.json'), JSON.stringify(index, null, 1) + '\n');
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(RAW_DIR, { recursive: true });
  const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/paper-catalog.json'), 'utf8'));
  const papers = catalog.papers;
  const idxPath = path.join(OUT_DIR, 'index.json');
  const index = fs.existsSync(idxPath) ? JSON.parse(fs.readFileSync(idxPath, 'utf8')) : { crawledAt: null, source: BASE, papers: {} };

  let blockHits = 0, failed = [];
  for (const p of papers) {
    if (STOP_AT && new Date() >= STOP_AT) { saveIndex(index); console.log('WINDOW_END'); process.exit(10); }
    if (index.papers[p.id] && index.papers[p.id].status === 'ok') continue;
    const gkzhentiId = p.sourceUrl && p.sourceUrl.startsWith(BASE) ? p.id.replace('source_', '') : null;
    if (!gkzhentiId) {
      index.papers[p.id] = { status: 'external-source', note: '来源不在 gkzhenti（' + (p.sourceUrl || '?') + '），未抓取', title: p.title };
      continue;
    }
    // fetch with retries on network/5xx only
    let http = 0, html = null, error = '';
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const r = await fetch(`${BASE}/paper/${gkzhentiId}`, { signal: AbortSignal.timeout(25000) });
        http = r.status;
        if (r.ok) { html = await r.text(); break; }
        if (r.status < 500) break; // 4xx: don't retry
      } catch (e) { error = e.message; }
      await new Promise(res => setTimeout(res, 3000 * attempt));
    }

    if (!html) {
      index.papers[p.id] = { status: 'fetch-failed', http, error, title: p.title };
      failed.push(p.id); console.log('FAIL', p.id, http, error);
    } else if (isBlockPage(html)) {
      blockHits++;
      console.log('BLOCKED', p.id, 'hits=' + blockHits, new Date().toLocaleTimeString());
      saveIndex(index);
      if (blockHits >= MAX_BLOCK_HITS) { console.log('ABORT_TOO_MANY_BLOCKS'); process.exit(11); }
      await new Promise(res => setTimeout(res, BLOCK_BACKOFF_MS));
      continue; // retry this paper after backoff (not marked in index)
    } else {
      fs.writeFileSync(path.join(RAW_DIR, p.id + '.html'), html);
      const page = parsePage(html);
      if (!page) {
        index.papers[p.id] = { status: 'empty-page', http, title: p.title };
        console.log('EMPTY', p.id);
      } else {
        const materials = parseMaterials(page.sections);
        const questions = parseQuestions(page.sections);
        const doc = {
          id: p.id,
          title: p.title,
          page_title: page.title,
          year: p.year,
          region: p.region,
          sourceUrl: p.sourceUrl,
          contentSource: BASE,
          importedAt: new Date().toISOString(),
          copyrightNote: '题目与材料转载自公开真题库 gwy.gkzhenti.cn（其来源标注 fenbi/网友回忆版），仅供个人学习研究，不得商用或再分发；非官方发布版本。',
          materials,
          questions,
          counts: { materials: materials.length, questions: questions.length }
        };
        fs.writeFileSync(path.join(OUT_DIR, p.id + '.json'), JSON.stringify(doc, null, 1) + '\n');
        const status = materials.length && questions.length ? 'ok' : (materials.length || questions.length) ? 'partial' : 'empty-content';
        index.papers[p.id] = { status, title: p.title, year: p.year, region: p.region, materials: materials.length, questions: questions.length };
        if (status !== 'ok') console.log('PARTIAL', p.id, materials.length, questions.length);
      }
    }
    saveIndex(index); // checkpoint every paper: a 65s cadence makes cheap insurance
    const jitter = Math.floor(Math.random() * 8000);
    await new Promise(res => setTimeout(res, DELAY_MS + jitter));
  }
  index.crawledAt = new Date().toISOString();
  index.total = papers.length;
  const summary = {};
  for (const v of Object.values(index.papers)) summary[v.status] = (summary[v.status] || 0) + 1;
  index.summary = summary;
  saveIndex(index);
  console.log('DONE', JSON.stringify({ total: papers.length, summary, failedCount: failed.length }));
  if (failed.length) console.log('FAILED_IDS', failed.join(','));
}
if (require.main === module) {
  main().catch(e => { console.error(e); process.exitCode = 1; });
}
module.exports = { parsePage, parseMaterials, parseQuestions, isBlockPage };
