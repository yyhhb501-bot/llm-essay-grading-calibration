#!/usr/bin/env node
/**
 * tools/test-site.js —— 网站版契约自测（方案-网站.md §6.2）
 *
 * 做四件事：
 *   1. 起一个「假上游」（本地打桩的 OpenAI 兼容接口），用来验证转发与错误中文化；
 *   2. 以子进程方式起 site-server.js（用独立端口，不打扰你正在跑的 8787）；
 *   3. 逐条断言：GET / 200 且含「申论朱批」；GET /api/health 返回 ok；
 *      POST /api/chat 无口令 → 401 JSON；带口令 + 假上游 → 拿到中文错误；
 *   4. 全部通过 exit 0，任一失败 exit 1 并打印失败原因。
 *
 * 运行：node tools/test-site.js
 */

'use strict';

var http = require('http');
var path = require('path');
var child = require('child_process');

var ROOT = path.resolve(__dirname, '..');
var SITE_PORT = Number(process.env.SLZ_TEST_PORT || 8799);
const ACCESS = 'test-access-code';
const FAKE_API_KEY = 'fake-api-key-for-test';
var sessionCookie = '';

/** 极简断言器 */
var passed = 0;
var failed = 0;

function ok(name, extra) {
  passed++;
  console.log('  通过  ' + name + (extra ? '  →  ' + extra : ''));
}

function fail(name, reason) {
  failed++;
  console.log('  失败  ' + name + '  →  ' + reason);
}

function check(name, condition, reason, extra) {
  if (condition) ok(name, extra);
  else fail(name, reason);
  return !!condition;
}

/** 发一个 HTTP 请求，返回 {status, headers, body} */
function request(port, method, urlPath, options) {
  var opts = options || {};
  return new Promise(function (resolve, reject) {
    var req = http.request({
      host: '127.0.0.1',
      port: port,
      method: method,
      path: urlPath,
      headers: Object.assign({}, method === 'POST' ? { Origin: 'http://127.0.0.1:' + port } : {},
        sessionCookie && !opts.noAuth ? { Cookie: sessionCookie } : {}, opts.headers || {})
    }, function (res) {
      var chunks = [];
      res.on('data', function (c) {
        chunks.push(c);
      });
      res.on('end', function () {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8')
        });
      });
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

/** 轮询等待端口就绪 */
function waitForPort(port, timeoutMs) {
  var deadline = Date.now() + (timeoutMs || 15000);
  return new Promise(function (resolve, reject) {
    (function tick() {
      var s = require('net').connect(port, '127.0.0.1');
      s.on('connect', function () {
        s.destroy();
        resolve(true);
      });
      s.on('error', function () {
        s.destroy();
        if (Date.now() > deadline) reject(new Error('等待 ' + port + ' 端口超时'));
        else setTimeout(tick, 200);
      });
    })();
  });
}

/** 假上游：模拟 OpenAI 兼容接口，返回 401 并带一段英文错误，用来验证中文化 */
function startFakeUpstream(port) {
  return new Promise(function (resolve) {
    var srv = http.createServer(function (req, res) {
      var chunks = [];
      req.on('data', function (c) {
        chunks.push(c);
      });
      req.on('end', function () {
        var payload = {};
        try {
          payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch (e) { /* 忽略 */ }
        // 自带 Key 模式打桩：正常返回一个极小的非流式答案，并回显上游收到的请求体供透传断言
        if (payload && payload.stream === false) {
          var ok = JSON.stringify({
            choices: [{ message: { content: '连接成功' } }],
            _echo: payload
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(ok);
          return;
        }
        var body = JSON.stringify({ error: { message: 'Invalid API key provided' } });
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(body);
      });
    });
    srv.listen(port, '127.0.0.1', function () {
      resolve(srv);
    });
  });
}

async function main() {
  var upstreamPort = SITE_PORT + 1;
  console.log('[test-site] 1/4 起假上游（127.0.0.1:' + upstreamPort + '）');
  var upstream = await startFakeUpstream(upstreamPort);

  console.log('[test-site] 2/4 起 site-server.js（127.0.0.1:' + SITE_PORT + '）');
  var childEnv = Object.assign({}, process.env, {
    SLZ_SHARED_CONFIG_FILE: path.join(require('os').tmpdir(), 'slz-test-shared-' + process.pid + '.json'),
    PORT: String(SITE_PORT),
    HOST: '127.0.0.1',
    ACCESS_CODE: ACCESS,
    REGISTER_INVITE_CODE: ACCESS,
    SLZ_AUTH_DB_FILE: path.join(require('os').tmpdir(), 'slz-test-accounts-' + process.pid + '.sqlite'),
    TRUST_PROXY: '0',
    ZHIPU_API_KEY: FAKE_API_KEY,
    ZHIPU_BASE_URL: 'http://127.0.0.1:' + upstreamPort + '/v1'
  });
  var serverProc = child.spawn(process.execPath, [path.join(ROOT, 'site-server.js')], {
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  var serverLog = '';
  serverProc.stdout.on('data', function (d) { serverLog += d.toString(); });
  serverProc.stderr.on('data', function (d) { serverLog += d.toString(); });

  function cleanup() {
    try {
      if (serverProc && !serverProc.killed) serverProc.kill();
    } catch (e) { /* 忽略 */ }
    try {
      upstream.close();
    } catch (e) { /* 忽略 */ }
  }

  try {
    await waitForPort(SITE_PORT, 15000);
  } catch (e) {
    fail('site-server 启动', '没能监听 ' + SITE_PORT + ' 端口：' + serverLog);
    cleanup();
    process.exit(1);
    return;
  }

  console.log('[test-site] 3/4 跑契约断言');

  // ---- 3.1 静态首页 ----
  var home = await request(SITE_PORT, 'GET', '/');
  check(
    'GET / 返回 200 且含「申论」或「批改」',
    home.status === 200 && (home.body.indexOf('申论') !== -1 || home.body.indexOf('批改') !== -1),
    'status=' + home.status + '，正文里没有找到「申论」或「批改」',
    'status=' + home.status
  );

  // ---- 3.1b 覆盖率模块：首页引入了 vendor，静态文件可取到 ----
  check(
    '首页引入 js/vendor/coverage.js',
    home.body.indexOf('js/vendor/coverage.js') !== -1,
    '首页没有 coverage.js 的 script 标签'
  );
  var coverageJs = await request(SITE_PORT, 'GET', '/js/vendor/coverage.js');
  check(
    'GET /js/vendor/coverage.js 返回 200 且含 CoverageScore 导出',
    coverageJs.status === 200 && coverageJs.body.indexOf('CoverageScore') !== -1 &&
      coverageJs.body.indexOf('parseHits') !== -1 && coverageJs.body.indexOf('renderAnchorBlock') !== -1,
    'status=' + coverageJs.status,
    'status=' + coverageJs.status + ' bytes=' + coverageJs.body.length
  );

  // ---- 3.2 健康检查 ----
  var health = await request(SITE_PORT, 'GET', '/api/health');
  var healthJson = null;
  try {
    healthJson = JSON.parse(health.body);
  } catch (e) { /* 保持 null */ }
  check(
    'GET /api/health 返回 {ok:true}',
    health.status === 200 && healthJson && healthJson.ok === true,
    'status=' + health.status + ' body=' + health.body,
    health.body
  );

  // ---- 3.3 无口令的 /api/chat → 401 JSON ----
  var noCode = await request(SITE_PORT, 'POST', '/api/chat', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: '你好' }], stream: false })
  });
  var noCodeJson = null;
  try {
    noCodeJson = JSON.parse(noCode.body);
  } catch (e) { /* 保持 null */ }
  check(
    'POST /api/chat 未登录返回 401 JSON',
    noCode.status === 401 && !!noCodeJson && typeof noCodeJson.error === 'string' &&
      noCodeJson.error.indexOf('登录') !== -1,
    'status=' + noCode.status + ' body=' + noCode.body,
    'status=' + noCode.status + ' error=' + (noCodeJson && noCodeJson.error)
  );

  var registration = await request(SITE_PORT, 'POST', '/api/auth/register', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'site-test-user', password: 'site-test-password', inviteCode: ACCESS })
  });
  check('邀请注册并获取真实会话 Cookie', registration.status === 201 && !!registration.headers['set-cookie'], 'status=' + registration.status);
  sessionCookie = ((registration.headers['set-cookie'] || [])[0] || '').split(';')[0];

  // ---- 3.4 登录 + 假上游 → 中文错误 ----
  var withCode = await request(SITE_PORT, 'POST', '/api/chat', {
    headers: {
      'Content-Type': 'application/json',
      'X-Access-Code': ACCESS
    },
    body: JSON.stringify({
      messages: [{ role: 'user', content: '你好' }],
      stream: true,
      model: 'glm-4-flash'
    })
  });
  var withCodeJson = null;
  try {
    withCodeJson = JSON.parse(withCode.body);
  } catch (e) { /* 保持 null */ }
  var errorText = withCodeJson && withCodeJson.error ? String(withCodeJson.error) : '';
  check(
    '已登录 + 假上游时拿到中文错误（上游 401 → 密钥无效）',
    withCode.status === 401 && errorText.indexOf('密钥') !== -1 && errorText.indexOf('Invalid API key') !== -1,
    'status=' + withCode.status + ' body=' + withCode.body,
    'error=' + errorText
  );

  // ---- 3.5 自带 Key 模式的非流式降级通路也通（顺带验证纯转发没坏）----
  var selfKey = await request(SITE_PORT, 'POST', '/api/chat', {
    headers: {
      'Content-Type': 'application/json',
      'X-Access-Code': ACCESS
    },
    body: JSON.stringify({
      messages: [{ role: 'user', content: '你好' }],
      stream: false,
      apiKey: 'own-key',
      model: 'glm-4-flash', // Explicit non-thinking fixture; shared default is GLM-5.3.
      baseURL: 'http://127.0.0.1:' + upstreamPort + '/v1'
    })
  });
  var selfKeyJson = null;
  try {
    selfKeyJson = JSON.parse(selfKey.body);
  } catch (e) { /* 保持 null */ }
  check(
    '自带 Key 模式纯转发：非流式返回 200 与模型内容',
    selfKey.status === 200 && selfKeyJson &&
      selfKeyJson.choices && selfKeyJson.choices[0].message.content === '连接成功',
    'status=' + selfKey.status + ' body=' + selfKey.body,
    selfKeyJson && selfKeyJson.choices ? selfKeyJson.choices[0].message.content : ''
  );
  check(
    '未显式传参时转发层用默认调温（temperature 0.3，不带 thinking/max_tokens）',
    selfKeyJson && selfKeyJson._echo && selfKeyJson._echo.temperature === 0.3 &&
      selfKeyJson._echo.thinking === undefined && selfKeyJson._echo.max_tokens === undefined,
    'echo=' + JSON.stringify(selfKeyJson && selfKeyJson._echo),
    'temperature=' + (selfKeyJson && selfKeyJson._echo ? selfKeyJson._echo.temperature : '')
  );

  // ---- 3.6 显式 temperature / thinking / max_tokens 透传（共识锚点判定依赖）----
  var passthrough = await request(SITE_PORT, 'POST', '/api/chat', {
    headers: {
      'Content-Type': 'application/json',
      'X-Access-Code': ACCESS
    },
    body: JSON.stringify({
      messages: [{ role: 'user', content: '判定要点' }],
      stream: false,
      apiKey: 'own-key',
      baseURL: 'http://127.0.0.1:' + upstreamPort + '/v1',
      model: 'glm-5.3-flash',
      temperature: 0.1,
      thinking: { type: 'disabled' },
      max_tokens: 16
    })
  });
  var passthroughJson = null;
  try {
    passthroughJson = JSON.parse(passthrough.body);
  } catch (e) { /* 保持 null */ }
  check(
    'GLM 不支持关闭思考：兼容为 enabled/low，保留温度和输出上限',
    passthrough.status === 200 && passthroughJson && passthroughJson._echo &&
      passthroughJson._echo.temperature === 0.1 &&
      passthroughJson._echo.thinking && passthroughJson._echo.thinking.type === 'enabled' &&
      passthroughJson._echo.reasoning_effort === 'low' &&
      passthroughJson._echo.max_tokens === 16,
    'status=' + passthrough.status + ' echo=' + JSON.stringify(passthroughJson && passthroughJson._echo),
    'echo=' + JSON.stringify(passthroughJson && passthroughJson._echo)
  );

  var rejectedAdmin = await request(SITE_PORT, 'POST', '/api/admin/shared-model', {
    headers: { 'Content-Type': 'application/json', Origin: 'https://someone.example' },
    body: JSON.stringify({ apiKey: 'dummy-test-key' })
  });
  check('外部来源无法修改共享密钥', rejectedAdmin.status === 403, 'status=' + rejectedAdmin.status);
  var acceptedAdmin = await request(SITE_PORT, 'POST', '/api/admin/shared-model', {
    headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:' + SITE_PORT },
    body: JSON.stringify({ apiKey: 'dummy-test-key' })
  });
  var acceptedInfo = JSON.parse(acceptedAdmin.body);
  check('本机可配置官方模型且响应不返回密钥', acceptedAdmin.status === 200 && acceptedInfo.model === 'glm-5.3-flash' && !acceptedInfo.apiKey, 'status=' + acceptedAdmin.status);
  var sharedUnauthorized = await request(SITE_PORT, 'POST', '/api/chat', {
    noAuth: true,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'test' }] })
  });
  check('共享模式拒绝未登录请求', sharedUnauthorized.status === 401, 'status=' + sharedUnauthorized.status);
  var privateFile = await request(SITE_PORT, 'GET', '/.runtime/shared-model.json');
  check('密钥配置不通过静态网站提供', privateFile.status === 404, 'status=' + privateFile.status);
  require('fs').unlinkSync(childEnv.SLZ_SHARED_CONFIG_FILE);

  console.log('[test-site] 4/4 收尾');

  cleanup();

  console.log('');
  console.log('[test-site] 结果：通过 ' + passed + ' 项，失败 ' + failed + ' 项。');
  if (failed > 0) process.exit(1);
  process.exit(0);
}

main().catch(function (err) {
  console.error('[test-site] 自测脚本异常：', err);
  process.exit(1);
});
