// Shared Node / Cloudflare service. No credentials or session tokens are logged.
const SESSION_SECONDS = 7 * 24 * 60 * 60;
const PASSWORD_ITERATIONS = 100000;
const MAX_AUTH_BYTES = 16 * 1024;
const COOKIE = 'slz_session';
const encoder = new TextEncoder();

class AuthError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}

export function authJson(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers }
  });
}

function failure(error) {
  if (error instanceof AuthError) return authJson({ error: error.message, code: error.code }, error.status);
  return authJson({ error: '账号服务暂时不可用，请稍后重试。', code: 'AUTH_UNAVAILABLE' }, 503);
}

function publicUser(user) { return { id: user.id, username: user.username, role: user.role === 'admin' ? 'admin' : 'member' }; }
function hex(bytes) { return Array.from(new Uint8Array(bytes), x => x.toString(16).padStart(2, '0')).join(''); }
function randomHex(size) { return hex(crypto.getRandomValues(new Uint8Array(size))); }
async function digest(value) { return hex(await crypto.subtle.digest('SHA-256', encoder.encode(value))); }
function equal(a, b) {
  let difference = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) difference |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return difference === 0;
}
async function passwordDigest(password, salt, iterations = PASSWORD_ITERATIONS) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bytes = Uint8Array.from(salt.match(/../g), x => parseInt(x, 16));
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: bytes, iterations }, key, 256));
}

function usernameValue(value) {
  return typeof value === 'string' ? value.normalize('NFKC').trim().toLowerCase() : '';
}
function validUsername(username) { return /^[\p{Script=Han}a-z0-9_-]{3,24}$/u.test(username); }
function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
    throw new AuthError(400, '密码须为 8–128 个字符。', 'INVALID_PASSWORD');
  }
}
function isLoopback(url) { return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname); }

export function checkMutationRequest(request) {
  const url = new URL(request.url);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url))) {
    throw new AuthError(403, '请通过 HTTPS 安全网址登录和使用。', 'HTTPS_REQUIRED');
  }
  if (request.headers.get('Origin') !== url.origin || request.headers.get('Sec-Fetch-Site') === 'cross-site') {
    throw new AuthError(403, '请求来源不正确，请从本站页面重新操作。', 'ORIGIN_REJECTED');
  }
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') || '')) {
    throw new AuthError(415, '请求须使用 JSON 格式。', 'JSON_REQUIRED');
  }
}

function checkNativeRequest(request, mutation = true) {
  const url = new URL(request.url);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url))) {
    throw new AuthError(403, '请通过 HTTPS 安全网址登录和使用。', 'HTTPS_REQUIRED');
  }
  const origin = request.headers.get('Origin');
  if ((origin && origin !== url.origin) || request.headers.get('Sec-Fetch-Site') === 'cross-site') {
    throw new AuthError(403, '请求来源不正确。', 'ORIGIN_REJECTED');
  }
  if (mutation && !/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') || '')) {
    throw new AuthError(415, '请求须使用 JSON 格式。', 'JSON_REQUIRED');
  }
}

function requestToken(request, native) {
  if (!native) return cookieToken(request);
  const match = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.get('Authorization') || '');
  return match ? match[1] : '';
}
// Domain-separate native tokens without changing the deployed database schema.
function tokenHash(token, native) { return digest((native ? 'mp:' : '') + token); }

async function readJson(request) {
  const declared = Number(request.headers.get('Content-Length') || 0);
  if (declared > MAX_AUTH_BYTES) throw new AuthError(413, '提交的内容过大。', 'BODY_TOO_LARGE');
  const reader = request.body?.getReader();
  let total = 0;
  const chunks = [];
  if (reader) {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_AUTH_BYTES) {
          await reader.cancel();
          throw new AuthError(413, '提交的内容过大。', 'BODY_TOO_LARGE');
        }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
  }
  try {
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('object required');
    return result;
  } catch (_) { throw new AuthError(400, '提交的内容不是有效 JSON。', 'INVALID_JSON'); }
}

function cookieToken(request) {
  const values = (request.headers.get('Cookie') || '').split(';').map(part => part.trim()).filter(part => part.startsWith(COOKIE + '='));
  if (values.length !== 1) return '';
  const token = values[0].slice(COOKIE.length + 1);
  return /^[a-f0-9]{64}$/.test(token) ? token : '';
}
function sessionCookie(request, token, maxAge = SESSION_SECONDS) {
  return COOKIE + '=' + token + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + maxAge +
    (new URL(request.url).protocol === 'https:' ? '; Secure' : '');
}

export function createAuth({ db, getInviteCode = () => '', clock = Date.now }) {
  function requireDb() {
    if (!db?.prepare) throw new Error('Database unavailable');
    return db;
  }
  async function first(sql, ...args) { return requireDb().prepare(sql).bind(...args).first(); }
  async function run(sql, ...args) { return requireDb().prepare(sql).bind(...args).run(); }
  async function throttle(kind, subject, limit, now) {
    const key = kind + ':' + await digest(String(subject).slice(0, 512));
    const row = await first(
      'INSERT INTO auth_throttles(key,attempts,window_end) VALUES(?1,1,?2) ' +
      'ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN window_end<=?3 THEN 1 ELSE attempts+1 END, ' +
      'window_end=CASE WHEN window_end<=?3 THEN ?2 ELSE window_end END RETURNING attempts',
      key, now + 15 * 60 * 1000, now
    );
    if (row.attempts > limit) throw new AuthError(429, '尝试次数过多，请 15 分钟后再试。', 'RATE_LIMITED');
  }
  async function cleanup(now) {
    await run('DELETE FROM auth_sessions WHERE expires_at<=?1', now);
    await run('DELETE FROM auth_throttles WHERE window_end<=?1', now);
  }
  async function currentUser(request, native = false) {
    requireDb();
    // Check schema availability even when the browser has no cookie.
    await first('SELECT id FROM auth_users LIMIT 1');
    const token = requestToken(request, native);
    if (!token) return null;
    return first("SELECT u.id,u.username,u.auth_version,COALESCE(r.role,'member') AS role FROM auth_sessions s JOIN auth_users u ON u.id=s.user_id LEFT JOIN auth_user_roles r ON r.user_id=u.id " +
      'WHERE s.token_hash=?1 AND s.expires_at>?2 AND s.auth_version=u.auth_version', await tokenHash(token, native), clock());
  }
  async function issueSession(request, user, native = false) {
    const token = randomHex(32);
    const now = clock();
    const result = await run('INSERT INTO auth_sessions(token_hash,user_id,auth_version,expires_at,created_at) ' +
      'SELECT ?1,id,auth_version,?2,?3 FROM auth_users WHERE id=?4 AND auth_version=?5',
      await tokenHash(token, native), now + SESSION_SECONDS * 1000, now, user.id, user.auth_version);
    if (result.meta?.changes !== 1) throw new AuthError(401, '账号状态已变化，请重新登录。', 'SESSION_CHANGED');
    // Do not accumulate a second session for the same browser on every login.
    const oldToken = requestToken(request, native);
    if (oldToken) await run('DELETE FROM auth_sessions WHERE token_hash=?1', await tokenHash(oldToken, native));
    return native ? { token, expiresAt: now + SESSION_SECONDS * 1000 } : sessionCookie(request, token);
  }
  async function signedIn(request, user, status, native) {
    const session = await issueSession(request, user, native);
    const roleRecord = await first('SELECT role FROM auth_user_roles WHERE user_id=?1', user.id);
    const effectiveUser = { ...user, role: roleRecord?.role || 'member' };
    return native
      ? authJson({ ok: true, user: publicUser(effectiveUser), ...session }, status)
      : authJson({ ok: true, user: publicUser(effectiveUser) }, status, { 'Set-Cookie': session });
  }
  async function authorize(request, { native = false, readOnly = false } = {}) {
    try {
      if (native || readOnly) checkNativeRequest(request, !readOnly); else checkMutationRequest(request);
      const user = await currentUser(request, native);
      if (!user) throw new AuthError(401, '请先登录账号。', 'AUTH_REQUIRED');
      return { user: publicUser(user), response: null };
    } catch (error) { return { user: null, response: failure(error) }; }
  }
  async function authorizeAdmin(request, options = {}) {
    const access = await authorize(request, options);
    if (access.response) return access;
    if (access.user.role !== 'admin') return { user: null, response: authJson({ error: '仅管理员可执行此操作。', code: 'ADMIN_REQUIRED' }, 403) };
    return access;
  }
  async function handle(request, { ip = 'unknown', native = false } = {}) {
    try {
      let path = new URL(request.url).pathname;
      // 别名：EdgeOne 平台保留 /api/auth/*，站点改用 /api/acct/*
      if (path.startsWith('/api/acct/')) path = '/api/auth/' + path.slice('/api/acct/'.length);
      if (native && !path.startsWith('/api/mp/auth/')) return authJson({ error: '账号接口不存在。' }, 404);
      const route = native ? path.replace('/api/mp/auth/', '/api/auth/') : path;
      if (native) checkNativeRequest(request, request.method !== 'GET');
      if (route === '/api/auth/session' && request.method === 'GET') {
        const user = await currentUser(request, native);
        return authJson({ ok: true, authenticated: !!user, user: user ? publicUser(user) : null });
      }
      const actions = ['/api/auth/register', '/api/auth/login', '/api/auth/logout', '/api/auth/password'];
      if (!actions.includes(route)) return authJson({ error: '账号接口不存在。' }, 404);
      if (request.method !== 'POST') return authJson({ error: '该操作只接受 POST 请求。' }, 405);
      if (!native) checkMutationRequest(request);
      requireDb();
      const body = await readJson(request);
      const now = clock();
      if (route === '/api/auth/logout') {
        const token = requestToken(request, native);
        if (token) await run('DELETE FROM auth_sessions WHERE token_hash=?1', await tokenHash(token, native));
        return authJson({ ok: true }, 200, native ? {} : { 'Set-Cookie': sessionCookie(request, '', 0) });
      }
      if (route === '/api/auth/password') {
        const user = await currentUser(request, native);
        if (!user) throw new AuthError(401, '请先登录账号。', 'AUTH_REQUIRED');
        await throttle('password-ip', ip, 20, now);
        await throttle('password-user', user.id, 10, now);
        validatePassword(body.oldPassword);
        validatePassword(body.newPassword);
        const record = await first('SELECT * FROM auth_users WHERE id=?1', user.id);
        if (!record || !equal(await passwordDigest(body.oldPassword, record.password_salt, record.password_iterations), record.password_hash)) {
          throw new AuthError(401, '当前密码不正确。', 'INVALID_PASSWORD');
        }
        const salt = randomHex(16);
        const hash = await passwordDigest(body.newPassword, salt);
        const updated = await run('UPDATE auth_users SET password_salt=?1,password_hash=?2,password_iterations=?3,auth_version=auth_version+1 ' +
          'WHERE id=?4 AND auth_version=?5 AND password_hash=?6', salt, hash, PASSWORD_ITERATIONS, user.id, record.auth_version, record.password_hash);
        if (updated.meta?.changes !== 1) throw new AuthError(409, '密码刚刚发生变化，请重新登录。', 'PASSWORD_CHANGED');
        const next = { ...user, auth_version: record.auth_version + 1 };
        await run('DELETE FROM auth_sessions WHERE user_id=?1 AND auth_version<?2', user.id, next.auth_version);
        return await signedIn(request, next, 200, native);
      }
      const username = usernameValue(body.username);
      await throttle('auth-ip', ip, 30, now);
      await throttle('auth-user', username, 10, now);
      await cleanup(now);
      if (route === '/api/auth/register') {
        await throttle('register-ip', ip, 10, now);
        const invite = String(getInviteCode() || '').trim();
        if (!invite) throw new AuthError(503, '暂未开放注册，请联系站主配置邀请码。', 'REGISTRATION_DISABLED');
        const provided = typeof body.inviteCode === 'string' ? body.inviteCode.trim() : '';
        if (provided.length > 256 || !equal(await digest(provided), await digest(invite))) {
          throw new AuthError(403, '邀请码不正确，请向站主获取。', 'INVITE_INVALID');
        }
        if (!validUsername(username)) throw new AuthError(400, '用户名须为 3–24 个中文、英文字母、数字、下划线或短横线。', 'INVALID_USERNAME');
        validatePassword(body.password);
        const salt = randomHex(16);
        const hash = await passwordDigest(body.password, salt);
        const id = crypto.randomUUID();
        const inserted = await run('INSERT INTO auth_users(id,username,password_salt,password_hash,password_iterations,auth_version,created_at) ' +
          'VALUES(?1,?2,?3,?4,?5,1,?6) ON CONFLICT(username) DO NOTHING', id, username, salt, hash, PASSWORD_ITERATIONS, now);
        if (inserted.meta?.changes !== 1) throw new AuthError(409, '这个用户名已被使用，请换一个。', 'USERNAME_TAKEN');
        const user = { id, username, auth_version: 1 };
        return await signedIn(request, user, 201, native);
      }
      // Always do a password derivation, including unknown users and malformed credentials.
      const record = validUsername(username) ? await first('SELECT * FROM auth_users WHERE username=?1', username) : null;
      const password = typeof body.password === 'string' && body.password.length <= 128 ? body.password : '';
      const actual = await passwordDigest(password, record?.password_salt || '00'.repeat(16), record?.password_iterations || PASSWORD_ITERATIONS);
      if (!record || !equal(actual, record.password_hash)) throw new AuthError(401, '用户名或密码不正确。', 'INVALID_CREDENTIALS');
      return await signedIn(request, record, 200, native);
    } catch (error) { return failure(error); }
  }
  return { handle, authorize, authorizeAdmin, registrationReady: () => !!db && !!String(getInviteCode() || '').trim() };
}
