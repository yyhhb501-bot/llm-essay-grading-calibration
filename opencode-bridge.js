'use strict';

/**
 * Narrow, loopback-only adapter between the public grading Worker and OpenCode.
 * This intentionally exposes no general OpenCode API and fixes the model and
 * agent so visitor content cannot invoke tools or choose another provider.
 */
var http = require('http');
var crypto = require('crypto');

var HOST = '127.0.0.1';
var PORT = Number(process.env.OPENCODE_BRIDGE_PORT || 8789);
var TOKEN = String(process.env.OPENCODE_BRIDGE_TOKEN || '');
var OPENCODE_URL = String(process.env.OPENCODE_SERVER_URL || 'http://127.0.0.1:4096').replace(/\/+$/, '');
var MAX_BODY = 1024 * 1024;
var MODEL = 'opencode-go/deepseek-v4.1-flash';
var PROVIDER_ID = 'opencode-go';
var MODEL_ID = 'deepseek-v4.1-flash';
var AGENT = 'essay-grader';

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

function safeEqual(a, b) {
  var left = Buffer.from(String(a));
  var right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function isLoopbackUrl(value) {
  try {
    var parsed = new URL(value);
    return parsed.protocol === 'http:' && /^(127\.0\.0\.1|localhost|\[::1\])$/.test(parsed.hostname);
  } catch (e) { return false; }
}

function readJson(req) {
  return new Promise(function (resolve, reject) {
    var chunks = [];
    var size = 0;
    req.on('data', function (chunk) {
      size += chunk.length;
      if (size > MAX_BODY) {
        chunks = [];
        if (!req._bridgeTooLarge) req._bridgeTooLarge = true;
      } else if (!req._bridgeTooLarge) {
        chunks.push(chunk);
      }
    });
    req.on('end', function () {
      if (req._bridgeTooLarge) {
        reject(Object.assign(new Error('请求内容过大，请缩短文本后重试。'), { status: 413 }));
        return;
      }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(Object.assign(new Error('请求体不是合法 JSON。'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function normalizeMessages(body) {
  if (body.vision) throw Object.assign(new Error('当前 OpenCode Go 接入只处理文本；拍照识别请改用支持视觉的模型。'), { status: 400 });
  if (!Array.isArray(body.messages) || !body.messages.length || body.messages.length > 30) {
    throw Object.assign(new Error('messages 格式不正确或消息数量过多。'), { status: 400 });
  }
  var system = [];
  var turns = [];
  var total = 0;
  body.messages.forEach(function (message) {
    if (!message || !/^(system|user|assistant)$/.test(message.role) || typeof message.content !== 'string') {
      throw Object.assign(new Error('暂不支持图片或多模态输入，请提交纯文本。'), { status: 400 });
    }
    total += message.content.length;
    if (total > 180000) throw Object.assign(new Error('输入文本过长，请缩短材料或作答后重试。'), { status: 413 });
    if (message.role === 'system') system.push(message.content);
    else turns.push((message.role === 'assistant' ? '【助手此前回复】\n' : '【用户】\n') + message.content);
  });
  if (!turns.length) throw Object.assign(new Error('缺少用户文本。'), { status: 400 });
  return { system: system.join('\n\n'), prompt: turns.join('\n\n') };
}

function openCodeHeaders() {
  var headers = { 'Content-Type': 'application/json' };
  var password = String(process.env.OPENCODE_SERVER_PASSWORD || '');
  if (password) {
    var username = String(process.env.OPENCODE_SERVER_USERNAME || 'opencode');
    headers.Authorization = 'Basic ' + Buffer.from(username + ':' + password).toString('base64');
  }
  return headers;
}

async function openCodeFetch(path, options) {
  var controller = new AbortController();
  var timer = setTimeout(function () { controller.abort(); }, 180000);
  try {
    var response = await fetch(OPENCODE_URL + path, Object.assign({
      headers: openCodeHeaders(), signal: controller.signal
    }, options || {}));
    return response;
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'OpenCode 响应超时，请稍后重试。' : '无法连接本机 OpenCode 服务。');
  } finally { clearTimeout(timer); }
}

async function complete(messages) {
  var normalized = normalizeMessages(messages);
  var created = await openCodeFetch('/api/session', { method: 'POST', body: JSON.stringify({
    title: '作文批改请求',
    agent: AGENT,
    model: { providerID: PROVIDER_ID, id: MODEL_ID },
    permissions: [{ action: '*', resource: '*', effect: 'deny' }]
  }) });
  if (!created.ok) throw new Error('OpenCode 创建会话失败（HTTP ' + created.status + '）。');
  var createdData = await created.json();
  var session = createdData && createdData.data;
  if (!session || !/^[A-Za-z0-9_-]{1,128}$/.test(String(session.id || ''))) throw new Error('OpenCode 返回了无效会话。');
  try {
    var prompt = [normalized.system, normalized.prompt].filter(Boolean).join('\n\n');
    var accepted = await openCodeFetch('/api/session/' + encodeURIComponent(session.id) + '/prompt', {
      method: 'POST',
      body: JSON.stringify({ text: prompt })
    });
    if (!accepted.ok) throw new Error('OpenCode 模型请求失败（HTTP ' + accepted.status + '）。');
    var deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      await new Promise(function (resolve) { setTimeout(resolve, 500); });
      var messagesRes = await openCodeFetch('/api/session/' + encodeURIComponent(session.id) + '/message');
      if (!messagesRes.ok) throw new Error('读取 OpenCode 回复失败（HTTP ' + messagesRes.status + '）。');
      var messagesData = await messagesRes.json();
      var list = messagesData && Array.isArray(messagesData.data) ? messagesData.data : [];
      var assistant = null;
      for (var i = list.length - 1; i >= 0; i--) {
        if (list[i] && list[i].type === 'assistant') { assistant = list[i]; break; }
      }
      if (assistant && assistant.finish) {
        if (assistant.finish === 'tool-calls') throw new Error('作文代理意外请求了工具，已中止本次批改。');
        if (assistant.finish === 'error') throw new Error('OpenCode 模型生成失败。');
        var text = (assistant.content || []).filter(function (part) { return part && part.type === 'text'; })
          .map(function (part) { return String(part.text || ''); }).join('');
        if (!text.trim()) throw new Error('OpenCode 没有返回可显示的文本。');
        return text;
      }
    }
    throw new Error('OpenCode 响应超时，请稍后重试。');
  } finally {
    await openCodeFetch('/api/session/' + encodeURIComponent(session.id), { method: 'DELETE' }).catch(function () {});
  }
}

async function readiness() {
  var health = await openCodeFetch('/api/info');
  if (!health.ok) throw new Error('本机 OpenCode 服务未就绪。');
  var info = await health.json();
  if (!info || !info.version) throw new Error('本机 OpenCode 服务未就绪。');
  var providersRes = await openCodeFetch('/api/provider');
  if (!providersRes.ok) throw new Error('无法读取本机 OpenCode 模型配置。');
  var providers = await providersRes.json();
  var connected = Array.isArray(providers.data) && providers.data.some(function (item) { return item && item.id === PROVIDER_ID; });
  if (!connected) throw new Error('OpenCode Go 尚未连接。');
  var modelsRes = await openCodeFetch('/api/model');
  if (!modelsRes.ok) throw new Error('无法读取本机 OpenCode 模型列表。');
  var models = await modelsRes.json();
  if (!models || !Array.isArray(models.data) || !models.data.some(function (model) {
    return model && model.providerID === PROVIDER_ID && model.id === MODEL_ID;
  })) throw new Error('DeepSeek V4.1 Flash 不在当前 OpenCode Go 模型列表中。');
  var agentsRes = await openCodeFetch('/api/agent');
  if (!agentsRes.ok) throw new Error('无法确认作文专用安全代理。');
  var agents = await agentsRes.json();
  if (!agents || !Array.isArray(agents.data) || !agents.data.some(function (agent) { return agent && agent.name === AGENT; })) {
    throw new Error('未加载 essay-grader 安全代理，请从项目目录启动 OpenCode。');
  }
  return { ok: true, provider: PROVIDER_ID, model: MODEL, agent: AGENT };
}

function sendCompletion(res, text, streaming) {
  var id = 'chatcmpl-opencode-' + crypto.randomBytes(8).toString('hex');
  var created = Math.floor(Date.now() / 1000);
  if (!streaming) {
    return json(res, 200, {
      id: id, object: 'chat.completion', created: created, model: MODEL,
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }]
    });
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write('data: ' + JSON.stringify({ id: id, object: 'chat.completion.chunk', created: created, model: MODEL,
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }) + '\n\n');
  res.write('data: ' + JSON.stringify({ id: id, object: 'chat.completion.chunk', created: created, model: MODEL,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n');
  res.end('data: [DONE]\n\n');
}

function createServer(options) {
  options = options || {};
  var token = String(options.token == null ? TOKEN : options.token);
  var completeFn = options.complete || complete;
  var readinessFn = options.readiness || readiness;
  return http.createServer(async function (req, res) {
    if (!token || !safeEqual(req.headers.authorization || '', 'Bearer ' + token)) return json(res, 401, { error: '桥接访问凭据无效。' });
    if (req.method === 'GET' && req.url === '/api/health') {
      try { return json(res, 200, await readinessFn()); }
      catch (e) { return json(res, 503, { ok: false, error: e.message || 'OpenCode 服务未就绪。' }); }
    }
    if (req.method !== 'POST' || req.url !== '/api/chat') return json(res, 404, { error: 'Not found' });
    try {
      var body = await readJson(req);
      normalizeMessages(body);
      if (body.ping) {
        var status = await readinessFn();
        return sendCompletion(res, status.model + ' 已在本机 OpenCode Go 中就绪。', false);
      }
      var text = await completeFn(body);
      return sendCompletion(res, text, body.stream !== false);
    } catch (e) {
      if (!res.headersSent) return json(res, e.status || 502, { error: e.message || 'OpenCode 本机桥接失败。' });
      res.end();
    }
  });
}

if (require.main === module) {
  if (!TOKEN) {
    process.stderr.write('请设置 OPENCODE_BRIDGE_TOKEN 后再启动；未监听任何端口。\n');
    process.exitCode = 1;
  } else if (!isLoopbackUrl(OPENCODE_URL)) {
    process.stderr.write('OPENCODE_SERVER_URL 必须指向本机回环地址。\n');
    process.exitCode = 1;
  } else {
    createServer().listen(PORT, HOST, function () {
      process.stdout.write('OpenCode 作文桥已启动在 http://' + HOST + ':' + PORT + '；固定模型：' + MODEL + '\n');
    });
  }
}

module.exports = { createServer: createServer, complete: complete, normalizeMessages: normalizeMessages, model: MODEL };
