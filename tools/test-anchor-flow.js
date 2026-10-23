#!/usr/bin/env node
/**
 * tools/test-anchor-flow.js —— 共识锚点两阶段批改流程集成自测
 *
 * 从 site/js/app.js 里切出「闭环可复算覆盖率」整段（函数声明在 vm 沙箱里挂到 ctx），
 * 用桩替代 Store / Api / root.CoverageScore，验证三条关键路径：
 *   1. Stage A 成功：程序核算写进 payload.anchor，Stage B 的 user 消息带【共识锚点程序核算】块；
 *   2. Stage A 返回非 JSON / 请求失败：静默回退单阶段，消息体不带锚点块；
 *   3. 迟到的 Stage A 回调（用户重试/重开导致代际失效）：直接丢弃，不再发起任何流；
 *   4. 辅助函数：题干等值判断（改题即失效）、1 起编号命中的归一化、Stage A 消息结构。
 *
 * 运行：node tools/test-anchor-flow.js
 */
'use strict';

var assert = require('assert');
var fs = require('fs');
var vm = require('vm');
var path = require('path');

var ROOT = path.resolve(__dirname, '..');
var cs = require('./coverage-score.js');
var prompts = require('../skill/prompts.js');

var src = fs.readFileSync(path.join(ROOT, 'site/js/app.js'), 'utf8');
var start = src.indexOf('  // ---- 闭环可复算覆盖率');
var end = src.indexOf('  // ---- 拍照识别 ----', start);
assert(start >= 0 && end > start, 'app.js 里找不到锚点流程段落');

function tick() {
  return new Promise(function (resolve) { setTimeout(resolve, 0); });
}

function makeCtx(records) {
  var startCalls = [];
  var chatCalls = [];
  var ctx = {
    State: { gradeSeq: 0, gradeStream: null, prefillAnchor: null, gradeBuf: '', gradeLastFlush: 0 },
    Store: {
      getConfig: function () { return {}; },
      getHistoryById: function (id) { return records[id] || null; },
      updateHistory: function (id, patch) {
        if (records[id]) records[id] = { id: id, payload: patch.payload };
      }
    },
    Api: {
      chatOnce: function (cfg, messages, opts) {
        chatCalls.push({ messages: messages, opts: opts });
        return ctx.__chatOnce(cfg, messages, opts);
      }
    },
    Prompts: prompts,
    root: { CoverageScore: cs },
    startGradeStream: function (recordId, messages) {
      ctx.bumpGradeSeq(); // 与真实实现一致：每次开流都开启新代际
      startCalls.push({ recordId: recordId, messages: messages });
    },
    console: console,
    __chatOnce: function () { return Promise.resolve(''); }
  };
  vm.runInNewContext(src.slice(start, end), ctx);
  return { ctx: ctx, startCalls: startCalls, chatCalls: chatCalls };
}

function makeBuilt() {
  return {
    messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'USER' }],
    system: 'SYS',
    user: 'USER',
    typeName: '归纳概括',
    question: '【2026年国家公考】请概括做法。',
    answer: '一是整合窗口；二是线上预约。'
  };
}

function makeAnchor() {
  return {
    paperId: 'source_test',
    qNo: '1',
    stem: '请概括做法。',
    questionValue: '【2026年国家公考】请概括做法。',
    groups: [
      { text: '整合窗口', count: 3, level: 'core' },
      { text: '线上预约', count: 2, level: 'core' }
    ],
    questionScore: 10
  };
}

(async function main() {
  // ---- 4a. 题干等值判断：只差空白算同一题，改字即失效 ----
  {
    var m = makeCtx({});
    var built = makeBuilt();
    m.ctx.State.prefillAnchor = makeAnchor();
    assert.ok(m.ctx.takeValidGradeAnchor(built), '未改题应取到锚点');
    built.question = '【2026年国家公考】 请概括做法。';
    assert.ok(m.ctx.takeValidGradeAnchor(built), '只差空白应视为同一题');
    built.question = '【2026年国家公考】请概括做法的意义。';
    assert.strictEqual(m.ctx.takeValidGradeAnchor(built), null, '改题后锚点必须失效');
    built.question = '【2026年国家公考】请概括做法。';
    built.answer = '';
    assert.strictEqual(m.ctx.takeValidGradeAnchor(built), null, '没有作答不启用两阶段');
    m.ctx.State.prefillAnchor = null;
    assert.strictEqual(m.ctx.takeValidGradeAnchor(built), null, '无预填锚点走单阶段');
    assert.strictEqual(m.ctx.normQuestion('a b\nc'), 'abc');
  }

  // ---- 4b. 1 起编号归一只在「恰为 1..n 且没有 0」时左移 ----
  {
    var m = makeCtx({});
    function sameJson(actual, expected) {
      assert.strictEqual(JSON.stringify(actual), JSON.stringify(expected));
    }
    var oneBased = [{ groupId: 1, hit: 'full' }, { groupId: 2, hit: 'missing' }];
    sameJson(m.ctx.normalizeHits(oneBased, 2), [
      { groupId: 0, hit: 'full' },
      { groupId: 1, hit: 'missing' }
    ]);
    sameJson(m.ctx.normalizeHits([{ groupId: 0, hit: 'full' }, { groupId: 2, hit: 'full' }], 3), [{ groupId: 0, hit: 'full' }, { groupId: 2, hit: 'full' }]);
    sameJson(m.ctx.normalizeHits([{ groupId: 1, hit: 'full' }], 3), [{ groupId: 1, hit: 'full' }]);
    sameJson(m.ctx.normalizeHits(oneBased, 1), oneBased);
  }

  // ---- 4c. Stage A 消息：id 从 0 起、共识度文案、system 为共享提示词 ----
  {
    var m = makeCtx({});
    var msgs = m.ctx.buildAnchorMessages(makeAnchor(), '考生作答');
    assert.strictEqual(msgs[0].role, 'system');
    assert.strictEqual(msgs[0].content, prompts.ANCHOR_MATCH_PROMPT);
    assert.strictEqual(msgs[1].role, 'user');
    assert.ok(msgs[1].content.indexOf('"id": 0') !== -1);
    assert.ok(msgs[1].content.indexOf('3家机构') !== -1);
    assert.ok(msgs[1].content.indexOf('单源') === -1);
    assert.ok(msgs[1].content.indexOf('【考生作答】\n考生作答') !== -1);
  }

  // ---- 1. Stage A 成功：核算块注入 Stage B，锚点落进 payload ----
  {
    var records = { rec1: { id: 'rec1', payload: { content: '', status: 'streaming' } } };
    var m = makeCtx(records);
    m.ctx.__chatOnce = function () {
      return Promise.resolve('{"hits":[{"id":0,"hit":"full","evidence":"整合窗口"},{"id":1,"hit":"partial","evidence":"线上预约"}]}');
    };
    m.ctx.State.gradeStream = { task: null, recordId: 'rec1' };
    var gen = m.ctx.bumpGradeSeq();
    var built = makeBuilt();
    m.ctx.startAnchorStage('rec1', makeAnchor(), built, gen);
    assert.ok(records.rec1.payload.content.indexOf('正在逐条核对共识要点（共 2 组）') === 0, 'Stage A 期间应有进度文案');
    await tick();
    assert.strictEqual(m.chatCalls.length, 1);
    assert.strictEqual(m.chatCalls[0].opts.temperature, 0.1);
    assert.strictEqual(m.chatCalls[0].opts.thinking, 'disabled');
    assert.strictEqual(m.chatCalls[0].opts.maxTokens, 4000);
    assert.strictEqual(m.startCalls.length, 1, '应接着开 Stage B');
    var bMsgs = m.startCalls[0].messages;
    assert.strictEqual(m.startCalls[0].recordId, 'rec1');
    assert.strictEqual(bMsgs[0].content, 'SYS');
    assert.ok(bMsgs[1].content.indexOf('USER\n\n【共识锚点程序核算】\n程序核算：') === 0, 'Stage B user 应带核算块');
    var anchor = records.rec1.payload.anchor;
    assert.ok(anchor, 'payload.anchor 应落盘');
    // 权重 1.25 与 1.0；命中 1 与 0.5 → (1.25 + 0.5) / 2.25 = 0.777…
    assert.strictEqual(Math.round(anchor.coverage * 1e6) / 1e6, Math.round((1.75 / 2.25) * 1e6) / 1e6);
    assert.strictEqual(anchor.pointMax, 60);
    assert.strictEqual(anchor.pointScore, 46.7);
    assert.strictEqual(anchor.block, cs.renderAnchorBlock(makeAnchor().groups, anchor.hits, { dimensionMax: 60 }));
    assert.strictEqual(records.rec1.payload.content, '', 'Stage B 开始前应清空进度文案');
    assert.strictEqual(m.ctx.State.gradeSeq, gen + 1, 'Stage B 应开启新代际');
  }

  // ---- 2a. Stage A 返回非 JSON：静默回退单阶段 ----
  {
    var records2 = { rec2: { id: 'rec2', payload: { content: '', status: 'streaming' } } };
    var m2 = makeCtx(records2);
    m2.ctx.__chatOnce = function () { return Promise.resolve('抱歉，我无法完成判定。'); };
    m2.ctx.State.gradeStream = { task: null, recordId: 'rec2' };
    var gen2 = m2.ctx.bumpGradeSeq();
    var built2 = makeBuilt();
    m2.ctx.startAnchorStage('rec2', makeAnchor(), built2, gen2);
    await tick();
    assert.strictEqual(m2.startCalls.length, 1, '应回退单阶段');
    assert.strictEqual(m2.startCalls[0].messages, built2.messages, '回退应使用原单阶段消息');
    assert.strictEqual(records2.rec2.payload.anchor, undefined, '不得写入锚点');
    assert.strictEqual(records2.rec2.payload.content, '正在进行常规批改，请稍候…');
  }

  // ---- 2b. Stage A 请求失败：静默回退单阶段 ----
  {
    var records3 = { rec3: { id: 'rec3', payload: { content: '', status: 'streaming' } } };
    var m3 = makeCtx(records3);
    m3.ctx.__chatOnce = function () { return Promise.reject(new Error('网络请求失败')); };
    m3.ctx.State.gradeStream = { task: null, recordId: 'rec3' };
    var gen3 = m3.ctx.bumpGradeSeq();
    var built3 = makeBuilt();
    m3.ctx.startAnchorStage('rec3', makeAnchor(), built3, gen3);
    await tick();
    assert.strictEqual(m3.startCalls.length, 1, '失败也要保住批改');
    assert.strictEqual(m3.startCalls[0].messages, built3.messages);
    assert.strictEqual(records3.rec3.payload.content, '正在进行常规批改，请稍候…');
  }

  // ---- 3. 迟到的 Stage A 回调：代际失效后直接丢弃 ----
  {
    var records4 = { rec4: { id: 'rec4', payload: { content: '', status: 'streaming' } } };
    var m4 = makeCtx(records4);
    var deferred = {};
    var pending = new Promise(function (resolve) { deferred.resolve = resolve; });
    m4.ctx.__chatOnce = function () { return pending; };
    m4.ctx.State.gradeStream = { task: null, recordId: 'rec4' };
    var gen4 = m4.ctx.bumpGradeSeq();
    var built4 = makeBuilt();
    m4.ctx.startAnchorStage('rec4', makeAnchor(), built4, gen4);
    m4.ctx.bumpGradeSeq(); // 模拟用户重试/重开：新代际接管
    deferred.resolve('{"hits":[{"id":0,"hit":"full"},{"id":1,"hit":"full"}]}');
    await tick();
    assert.strictEqual(m4.startCalls.length, 0, '代际失效后的迟到回调不得再发起任何流');
    assert.strictEqual(records4.rec4.payload.anchor, undefined);
  }

  // ---- 4d. 覆盖率模块缺失（老单文件缓存）：立即回退，不炸页面 ----
  {
    var records5 = { rec5: { id: 'rec5', payload: { content: '', status: 'streaming' } } };
    var m5 = makeCtx(records5);
    m5.ctx.root.CoverageScore = undefined;
    m5.ctx.State.gradeStream = { task: null, recordId: 'rec5' };
    var gen5 = m5.ctx.bumpGradeSeq();
    var built5 = makeBuilt();
    m5.ctx.startAnchorStage('rec5', makeAnchor(), built5, gen5);
    assert.strictEqual(m5.startCalls.length, 1, '缺依赖应同步回退');
    assert.strictEqual(m5.chatCalls.length, 0, '缺依赖不得发起 Stage A');
  }

  console.log('通过：共识锚点两阶段流程（成功注入/静默回退/迟到作废/依赖缺失兜底）集成自测');
})().catch(function (e) {
  console.error(e);
  process.exitCode = 1;
});
