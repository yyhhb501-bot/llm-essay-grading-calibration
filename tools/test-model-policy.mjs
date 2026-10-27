import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { openAuthDatabase } = require('../server/auth-local.cjs');
const workerPath = process.env.SLZ_RELEASE_DIR
  ? path.resolve(process.env.SLZ_RELEASE_DIR, 'source/worker/worker.js')
  : path.resolve('worker/worker.js');
const worker = (await import(pathToFileURL(workerPath))).default;
const db = openAuthDatabase(':memory:');
const env = { AUTH_DB: db, ACCESS_CODE: 'model-invite', ZHIPU_API_KEY: 'fake-server-key' };
const request = (route, body, cookie) => new Request('https://model.test' + route, {
  method: body ? 'POST' : 'GET',
  headers: { Origin: 'https://model.test', 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
  body: body ? JSON.stringify(body) : undefined
});
let passed = 0;
const check = (actual, expected, name) => { assert.deepEqual(actual, expected, name); passed++; console.log('PASS ' + name); };
const original = globalThis.fetch;
let sent;
try {
  const reg = await worker.fetch(request('/api/auth/register', { username: 'modeluser', password: 'model-test-password', inviteCode: 'model-invite' }), env);
  assert.equal(reg.status, 201);
  const cookie = reg.headers.get('set-cookie').split(';')[0];
  globalThis.fetch = async (url, init) => {
    sent = JSON.parse(init.body);
    return new Response(JSON.stringify({ model: sent.model, choices: [{ message: { content: 'MOCK MODEL' } }] }));
  };
  async function call(body, overrides = {}) {
    const res = await worker.fetch(request('/api/chat', { messages: [{ role: 'user', content: 'test' }], stream: false, ...body }, cookie), { ...env, ...overrides });
    assert.equal(res.status, 200);
    return sent;
  }
  check((await call({})).model, 'glm-5.3-flash', 'Worker 默认共享文本模型');
  check((await call({ vision: true })).model, 'glm-5.3-flash', 'Worker 默认视觉回退同一个共享模型');
  check((await call({ model: 'client-model' })).model, 'glm-5.3-flash', '共享凭据不采用客户端模型');
  check((await call({ vision: true, model: 'client-vision' })).model, 'glm-5.3-flash', '共享视觉不采用客户端模型');
  const overrides = { ZHIPU_MODEL: 'owner-text', ZHIPU_VISION_MODEL: 'owner-vision' };
  check((await call({}, overrides)).model, 'owner-text', '采用站主配置文本模型');
  check((await call({ vision: true }, overrides)).model, 'owner-vision', '采用站主配置视觉模型');
  check((await call({ vision: true }, { ZHIPU_MODEL: 'owner-text' })).model, 'owner-text', '自定义共享模型同样用于默认识图');
  check((await call({ apiKey: 'fake-own-key', model: 'own-text' }, overrides)).model, 'own-text', '自带 Key 保留文本模型');
  check((await call({ apiKey: 'fake-own-key', vision: true, model: 'own-vision' }, overrides)).model, 'own-vision', '自带 Key 保留视觉模型');
  check((await call({})).thinking, { type: 'enabled' }, '默认模型保持思考参数');
  check((await call({})).reasoning_effort, 'low', '交互批改默认低思考预算');
  check((await call({ thinking: { type: 'disabled' } })).thinking, { type: 'enabled' }, 'GLM 要点核验请求兼容始终思考模式');
  check((await call({ reasoning_effort: 'high' })).reasoning_effort, 'high', '显式合法思考预算保留');
  check((await call({ ping: true })).max_tokens, 1024, '连接测试留足正文输出预算');
  const health = await (await worker.fetch(request('/api/health'), { ...env, ...overrides })).json();
  check(health.officialModel, 'owner-text', 'health 文本名与请求一致');
  check(health.officialVisionModel, 'owner-vision', 'health 视觉名与请求一致');
  console.log(passed + ' Worker 模型选择检查通过；仅调用假上游。');
} finally { globalThis.fetch = original; db.close(); }
