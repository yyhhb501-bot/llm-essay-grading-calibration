'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const http = require('node:http'), { spawn } = require('node:child_process'), { once } = require('node:events');
async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slz-go-node-'));
  const requests = [];
  const upstream = http.createServer((req, res) => {
    let raw = ''; req.on('data', b => raw += b); req.on('end', () => {
      const body = JSON.parse(raw); requests.push({ body, headers: req.headers });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ model: body.model, choices: [{ message: { content: 'MOCK' } }] }));
    });
  }).listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const base = 'http://127.0.0.1:' + upstream.address().port;
  const allocation = http.createServer().listen(0, '127.0.0.1'); await once(allocation, 'listening');
  const port = allocation.address().port; await new Promise(r => allocation.close(r));
  const preload = path.join(tmp, 'fetch-fixture.cjs');
  fs.writeFileSync(preload, `const original=globalThis.fetch;globalThis.fetch=(url,init)=>{if(String(url)==='https://opencode.ai/inference/go/openai/v1/chat/completions')return original(process.env.GO_TEST_UPSTREAM,init);return original(url,init);};`);
  const child = spawn(process.execPath, ['--require', preload, 'site-server.js'], {
    cwd: path.resolve(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), REGISTER_INVITE_CODE: 'node-go-invite',
      OPENCODE_GO_API_KEY: 'fake-go-key', OPENCODE_GO_CONFIG_FILE: path.join(tmp, 'missing.json'), GO_TEST_UPSTREAM: base,
      SLZ_AUTH_DB_FILE: path.join(tmp, 'auth.sqlite'), SLZ_SHARED_CONFIG_FILE: path.join(tmp, 'missing-model.json'),
      ZHIPU_API_KEY: 'fake-vision-key', ZHIPU_BASE_URL: base }
  });
  let logs = ''; child.stdout.on('data', d => logs += d); child.stderr.on('data', d => logs += d);
  const origin = 'http://127.0.0.1:' + port;
  const call = (p, body, cookie) => fetch(origin + p, { method: body ? 'POST' : 'GET',
    headers: { Origin: origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  try {
    let health;
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw Error(logs);
      try { health = await (await call('/api/health')).json(); if (health.authReady) break; } catch (_) {}
      await new Promise(r => setTimeout(r, 50));
    }
    assert.equal(health.sharedProvider, 'opencode-go-api');
    assert.equal(health.officialModel, 'deepseek-v4.1-flash');
    const body = { messages: [{ role: 'user', content: 'same conversation' }], model: 'ignored-client-model', stream: false };
    assert.equal((await call('/api/chat', body)).status, 401);
    assert.equal(requests.length, 0);
    const registered = await call('/api/auth/register', { username: 'gonodeuser', password: 'node-test-password', inviteCode: 'node-go-invite' });
    assert.equal(registered.status, 201);
    const cookie = registered.headers.get('set-cookie').split(';')[0];
    assert.equal((await call('/api/chat', body, cookie)).status, 200);
    assert.equal(requests.at(-1).headers.authorization, 'Bearer fake-go-key');
    assert.equal(requests.at(-1).body.model, 'deepseek-v4.1-flash');
    const session = requests.at(-1).headers['x-opencode-session']; assert.match(session, /^shenlun-[a-f0-9]{64}$/);
    await call('/api/chat', body, cookie); assert.equal(requests.at(-1).headers['x-opencode-session'], session);
    await call('/api/chat', { ...body, vision: true }, cookie);
    assert.equal(requests.at(-1).headers.authorization, 'Bearer fake-vision-key');
    assert.equal(requests.at(-1).body.model, 'glm-5.3-flash');
    assert.equal(requests.at(-1).headers['x-opencode-session'], undefined);
    console.log('Node Go 集成通过：认证、健康状态、固定模型、稳定会话、原视觉通道隔离；仅调用假上游。');
  } finally {
    if (child.exitCode === null) { child.kill(); await once(child, 'exit'); }
    await new Promise(r => upstream.close(r));
    assert(path.resolve(tmp).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
