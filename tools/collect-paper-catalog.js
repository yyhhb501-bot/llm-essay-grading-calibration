'use strict';
// Collect public titles and source links only; never copy paid papers or institution answers.
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const BASE = 'https://gwy.gkzhenti.cn';
const decode = s => s.replace(/&amp;/g, '&').replace(/<[^>]*>/g, '').trim();
async function main() {
  const first = fs.readFileSync(path.join(ROOT, 'output/research/source0.html'), 'utf8');
  const block = first.match(/id="options_Province"[\s\S]*?<\/ul>/)[0];
  const regions = [...block.matchAll(/href="([^"]+)"[^>]*>([^<]+)<\/a>/g)].map(m => ({url:decode(m[1]), region:m[2]}));
  const catalog = new Map(), failures = [];
  function collect(html, region) {
    // Exclude sidebar newest links: only collect the main paper table.
    const main = html.split('<div class="col-sm-4">')[0];
    for (const m of main.matchAll(/href="(\/paper\/\d+)"[^>]*>([^<]+)<\/a>/g)) {
      const title = decode(m[2]), year = Number((title.match(/^20\d\d/) || [])[0]);
      if (year < 2020 || year > 2026 || !title.includes('申论')) continue;
      catalog.set(m[1], {id:'source_'+m[1].split('/').pop(), title, year, region, sourceUrl:BASE+m[1], status:'source-link', recalled:title.includes('回忆')});
    }
  }
  for (const r of regions) {
    let next = new URL(r.url, BASE+'/paper').href, seen = new Set();
    while (next && !seen.has(next)) {
      seen.add(next);
      try {
        const response = await fetch(next, {signal:AbortSignal.timeout(20000)});
        if (!response.ok) throw Error('HTTP '+response.status);
        const html = await response.text(); collect(html,r.region);
        const pages = [...html.matchAll(/<option value="([^"]+)"[^>]*>第\d+页/g)].map(m=>new URL(decode(m[1]),BASE).href);
        next = pages.find(p=>!seen.has(p));
      } catch(e) { failures.push({region:r.region,url:next,error:e.message}); next=null; }
    }
    console.log(r.region, catalog.size);
  }
  const supplementsFile = path.join(ROOT,'data/paper-catalog-supplements.json');
  if (fs.existsSync(supplementsFile)) {
    for (const p of JSON.parse(fs.readFileSync(supplementsFile,'utf8'))) catalog.set(p.sourceUrl,p);
  }
  const papers = [...catalog.values()].sort((a,b)=>b.year-a.year || a.region.localeCompare(b.region,'zh') || a.title.localeCompare(b.title,'zh'));
  const answerFile=path.join(ROOT,'data/answer-sources.json');
  if(fs.existsSync(answerFile)) {
    const answers=JSON.parse(fs.readFileSync(answerFile,'utf8'));
    for(const p of papers)p.answerSources=answers.filter(a=>a.region===p.region&&a.year===p.year&&p.title.includes(a.volume));
  }
  const result={collectedAt:new Date().toISOString(),source:BASE,scope:'2020–2026 公开目录元数据；未导入原文',papers,failures};
  fs.writeFileSync(path.join(ROOT,'data/paper-catalog.json'),JSON.stringify(result,null,2)+'\n');
  fs.writeFileSync(path.join(ROOT,'site/js/vendor/paper-catalog.js'),'window.PaperCatalog = '+JSON.stringify(result)+';\n');
  console.log(JSON.stringify({papers:papers.length,failures}));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
