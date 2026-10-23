'use strict';
const fs=require('fs');
async function main(){
 const catalog=JSON.parse(fs.readFileSync('data/paper-catalog.json','utf8'));
 const regions=[...new Set(catalog.papers.map(p=>p.region))].sort((a,b)=>b.length-a.length);
 const sources=JSON.parse(fs.readFileSync('data/answer-sources.json','utf8'));
 const seen=new Set(sources.map(s=>s.url));
 for(const index of ['https://m.aipta.com/zt/sk/','https://m.aipta.com/zt/gk/']){
  const r=await fetch(index,{signal:AbortSignal.timeout(30000)});if(!r.ok)throw Error('HTTP '+r.status);
  const html=await r.text();
  for(const m of html.matchAll(/href=["']([^"']+)["'][^>]*>\s*(202[0-6][^<]*申论[^<]*答案[^<]*)<\/a>/g)){
   const title=m[2].trim(),url=new URL(m[1],index).href;
   if(seen.has(url))continue;
   const region=title.includes('国考')?'国考':regions.find(x=>title.includes(x));if(!region)continue;
   const volume=(title.match(/[（(]([^）)]+)[）)]/)||[])[1]||'';
   sources.push({year:Number(title.slice(0,4)),region,volume,title,url,kind:'第三方答案解析入口',availability:'目录标注含答案解析；正文、下载条件及卷别尚未核验'});seen.add(url);
  }
 }
 fs.writeFileSync('data/answer-sources.json',JSON.stringify(sources,null,2)+'\n');
 const normalize=s=>s.replace(/副省级|副省卷/g,'副省').replace(/地市级|地市卷/g,'地市').replace(/A类/g,'A卷').replace(/B类/g,'B卷').replace(/C类/g,'C卷');
 const audit=catalog.papers.map(p=>{
  const candidates=sources.filter(a=>a.region===p.region&&a.year===p.year);
  const matched=candidates.filter(a=>a.volume&&normalize(p.title).includes(normalize(a.volume)));
  p.answerSources=matched;
  return {paperId:p.id,title:p.title,year:p.year,region:p.region,status:matched.length?'source-matched-unverified':candidates.length?'volume-needs-review':'source-not-found',matchedSources:matched.map(a=>a.url),candidateSources:candidates.map(a=>({title:a.title,url:a.url})),materialVerified:false,answerVerified:false,usedForCalibration:false};
 });
 fs.writeFileSync('data/paper-catalog.json',JSON.stringify(catalog,null,2)+'\n');
 const summary=audit.reduce((a,p)=>(a[p.status]=(a[p.status]||0)+1,a),{});
 fs.writeFileSync('data/answer-audit.json',JSON.stringify({updatedAt:new Date().toISOString(),total:audit.length,summary,papers:audit},null,2)+'\n');
 fs.writeFileSync('docs/全部试卷答案核验进度.md','# 全部试卷答案核验进度\n\n共 '+audit.length+' 份试卷；找到入口不等于取得答案。已核验并用于校准的历年试卷：0。\n\n'+Object.entries(summary).map(([k,v])=>'- '+k+'：'+v).join('\n')+'\n\n逐卷清单见 data/answer-audit.json。匹配只比较年份、地区、卷名，缺少卷名及别名冲突须人工核验。未取得正文不将其当成评测依据。\n');
 console.log(JSON.stringify({sources:sources.length,total:audit.length,summary}));
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
