'use strict';
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const prompts = require('../skill/prompts');
const sample = '来源：用户测试。整合窗口，网上预约。';
let mini;
vm.runInNewContext(fs.readFileSync('pages/grade/grade.js','utf8'), {
  Page: page => {mini=page;},
  require: name => name.includes('/prompts') ? prompts : name.includes('/references') ? {REF:{}} : name.includes('/storage') ? {getSkillCustom:()=>({})} : name.includes('/format') ? require('../utils/format') : {}
});
const miniMessages = mini.buildMessages.call({data:{typeIndex:0,question:'概括做法',material:'整合窗口，网上预约。',answer:'集中办理并线上预约。',referenceAnswer:sample}});
assert(miniMessages[1].content.includes('【参考答案】'+sample));
const src = fs.readFileSync('site/js/app.js','utf8');
const start = src.indexOf('  function buildGradeMessages(cfg)');
const end = src.indexOf('\n  function loadPresetQuestion',start);
const ctx = {Prompts:prompts,References:{REF:{}},TYPE_OPTIONS:['归纳概括'],$:id=>({value:id==='grade-reference'?sample:'测试文本'})};
vm.runInNewContext(src.slice(start,end),ctx);
assert(ctx.buildGradeMessages({}).messages[1].content.includes('【参考答案】'+sample));
assert(src.includes("referenceAnswer: ($('grade-reference').value || '').trim()"));
assert(src.includes("'【参考答案】' + (payload.referenceAnswer || '（未提供）')"));
assert(prompts.GRADE_PROMPT.includes('不以与参考答案的字词相似率评分'));
console.log('网页与小程序参考答案输入、保存与重试消息契约通过');
