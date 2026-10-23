#!/usr/bin/env node
/**
 * tools/test-coverage.js —— 闭环可复算覆盖率算法契约自测
 *
 * 只用 Node 内置 assert，零 npm 依赖。校验 tools/coverage-score.js：
 *   1. groupWeight：单源 0.4、共识 1.0 起每多一家 +0.25、封顶 2.0；
 *   2. coverage：加权命中率、稀疏命中按 missing、空组返回 0；
 *   3. pointDimensionScore：线性折算 + 一位小数四舍五入 + 0..max 夹取；
 *   4. pointDimensionMax：五类题型满分与未知题型回退；
 *   5. estimateExamScore：0.5 颗粒度与非官方估算的 null 约定；
 *   6. parseHits：围栏/前后杂文/裸换行/尾逗号/缺失 id/未知 hit 的宽容解析，畸形输入返回 null；
 *   7. renderAnchorTable / renderAnchorBlock：Stage B 注入块格式与数值展示。
 *
 * 运行：node tools/test-coverage.js
 */
'use strict';

var assert = require('assert');
var cs = require('./coverage-score.js');

// ---- 1. groupWeight ----
assert.strictEqual(cs.groupWeight({ count: 1 }), 0.4, '单源权重应为 0.4');
assert.strictEqual(cs.groupWeight({ count: 2 }), 1, '2 家共识权重应为 1.0');
assert.strictEqual(cs.groupWeight({ count: 3 }), 1.25, '3 家共识权重应为 1.25');
assert.strictEqual(cs.groupWeight({ count: 4 }), 1.5, '4 家共识权重应为 1.5');
assert.strictEqual(cs.groupWeight({ count: 10 }), 2, '共识权重封顶 2.0');
assert.strictEqual(cs.groupWeight({ level: 'core', institutions: ['a', 'b', 'c'] }), 1.25, '缺 count 时用 institutions 长度');
assert.strictEqual(cs.groupWeight({ count: 2, institutions: ['a', 'b'] }), 1, '显式 count 优先于 institutions');
assert.strictEqual(cs.groupWeight({}), 0.4, '既无 count 也无 institutions 视作单源');

// ---- 2. coverage ----
var g2 = [{ count: 2 }, { count: 2 }];
assert.strictEqual(cs.coverage(g2, [{ groupId: 0, hit: 'full' }]), 0.5, '一命中一未写应为 0.5');
assert.strictEqual(cs.coverage(g2, [{ groupId: 0, hit: 'full' }, { groupId: 1, hit: 'full' }]), 1);
assert.strictEqual(cs.coverage(g2, [{ hit: 'full' }, { hit: 'partial' }]), 0.75, '无 groupId 时按数组下标');
assert.strictEqual(cs.coverage(g2, []), 0, '命中数组为空全部按未写');
assert.strictEqual(cs.coverage([], [{ groupId: 0, hit: 'full' }]), 0, '空组返回 0');
assert.strictEqual(cs.coverage(g2, [{ groupId: 0, hit: 'full' }, { groupId: 1, hit: '不认识的档位' }]), 0.5, '未知档位按未写');
var mixed = [{ count: 3 }, { count: 2 }, { count: 1 }];
assert.strictEqual(Math.round(cs.coverage(mixed, [{ groupId: 0, hit: 'full' }, { groupId: 1, hit: 'partial' }]) * 1e6) / 1e6, Math.round((1.75 / 2.65) * 1e6) / 1e6, '混合权重加权命中');

// ---- 3. pointDimensionScore ----
assert.strictEqual(cs.pointDimensionScore(0.75, 60), 45);
assert.strictEqual(cs.pointDimensionScore(59 / 75, 60), 47.2, '60 分制线性折算保留一位小数');
assert.strictEqual(cs.pointDimensionScore(0, 60), 0);
assert.strictEqual(cs.pointDimensionScore(-1, 60), 0, '负覆盖率夹到 0');
assert.strictEqual(cs.pointDimensionScore(1.5, 60), 60, '超 1 覆盖率夹到满分');
assert.strictEqual(cs.pointDimensionScore(2 / 3, 45), 30, '综合分析 45 分制');
assert.strictEqual(cs.pointDimensionScore(0.9, 35), 31.5, '文章写作 35 分制');

// ---- 4. pointDimensionMax ----
assert.strictEqual(cs.pointDimensionMax('归纳概括'), 60);
assert.strictEqual(cs.pointDimensionMax('综合分析'), 45);
assert.strictEqual(cs.pointDimensionMax('提出对策'), 40);
assert.strictEqual(cs.pointDimensionMax('公文写作'), 40);
assert.strictEqual(cs.pointDimensionMax('文章写作'), 35);
assert.strictEqual(cs.pointDimensionMax('未知题型'), 60, '未知题型回退归纳概括满分');
assert.strictEqual(cs.pointDimensionMax(undefined), 60);
assert.deepStrictEqual(Object.keys(cs.POINT_DIMENSION_MAX), ['归纳概括', '综合分析', '提出对策', '公文写作', '文章写作']);

// ---- 5. estimateExamScore ----
assert.strictEqual(cs.estimateExamScore(0.66, 20), 13, '20 分题 × 66% → 13.0');
assert.strictEqual(cs.estimateExamScore(0.7, 25), 17.5, '四舍五入到 0.5 颗粒度');
assert.strictEqual(cs.estimateExamScore(1, 10), 10);
assert.strictEqual(cs.estimateExamScore(0.5, 0), null, '无题目分值时不估算');
assert.strictEqual(cs.estimateExamScore(0.5, undefined), null);

// ---- 6. parseHits ----
var ok = cs.parseHits('{"hits":[{"id":0,"hit":"full","evidence":"整合窗口"},{"id":1,"hit":"missing","evidence":""}]}');
assert.deepStrictEqual(ok, [
  { groupId: 0, hit: 'full', evidence: '整合窗口' },
  { groupId: 1, hit: 'missing', evidence: '' }
]);

var fenced = cs.parseHits('判定如下：\n```json\n{"hits":[{"id":0,"hit":"partial","evidence":"x"}]}\n```\n以上。');
assert.strictEqual(fenced.length, 1);
assert.strictEqual(fenced[0].hit, 'partial');

var bareNewline = cs.parseHits('{"hits":[{"id":0,"hit":"full","evidence":"第一行\n第二行"}]}');
assert.strictEqual(bareNewline[0].evidence, '第一行\n第二行', '裸换行 JSON 应被容错');

var trailingComma = cs.parseHits('{"hits":[{"id":0,"hit":"full"},]}');
assert.strictEqual(trailingComma.length, 1);

var noId = cs.parseHits('{"hits":[{"hit":"full"},{"hit":"deviated"}]}');
assert.strictEqual(noId[0].groupId, 0, '缺失 id 按数组下标');
assert.strictEqual(noId[1].groupId, 1);

var strId = cs.parseHits('{"hits":[{"id":"2","hit":"FULL","evidence":""}]}');
assert.strictEqual(strId[0].groupId, 2, '字符串 id 转数字');
assert.strictEqual(strId[0].hit, 'full', '大小写归一到小写');

var unknown = cs.parseHits('{"hits":[{"id":0,"hit":"whatever"}]}');
assert.strictEqual(unknown[0].hit, 'missing', '未知 hit 档位按未写');

assert.strictEqual(cs.parseHits('抱歉，我无法给出 JSON'), null);
assert.strictEqual(cs.parseHits('{"hits":"不是数组"}'), null);
assert.strictEqual(cs.parseHits('{}'), null);
assert.strictEqual(cs.parseHits(''), null);
assert.strictEqual(cs.parseHits(null), null);
assert.strictEqual(cs.parseHits(undefined), null);

// ---- 7. renderAnchorTable / renderAnchorBlock ----
var groups = [{ text: '要点甲', count: 2, level: 'core' }, { text: '要点乙', count: 1 }];
var hits = [{ groupId: 0, hit: 'full' }, { groupId: 1, hit: 'missing' }];
var table = cs.renderAnchorTable(groups, hits);
assert.strictEqual(table, '[完整命中]共识点(2家) 要点甲\n[未写]单源点 要点乙');

var block = cs.renderAnchorBlock(groups, hits, { typeName: '归纳概括' });
assert.ok(block.indexOf('程序核算：共识加权覆盖率 71.4%，要点完整度 = 42.9 / 60。') === 0, '核算块首行格式：' + block.split('\n')[0]);
assert.ok(block.indexOf('[完整命中]共识点(2家) 要点甲') !== -1);
assert.ok(block.indexOf('[部分命中]') === -1);

var block45 = cs.renderAnchorBlock(groups, hits, { dimensionMax: 45 });
assert.ok(block45.indexOf('要点完整度 = 32.1 / 45。') !== -1, '45 分制：' + block45.split('\n')[0]);

var blockEmpty = cs.renderAnchorBlock([], [], {});
assert.ok(blockEmpty.indexOf('共识加权覆盖率 0%') !== -1);

assert.strictEqual(cs.HIT_LEVEL.full, 1);
assert.strictEqual(cs.HIT_LEVEL.partial, 0.5);
assert.strictEqual(cs.HIT_LEVEL.deviated, 0.2);
assert.strictEqual(cs.HIT_LEVEL.missing, 0);

console.log('通过：覆盖率算法（权重/覆盖/折算/题型满分/卷面估算/宽容解析/注入块）契约自测');
