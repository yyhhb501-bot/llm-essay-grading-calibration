#!/usr/bin/env node
'use strict';
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const path = require('path');
// 执行现有页面的纯视图函数，验证空分数不会变0以及动态满分的显示。
function loadView(rel, indent) {
  const source = fs.readFileSync(path.join(__dirname,'..',rel),'utf8');
  const start = source.indexOf('function buildScoreView(scores)');
  const end = source.indexOf('\n'+indent+'}',start)+indent.length+2;
  assert(start >= 0 && end > start);
  const context = {ISSUE_TAG_CLASS:{},formatScore:String,format:{formatScore:String}};
  vm.createContext(context);
  vm.runInContext(source.slice(start,end),context);
  return context.buildScoreView;
}
for(const [file,indent] of [['site/js/app.js','  '],['pages/result/result.js','']]) {
  const view=loadView(file,indent);
  for(const input of [null,{}, {total:null,dimensions:[]}, {total:'',dimensions:[]}]) assert.strictEqual(view(input).hasScore,false,file+'未知分数不应显示0');
  assert.strictEqual(view({total:0,dimensions:[],issues:[]}).totalText,'0','真实零分需保留');
  const rendered=view({total:80,grade:'训练 B 档',dimensions:[{name:'要点完整度',score:48,max:60}],issues:[],upgrade:'示范'});
  assert.strictEqual(rendered.dimensions[0].max,60);
  assert.strictEqual(rendered.dimensions[0].percent,80);
  assert.strictEqual(rendered.gradeLabel,'训练 B 档');
}
console.log('网站与小程序：未知/零分区分、动态满分比例与训练分档显示通过。');
const miniMd=require('../utils/md');
const webContext={window:{}};
vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../site/js/md.js'),'utf8'),webContext);
for(const md of [miniMd,webContext.window.MD]) {
  const text='正文\n```scores\n{"total":1}\n```\n更正\n```scores\n{"total":2}\n```';
  assert.strictEqual(md.parseScores(text).total,2);
  assert(!/scores|total/.test(md.stripScores(text)));
  assert.strictEqual(md.stripScores('正文\n```scores\n{"total":'), '正文\n');
}
console.log('重复评分与流式未闭合评分：解析最终值，复制文本不含JSON。');
