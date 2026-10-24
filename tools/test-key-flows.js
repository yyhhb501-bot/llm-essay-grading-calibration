'use strict';
// 本地关键流程验收（假模型上游，零额度消耗）。运行：node tools/test-key-flows.js
//
// 静态目录通过 SLZ_SITE_DIR 指向发布包 .agent/site-release-20261024/assets，
// 因此这里验收的是“将要发布的字节”（与 manifest.json 的 SHA256 逐项核对）。
// 覆盖：健康检查、注册、普通用户权限、题库静态配套（索引/逐卷/共识/采分点/bundle）、
// /api/chat 非流式与 SSE 透传、慢速流渐进、客户端取消（上游连接被销毁）、
// 上游错误中文映射（含视觉 400 专项）、陪练请求契约（system 首消息 + glm-5.3-flash
// thinking/temperature 默认）、图片识别消息契约（image_url 内容数组）、登出后拒绝。
// 假模型上游按用户消息里的 #MODE 提示词编排行为。

const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { once } = require('events');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RELEASE_ASSETS = path.join(ROOT, '.agent/site-release-20261024/assets');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, '.agent/site-release-20261024/manifest.json'), 'utf8'));
const SHARED_KEY = 'fake-shared-key-not-real';

let passed = 0;
function ok(name, condition) { assert.ok(condition, name); passed++; console.log('PASS ' + name); }
function sseChunk(content) { return 'data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\n\n'; }
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

async function main() {
  assert.ok(fs.existsSync(path.join(RELEASE_ASSETS, 'index.html')), '发布包 assets 不存在，先运行 node tools/prepare-site-release.js');

  // ---- 可编排的假模型上游 ----
  const upstreamRequests = [];
  let upstreamCloses = 0;
  const upstream = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      const record = { url: req.url, auth: req.headers.authorization, body };
      upstreamRequests.push(record);
      const hint = JSON.stringify(body.messages || []).match(/#(PING|SLOW|HANG|FAIL401|FAILVISION)/);
      const mode = hint ? hint[1] : 'STREAM';
      if (body.stream === false) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'MOCK 非流式回复 ' + mode } }] }));
        return;
      }
      if (mode === 'FAIL401' || mode === 'FAILVISION') {
        res.writeHead(mode === 'FAIL401' ? 401 : 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: mode === 'FAIL401' ? 'invalid api key' : 'image content is invalid' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      if (mode === 'HANG') {
        res.write(sseChunk('挂住不发完'));
        res.on('close', () => { upstreamCloses++; });
        return;
      }
      const chunks = mode === 'SLOW' ? ['慢一', '慢二', '慢三'] : ['第一段', '第二段'];
      const send = i => {
        if (i >= chunks.length) { res.write('data: [DONE]\n\n'); res.end(); return; }
        res.write(sseChunk(chunks[i]));
        setTimeout(() => send(i + 1), mode === 'SLOW' ? 250 : 15);
      };
      send(0);
    });
  }).listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const upstreamPort = upstream.address().port;

  // ---- 起 site-server：静态目录=发布包，共享配置指向假上游 ----
  const allocation = http.createServer().listen(0, '127.0.0.1');
  await once(allocation, 'listening');
  const port = allocation.address().port;
  await new Promise(r => allocation.close(r));
  const origin = 'http://127.0.0.1:' + port;
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'slz-flows-'));
  fs.writeFileSync(path.join(temporary, 'shared-model.json'), JSON.stringify({
    apiKey: SHARED_KEY, baseURL: 'http://127.0.0.1:' + upstreamPort,
    model: 'glm-5.3-flash', accessCode: 'flow-access-code'
  }));
  const child = spawn(process.execPath, ['site-server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(port), HOST: '127.0.0.1',
      SLZ_SITE_DIR: RELEASE_ASSETS,
      REGISTER_INVITE_CODE: 'flow-invite', ACCESS_CODE: 'old-code',
      SLZ_SHARED_CONFIG_FILE: path.join(temporary, 'shared-model.json'),
      SLZ_AUTH_DB_FILE: path.join(temporary, 'accounts.sqlite'),
      // 故意给错：证明共享配置密钥优先于环境变量
      ZHIPU_API_KEY: 'wrong-env-key', TRUST_PROXY: '0'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let serverLog = '';
  child.stdout.on('data', c => { serverLog += c; });
  child.stderr.on('data', c => { serverLog += c; });
  const call = (route, body, opts = {}) => fetch(origin + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'Content-Type': 'application/json', Origin: origin,
      ...(opts.cookie ? { Cookie: opts.cookie } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: opts.signal
  });
  const cookieOf = res => (res.headers.get('set-cookie') || '').split(';')[0];
  const lastUpstream = () => upstreamRequests[upstreamRequests.length - 1];
  try {
    const deadline = Date.now() + 15000;
    let health = null;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error('site-server 退出：' + serverLog);
      try { health = await (await fetch(origin + '/api/health')).json(); if (health.ok) break; } catch (_) { /* 还没起来 */ }
      await new Promise(r => setTimeout(r, 100));
    }
    ok('健康检查就绪（auth/shared/registration）', health && health.authReady && health.sharedReady && health.registrationReady);

    // ---- 账号与权限 ----
    ok('错误邀请码注册被拒（403）', (await call('/api/auth/register', { username: 'badinvite', password: 'flow password 8', inviteCode: 'wrong-code' })).status, 403);
    const registered = await call('/api/auth/register', { username: 'flowuser', password: 'flow password 8', inviteCode: 'flow-invite' });
    ok('邀请码注册成功', registered.status === 201);
    const cookie = cookieOf(registered);
    ok('拿到会话 Cookie', /^slz_session=/.test(cookie));
    const adminTry = await call('/api/admin/overview', undefined, { cookie });
    ok('普通用户访问管理概况被拒（403）', adminTry.status === 403);

    // ---- 题库静态配套（对发布包 manifest 逐一核对） ----
    const entry = f => MANIFEST.saved.find(s => s.file === f);
    const home = await fetch(origin + '/');
    ok('首页与发布包逐字节一致', home.status === 200 && sha256(Buffer.from(await home.arrayBuffer())) === entry('index.html').sha256);
    const appjs = await fetch(origin + '/js/app.js');
    ok('app.js 与发布包逐字节一致', appjs.status === 200 && sha256(Buffer.from(await appjs.arrayBuffer())) === entry('js/app.js').sha256);

    const indexJs = await (await fetch(origin + '/js/vendor/papers-index.js')).text();
    const papers = JSON.parse(indexJs.match(/window\.PapersFullIndex = (\{[\s\S]*\});\s*$/)[1]);
    const ids = Object.keys(papers);
    ok('全量索引卷数与 manifest 一致（' + ids.length + ' 套）', ids.length === MANIFEST.papers.indexed);
    const consId = ids.find(id => papers[id].cons);
    const apId = ids.find(id => papers[id].ap);
    assert.ok(consId && apId, '索引中应同时存在共识锚点卷与采分点卷');

    const paperRes = await fetch(origin + '/js/vendor/papers/' + consId + '.json');
    const paper = JSON.parse(await paperRes.text());
    ok('逐卷 JSON 与发布包一致且材料非空', paperRes.status === 200
      && sha256(Buffer.from(await (await fetch(origin + '/js/vendor/papers/' + consId + '.json')).arrayBuffer())) === entry('js/vendor/papers/' + consId + '.json').sha256
      && paper.questions.length > 0 && (paper.materials || []).some(m => (m.content || m.text || '').length > 0));

    const cons = await (await fetch(origin + '/js/vendor/consensus-points/' + consId + '.json')).json();
    ok('共识锚点文件可读且有题目', cons.questions && cons.questions.length > 0);
    const ap = await (await fetch(origin + '/js/vendor/answer-points/' + apId + '.json')).json();
    ok('参考答案采分点文件可读且有题目', ap.questions && ap.questions.length > 0);

    const bundleRaw = Buffer.from(await (await fetch(origin + '/js/vendor/papers-bundle.json.gz')).arrayBuffer());
    const bundle = JSON.parse(zlib.gunzipSync(bundleRaw).toString('utf8'));
    ok('gzip 整包与发布包一致且卷数=索引卷数', sha256(bundleRaw) === entry('js/vendor/papers-bundle.json.gz').sha256
      && Object.keys(bundle).length === ids.length);

    // ---- /api/chat：非流式（ping 契约 + 共享配置密钥优先） ----
    const ping = await call('/api/chat', { messages: [{ role: 'user', content: '#PING' }], stream: false, ping: true }, { cookie });
    const pingJson = await ping.json();
    ok('非流式假上游返回内容', ping.status === 200 && /MOCK 非流式回复/.test(pingJson.choices[0].message.content));
    ok('使用共享配置密钥（Bearer 共享 Key 而非环境变量）', lastUpstream().auth === 'Bearer ' + SHARED_KEY);
    ok('共享模式模型为 glm-5.3-flash', lastUpstream().body.model === 'glm-5.3-flash');
    ok('ping 压缩为 max_tokens 8', lastUpstream().body.max_tokens === 8);
    ok('glm-5.3-flash 默认 thinking enabled + temperature 1', lastUpstream().body.thinking && lastUpstream().body.thinking.type === 'enabled' && lastUpstream().body.temperature === 1);

    // ---- SSE 流式透传 ----
    const streamRes = await call('/api/chat', { messages: [{ role: 'user', content: '#STREAM 你好' }] }, { cookie });
    ok('流式响应 Content-Type 为 event-stream', /text\/event-stream/.test(streamRes.headers.get('content-type') || ''));
    const streamText = await streamRes.text();
    const dataLines = streamText.split('\n').filter(l => l.startsWith('data: '));
    ok('SSE 分段透传并以 [DONE] 收尾', dataLines.length >= 3 && dataLines[dataLines.length - 1] === 'data: [DONE]'
      && streamText.includes('第一段') && streamText.includes('第二段'));

    // ---- 慢速流渐进（未被整段缓冲） ----
    const slowRes = await call('/api/chat', { messages: [{ role: 'user', content: '#SLOW' }] }, { cookie });
    const arrivals = [];
    const reader = slowRes.body.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      arrivals.push(Date.now());
    }
    ok('慢速流渐进到达（首末分片间隔 ≥ 400ms）', arrivals.length >= 3 && arrivals[arrivals.length - 1] - arrivals[0] >= 400);

    // ---- 客户端取消：上游连接必须被销毁 ----
    const ac = new AbortController();
    const hangRes = await call('/api/chat', { messages: [{ role: 'user', content: '#HANG' }] }, { cookie, signal: ac.signal });
    const hangReader = hangRes.body.getReader();
    await hangReader.read();           // 读到第一段后取消
    const closesBefore = upstreamCloses;
    ac.abort();
    await assert.rejects(() => hangReader.read(), err => err && (err.name === 'AbortError' || err instanceof TypeError));
    let closed = false;
    for (let i = 0; i < 30 && !closed; i++) {
      await new Promise(r => setTimeout(r, 100));
      closed = upstreamCloses > closesBefore;
    }
    ok('取消后上游连接被销毁（3 秒内）', closed);

    // ---- 上游错误中文映射 ----
    const fail401 = await call('/api/chat', { messages: [{ role: 'user', content: '#FAIL401' }] }, { cookie });
    const fail401Body = await fail401.json();
    ok('上游 401 → 状态透传 + 中文密钥提示', fail401.status === 401 && /密钥无效或已过期/.test(fail401Body.error));
    const failVision = await call('/api/chat', {
      vision: true,
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } }, { type: 'text', text: '#FAILVISION 转录' }] }]
    }, { cookie });
    const failVisionBody = await failVision.json();
    ok('视觉 400 → 专属中文提示（配置视觉模型）', failVision.status === 400 && /不支持图片输入|视觉模型/.test(failVisionBody.error));

    // ---- 陪练请求契约（system 首消息 + 流式） ----
    await call('/api/chat', {
      messages: [
        { role: 'system', content: '你是申论陪练老师，请针对学生作答给出点评与追问。' },
        { role: 'user', content: '请点评我的归纳概括题作答。' }
      ]
    }, { cookie });
    const coach = lastUpstream();
    ok('陪练契约：system 首消息原文往返且流式转发', coach.body.messages.length === 2
      && coach.body.messages[0].role === 'system'
      && coach.body.messages[0].content === '你是申论陪练老师，请针对学生作答给出点评与追问。'
      && coach.body.stream === true);

    // ---- 图片识别消息契约（image_url 数组原样转发） ----
    await call('/api/chat', {
      vision: true, stream: false,
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,/9j/4AAQ' } }, { type: 'text', text: '只转录图片中的手写作答，不要批改。' }] }]
    }, { cookie });
    const vision = lastUpstream();
    const visionContent = vision.body.messages[0].content;
    ok('视觉契约：image_url 内容数组原样转发且模型不变', Array.isArray(visionContent)
      && vision.body.messages.length === 1
      && visionContent.length === 2
      && visionContent[0].type === 'image_url' && visionContent[0].image_url.url === 'data:image/jpeg;base64,/9j/4AAQ'
      && visionContent[1].type === 'text' && visionContent[1].text === '只转录图片中的手写作答，不要批改。'
      && vision.body.model === 'glm-5.3-flash');

    // ---- 登出 ----
    await call('/api/auth/logout', {}, { cookie });
    const afterLogout = await call('/api/chat', { messages: [{ role: 'user', content: '再试' }] }, { cookie });
    ok('登出后 chat 被拒（401）', afterLogout.status === 401);

    console.log('\n[key-flows] 结果：通过 ' + passed + ' 项，失败 0 项。（假模型上游，零额度消耗；静态资源为发布包字节）');
  } finally {
    if (child.exitCode === null) { child.kill(); await once(child, 'exit'); }
    await new Promise(r => upstream.close(r));
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

main().catch(err => { console.error(err); process.exitCode = 1; });
