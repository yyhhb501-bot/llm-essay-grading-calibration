'use strict';
// Local, short-lived password form. Never log/store plaintext credentials.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const ROOT = path.resolve(__dirname, '..');
const WRANGLER = 'C:/Users/展红/AppData/Local/npm-cache/_npx/32026684e21afda6/node_modules/wrangler/bin/wrangler.js';
const CONFIG = path.join(ROOT, '.agent/admin-release/wrangler.toml');
const ORIGIN = 'https://shenlundawang.asia';
const username = 'admin';
const nonce = crypto.randomBytes(24).toString('hex');
let localOrigin = '', busy = false, done = false;
const resultFile = path.join(ROOT, '.runtime/admin-setup-result.json');
const q = value => "'" + String(value).replace(/'/g, "''") + "'";
async function sql(command) {
  const { stdout } = await run(process.execPath, [WRANGLER, 'd1', 'execute', 'shenlun-accounts', '--remote', '--config', CONFIG, '--command', command, '--json'],
    { cwd: ROOT, windowsHide: true, timeout: 60000, maxBuffer: 1024 * 1024 });
  const result = JSON.parse(stdout.replace(/^\uFEFF/, ''));
  if (!Array.isArray(result) || result.some(item => !item.success)) throw new Error('DATABASE_ERROR');
  return result.flatMap(item => item.results || []);
}
function reply(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(data));
}
function page() {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>设置站主管理员密码</title>
<style>body{font:16px/1.7 system-ui,sans-serif;background:#f6f7f9;color:#1d2129;padding:24px;margin:auto;max-width:480px}main{background:white;padding:28px;border-radius:20px}h1{font-size:24px}label{display:block;margin-top:18px}input,button{box-sizing:border-box;width:100%;font:inherit;border-radius:10px;padding:12px}input{border:1px solid #ddd}button{margin-top:24px;background:#ff6b35;color:white;border:0}button:disabled{opacity:.5}p{font-size:14px;color:#4e5969}#status{white-space:pre-wrap}a{color:#c34b1f}</style>
<main><h1>设置你的管理员密码</h1><p>网站：shenlundawang.asia<br>用户名：<b>admin</b></p><p>这是本机临时设置页。密码只用于创建你请求的线上账号，并通过 HTTPS 确认登录；不会写入文件或显示在聊天中。</p>
<form id="form"><label>密码（8–128 个字符）<input id="password" type="password" minlength="8" maxlength="128" autocomplete="new-password" required></label><label>再次输入密码<input id="confirm" type="password" minlength="8" maxlength="128" autocomplete="new-password" required></label><button id="submit">创建线上管理员账号</button></form><p id="status" role="status"></p><p><a href="https://shenlundawang.asia/" target="_blank" rel="noopener">打开手机网站</a></p></main>
<script nonce="${nonce}">document.getElementById('form').onsubmit=async function(e){e.preventDefault();const p=document.getElementById('password'),c=document.getElementById('confirm'),b=document.getElementById('submit'),s=document.getElementById('status');if(p.value!==c.value){s.textContent='两次密码不一致';return;}b.disabled=true;s.textContent='正在开通，请稍候…';try{const r=await fetch('/create',{method:'POST',headers:{'Content-Type':'application/json','X-Setup-Token':'${nonce}'},body:JSON.stringify({password:p.value,confirmPassword:c.value})});const d=await r.json();s.textContent=d.message;if(d.created){p.value='';c.value='';document.getElementById('form').hidden=true;}else b.disabled=false;}catch(_){s.textContent='连接中断，请回到对话确认开通状态，勿重复创建。';}}</script></html>`;
}
async function readBody(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 4096) throw new Error('BODY_TOO_LARGE'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
const server = http.createServer(async (req, res) => {
  if (req.headers.host !== localOrigin.slice('http://'.length)) { reply(res, 403, { message: '仅限本机设置页' }); return; }
  if (req.method === 'GET' && req.url === '/setup') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-" + nonce + "'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'" });
    res.end(done ? '<meta charset="utf-8"><p>设置已完成，请返回网站使用 admin 和你设置的密码登录。</p>' : page()); return;
  }
  if (req.method !== 'POST' || req.url !== '/create') { reply(res, 404, { message: '页面不存在' }); return; }
  if (req.headers.origin !== localOrigin || req.headers['x-setup-token'] !== nonce || !/^application\/json/.test(req.headers['content-type'] || '')) {
    reply(res, 403, { message: '请从本机设置页重新操作' }); return;
  }
  if (busy || done) { reply(res, 409, { message: '正在处理或设置已完成，请勿重复提交' }); return; }
  let data;
  try { data = await readBody(req); } catch (_) { reply(res, 400, { message: '提交无效，请重试' }); return; }
  if (typeof data.password !== 'string' || data.password.length < 8 || data.password.length > 128 || data.password !== data.confirmPassword) {
    reply(res, 400, { message: '密码需 8–128 字符，且两次输入一致' }); return;
  }
  busy = true;
  const id = crypto.randomUUID(), salt = crypto.randomBytes(16).toString('hex');
  let cookie = '', created = false;
  try {
    const hash = crypto.pbkdf2Sync(data.password, Buffer.from(salt, 'hex'), 100000, 32, 'sha256').toString('hex');
    await sql('INSERT INTO auth_users(id,username,password_salt,password_hash,password_iterations,auth_version,created_at) VALUES(' +
      [q(id), q(username), q(salt), q(hash), '100000', '1', String(Date.now())].join(',') + ') ON CONFLICT(username) DO NOTHING; ' +
      "INSERT INTO auth_user_roles(user_id,role) SELECT id,'admin' FROM auth_users WHERE id=" + q(id) + ' AND username=' + q(username) + ' ON CONFLICT(user_id) DO NOTHING;');
    const rows = await sql('SELECT u.id,u.username,r.role FROM auth_users u LEFT JOIN auth_user_roles r ON r.user_id=u.id WHERE u.username=' + q(username) + ';');
    if (!rows[0] || rows[0].id !== id || rows[0].role !== 'admin') throw new Error('USERNAME_TAKEN');
    created = true;
    const login = await fetch(ORIGIN + '/api/auth/login', { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: data.password }), signal: AbortSignal.timeout(20000) });
    data.password = ''; data.confirmPassword = '';
    const signedIn = await login.json();
    cookie = (login.headers.get('set-cookie') || '').split(';')[0];
    if (!login.ok || signedIn.user?.id !== id || signedIn.user?.role !== 'admin' || !cookie.startsWith('slz_session=')) throw new Error('LOGIN_UNVERIFIED');
    const overview = await fetch(ORIGIN + '/api/admin/overview', { headers: { Cookie: cookie }, signal: AbortSignal.timeout(20000) });
    const identity = await overview.json();
    if (!overview.ok || identity.user?.role !== 'admin' || identity.user?.id !== id) throw new Error('ROLE_UNVERIFIED');
    const result = { created: true, id, username, role: 'admin', loginVerified: true, time: new Date().toISOString() };
    fs.mkdirSync(path.dirname(resultFile), { recursive: true }); fs.writeFileSync(resultFile, JSON.stringify(result, null, 2));
    done = true; console.log(JSON.stringify({ created: true, username, role: 'admin', loginVerified: true }));
    reply(res, 200, { created: true, message: '管理员账号已开通并确认可登录。\n用户名：admin\n请在手机网站使用你刚设置的密码登录。' });
  } catch (error) {
    data.password = ''; data.confirmPassword = '';
    done = true;
    const code = ['USERNAME_TAKEN', 'LOGIN_UNVERIFIED', 'ROLE_UNVERIFIED'].includes(error.message) ? error.message : 'SETUP_UNCONFIRMED';
    fs.mkdirSync(path.dirname(resultFile), { recursive: true }); fs.writeFileSync(resultFile, JSON.stringify({ created, id, username, code, loginVerified: false }));
    console.log(JSON.stringify({ created, username, code }));
    reply(res, 202, { created: true, message: '开通状态需要进一步确认，请返回对话。不要重复提交或覆盖已有账号。' });
  } finally {
    if (cookie) {
      try { await fetch(ORIGIN + '/api/auth/logout', { method: 'POST', headers: { Origin: ORIGIN, Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(10000) }); } catch (_) {}
    }
    busy = false;
  }
});
server.listen(0, '127.0.0.1', () => { localOrigin = 'http://127.0.0.1:' + server.address().port; console.log(JSON.stringify({ setupUrl: localOrigin + '/setup', username, expiresMinutes: 20 })); });
const expiry = setTimeout(() => { server.close(); server.closeIdleConnections(); }, 20 * 60 * 1000);
server.on('close', () => clearTimeout(expiry));
