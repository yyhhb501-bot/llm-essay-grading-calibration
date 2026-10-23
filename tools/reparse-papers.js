'use strict';
// Re-parse all archived raw HTML (output/crawl-raw/*.html) with the current parser.
// No network requests. Upgrades papers-full docs when the new parse finds more content
// than the existing one; never downgrades a good doc.
// Usage: node tools/reparse-papers.js [--force-update]
const fs = require('fs');
const path = require('path');
const { parsePage, parseMaterials, parseQuestions, isBlockPage } = require('./crawl-paper-content.js');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'data/papers-full');
const RAW_DIR = path.join(ROOT, 'output/crawl-raw');
const FORCE = process.argv.includes('--force-update');

function readJson(p, fallback) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return fallback; } }

function main() {
  const catalog = readJson(path.join(ROOT, 'data/paper-catalog.json'), { papers: [] });
  const byId = new Map(catalog.papers.map(p => [p.id, p]));
  const idxPath = path.join(OUT_DIR, 'index.json');
  const index = readJson(idxPath, { papers: {} });
  let upgraded = 0, kept = 0, empty = 0, missing = 0;
  const rawFiles = fs.readdirSync(RAW_DIR).filter(f => f.endsWith('.html') && !f.startsWith('_'));
  for (const f of rawFiles) {
    const id = f.replace(/\.html$/, '');
    const html = fs.readFileSync(path.join(RAW_DIR, f), 'utf8');
    if (isBlockPage(html)) { missing++; continue; }
    const page = parsePage(html);
    if (!page) { missing++; continue; }
    const materials = parseMaterials(page.sections);
    const questions = parseQuestions(page.sections);
    const newScore = materials.length * 10 + questions.length;
    const docPath = path.join(OUT_DIR, id + '.json');
    const old = readJson(docPath, null);
    const oldScore = old ? (old.materials || []).length * 10 + (old.questions || []).length : 0;
    const meta = byId.get(id) || {};
    if (newScore > oldScore || FORCE || !old) {
      if (!newScore) { empty++; continue; }
      const doc = {
        id,
        title: meta.title || (old && old.title) || page.title,
        page_title: page.title,
        year: meta.year || (old && old.year),
        region: meta.region || (old && old.region),
        sourceUrl: meta.sourceUrl || (old && old.sourceUrl),
        contentSource: 'https://gwy.gkzhenti.cn',
        importedAt: new Date().toISOString(),
        copyrightNote: '题目与材料转载自公开真题库 gwy.gkzhenti.cn（其来源标注 fenbi/网友回忆版），仅供个人学习研究，不得商用或再分发；非官方发布版本。',
        materials,
        questions,
        counts: { materials: materials.length, questions: questions.length }
      };
      fs.writeFileSync(docPath, JSON.stringify(doc, null, 1) + '\n');
      index.papers[id] = {
        status: materials.length && questions.length ? 'ok' : (materials.length || questions.length) ? 'partial' : 'empty-content',
        title: doc.title, year: doc.year, region: doc.region,
        materials: materials.length, questions: questions.length
      };
      upgraded++;
      if (oldScore > 0 && newScore > oldScore) console.log('UPGRADE', id, oldScore, '→', newScore);
    } else {
      kept++;
    }
  }
  const summary = {};
  for (const v of Object.values(index.papers)) summary[v.status] = (summary[v.status] || 0) + 1;
  index.summary = summary;
  index.updatedAt = new Date().toISOString();
  fs.writeFileSync(idxPath, JSON.stringify(index, null, 1) + '\n');
  console.log(JSON.stringify({ rawFiles: rawFiles.length, upgraded, kept, emptyOrUnparseable: empty, missing, summary }));
}
main();
