'use strict';
var fs = require('fs');
var vm = require('vm');
var path = require('path');
var assert = require('assert');
var source = fs.readFileSync(path.join(__dirname, '../site/js/api.js'), 'utf8');

async function check(protocol, mode) {
  var requests = [];
  var root = { Auth: { isAuthenticated: function () { return true; } }, console: { error: function () {} }, fetch: async function (url, options) {
    var body = JSON.parse(options.body);
    requests.push({ url: url, options: options, body: body });
    // 强制流式请求失败，验证非流式降级也能访问共享函数。
    if (body.stream) return { status: 500, text: async function () { return ''; } };
    return { status: 200, text: async function () {
      return JSON.stringify({ choices: [{ message: { content: '连接正常' } }] });
    } };
  } };
  vm.runInNewContext(source, { window: root, location: { protocol: protocol }, AbortController: AbortController });
  var cfg = { mode: mode, accessCode: 'test-code', baseURL: 'https://api.example.test/v1', apiKey: 'test-key', model: 'glm-5.3-flash' };
  var result = await root.Api.testConnection(cfg);
  assert.strictEqual(result.ok, true);
  var direct = protocol === 'file:' && mode === 'selfkey';
  assert.strictEqual(requests[0].url, direct ? 'https://api.example.test/v1/chat/completions' : '/api/chat');
  assert.strictEqual(requests[0].body.stream, false);
  assert.strictEqual(requests[0].body.thinking.type, 'enabled');
  assert.strictEqual(requests[0].body.temperature, 1);
  if (direct) assert.strictEqual(requests[0].options.headers.Authorization, 'Bearer test-key');
  else {
    assert.strictEqual(requests[0].options.headers['X-Access-Code'], undefined);
    assert.strictEqual(requests[0].body.ping, true);
    assert.strictEqual(requests[0].body.apiKey, mode === 'selfkey' ? 'test-key' : undefined);
  }
  assert.strictEqual(requests[0].options.credentials, direct ? 'omit' : 'same-origin');
  await new Promise(function (resolve, reject) {
    root.Api.chatStream(cfg, [{ role: 'user', content: '测试' }], {
      onDone: function (text) {
        try { assert.strictEqual(text, '连接正常'); resolve(); } catch (e) { reject(e); }
      },
      onError: function () {}
    });
  });
  assert.strictEqual(requests.length, 3);
  assert.strictEqual(requests[2].body.stream, false);
  // glm-5.3-flash 未显式给参数时仍走「开思考 + 温度 1」的默认（流式首请求）
  assert.strictEqual(requests[1].body.thinking.type, 'enabled');
  assert.strictEqual(requests[1].body.temperature, 1);

  // chatOnce：显式 temperature / thinking / max_tokens 必须原样进请求体（共识锚点判定用）
  var once = await root.Api.chatOnce(cfg, [{ role: 'user', content: '判定要点' }], { temperature: 0.1, thinking: 'disabled', maxTokens: 4000 });
  assert.strictEqual(once, '连接正常');
  assert.strictEqual(requests.length, 4);
  var onceReq = requests[3];
  assert.strictEqual(onceReq.body.stream, false);
  assert.strictEqual(onceReq.body.temperature, 0.1);
  assert.strictEqual(onceReq.body.thinking.type, 'disabled');
  assert.strictEqual(onceReq.body.max_tokens, 4000);

  // 非智谱系（DeepSeek 预设）自带 Key 模式下不塞 thinking，避免上游 400；服务端模式由服务端选上游，照常带
  var dsCfg = { mode: mode, accessCode: 'test-code', presetId: 'deepseek', baseURL: 'https://api.deepseek.com', apiKey: 'test-key', model: 'deepseek-chat' };
  var once2 = await root.Api.chatOnce(dsCfg, [{ role: 'user', content: '判定要点' }], { temperature: 0.1, thinking: 'disabled' });
  assert.strictEqual(once2, '连接正常');
  assert.strictEqual(requests.length, 5);
  if (mode === 'server') {
    assert.strictEqual(requests[4].body.thinking.type, 'disabled', '服务端模式带 thinking 交给转发层');
  } else {
    assert.strictEqual(requests[4].body.thinking, undefined, '自带 Key 非智谱系不带 thinking');
  }
  assert.strictEqual(requests[4].body.temperature, 0.1);
  assert.strictEqual(requests[4].body.max_tokens, undefined);

  // 配置不全：chatOnce 直接 reject 中文错误，不发请求
  var badMsg = '';
  await root.Api.chatOnce({ mode: 'selfkey' }, [{ role: 'user', content: 'x' }], {}).then(function () {
    badMsg = '';
  }, function (e) {
    badMsg = String((e && e.message) || '');
  });
  assert.ok(badMsg.indexOf('API Key') !== -1, '配置不全应给出中文错误：' + badMsg);
  assert.strictEqual(requests.length, 5);
}

(async function () {
  await check('http:', 'server');
  await check('http:', 'selfkey');
  await check('file:', 'selfkey');
  var sent = 0;
  var unauthorized = { Auth: { isAuthenticated: function () { return false; } }, fetch: function () { sent++; } };
  vm.runInNewContext(source, { window: unauthorized, location: { protocol: 'https:' }, AbortController: AbortController });
  var rejected = await unauthorized.Api.testConnection({ mode: 'server', accessCode: 'old-code' });
  assert.strictEqual(rejected.ok, false); assert.strictEqual(sent, 0);
  for (var code of ['AUTH_REQUIRED', undefined]) {
    var prompted = 0;
    var context = { Auth: { isAuthenticated: function () { return true; }, requireLogin: function () { prompted++; } },
      fetch: async function () { return { status: 401, text: async function () { return JSON.stringify({ error: 'mock failure', code: code }); } }; } };
    vm.runInNewContext(source, { window: context, location: { protocol: 'https:' }, AbortController: AbortController });
    var failedConnection = await context.Api.testConnection({ mode: 'server' });
    assert.strictEqual(failedConnection.ok, false);
    assert.strictEqual(prompted, code === 'AUTH_REQUIRED' ? 1 : 0, 'only account 401 opens the login gate');
  }
  console.log('通过：服务端、自带 Key 转发、本地文件直连的连接测试与非流式降级、chatOnce 显式参数透传');
})().catch(function (e) { console.error(e); process.exitCode = 1; });
