'use strict';
var assert = require('assert');
var http = require('http');

var Bridge;
var upstreamState = { calls: 0, deletes: 0, session: null, message: null, failMessage: false };

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

var upstream = http.createServer(function (req, res) {
  if (req.method === 'POST' && req.url === '/api/session') {
    var sessionChunks = [];
    req.on('data', function (c) { sessionChunks.push(c); });
    req.on('end', function () {
      upstreamState.calls++;
      upstreamState.session = JSON.parse(Buffer.concat(sessionChunks).toString('utf8'));
      return send(res, 200, { data: { id: 'session_test_1' } });
    });
    return;
  }
  if (req.method === 'POST' && req.url === '/api/session/session_test_1/prompt') {
    var chunks = [];
    req.on('data', function (c) { chunks.push(c); });
    req.on('end', function () {
      upstreamState.message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (upstreamState.failMessage) return send(res, 502, { error: 'mock unavailable' });
      return send(res, 200, { data: { id: 'msg_user_1', type: 'user', text: upstreamState.message.text } });
    });
    return;
  }
  if (req.method === 'GET' && req.url === '/api/session/session_test_1/message') {
    return send(res, 200, { data: [{ type: 'assistant', finish: 'stop', content: [{ type: 'text', text: '这是一份模拟批改。' }, { type: 'reasoning', text: '不返回' }] }] });
  }
  if (req.method === 'DELETE' && req.url === '/api/session/session_test_1') {
    upstreamState.deletes++;
    return send(res, 200, true);
  }
  return send(res, 404, { error: 'not found' });
});

function request(url, options) {
  return fetch(url, options);
}

async function run() {
  await new Promise(function (resolve) { upstream.listen(0, '127.0.0.1', resolve); });
  process.env.OPENCODE_SERVER_URL = 'http://127.0.0.1:' + upstream.address().port;
  delete require.cache[require.resolve('../opencode-bridge')];
  Bridge = require('../opencode-bridge');
  var bridge = Bridge.createServer({ token: 'bridge-test-token', readiness: async function () {
    return { ok: true, provider: 'opencode-go', model: Bridge.model, agent: 'essay-grader' };
  } });
  await new Promise(function (resolve) { bridge.listen(0, '127.0.0.1', resolve); });
  var base = 'http://127.0.0.1:' + bridge.address().port;
  try {
    var bad = await request(base + '/api/chat', { method: 'POST', headers: { Authorization: 'Bearer wrong', 'Content-Type': 'application/json' }, body: '{"messages":[]}' });
    assert.strictEqual(bad.status, 401);
    assert.strictEqual(upstreamState.calls, 0);

    var ok = await request(base + '/api/chat', { method: 'POST', headers: { Authorization: 'Bearer bridge-test-token', 'Content-Type': 'application/json' }, body: JSON.stringify({
      messages: [{ role: 'system', content: '请批改作文' }, { role: 'user', content: '我的作答' }], stream: false
    }) });
    assert.strictEqual(ok.status, 200);
    var completion = await ok.json();
    assert.strictEqual(completion.choices[0].message.content, '这是一份模拟批改。');
    assert.strictEqual(upstreamState.session.agent, 'essay-grader');
    assert.strictEqual(upstreamState.session.model.providerID, 'opencode-go');
    assert.strictEqual(upstreamState.session.model.id, 'deepseek-v4.1-flash');
    assert.deepStrictEqual(upstreamState.session.permissions, [{ action: '*', resource: '*', effect: 'deny' }]);
    assert.match(upstreamState.message.text, /请批改作文/);
    assert.match(upstreamState.message.text, /我的作答/);
    assert.strictEqual(upstreamState.deletes, 1);

    var streamRes = await request(base + '/api/chat', { method: 'POST', headers: { Authorization: 'Bearer bridge-test-token', 'Content-Type': 'application/json' }, body: JSON.stringify({
      messages: [{ role: 'user', content: '另一份作文' }], stream: true
    }) });
    var streamText = await streamRes.text();
    assert.match(streamRes.headers.get('content-type'), /text\/event-stream/);
    assert.match(streamText, /"content":"这是一份模拟批改。"/);
    assert.match(streamText, /data: \[DONE\]/);

    var malformed = await request(base + '/api/chat', { method: 'POST', headers: { Authorization: 'Bearer bridge-test-token', 'Content-Type': 'application/json' }, body: '{' });
    assert.strictEqual(malformed.status, 400);
    var image = await request(base + '/api/chat', { method: 'POST', headers: { Authorization: 'Bearer bridge-test-token', 'Content-Type': 'application/json' }, body: JSON.stringify({ vision: true, messages: [{ role: 'user', content: '识别' }] }) });
    assert.strictEqual(image.status, 400);

    upstreamState.failMessage = true;
    var failed = await request(base + '/api/chat', { method: 'POST', headers: { Authorization: 'Bearer bridge-test-token', 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: '出错测试' }], stream: false }) });
    assert.strictEqual(failed.status, 502);
    assert.strictEqual(upstreamState.deletes, 3);

    var health = await request(base + '/api/health', { headers: { Authorization: 'Bearer bridge-test-token' } });
    assert.deepStrictEqual(await health.json(), { ok: true, provider: 'opencode-go', model: Bridge.model, agent: 'essay-grader' });
    console.log('通过：口令、纯文本适配、SSE/JSON、文本限制、上游失败及会话清理');
  } finally {
    await new Promise(function (resolve) { bridge.close(resolve); });
    await new Promise(function (resolve) { upstream.close(resolve); });
  }
}

run().catch(function (err) {
  console.error(err);
  process.exitCode = 1;
});
