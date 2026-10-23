import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createAuth } from '../server/auth.mjs';
import worker from '../worker/worker.js';
const require = createRequire(import.meta.url);
const { openAuthDatabase } = require('../server/auth-local.cjs');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'slz-auth-'));
let passed = 0;
function check(name, actual, expected = true) { assert.deepEqual(actual, expected, name); passed++; console.log('PASS ' + name); }
const cookie = response => (response.headers.get('set-cookie') || '').split(';')[0];
const password = 'testing password 123';

function request(urlPath, body, options = {}) {
  const origin = options.origin === undefined ? 'https://accounts.test' : options.origin;
  const headers = { 'Content-Type': 'application/json', ...options.headers };
  if (origin !== null) headers.Origin = origin;
  if (options.cookie) headers.Cookie = options.cookie;
  return new Request('https://accounts.test' + urlPath, {
    method: body === undefined ? 'GET' : 'POST', headers,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
  });
}

async function coreTests() {
  const filename = path.join(temporary, 'core.sqlite');
  const db = openAuthDatabase(filename);
  const raw = new DatabaseSync(filename);
  let now = Date.now();
  const auth = createAuth({ db, getInviteCode: () => 'invite-test', clock: () => now });
  let counter = 0;
  const call = (route, body, opts = {}) => auth.handle(request('/api/auth/' + route, body, opts), { ip: opts.ip || String(++counter) });
  try {
    check('unauthenticated session', (await (await call('session')).json()).authenticated, false);
    check('unknown login status', (await call('login', { username: 'unknown', password })).status, 401);
    check('wrong invitation', (await call('register', { username: 'alice', password, inviteCode: 'wrong' })).status, 403);
    check('short password rejected', (await call('register', { username: 'alice', password: 'short', inviteCode: 'invite-test' })).status, 400);
    const registered = await call('register', { username: 'ＡＬＩＣＥ', password, inviteCode: 'invite-test' });
    check('invited registration', registered.status, 201);
    const identity = (await registered.json()).user;
    check('username is normalized', identity.username, 'alice');
    const aliceCookie = cookie(registered);
    check('cookie is HttpOnly, Secure and SameSite', /HttpOnly/.test(registered.headers.get('set-cookie')) && /; Secure/.test(registered.headers.get('set-cookie')) && /SameSite=Lax/.test(registered.headers.get('set-cookie')));
    check('no token in JSON response', Object.keys(identity).sort(), ['id', 'username']);
    check('duplicate normalized username', (await call('register', { username: 'Alice', password, inviteCode: 'invite-test' })).status, 409);
    check('valid session', (await (await call('session', undefined, { cookie: aliceCookie })).json()).user.id, identity.id);
    const wrong = await call('login', { username: 'alice', password: 'wrong-pass' });
    const unknown = await call('login', { username: 'notfound', password: 'wrong-pass' });
    check('login errors do not enumerate users', await wrong.json(), await unknown.json());
    const logged = await call('login', { username: 'alice', password });
    check('login with correct password', logged.status, 200);
    const secondCookie = cookie(logged);
    check('old shared-code cannot authorize chat', (await auth.authorize(request('/api/chat', {}, { headers: { 'X-Access-Code': 'invite-test' } }))).response.status, 401);
    check('logged in chat is authorized', (await auth.authorize(request('/api/chat', {}, { cookie: aliceCookie }))).user.id, identity.id);
    check('foreign origin rejected', (await call('login', { username: 'alice', password }, { origin: 'https://evil.test' })).status, 403);
    check('missing origin rejected', (await call('logout', {}, { origin: null })).status, 403);
    check('invalid JSON rejected', (await call('login', '{')).status, 400);
    check('oversized body rejected', (await call('login', { pad: 'x'.repeat(17000) })).status, 413);
    check('wrong content type rejected', (await call('login', {}, { headers: { 'Content-Type': 'text/plain' } })).status, 415);
    const before = raw.prepare('SELECT * FROM auth_users WHERE id=?').get(identity.id);
    check('password not stored in clear text', before.password_hash !== password && before.password_salt.length >= 32 && before.password_iterations === 100000);
    check('token not stored in clear text', !raw.prepare('SELECT token_hash FROM auth_sessions').all().some(row => row.token_hash === aliceCookie.split('=')[1]));
    check('password change rejects wrong current password', (await call('password', { oldPassword: 'wrong-pass', newPassword: 'replacement123' }, { cookie: aliceCookie })).status, 401);
    const changed = await call('password', { oldPassword: password, newPassword: 'replacement123' }, { cookie: aliceCookie });
    check('password change succeeds', changed.status, 200);
    const changedCookie = cookie(changed);
    check('password change revokes current old token', (await (await call('session', undefined, { cookie: aliceCookie })).json()).authenticated, false);
    check('password change revokes another session', (await (await call('session', undefined, { cookie: secondCookie })).json()).authenticated, false);
    check('new password session is active', (await (await call('session', undefined, { cookie: changedCookie })).json()).authenticated);
    const logout = await call('logout', {}, { cookie: changedCookie });
    check('logout clears cookie', logout.status === 200 && /Max-Age=0/.test(logout.headers.get('set-cookie')));
    check('logout revokes server session', (await (await call('session', undefined, { cookie: changedCookie })).json()).authenticated, false);
    const again = await call('login', { username: 'alice', password: 'replacement123' });
    const expiryCookie = cookie(again);
    now += 8 * 24 * 60 * 60 * 1000;
    check('expired cookie rejected', (await (await call('session', undefined, { cookie: expiryCookie })).json()).authenticated, false);
    const race = await Promise.all([0, 1].map(() => call('register', { username: 'raceuser', password, inviteCode: 'invite-test' })));
    check('concurrent duplicate registration has one owner', race.map(res => res.status).sort(), [201, 409]);
    check('missing invite configuration disables registration', (await createAuth({ db }).handle(request('/api/auth/register', { username: 'blocked', password }))).status, 503);
    check('missing database fails closed', (await createAuth({ db: null }).handle(request('/api/auth/session'))).status, 503);
    check('missing database never authorizes code', (await createAuth({ db: null }).authorize(request('/api/chat', {}))).response.status, 503);
    for (let i = 0; i < 10; i++) await call('login', { username: 'bruteforce', password: 'incorrect' }, { ip: 'throttle-ip' });
    check('failed logins are persistently rate limited', (await call('login', { username: 'bruteforce', password }, { ip: 'throttle-ip' })).status, 429);
    // Session version prevents an old-password login racing a password change from becoming valid.
    const snapshot = raw.prepare('SELECT * FROM auth_users WHERE id=?').get(identity.id);
    raw.prepare('UPDATE auth_users SET auth_version=auth_version+1 WHERE id=?').run(identity.id);
    raw.prepare('INSERT INTO auth_sessions VALUES(?,?,?,?,?)').run('a'.repeat(64), identity.id, snapshot.auth_version, now + 10000, now);
    check('session validation joins current password version', raw.prepare('SELECT COUNT(*) AS n FROM auth_sessions s JOIN auth_users u ON s.user_id=u.id WHERE s.auth_version=u.auth_version AND s.token_hash=?').get('a'.repeat(64)).n, 0);
  } finally { raw.close(); db.close(); }
  const reopened = openAuthDatabase(filename);
  check('account survives database reopen', (await reopened.prepare('SELECT username FROM auth_users WHERE username=?').bind('alice').first()).username, 'alice');
  reopened.close();
}

async function workerTests() {
  const db = openAuthDatabase(':memory:');
  const env = { AUTH_DB: db, ACCESS_CODE: 'worker-invite', ZHIPU_API_KEY: 'fake-test-key' };
  let ip = 0;
  const call = async (route, body, opts = {}) => {
    const req = request(route, body, opts);
    req.headers.set('CF-Connecting-IP', '192.0.2.' + (++ip));
    return worker.fetch(req, env, {});
  };
  try {
    check('worker requires D1 binding', (await worker.fetch(request('/api/auth/session'), {}, {})).status, 503);
    check('worker old access code is not login', (await call('/api/chat', { messages: [{ role: 'user', content: 'test' }] }, { headers: { 'X-Access-Code': 'worker-invite' } })).status, 401);
    const registered = await call('/api/auth/register', { username: 'workeruser', password, inviteCode: 'worker-invite' });
    check('Worker registration on D1 adapter', registered.status, 201);
    const sessionCookie = cookie(registered);
    check('Worker session restored', (await (await call('/api/auth/session', undefined, { cookie: sessionCookie })).json()).authenticated);
    check('Worker chat CSRF rejected', (await call('/api/chat', {}, { cookie: sessionCookie, origin: 'https://evil.test' })).status, 403);
    const originalFetch = globalThis.fetch;
    let upstreamCalls = 0;
    globalThis.fetch = async (url, init) => {
      check('Worker forwards only expected fake model request', String(url), 'https://open.bigmodel.cn/api/paas/v4/chat/completions');
      check('Worker uses server key after login', init.headers.Authorization, 'Bearer fake-test-key');
      upstreamCalls++;
      return new Response(JSON.stringify({ choices: [{ message: { content: 'MOCK MODEL RESULT' } }] }), { headers: { 'Content-Type': 'application/json' } });
    };
    try {
      const model = await call('/api/chat', { messages: [{ role: 'user', content: 'test' }], stream: false }, { cookie: sessionCookie });
      check('authorized Worker forwarding succeeds with stub', model.status, 200);
      check('fake upstream called once', upstreamCalls, 1);
    } finally { globalThis.fetch = originalFetch; }
    await call('/api/auth/logout', {}, { cookie: sessionCookie });
    check('Worker logout revokes cookie', (await (await call('/api/auth/session', undefined, { cookie: sessionCookie })).json()).authenticated, false);
    check('health advertises accounts', (await (await call('/api/health')).json()).authRequired);
  } finally { db.close(); }
}

async function nodeHttpTests() {
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: 'MOCK NODE RESULT' } }] })); });
  }).listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const allocation = http.createServer().listen(0, '127.0.0.1');
  await once(allocation, 'listening');
  const port = allocation.address().port;
  await new Promise(resolve => allocation.close(resolve));
  const origin = 'http://127.0.0.1:' + port;
  const filename = path.join(temporary, 'http.sqlite');
  let child;
  async function start() {
    child = spawn(process.execPath, ['site-server.js'], { cwd: root, env: { ...process.env,
      PORT: String(port), HOST: '127.0.0.1', REGISTER_INVITE_CODE: 'node-invite', ACCESS_CODE: 'old-invite',
      SLZ_SHARED_CONFIG_FILE: path.join(temporary, 'no-shared.json'), SLZ_AUTH_DB_FILE: filename,
      ZHIPU_API_KEY: 'fake-test-key', ZHIPU_BASE_URL: 'http://127.0.0.1:' + upstream.address().port,
      TRUST_PROXY: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    child.stdout.on('data', chunk => { log += chunk; });
    child.stderr.on('data', chunk => { log += chunk; });
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error('Node test server exited: ' + log);
      try { const health = await fetch(origin + '/api/health'); if (health.ok) return; } catch (_) {}
      await new Promise(resolve => setTimeout(resolve, 80));
    }
    throw new Error('Node test server start timeout');
  }
  async function stop() { if (child && child.exitCode === null) { child.kill(); await once(child, 'exit'); } }
  const call = (route, body, opts = {}) => fetch(origin + route, {
    method: body === undefined ? 'GET' : 'POST', headers: {
      'Content-Type': 'application/json', Origin: origin, ...opts.headers,
      ...(opts.cookie ? { Cookie: opts.cookie } : {})
    }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
  });
  try {
    await start();
    check('HTTP health has account backend', (await (await call('/api/health')).json()).authReady);
    check('HTTP missing session cannot use old code', (await call('/api/chat', { messages: [] }, { headers: { 'X-Access-Code': 'old-invite' } })).status, 401);
    const registered = await call('/api/auth/register', { username: 'nodeuser', password, inviteCode: 'node-invite' });
    check('HTTP registration', registered.status, 201);
    const sessionCookie = cookie(registered);
    check('HTTP loopback cookie does not require HTTPS', !/; Secure/.test(registered.headers.get('set-cookie')));
    check('HTTP oversized body returns JSON error', (await call('/api/auth/login', { pad: 'x'.repeat(18000) })).status, 413);
    check('HTTP forwarded-origin spoof is rejected by default', (await call('/api/auth/login', { username: 'nodeuser', password }, { headers: { Origin: 'https://evil.test', 'X-Forwarded-Proto': 'https', Host: '127.0.0.1:' + port } })).status, 403);
    const model = await call('/api/chat', { messages: [{ role: 'user', content: 'test' }], stream: false }, { cookie: sessionCookie });
    check('HTTP logged-in model request reaches local stub', (await model.json()).choices[0].message.content, 'MOCK NODE RESULT');
    await stop(); await start();
    check('HTTP restart retains existing session', (await (await call('/api/auth/session', undefined, { cookie: sessionCookie })).json()).authenticated);
    await call('/api/auth/logout', {}, { cookie: sessionCookie });
    check('HTTP logout blocks following chat', (await call('/api/chat', { messages: [] }, { cookie: sessionCookie })).status, 401);
  } finally { await stop(); await new Promise(resolve => upstream.close(resolve)); }
}

try {
  await coreTests(); await workerTests(); await nodeHttpTests();
  console.log('\n' + passed + ' account checks passed. Models were stubbed; no real upstream requests.');
} finally { await rm(temporary, { recursive: true, force: true }); }
