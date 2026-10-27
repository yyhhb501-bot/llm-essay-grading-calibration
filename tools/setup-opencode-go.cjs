'use strict';
// A loopback-only key entry page. Validates against the real Go endpoint, then
// saves only to the ignored local runtime directory. Never changes cloud secrets.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const go = require('../server/opencode-go.cjs');
const root = path.resolve(__dirname, '..');
const nonce = crypto.randomBytes(24).toString('hex');
let origin, busy = false;
const resultFile = path.join(root, '.runtime/opencode-go-setup-result.json');
function reply(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(data));
}
const server = http.createServer(async (req, res) => {
  if (req.headers.host !== new URL(origin).host) return reply(res, 403, { message: '仅限本机访问。' });
  if (req.method === 'GET' && req.url === '/setup') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' });
    return res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OpenCode Go 本机配置</title><style>body{font:16px/1.7 system-ui;background:#f8f7f4;padding:24px;color:#222}main{max-width:550px;margin:6vh auto;background:white;padding:28px;border-radius:16px}input,button{box-sizing:border-box;width:100%;padding:13px;margin:12px 0;border:1px solid #ccc;border-radius:8px;font:inherit}button{background:#b03a2e;color:white;cursor:pointer}small{color:#666}#status{white-space:pre-wrap}</style><main><h2>设置 OpenCode Go · DeepSeek</h2><p>在这里粘贴 Go API Key，不要发送到聊天。提交后会向官方 API 发一次短请求，成功后仅保存在本机。</p><small>当前本机旧凭据返回 401，请从 OpenCode 控制台复制有效 Key。此操作不会发布网站或更新云端密钥。Go 官方主要面向编程代理，申论用途是否适用需向供应商确认；这里如实标识批改客户端。</small><form id="form"><input id="key" type="password" placeholder="OpenCode Go API Key" required autocomplete="off" aria-label="OpenCode Go API Key"><button id="submit">验证并保存到本机</button></form><p id="status" role="status"></p></main><script>document.getElementById('form').onsubmit=async function(e){e.preventDefault();const k=document.getElementById('key'),b=document.getElementById('submit'),s=document.getElementById('status');b.disabled=true;s.textContent='正在验证，可能需要约一分钟…';try{const r=await fetch('/configure',{method:'POST',headers:{'Content-Type':'application/json','X-Setup-Nonce':'${nonce}'},body:JSON.stringify({apiKey:k.value})});const d=await r.json();s.textContent=d.message;k.value='';if(d.ok)document.getElementById('form').hidden=true;}catch(_){s.textContent='连接失败，请回到对话查看状态。';}b.disabled=false;};</script></html>`);
  }
  if (req.method !== 'POST' || req.url !== '/configure') return reply(res, 404, { message: '页面不存在。' });
  if (req.headers.origin !== origin || req.headers['x-setup-nonce'] !== nonce) return reply(res, 403, { message: '请从本机配置页提交。' });
  if (busy) return reply(res, 409, { message: '正在验证，请等待本次请求结束。' });
  busy = true;
  try {
    let raw = '', oversized = false;
    for await (const chunk of req) { if (Buffer.byteLength(raw) + chunk.length > 4096) oversized = true; else if (!oversized) raw += chunk; }
    if (oversized) return reply(res, 413, { message: '提交内容过大。' });
    const key = String(JSON.parse(raw).apiKey || '').trim();
    if (key.length < 10 || key.length > 1024) return reply(res, 400, { message: '请填写有效的 Go API Key。' });
    const messages = [{ role: 'user', content: '请只回复：连接正常。' }];
    const response = await fetch(go.BASE_URL + '/chat/completions', {
      method: 'POST', headers: await go.headers(key, 'local-owner-setup', messages),
      body: JSON.stringify({ model: go.MODEL, messages, stream: false, max_tokens: 512 }), signal: AbortSignal.timeout(60000)
    });
    // Do not log provider responses: they might echo submitted credentials.
    if (!response.ok) { await response.body?.cancel(); return reply(res, response.status, { message: '验证失败（HTTP ' + response.status + '）。请检查 Key 是否有效、Go 订阅与模型权限。没有保存此 Key。' }); }
    const data = await response.json();
    if (!data.choices?.[0]?.message?.content) return reply(res, 502, { message: '模型未返回非空正文，本次未保存。请检查权限或稍后重试。' });
    fs.mkdirSync(path.join(root, '.runtime'), { recursive: true });
    fs.writeFileSync(path.join(root, '.runtime/opencode-go.json'), JSON.stringify({ apiKey: key, baseURL: go.BASE_URL, model: go.MODEL }), { mode: 0o600 });
    fs.writeFileSync(resultFile, JSON.stringify({ ok: true, model: go.MODEL, testedAt: new Date().toISOString(), deployed: false }, null, 2));
    reply(res, 200, { ok: true, message: 'DeepSeek 连接成功，已保存到本机。请回到对话，我会继续线上切换所需的验证；当前尚未发布网站。' });
  } catch (_) { reply(res, 502, { message: '验证超时或请求失败，本次未保存 Key。' }); }
  finally { busy = false; }
});
server.listen(0, '127.0.0.1', () => {
  origin = 'http://127.0.0.1:' + server.address().port;
  const url = origin + '/setup';
  fs.mkdirSync(path.join(root, '.runtime'), { recursive: true });
  fs.writeFileSync(path.join(root, '.runtime/opencode-go-setup-url.json'), JSON.stringify({ url, expiresAt: new Date(Date.now() + 20 * 60 * 1000).toISOString() }));
  console.log('本机 Go Key 配置页：' + url + '（20 分钟有效；不打印密钥）');
});
setTimeout(() => { server.close(); }, 20 * 60 * 1000).unref();
