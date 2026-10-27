import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import worker from '../worker/worker.js';
const require = createRequire(import.meta.url);
const { openAuthDatabase } = require('../server/auth-local.cjs');
const db = openAuthDatabase(':memory:');
const env = { AUTH_DB: db, ACCESS_CODE: 'go-invite', OPENCODE_GO_API_KEY: 'fake-go-key', ZHIPU_API_KEY: 'fake-vision-key' };
const request = (route, body, cookie) => new Request('https://go.test' + route, {
  method: body ? 'POST' : 'GET', headers: { Origin: 'https://go.test', 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
  body: body ? JSON.stringify(body) : undefined
});
const saved = globalThis.fetch;
const calls = [];
let failure = false, count = 0;
const check = (actual, expected, message) => { assert.deepEqual(actual, expected, message); count++; console.log('PASS ' + message); };
try {
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
    if (failure) return new Response(JSON.stringify({ error: { message: 'Invalid credential' } }), { status: 401 });
    if (JSON.parse(init.body).stream) return new Response('data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
    return new Response(JSON.stringify({ model: JSON.parse(init.body).model, choices: [{ message: { content: 'MOCK GO' } }] }));
  };
  const body = { model: 'client-model', baseURL: 'https://untrusted.test', messages: [{ role: 'user', content: '同一个会话' }], stream: false };
  check((await worker.fetch(request('/api/chat', body), env)).status, 401, '匿名不能使用 Go');
  check(calls.length, 0, '匿名请求不消耗模型');
  async function register(username) {
    const res = await worker.fetch(request('/api/auth/register', { username, password: 'go-test-password', inviteCode: 'go-invite' }), env);
    assert.equal(res.status, 201); return res.headers.get('set-cookie').split(';')[0];
  }
  const alice = await register('go-alice'), bob = await register('go-bob');
  async function call(patch = {}, cookie = alice, config = env) {
    return worker.fetch(request('/api/chat', { ...body, ...patch }, cookie), config);
  }
  check((await call()).status, 200, '登录后 Go 返回内容');
  check(calls[0].url, 'https://opencode.ai/inference/go/openai/v1/chat/completions', '固定官方 Go endpoint');
  check(calls[0].headers.Authorization, 'Bearer fake-go-key', '只使用服务端 Go Key');
  check(calls[0].headers['User-Agent'], 'ShenlunGrader/1.0', '如实标识批改客户端');
  check(calls[0].body.model, 'deepseek-v4.1-flash', '固定用户要求的 DeepSeek');
  check(calls[0].body.thinking, undefined, '不塞入 GLM 专属 thinking 参数');
  check(calls[0].body.tools, undefined, '不启用代理工具');
  const session = calls[0].headers['x-opencode-session'];
  assert.match(session, /^shenlun-[a-f0-9]{64}$/);
  await call({ messages: [...body.messages, { role: 'assistant', content: '上一轮' }, { role: 'user', content: '下一轮' }] });
  check(calls.at(-1).headers['x-opencode-session'], session, '同一账号会话路由稳定');
  await call({}, bob);
  check(calls.at(-1).headers['x-opencode-session'] === session, false, '不同账号会话隔离');
  await call({ vision: true });
  check(calls.at(-1).headers.Authorization, 'Bearer fake-vision-key', '视觉走原服务，不把图片发给 Go 文本通道');
  check(calls.at(-1).body.model, 'glm-5.3-flash', '视觉模型保留原配置');
  await call({ apiKey: 'fake-own-key', baseURL: 'https://own.test/v1', model: 'own-model' });
  check(calls.at(-1).url, 'https://own.test/v1/chat/completions', '自带 Key 路径保留');
  check(calls.at(-1).body.model, 'own-model', '自带 Key 模型不覆盖');
  check((await call({ vision: true }, alice, { ...env, ZHIPU_API_KEY: '' })).status, 400, '视觉未配置时明确提示');
  check((await call({ stream: true })).headers.get('content-type').includes('event-stream'), true, 'Go SSE 透传');
  const health = await (await worker.fetch(request('/api/health'), env)).json();
  check(health.sharedProvider, 'opencode-go-api', '健康接口区分云端直连与本机桥接');
  check(health.officialModel, 'deepseek-v4.1-flash', '健康接口模型名正确');
  failure = true;
  const before = calls.length;
  check((await call()).status, 401, '真实供应商错误不伪装成功');
  check(calls.length, before + 1, 'Go 失败不静默切换其他供应商');
  console.log(count + ' Go 直连契约检查通过（假上游，无真实额度）。');
} finally { globalThis.fetch = saved; db.close(); }
