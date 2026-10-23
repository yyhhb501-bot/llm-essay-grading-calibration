'use strict';
const assert = require('node:assert/strict');
const { openAuthDatabase } = require('../server/auth-local.cjs');

async function run() {
  const Worker = (await import('../worker/worker.js')).default;
  const db = openAuthDatabase(':memory:');
  const env = {
    AUTH_DB: db, ACCESS_CODE: 'friend-invite', ZHIPU_API_KEY: 'must-not-be-used',
    OPENCODE_BRIDGE_URL: 'https://bridge.example.test', OPENCODE_BRIDGE_TOKEN: 'worker-secret'
  };
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async function (url, init) {
    calls.push({ url: String(url), init });
    return new Response('data: [DONE]\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
  const request = (pathname, body, cookie) => new Request('https://app.example.test' + pathname, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://app.example.test',
      ...(cookie ? { Cookie: cookie } : {}), 'X-Access-Code': 'friend-invite' }, body: JSON.stringify(body)
  });
  try {
    const bad = await Worker.fetch(request('/api/chat', { messages: [{ role: 'user', content: 'x' }] }), env);
    assert.equal(bad.status, 401); assert.equal(calls.length, 0);
    const registration = await Worker.fetch(request('/api/auth/register', { username: 'bridgeuser', password: 'test-password123', inviteCode: 'friend-invite' }), env);
    assert.equal(registration.status, 201);
    const cookie = registration.headers.get('set-cookie').split(';')[0];
    const good = await Worker.fetch(request('/api/chat', {
      model: 'attacker-model', apiKey: '', baseURL: 'https://attacker.invalid',
      messages: [{ role: 'user', content: 'essay' }], stream: true
    }, cookie), env);
    assert.equal(good.status, 200); assert.match(good.headers.get('content-type'), /text\/event-stream/);
    assert.equal(calls.length, 1); assert.equal(calls[0].url, 'https://bridge.example.test/api/chat');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer worker-secret');
    const sent = JSON.parse(calls[0].init.body);
    assert.equal(sent.model, undefined); assert.equal(sent.baseURL, undefined); assert.equal(sent.apiKey, undefined);
    const health = await (await Worker.fetch(new Request('https://app.example.test/api/health'), env)).json();
    assert.equal(health.sharedReady, true); assert.equal(health.authRequired, true);
    assert.equal(health.officialModel, 'OpenCode Go · DeepSeek V4.1 Flash');
    const missing = await Worker.fetch(request('/api/chat', { messages: [{ role: 'user', content: 'essay' }] }, cookie), { ...env, OPENCODE_BRIDGE_TOKEN: '' });
    assert.equal(missing.status, 500); assert.equal(calls.length, 1);
    console.log('PASS: account session gates the fixed HTTPS OpenCode bridge; only stubs were called.');
  } finally { globalThis.fetch = originalFetch; db.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
