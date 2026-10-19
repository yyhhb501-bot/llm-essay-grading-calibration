'use strict';
var assert = require('assert');
var fs = require('fs');
var vm = require('vm');
var source = fs.readFileSync(require('path').join(__dirname, '../worker/worker.js'), 'utf8')
  .replace('export default {', 'module.exports = {');
var module = { exports: {} };
var calls = [];
vm.runInNewContext(source, {
  module: module, Response: Response, URL: URL,
  fetch: async function (url, init) {
    calls.push({ url: String(url), init: init });
    return new Response('data: [DONE]\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }
});
var Worker = module.exports;

async function run() {
  var env = {
    ACCESS_CODE: 'friend-code',
    ZHIPU_API_KEY: 'must-not-be-used',
    OPENCODE_BRIDGE_URL: 'https://bridge.example.test',
    OPENCODE_BRIDGE_TOKEN: 'worker-secret'
  };
  {
    var bad = await Worker.fetch(new Request('https://app.example.test/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Access-Code': 'wrong' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }] })
    }), env);
    assert.strictEqual(bad.status, 401);
    assert.strictEqual(calls.length, 0);

    var good = await Worker.fetch(new Request('https://app.example.test/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Access-Code': 'friend-code' },
      body: JSON.stringify({ model: 'attacker-model', apiKey: '', baseURL: 'https://attacker.invalid', messages: [{ role: 'user', content: 'essay' }], stream: true })
    }), env);
    assert.strictEqual(good.status, 200);
    assert.match(good.headers.get('content-type'), /text\/event-stream/);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].url, 'https://bridge.example.test/api/chat');
    assert.strictEqual(calls[0].init.headers.Authorization, 'Bearer worker-secret');
    var sent = JSON.parse(calls[0].init.body);
    assert.strictEqual(sent.model, undefined);
    assert.strictEqual(sent.baseURL, undefined);
    assert.strictEqual(sent.apiKey, undefined);

    var health = await Worker.fetch(new Request('https://app.example.test/api/health'), env);
    var healthJson = await health.json();
    assert.strictEqual(healthJson.sharedReady, true);
    assert.strictEqual(healthJson.officialModel, 'OpenCode Go · DeepSeek V4.1 Flash');

    var missingToken = await Worker.fetch(new Request('https://app.example.test/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Access-Code': 'friend-code' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'essay' }] })
    }), Object.assign({}, env, { OPENCODE_BRIDGE_TOKEN: '' }));
    assert.strictEqual(missingToken.status, 500);
    assert.strictEqual(calls.length, 1);
  }
  console.log('通过：Cloudflare Worker 按访问口令转发到固定 HTTPS OpenCode 桥接，不暴露客户端密钥或上游地址');
}

run().catch(function (err) { console.error(err); process.exitCode = 1; });
