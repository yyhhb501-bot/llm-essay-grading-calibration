'use strict';
const fs=require('fs');
const file='data/paper-catalog.json';
const catalog=JSON.parse(fs.readFileSync(file,'utf8'));
const links=JSON.parse(fs.readFileSync('output/research/fujian-answer-links.json','utf8'));
const references=links.map(x=>({year:Number(x.title.slice(0,4)),region:'福建',volume:(x.title.match(/（([^）]+)）/)||[])[1],title:x.title,url:x.url,kind:'第三方答案解析入口',availability:x.title.startsWith('2025')?'页面标注答案需下载查看；下载及答案正文未核验':'目录标注含答案解析；答案正文、下载条件未逐页核验'}));
references.push({year:2026,region:'福建',volume:'通用卷',title:'2026福建申论通用卷材料及参考答案',url:'https://sjds.net/587319.html',kind:'第三方参考文章',availability:'正文已确认含第一题参考答案，其他题完整性未核验'});
references.push({year:2026,region:'福建',volume:'通用卷',title:'2026福建通用卷第一题参考答案与自拟评分说明',url:'https://www.sohu.com/a/1001762588_122363278',kind:'作者原创参考（仅第一题）',availability:'正文可查看；评分说明为作者自拟，非官方标准'});
const existing=fs.existsSync('data/answer-sources.json')?JSON.parse(fs.readFileSync('data/answer-sources.json','utf8')):[];
const updated=existing.filter(x=>!references.some(r=>r.url===x.url)).concat(references);
fs.writeFileSync('data/answer-sources.json',JSON.stringify(updated,null,2)+'\n');
for(const p of catalog.papers) {
  if(p.region!=='福建')continue;
  p.answerSources=references.filter(r=>r.year===p.year&&p.title.includes(r.volume));
}
fs.writeFileSync(file,JSON.stringify(catalog,null,2)+'\n');
let text='# 福建申论参考答案来源\n\n已确认的是来源入口；除标注正文可查看的文章外，未核验下载文件、是否收费和答案完整性。均非经官方确认的标准答案，未将答案原文导入应用。\n\n';
for(const r of references)text+='- ['+r.title+']('+r.url+')：'+r.availability+'。\n';
fs.writeFileSync('docs/福建申论参考答案来源.md',text);
console.log('来源',references.length,'匹配试卷',catalog.papers.filter(p=>p.answerSources&&p.answerSources.length).length);
