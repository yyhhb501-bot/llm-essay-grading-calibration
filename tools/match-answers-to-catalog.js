'use strict';
// Match crawled zhihu answer articles (data/answers-crawled/*.json) to papers in
// data/paper-catalog.json by year + region + volume, append to paper.answerSources,
// and regenerate the site vendor bundle. Idempotent: previous zhihu entries (kind starts
// with '知乎参考答案') are stripped before re-adding, so re-runs never duplicate.
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'data/answers-crawled');

const PROVINCES = ['江苏', '浙江', '广东', '山东', '北京', '上海', '四川', '福建', '深圳', '天津', '重庆', '安徽', '河南', '河北', '湖北', '湖南', '陕西', '山西', '江西', '辽宁', '广西', '贵州', '云南', '黑龙江', '吉林', '内蒙古', '宁夏', '甘肃', '海南', '新疆', '青海'];

function yearOf(t) { const m = (t || '').match(/20(2[0-6])/); return m ? '20' + m[1] : ''; }
function regionOf(t) {
  for (const p of PROVINCES) if ((t || '').includes(p)) return p;
  if (/联考|多省/.test(t)) return '联考';
  if (/国考|国家公务员|中央机关/.test(t)) return '国考';
  return '';
}
// normalize volume tokens so 副省级/副省卷 == 副省, 执法卷 == 执法, A类 == A, 省市卷 == 省市 ...
function volTokens(t) {
  const s = t || '';
  const out = new Set();
  const add = v => out.add(v);
  if (/副省/.test(s)) add('副省');
  if (/地市|市地/.test(s)) add('地市');
  if (/行政执法|执法卷|执法类|执法/.test(s)) add('执法');
  if (/省市卷|省市类|通用卷|省级卷/.test(s)) add('省市');
  if (/县乡卷|乡镇卷|县乡|乡镇/.test(s)) add('县乡');
  const ab = s.match(/([ABCD])\s*[卷类]/g) || [];
  for (const x of ab) add(x.replace(/\s/g, '').replace('类', '卷'));
  const num = s.match(/[一二三]\s*卷/g) || [];
  for (const x of num) add(x.replace(/\s/g, ''));
  return [...out];
}

function loadArticles() {
  const seen = new Set(); const articles = [];
  for (const f of fs.readdirSync(DIR).filter(f => f.endsWith('.json') && f !== 'index.json' && f !== 'harvested-links.json' && f !== 'by-paper.json')) {
    let j; try { j = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch (e) { continue; }
    for (const it of (j.items || [])) {
      if (!it.ok || !it.text) continue;
      const t = it.title || it.hit || '';
      // 备考经验/报考咨询类问答不是答案
      if (/什么时候|怎么准备|备考|经验分享|报国考|报省考/.test(t) && !/真题|答案|解析|范文|采分|作答/.test(t)) continue;
      if (it.url && seen.has(it.url)) continue;
      if (it.url) seen.add(it.url);
      articles.push({
        title: t,
        url: it.url,
        author: it.author || '',
        chars: it.text.length,
        batchFile: f,
        year: yearOf(it.title || it.hit),
        region: regionOf(it.title || it.hit),
        vols: volTokens(it.title || it.hit)
      });
    }
  }
  return articles;
}

function matchPaper(paper, articles) {
  const pYear = String(paper.year);
  const pRegion = paper.region;
  const pVols = volTokens(paper.title);
  const pIsGk = /国考|国家公考/.test(paper.title) || pRegion === '国考';
  const pIsLk = /联考|多省/.test(paper.title);
  const pHasVolumeConcept = pVols.length > 0 || /卷/.test(paper.title);
  const out = [];
  for (const a of articles) {
    if (a.chars < 450) continue; // 网盘引流帖/占位文，不算答案源
    if (a.year !== pYear) continue;
    let regionOk = false;
    if (a.region === pRegion) regionOk = true;
    else if (a.region === '联考' && pIsLk) regionOk = true;
    else if (a.region === '国考' && pIsGk) regionOk = true;
    else if (/联考|多省/.test(a.title) && (a.region === pRegion)) regionOk = true; // 联考文章带省名
    if (!regionOk) continue;
    // volume: both have tokens -> require intersection; article-specific volume vs
    // untOKENIZED paper volume (e.g. 安徽A、普通选调卷) -> skip; generic article -> region+year suffices
    if (a.vols.length && pVols.length) {
      if (!a.vols.some(v => pVols.includes(v))) continue;
    } else if (a.vols.length && pHasVolumeConcept) {
      continue;
    }
    out.push(a);
  }
  return out;
}

function main() {
  const articles = loadArticles();
  const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/paper-catalog.json'), 'utf8'));
  let matchedPapers = 0, added = 0;
  const byPaper = {};
  for (const p of catalog.papers) {
    p.answerSources = (p.answerSources || []).filter(s => !(s.kind || '').startsWith('知乎参考答案'));
    const matches = matchPaper(p, articles);
    for (const a of matches) {
      p.answerSources.push({
        year: a.year, region: a.region, volume: a.vols.join('/') || '',
        title: a.title, url: a.url, author: a.author, chars: a.chars,
        kind: '知乎参考答案（作者/机构解析，非官方）',
        batchFile: 'data/answers-crawled/' + a.batchFile,
        availability: '正文已抓取，见 batchFile；仅供学习比对'
      });
      added++;
    }
    if (matches.length) { matchedPapers++; byPaper[p.id] = matches.map(a => ({ title: a.title, url: a.url, chars: a.chars, batchFile: a.batchFile })); }
    if (p.answerSources.length) p.hasAnswerContent = true;
  }
  catalog.answerMatchedAt = new Date().toISOString();
  catalog.answerMatchSummary = { papers: catalog.papers.length, papersWithZhihuAnswers: matchedPapers, zhihuLinksAdded: added, articles: articles.length };
  fs.writeFileSync(path.join(ROOT, 'data/paper-catalog.json'), JSON.stringify(catalog, null, 2) + '\n');
  fs.writeFileSync(path.join(DIR, 'by-paper.json'), JSON.stringify({ updatedAt: catalog.answerMatchedAt, papers: byPaper }, null, 1) + '\n');
  fs.writeFileSync(path.join(ROOT, 'site/js/vendor/paper-catalog.js'), 'window.PaperCatalog = ' + JSON.stringify(catalog) + ';\n');
  console.log(JSON.stringify({ articles: articles.length, papers: catalog.papers.length, papersWithZhihuAnswers: matchedPapers, zhihuLinksAdded: added }));
}
main();
