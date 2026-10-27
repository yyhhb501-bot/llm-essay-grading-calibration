'use strict';
// Execute the actual submission gate: missing sources must never reach the API/history.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('site/js/app.js', 'utf8');
const helperStart = source.indexOf('  function hasGradeEvidence(material)');
const helperEnd = source.indexOf('  function onGradeSubmit()', helperStart);
const submitEnd = source.indexOf('  function startGradeStream(', helperEnd);
for (const material of ['', '   ', '（未提供）', '未提供', '暂无', '—']) {
  const messages = [];
  const context = { buildGradeMessages: () => ({ question: '概括材料中的做法', answer: '整合窗口' }),
    Store: { getConfig: () => ({}), isConfigured: () => { throw new Error('MISSING_MATERIAL_PASSED_GATE'); } },
    $: () => ({ value: material }), toast: message => messages.push(message) };
  vm.runInNewContext(source.slice(helperStart, helperEnd) + source.slice(helperEnd, submitEnd), context);
  context.onGradeSubmit();
  assert.equal(messages.length, 1);
  assert.match(messages[0], /缺少关键材料/);
}
const context = { buildGradeMessages: () => ({ question: '概括材料中的做法', answer: '整合窗口' }),
  Store: { getConfig: () => ({}), isConfigured: () => { throw new Error('VALID_EVIDENCE_REACHED_CONFIGURATION_CHECK'); } },
  $: () => ({ value: '社区整合社保和医保窗口，并开通线上预约。' }), toast: () => {} };
vm.runInNewContext(source.slice(helperStart, helperEnd) + source.slice(helperEnd, submitEnd), context);
assert.throws(() => context.onGradeSubmit(), /VALID_EVIDENCE_REACHED_CONFIGURATION_CHECK/);
console.log('PASS 6 missing-material cases cannot reach account/model/history actions; real material passes the gate.');
