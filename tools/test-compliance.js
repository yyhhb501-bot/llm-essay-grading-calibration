'use strict';
var assert = require('assert');
var aigc = require('../utils/aigc.js');
var transport = require('../utils/model-request.js');
var api = require('../utils/api.js');
var calls;
var modal;
var cache;
var errors;
var latest;

function reset() {
  transport.abortAll();
  calls = 0; modal = null; cache = {}; errors = []; latest = null;
  global.wx = {
    getStorageSync: function (key) { return cache[key]; },
    setStorageSync: function (key, value) { cache[key] = value; },
    showModal: function (options) { modal = options; },
    request: function (options) {
      calls++;
      latest = { options: options, chunks: [] };
      var record = latest;
      return {
        abort: function () {
          var err = { errMsg: 'request:fail abort' };
          if (options.fail) options.fail(err);
          if (options.complete) options.complete(err);
        },
        onChunkReceived: function (fn) { record.chunks.push(fn); }
      };
    }
  };
}
function send(url) {
  return transport.request({ url: url, fail: function (e) { errors.push(e.errMsg); } });
}

reset();
send('https://api.deepseek.com/chat/completions');
assert.strictEqual(calls, 0, '未经同意不得传输');
modal.success({ confirm: false });
assert.strictEqual(calls, 0);
assert.match(errors[0], /未同意/);
assert.strictEqual(cache[transport.CONSENT_KEY], undefined);

reset();
var task = send('https://api.deepseek.com/chat/completions');
var received = null;
var onChunk = function (c) { received = c; };
task.onChunkReceived(onChunk);
modal.success({ confirm: true });
assert.strictEqual(calls, 1);
assert.strictEqual(latest.chunks.length, 1, '授权后仍能监听流式分块');
latest.chunks[0]('chunk-payload');
assert.strictEqual(received, 'chunk-payload', '分块能被正常转发到监听器');
send('https://api.deepseek.com/chat/completions');
assert.strictEqual(calls, 2, '同域名复用同意');
send('https://other.example/v1/chat/completions');
assert.strictEqual(calls, 2, '新域名需要新的同意');
assert.match(modal.content, /other.example/);
modal.success({ confirm: false });

reset();
task = send('https://api.deepseek.com/chat/completions');
task.abort();
modal.success({ confirm: true });
assert.strictEqual(calls, 0, '取消后点击同意不能补发请求');
assert.strictEqual(errors.length, 1);

reset();
send('http://example.com/v1');
send('https://key@example.com/v1');
assert.strictEqual(calls, 0, '禁止 HTTP 和地址内认证信息');
assert.strictEqual(modal, null);

reset();
send('https://api.deepseek.com/chat/completions');
var pending = modal;
transport.abortAll();
pending.success({ confirm: true });
assert.strictEqual(calls, 0, '撤回或删除会取消待授权请求');

reset();
var deltas = [];
var done = '';
var failures = [];
api.chatStream({ baseURL: 'https://api.deepseek.com', apiKey: 'test-only', model: 'deepseek-flash' }, [
  { role: 'user', content: '测试' }
], {
  onDelta: function (text) { deltas.push(text); },
  onDone: function (text) { done = text; },
  onError: function (text) { failures.push(text); }
});
modal.success({ confirm: true });
var packet = Buffer.from('data: {"choices":[{"delta":{"content":"中文批改"}}]}\n\ndata: [DONE]\n\n');
latest.chunks[0]({ data: packet.buffer.slice(packet.byteOffset, packet.byteOffset + packet.byteLength) });
latest.options.success({ statusCode: 200 });
latest.options.complete({ statusCode: 200 });
assert.deepStrictEqual(deltas, ['中文批改']);
assert.strictEqual(done, '中文批改');
assert.deepStrictEqual(failures, []);

reset();
api.chatStream({ baseURL: 'https://api.deepseek.com', apiKey: 'test-only', model: 'deepseek-flash' }, [], {
  onError: function (text) { errors.push(text); }
});
modal.success({ confirm: false });
assert.strictEqual(calls, 0, '拒绝不得触发降级重试');
assert.match(errors[0], /未同意/);

assert.strictEqual(aigc.forClipboard(aigc.forClipboard('正文')), aigc.forClipboard('正文'));
var copied;
wx.setClipboardData = function (options) { copied = options.data; };
var page;
global.Page = function (definition) { page = definition; };
require('../pages/chat/chat.js');
page.doCopyMsg.call({ data: { messages: [{ role: 'ai', text: '回复' }, { role: 'user', text: '作答' }] } }, { currentTarget: { dataset: { index: 0 } } });
assert.strictEqual(copied, aigc.forClipboard('回复'));
page.doCopyMsg.call({ data: { messages: [{ role: 'user', text: '作答' }] } }, { currentTarget: { dataset: { index: 0 } } });
assert.strictEqual(copied, '作答', '用户原文不应被标为 AI 生成');
require('../pages/result/result.js');
page.doCopy.call({ data: { rawText: '报告\n```scores\n{"total":80}\n```' } });
assert.ok(copied.indexOf(aigc.LABEL) === 0);
assert.ok(copied.indexOf('scores') === -1);
require('../pages/study/study.js');
page.doCopyPlan.call({ data: { content: '计划' } });
assert.strictEqual(copied, aigc.forClipboard('计划'));
var definition;
global.Component = function (component) { definition = component; };
require('../components/privacy-dialog/privacy-dialog.js');
var dialog = {
  data: { visible: false },
  setData: function (patch) { Object.assign(this.data, patch); }
};
Object.assign(dialog, definition.methods);
var privacyResult;
dialog.requestConsent(function (result) { privacyResult = result; });
assert.strictEqual(dialog.data.visible, true);
dialog.onDecline();
assert.deepStrictEqual(privacyResult, { event: 'disagree' });
dialog.requestConsent(function (result) { privacyResult = result; });
dialog.onAgree();
assert.deepStrictEqual(privacyResult, { event: 'agree', buttonId: 'privacy-agree-button' });
dialog.requestConsent(function (result) { privacyResult = result; });
definition.lifetimes.detached.call(dialog);
assert.deepStrictEqual(privacyResult, { event: 'disagree' });

var allowed = false;
var privacy = require('../utils/privacy.js');
wx.showToast = function () {};
privacy.ensurePrivacy(function () { allowed = true; });
assert.strictEqual(allowed, false, '不支持隐私授权时不能静默执行');
wx.requirePrivacyAuthorize = function (options) { options.fail(); };
privacy.ensurePrivacy(function () { allowed = true; });
assert.strictEqual(allowed, false);
wx.requirePrivacyAuthorize = function (options) { options.success(); };
privacy.ensurePrivacy(function () { allowed = true; });
assert.strictEqual(allowed, true);

var fs = require('fs');
var path = require('path');
var config = require('../app.json');
config.pages.forEach(function (name) {
  assert.ok(fs.readFileSync(path.join(__dirname, '..', name + '.wxml'), 'utf8').includes('<privacy-dialog id="privacy-dialog"'), '页面包含授权组件：' + name);
});

reset();
wx.removeStorageSync = function (key) { delete cache[key]; };
wx.getStorageInfoSync = function () { return { keys: Object.keys(cache) }; };
wx.switchTab = function (options) { if (options && options.success) options.success(); };
wx.showToast = function () {};
var storage = require('../utils/storage.js');
Object.keys(storage.KEYS).forEach(function (name) { cache[storage.KEYS[name]] = 'private data'; });
cache.unrelated = 'keep';
cache[transport.CONSENT_KEY] = ['https://api.deepseek.com'];
global.getApp = function () { return { globalData: {}, refreshGlobalData: function () {} }; };
global.getCurrentPages = function () { return []; };
wx.reLaunch = function (options) {
  // 模拟页面卸载时最后保存一次历史，删除必须在此之后。
  cache[storage.KEYS.HISTORY] = ['late history'];
  options.success();
};
require('../pages/mine/mine.js');
page.onDeleteLocalData();
modal.success({ confirm: true });
setImmediate(function () {
  Object.keys(storage.KEYS).forEach(function (name) { assert.strictEqual(cache[storage.KEYS[name]], undefined); });
  assert.strictEqual(cache[transport.CONSENT_KEY], undefined);
  assert.strictEqual(cache.unrelated, 'keep');
  assert.strictEqual(storage.getConfig().model, 'deepseek-flash');
  cache[storage.KEYS.CONFIG] = { presetId: 'custom', baseURL: '', apiKey: 'saved-key', model: 'my-model' };
  assert.strictEqual(storage.getConfig().baseURL, '', '已有配置清空地址后不能自动切换接收方');
  assert.strictEqual(storage.getConfig().visionModel, '', '已有配置缺少视觉模型不能补其他厂商模型');
  console.log('通过：传输同意、拒绝、取消、域名切换、HTTPS、撤回、中文流式响应、复制标识、隐私授权与本地删除');
});
