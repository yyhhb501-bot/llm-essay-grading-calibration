#!/usr/bin/env node
/**
 * site-server.js —— 本地开发服务器（纯 Node 零依赖，方案-网站.md §1 / §6.2）
 *
 * 一个进程干两件事，与 worker/worker.js 保持**完全一致的契约**：
 *   1. 静态托管 site/ 目录（/ → index.html，哈希路由不经过服务器）；
 *   2. POST /api/chat：校验访问口令 → 按模式选密钥 → 调 OpenAI 兼容接口 → SSE 原样透传；
 *      请求体里的 temperature / thinking / max_tokens 按原样透传给上游（未传时用本地默认），
 *      共识锚点判定等窄任务靠它拿到低温、关思考的确定性输出；
 *      GET /api/health 返回 {ok:true}。
 *
 * 环境变量：
 *   PORT            监听端口，默认 8787
 *   HOST            监听地址，默认 127.0.0.1
 *   ACCESS_CODE     访问口令；不设则不校验（仅本地调试用）
 *   ZHIPU_API_KEY   服务端模式的智谱密钥
 *   ZHIPU_BASE_URL  上游地址覆盖，默认 https://open.bigmodel.cn/api/paas/v4
 *                   （本地联调、tools/test-site.js 打桩测试都靠它）
 *
 * 运行：node site-server.js
 */

'use strict';

var http = require('http');
var fs = require('fs');
var path = require('path');
var stream = require('stream');
var crypto = require('crypto');

var ROOT = __dirname;
var SITE_DIR = path.join(ROOT, 'site');

var PORT = Number(process.env.PORT || 8787);
var HOST = String(process.env.HOST || '0.0.0.0');
var ACCESS_CODE = String(process.env.ACCESS_CODE || '').trim();
var ZHIPU_API_KEY = String(process.env.ZHIPU_API_KEY || '').trim();
var DEFAULT_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4';
var DEFAULT_MODEL = 'glm-4-flash';
var SHARED_FILE = process.env.SLZ_SHARED_CONFIG_FILE || path.join(ROOT, '.runtime', 'shared-model.json');
var sharedConfig = null;
try { sharedConfig = JSON.parse(fs.readFileSync(SHARED_FILE, 'utf8')); } catch (e) {}

function isLocalAdmin(req) {
  var remote = req.socket.remoteAddress;
  var host = String(req.headers.host || '');
  var origin = String(req.headers.origin || '');
  return (remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1') &&
    /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host) &&
    origin === 'http://' + host && !req.headers['cf-connecting-ip'] && !req.headers['x-forwarded-for'];
}

async function configureSharedModel(req, res) {
  if (!isLocalAdmin(req)) { sendJson(res, 403, { error: '只能在本机页面配置共享模型。' }); return; }
  var body = JSON.parse(await readBody(req));
  var key = String(body.apiKey || '').trim();
  if (!key || key.length > 1024) { sendJson(res, 400, { error: '请先填写有效的智谱 API Key。' }); return; }
  var next = {
    apiKey: key,
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-5.3-flash',
    accessCode: sharedConfig && sharedConfig.accessCode || crypto.randomBytes(8).toString('hex')
  };
  fs.mkdirSync(path.dirname(SHARED_FILE), { recursive: true });
  fs.writeFileSync(SHARED_FILE, JSON.stringify(next), { mode: 0o600 });
  sharedConfig = next;
  sendJson(res, 200, { ok: true, model: next.model, accessCode: next.accessCode });
}

/** 常见静态资源的 Content-Type；其余按后缀兜底 */
var MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8'
};

// ---------------------------------------------------------------- 静态资源

/** 取文件扩展名对应的 Content-Type */
function contentType(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

/**
 * 把 URL 路径安全地映射到 site/ 下的真实文件。
 * 目录回退到 index.html；越界（..）一律拒绝。
 * @param {string} urlPath
 * @returns {string|null} 真实路径，取不到返回 null
 */
function resolveStatic(urlPath) {
  var clean;
  try {
    clean = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  } catch (e) {
    return null;
  }
  if (clean === '/' || clean === '') clean = '/index.html';
  var target = path.normalize(path.join(SITE_DIR, clean));
  // 必须仍在 site/ 之内
  if (target !== SITE_DIR && target.indexOf(SITE_DIR + path.sep) !== 0) return null;
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
    target = path.join(target, 'index.html');
  }
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return null;
  return target;
}

/** 处理静态资源请求 */
function serveStatic(req, res) {
  var file = resolveStatic(req.url || '/');
  if (!file) {
    sendJson(res, 404, { error: '页面不存在：' + req.url });
    return;
  }
  var head = { 'Content-Type': contentType(file) };
  if (/\.(png|jpe?g|gif|svg|ico)$/i.test(file)) head['Cache-Control'] = 'public, max-age=86400';
  res.writeHead(200, head);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  var pipe = fs.createReadStream(file);
  pipe.on('error', function () {
    res.end();
  });
  pipe.pipe(res);
}

// ---------------------------------------------------------------- /api 公共

/** 组装 JSON 响应（与 Worker 一致：UTF-8 + 不缓存） */
function sendJson(res, status, obj) {
  var body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

/** 读取请求体，限制 24MB（拍照识别的 base64 图片较大，但不至于超） */
function readBody(req, limit) {
  return new Promise(function (resolve, reject) {
    var chunks = [];
    var size = 0;
    var max = limit || 24 * 1024 * 1024;
    req.on('data', function (c) {
      size += c.length;
      if (size > max) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', function () {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------- /api/chat

/** 访问口令校验：正确返回 null，不正确返回中文说明 */
function checkAccessCode(req) {
  var expected = sharedConfig ? sharedConfig.accessCode : ACCESS_CODE;
  if (!expected) return null;
  var got = String(req.headers['x-access-code'] || '').trim();
  if (got !== expected) return '访问口令不正确，请向站主要一下口令后，在设置页重新填写。';
  return null;
}

/** 从上游错误体里尽力抠出厂商原话 */
function pickServerMessage(text) {
  var raw = text == null ? '' : String(text);
  if (!raw) return '';
  try {
    var obj = JSON.parse(raw);
    if (obj && obj.error) {
      var e = obj.error;
      if (typeof e === 'string') return e;
      if (e && typeof e === 'object') return e.message || e.code || '';
    }
    if (obj && typeof obj === 'object') return '';
  } catch (e) {
    // 不是 JSON，原样截一段
  }
  return raw.slice(0, 200);
}

/** 上游非 200 → 中文错误（措辞与 Worker 一致） */
function describeUpstreamError(status, serverMsg) {
  var text;
  if (status === 401) {
    text = '密钥无效或已过期（HTTP 401），请检查 ZHIPU_API_KEY 或自带模式里的 API Key。';
  } else if (status === 403) {
    text = '访问被拒绝（HTTP 403），可能是额度不足或该模型无权限。';
  } else if (status === 429) {
    text = '请求过于频繁或额度已用尽（HTTP 429），请稍后重试或更换模型。';
  } else if (status === 404) {
    text = '接口地址不存在（HTTP 404），请检查 baseURL 是否填到 /v1 一级。';
  } else if (status >= 400 && status < 500) {
    text = '请求被拒绝（HTTP ' + status + '），请检查地址、密钥与模型名是否正确。';
  } else {
    text = '服务异常（HTTP ' + status + '），请稍后重试。';
  }
  if (serverMsg) text += ' 厂商提示：' + serverMsg;
  return text;
}

/**
 * POST /api/chat
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 */
async function handleChat(req, res) {
  var codeError = checkAccessCode(req);
  if (codeError) {
    sendJson(res, 401, { error: codeError });
    return;
  }

  var raw;
  try {
    raw = await readBody(req);
  } catch (e) {
    sendJson(res, 400, { error: '读取请求体失败：' + ((e && e.message) || '未知错误') });
    return;
  }
  var body;
  try {
    body = JSON.parse(raw);
  } catch (e) {
    sendJson(res, 400, { error: '请求体不是合法 JSON。' });
    return;
  }
  if (!body || !Array.isArray(body.messages) || !body.messages.length) {
    sendJson(res, 400, { error: '请求体里没有 messages，请刷新页面重试。' });
    return;
  }

  var ownKey = String(body.apiKey || '').trim();
  var apiKey = ownKey;
  var baseURL;
  if (apiKey) {
    baseURL = String(body.baseURL || '').trim() || DEFAULT_BASE_URL;
  } else {
    apiKey = sharedConfig ? sharedConfig.apiKey : ZHIPU_API_KEY;
    baseURL = sharedConfig ? sharedConfig.baseURL : String(process.env.ZHIPU_BASE_URL || DEFAULT_BASE_URL).trim();
  }
  if (!apiKey) {
    sendJson(res, 500, { error: '服务端还没有配置模型密钥：请设置环境变量 ZHIPU_API_KEY，或改用自带 Key 模式。' });
    return;
  }
  baseURL = baseURL.replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(baseURL)) {
    sendJson(res, 400, { error: '模型地址格式不对，应以 https:// 开头。' });
    return;
  }

  var defaultModel = body.vision ? 'glm-4v-flash' : DEFAULT_MODEL;
  var model = !ownKey && sharedConfig ? sharedConfig.model : String(body.model || '').trim() || defaultModel;
  var useStream = body.stream !== false;
  // 客户端显式传的参数优先（共识锚点判定要 thinking:disabled + 低温度），未传时维持原有默认
  var upstreamBody = {
    model: model,
    messages: body.messages,
    stream: useStream,
    temperature: body.temperature === undefined ? 0.3 : body.temperature
  };
  if (model === 'glm-5.3-flash') {
    upstreamBody.thinking = body.thinking === undefined ? { type: 'enabled' } : body.thinking;
    if (body.temperature === undefined) upstreamBody.temperature = 1;
  }
  if (body.ping) upstreamBody.max_tokens = 8;
  else if (Number(body.max_tokens) > 0) upstreamBody.max_tokens = Number(body.max_tokens);

  var upstream;
  try {
    upstream = await fetch(baseURL + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + apiKey
      },
      body: JSON.stringify(upstreamBody)
    });
  } catch (e) {
    sendJson(res, 502, { error: '连不上模型厂商：' + ((e && e.message) || '网络异常') + '，请稍后重试。' });
    return;
  }

  if (upstream.status !== 200) {
    var text = await upstream.text().catch(function () { return ''; });
    var serverMsg = pickServerMessage(text);
    var error = describeUpstreamError(upstream.status, serverMsg);
    if (upstream.status === 400 && body.vision && /image|content|vision|图片|视觉/i.test(serverMsg)) {
      error = '当前模型可能不支持图片输入，请到设置页配置视觉模型。 厂商提示：' + serverMsg;
    }
    sendJson(res, upstream.status, { error: error });
    return;
  }

  if (useStream && upstream.body) {
    // SSE 原样透传：分块直接写给浏览器，不做任何缓冲
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    var readable = stream.Readable.fromWeb(upstream.body);
    readable.on('error', function () {
      res.end();
    });
    res.on('close', function () {
      try {
        readable.destroy();
      } catch (e) { /* 已结束 */ }
    });
    readable.pipe(res);
    return;
  }

  var okText = await upstream.text();
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(okText),
    'Cache-Control': 'no-store'
  });
  res.end(okText);
}

// ---------------------------------------------------------------- 服务器

var server = http.createServer(function (req, res) {
  var pathname = String(req.url || '/').split('?')[0];

  if (pathname === '/api/admin/shared-model') {
    if (req.method !== 'POST') { sendJson(res, 405, { error: '只支持 POST。' }); return; }
    configureSharedModel(req, res).catch(function () { sendJson(res, 400, { error: '共享配置未保存，请重试。' }); });
    return;
  }

  if (pathname === '/api/health') {
    sendJson(res, 200, { ok: true, officialModel: sharedConfig ? sharedConfig.model : DEFAULT_MODEL, sharedReady: !!sharedConfig });
    return;
  }
  if (pathname === '/api/chat') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: '请求方法不对，/api/chat 只接受 POST。' });
      return;
    }
    handleChat(req, res).catch(function (err) {
      if (!res.headersSent) sendJson(res, 500, { error: '服务器内部错误：' + ((err && err.message) || '未知错误') });
      else res.end();
    });
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { error: '静态资源只接受 GET / HEAD。' });
    return;
  }
  serveStatic(req, res);
});

server.listen(PORT, function () {
  console.log('[site-server] 申论朱批网站版已启动');
  console.log('  本地地址   http://127.0.0.1:' + PORT + '/');
  console.log('  静态目录   ' + SITE_DIR);
  console.log('  访问口令   ' + (ACCESS_CODE ? '已设置' : '未设置（不校验，仅限本地调试）'));
  console.log('  模型密钥   ' + (ZHIPU_API_KEY ? '已设置' : '未设置（可用自带 Key 模式）'));
  console.log('  上游地址   ' + (process.env.ZHIPU_BASE_URL || DEFAULT_BASE_URL));
});

process.on('SIGINT', function () {
  console.log('\n[site-server] 已停止');
  server.close(function () {
    process.exit(0);
  });
});

module.exports = server;
