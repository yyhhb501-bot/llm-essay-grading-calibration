/**
 * site/js/auth.js —— 网站账号与会话管理层（方案-网站.md & docs/账号登录实施方案.md）
 *
 * 契约约定：
 *   GET  /api/acct/session  -> { ok: true, authenticated: boolean, user: { id, username } | null }
 *   POST /api/acct/register -> { ok: true, user: { id, username } } (201)
 *   POST /api/acct/login    -> { ok: true, user: { id, username } } (200)
 *   POST /api/acct/logout   -> { ok: true } (200)
 *   POST /api/acct/password -> { ok: true, user: { id, username } } (200)
 *
 * 安全与体验规则：
 *   1. 仅使用服务端 HttpOnly 会话 Cookie（slz_session），严禁在 localStorage 存储凭据、密码或会话令牌；
 *   2. POST 统一使用 credentials: 'same-origin' 和 Content-Type: application/json；
 *   3. 密码长度 8–128 位，不自动 trim；用户名 3–24 位（中文、字母、数字、_、-）；
 *   4. 多标签页通过 BroadcastChannel 与 storage 事件同步会话状态；
 *   5. 离线 file: 协议保持 standalone 模式，禁用服务端登录门禁。
 */
(function (root) {
  'use strict';

  var BROADCAST_CHANNEL = 'slz_auth_channel';
  var STORAGE_SYNC_KEY = 'slz_auth_sync_event';

  var _user = null;
  var _authenticated = false;
  var _initialized = false;
  var _initPromise = null;
  var _listeners = [];
  var _channel = null;
  var _channelInitialized = false;

  function authFetch(url, options) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, 12000);
    return root.fetch(url, Object.assign({}, options, { signal: controller.signal })).catch(function () {
      throw new Error('无法连接账号服务，请检查网络后重试。');
    }).finally(function () { clearTimeout(timer); });
  }

  function isOffline() {
    return typeof location !== 'undefined' && location.protocol === 'file:';
  }

  function getUser() {
    if (!_authenticated || !_user) return null;
    return {
      id: String(_user.id || ''),
      username: String(_user.username || '')
    };
  }

  function isAuthenticated() {
    return !!(_authenticated && _user && _user.id);
  }

  function onChange(listener) {
    if (typeof listener === 'function') {
      _listeners.push(listener);
    }
    return function () {
      var idx = _listeners.indexOf(listener);
      if (idx >= 0) _listeners.splice(idx, 1);
    };
  }

  function triggerChange(type, detail) {
    for (var i = 0; i < _listeners.length; i++) {
      try {
        _listeners[i]({ type: type, user: getUser(), detail: detail });
      } catch (e) {
        if (root.console) console.error('[Auth] onChange 监听器执行异常：', e);
      }
    }
  }

  function broadcast(type, detail) {
    var payload = {
      type: type,
      userId: _user ? _user.id : null,
      time: Date.now()
    };
    if (_channel && typeof _channel.postMessage === 'function') {
      try { _channel.postMessage(payload); } catch (e) {}
    }
    try {
      if (root.localStorage) {
        root.localStorage.setItem(STORAGE_SYNC_KEY, JSON.stringify(payload));
      }
    } catch (e) {}
  }

  function initChannel() {
    if (_channelInitialized) return;
    _channelInitialized = true;
    if (typeof BroadcastChannel !== 'undefined') {
      try {
        _channel = new BroadcastChannel(BROADCAST_CHANNEL);
        _channel.onmessage = function (evt) {
          handleRemoteSync(evt && evt.data);
        };
      } catch (e) {
        _channel = null;
      }
    }
    if (root.addEventListener) {
      root.addEventListener('storage', function (e) {
        if (e.key === STORAGE_SYNC_KEY && e.newValue) {
          try {
            var data = JSON.parse(e.newValue);
            handleRemoteSync(data);
          } catch (err) {}
        }
      });
      // 页面重新聚焦或从后台恢复时核验会话
      root.addEventListener('focus', function () {
        if (!isOffline() && _initialized) checkSessionSilent();
      });
      root.addEventListener('pageshow', function () {
        if (!isOffline() && _initialized) checkSessionSilent();
      });
    }
  }

  function handleRemoteSync(data) {
    if (!data || isOffline()) return;
    var remoteUserId = data.userId || null;
    var currentUserId = _user ? _user.id : null;
    // 跨标签页发生登出、换号、修改密码
    if (remoteUserId !== currentUserId || /^(logout|password|login|register)$/.test(data.type)) {
      if (root.console) console.info('[Auth] 检测到其他标签页账号状态变化：', data.type);
      triggerChange('remote_change', data);
      // 立即刷新以阻断旧数据展示与回调泄漏
      if (root.location && typeof root.location.reload === 'function') {
        root.location.reload();
      }
    }
  }

  function parseError(res, text) {
    var code = '';
    var error = '';
    if (text) {
      try {
        var obj = JSON.parse(text);
        if (obj) {
          error = obj.error || '';
          code = obj.code || '';
        }
      } catch (e) {
        error = text.slice(0, 120);
      }
    }
    if (!error) {
      if (res.status === 401) error = '用户名或密码不正确。';
      else if (res.status === 403) error = '访问被拒绝，请检查权限或邀请码。';
      else if (res.status === 409) error = '该用户名已被使用，请换一个。';
      else if (res.status === 429) error = '尝试次数过多，请 15 分钟后再试。';
      else if (res.status === 503) error = '账号服务暂时不可用，请稍后重试。';
      else error = '操作失败（HTTP ' + res.status + '），请稍后重试。';
    }
    var err = new Error(error);
    err.status = res.status;
    err.code = code;
    return err;
  }

  function checkSessionSilent() {
    if (isOffline()) return Promise.resolve(null);
    return authFetch('/api/acct/session', {
      method: 'GET',
      credentials: 'same-origin',
      headers: { 'Accept': 'application/json' },
      cache: 'no-store'
    }).then(function (res) {
      if (res.status !== 200) {
        return res.text().then(function (text) { throw parseError(res, text); });
      }
      return res.json().then(function (data) {
        var nowAuthed = !!(data && data.authenticated && data.user);
        var nowUser = nowAuthed ? data.user : null;
        var changed = false;
        if (nowAuthed !== _authenticated) changed = true;
        else if (nowAuthed && (!_user || _user.id !== nowUser.id)) changed = true;

        if (changed) {
          _authenticated = nowAuthed;
          _user = nowUser;
          triggerChange('session_changed');
          if (root.location && typeof root.location.reload === 'function') {
            root.location.reload();
          }
        }
        return data;
      });
    }).catch(function (error) {
      _authenticated = false;
      _user = null;
      _initPromise = null;
      triggerChange('unavailable', { message: error.message });
      return null;
    });
  }

  function init() {
    if (_initPromise) return _initPromise;
    initChannel();

    if (isOffline()) {
      _authenticated = false;
      _user = null;
      _initialized = true;
      _initPromise = Promise.resolve({ ok: true, offline: true, authenticated: false, user: null });
      return _initPromise;
    }

    _initPromise = authFetch('/api/acct/session', {
      method: 'GET',
      credentials: 'same-origin',
      headers: { 'Accept': 'application/json' },
      cache: 'no-store'
    }).then(function (res) {
      if (res.status === 503) {
        return res.text().then(function (t) {
          throw parseError(res, t);
        });
      }
      if (res.status !== 200) {
        _authenticated = false;
        _user = null;
        _initialized = true;
        return { ok: true, authenticated: false, user: null };
      }
      return res.json().then(function (data) {
        _authenticated = !!(data && data.authenticated && data.user);
        _user = _authenticated ? { id: data.user.id, username: data.user.username } : null;
        _initialized = true;
        triggerChange('init');
        return { ok: true, authenticated: _authenticated, user: getUser() };
      });
    }).catch(function (err) {
      _initialized = true;
      _authenticated = false;
      _user = null;
      _initPromise = null;
      throw err;
    });

    return _initPromise;
  }

  function login(username, password) {
    if (isOffline()) {
      return Promise.reject(new Error('本地单文件离线模式无需登录。'));
    }
    var u = typeof username === 'string' ? username.trim() : '';
    var p = typeof password === 'string' ? password : '';
    if (!u) return Promise.reject(new Error('请输入用户名。'));
    if (!p) return Promise.reject(new Error('请输入密码。'));

    return authFetch('/api/acct/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Accept': 'application/json'
      },
      body: JSON.stringify({ username: u, password: p })
    }).then(function (res) {
      return res.text().then(function (text) {
        if (res.status !== 200) {
          throw parseError(res, text);
        }
        var obj = JSON.parse(text);
        _authenticated = true;
        _user = { id: obj.user.id, username: obj.user.username };
        broadcast('login', _user);
        triggerChange('login', _user);
        return { ok: true, user: getUser() };
      });
    });
  }

  function register(username, password, confirmPassword, inviteCode) {
    if (isOffline()) {
      return Promise.reject(new Error('本地单文件离线模式无需注册。'));
    }
    var u = typeof username === 'string' ? username.normalize('NFKC').trim() : '';
    var p = typeof password === 'string' ? password : '';
    var cp = typeof confirmPassword === 'string' ? confirmPassword : '';
    var inv = typeof inviteCode === 'string' ? inviteCode.trim() : '';

    if (!u) return Promise.reject(new Error('请输入用户名。'));
    if (!/^[\p{Script=Han}a-zA-Z0-9_-]{3,24}$/u.test(u)) {
      return Promise.reject(new Error('用户名须为 3–24 个中文、英文字母、数字、下划线或短横线。'));
    }
    if (!p || p.length < 8 || p.length > 128) {
      return Promise.reject(new Error('密码须为 8–128 个字符。'));
    }
    if (p !== cp) {
      return Promise.reject(new Error('两次输入的密码不一致。'));
    }
    if (!inv) {
      return Promise.reject(new Error('请输入注册邀请码（站主原分享的访问口令即可作为邀请码）。'));
    }

    return authFetch('/api/acct/register', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Accept': 'application/json'
      },
      body: JSON.stringify({ username: u, password: p, inviteCode: inv })
    }).then(function (res) {
      return res.text().then(function (text) {
        if (res.status !== 201) {
          throw parseError(res, text);
        }
        var obj = JSON.parse(text);
        _authenticated = true;
        _user = { id: obj.user.id, username: obj.user.username };
        broadcast('register', _user);
        triggerChange('register', _user);
        return { ok: true, user: getUser() };
      });
    });
  }

  function logout() {
    if (isOffline()) {
      _authenticated = false;
      _user = null;
      return Promise.resolve({ ok: true });
    }
    return authFetch('/api/acct/logout', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Accept': 'application/json'
      },
      body: JSON.stringify({})
    }).then(function (res) {
      return res.text().then(function (text) {
        if (res.status !== 200) {
          throw parseError(res, text);
        }
        _authenticated = false;
        var oldUser = _user;
        _user = null;
        broadcast('logout', oldUser);
        triggerChange('logout', null);
        return { ok: true };
      });
    });
  }

  function changePassword(oldPassword, newPassword, confirmPassword) {
    if (isOffline()) {
      return Promise.reject(new Error('本地单文件离线模式不支持修改密码。'));
    }
    var op = typeof oldPassword === 'string' ? oldPassword : '';
    var np = typeof newPassword === 'string' ? newPassword : '';
    var cp = typeof confirmPassword === 'string' ? confirmPassword : '';

    if (!op) return Promise.reject(new Error('请输入当前密码。'));
    if (!np || np.length < 8 || np.length > 128) {
      return Promise.reject(new Error('新密码须为 8–128 个字符。'));
    }
    if (np !== cp) {
      return Promise.reject(new Error('两次输入的新密码不一致。'));
    }

    return authFetch('/api/acct/password', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Accept': 'application/json'
      },
      body: JSON.stringify({ oldPassword: op, newPassword: np })
    }).then(function (res) {
      return res.text().then(function (text) {
        if (res.status !== 200) {
          throw parseError(res, text);
        }
        var obj = JSON.parse(text);
        if (obj && obj.user) {
          _user = { id: obj.user.id, username: obj.user.username };
        }
        broadcast('password', _user);
        triggerChange('password', _user);
        return { ok: true, user: getUser() };
      });
    });
  }

  function requireLogin(message) {
    if (isOffline()) return;
    _authenticated = false;
    _user = null;
    triggerChange('require_login', { message: message });
  }

  root.Auth = {
    init: init,
    isOffline: isOffline,
    isAuthenticated: isAuthenticated,
    getUser: getUser,
    login: login,
    register: register,
    logout: logout,
    changePassword: changePassword,
    requireLogin: requireLogin,
    onChange: onChange,
    checkSessionSilent: checkSessionSilent
  };
})(typeof window !== 'undefined' ? window : this);

// UI adapter: starts the application only after the server confirms its session.
(function (root, doc) {
  'use strict';
  var mode = 'login';
  var mounted = false;
  var booted = false;
  var transitioning = false;
  var bootApp;
  function el(id) { return doc.getElementById(id); }
  function stopPersonalTasks() {
    if (typeof root.resetAccountActivity === 'function') root.resetAccountActivity();
  }
  function cover() {
    doc.body.classList.add('auth-locked');
    el('auth-screen').hidden = false;
    stopPersonalTasks();
    var dialog = el('password-dialog');
    if (dialog.open) dialog.close();
    el('password-form').reset();
  }
  function showApp() {
    el('auth-screen').hidden = true;
    doc.body.classList.remove('auth-locked');
    var user = root.Auth.getUser();
    el('account-tools').hidden = !user;
    el('settings-account').hidden = !user;
    el('account-username').textContent = user ? user.username : '';
    el('settings-account-name').textContent = user ? user.username : '';
    el('password-username').value = user ? user.username : '';
    el('password-username').defaultValue = user ? user.username : '';
    if (booted) root.dispatchEvent(new Event('hashchange'));
  }
  function errorText(error) { return error && error.message ? error.message : '操作失败，请稍后重试。'; }
  function showGate(message, unavailable) {
    cover();
    el('auth-loading').hidden = true;
    el('auth-form').hidden = !!unavailable;
    el('auth-retry').hidden = !unavailable;
    el('auth-error').hidden = !message;
    el('auth-error').textContent = message || '';
    el('auth-password').value = '';
    el('auth-confirm').value = '';
    el('auth-invite').value = '';
  }
  function reload() {
    if (transitioning) return;
    transitioning = true;
    cover();
    el('auth-form').hidden = true;
    el('auth-error').hidden = true;
    el('auth-loading').textContent = '正在进入你的账号…';
    el('auth-loading').hidden = false;
    root.location.reload();
  }
  function switchMode(next) {
    mode = next;
    var register = mode === 'register';
    el('auth-login-tab').setAttribute('aria-selected', String(!register));
    el('auth-register-tab').setAttribute('aria-selected', String(register));
    el('auth-register-fields').hidden = !register;
    el('auth-confirm').required = register;
    el('auth-invite').required = register;
    el('auth-password').setAttribute('autocomplete', register ? 'new-password' : 'current-password');
    el('auth-password').setAttribute('placeholder', register ? '设置 8–128 位密码' : '输入密码');
    el('auth-password').minLength = register ? 8 : 1;
    el('auth-title').textContent = register ? '建立你的练习空间' : '欢迎回来';
    el('auth-subtitle').textContent = register ? '先向站主获取邀请码，再创建自己的账号。' : '登录后继续批改与练习。';
    el('auth-submit').textContent = register ? '注册并开始练习' : '登录并进入';
    el('auth-bottom-note').textContent = register ? '用户名支持 3–24 个中文、字母、数字、下划线或短横线。' : '新同学请先注册。忘记密码可联系站主。';
    el('auth-error').hidden = true;
  }
  function pending(value) {
    el('auth-submit').disabled = value;
    el('auth-login-tab').disabled = value;
    el('auth-register-tab').disabled = value;
    el('auth-submit').textContent = value ? '请稍候…' : mode === 'register' ? '注册并开始练习' : '登录并进入';
  }
  function startAppIfAllowed(data) {
    if (data.offline) {
      showApp();
      if (!booted) { booted = true; bootApp(); }
    } else if (root.Auth.isAuthenticated()) {
      var id = root.Auth.getUser().id;
      if (!root.Store.bindUser(id)) { reload(); return; }
      showApp();
      if (!booted) { booted = true; bootApp(); }
    } else showGate();
  }
  function initialize() {
    el('auth-error').hidden = true;
    el('auth-retry').hidden = true;
    el('auth-loading').hidden = false;
    el('auth-loading').textContent = '正在确认登录状态…';
    return root.Auth.init().then(startAppIfAllowed).catch(function (error) { showGate(errorText(error), true); });
  }
  function mount() {
    if (mounted) return;
    mounted = true;
    root.Auth.onChange(function (event) {
      if (/^(login|register|logout|password|remote_change|session_changed|require_login|expired)$/.test(event.type)) reload();
      else if (event.type === 'unavailable') showGate(event.detail && event.detail.message, true);
    });
    el('auth-login-tab').addEventListener('click', function () { switchMode('login'); });
    el('auth-register-tab').addEventListener('click', function () { switchMode('register'); });
    el('auth-retry').addEventListener('click', function () { if (booted) reload(); else initialize(); });
    var guestBtn = el('auth-guest-btn');
    if (guestBtn) {
      guestBtn.addEventListener('click', function () {
        _authenticated = true;
        _user = { id: 'guest', username: '游客体验' };
        _initialized = true;
        root.Store.bindUser('guest');
        showApp();
        if (!booted) { booted = true; bootApp(); }
      });
    }
    el('auth-form').addEventListener('submit', function (event) {
      event.preventDefault();
      pending(true); el('auth-error').hidden = true;
      var task = mode === 'register'
        ? root.Auth.register(el('auth-username').value, el('auth-password').value, el('auth-confirm').value, el('auth-invite').value)
        : root.Auth.login(el('auth-username').value, el('auth-password').value);
      task.catch(function (error) {
        el('auth-error').textContent = errorText(error); el('auth-error').hidden = false;
      }).finally(function () { pending(false); });
    });
    el('account-logout').addEventListener('click', function () {
      cover();
      el('auth-form').hidden = true;
      el('auth-error').hidden = true;
      el('auth-loading').textContent = '正在退出登录…';
      el('auth-loading').hidden = false;
      root.Auth.logout().catch(function (error) {
        showApp();
        var notice = el('account-notice');
        if (!notice) { notice = doc.createElement('p'); notice.id = 'account-notice'; notice.className = 'auth-error'; notice.setAttribute('role', 'alert'); el('views').prepend(notice); }
        notice.textContent = '未能确认退出：' + errorText(error) + ' 请点击右上角退出重试。';
      });
    });
    el('account-password-open').addEventListener('click', function () {
      el('password-error').hidden = true;
      el('password-form').reset(); el('password-dialog').showModal();
    });
    el('password-cancel').addEventListener('click', function () { el('password-dialog').close(); el('password-form').reset(); });
    el('password-form').addEventListener('submit', function (event) {
      event.preventDefault();
      el('password-submit').disabled = true; el('password-error').hidden = true;
      root.Auth.changePassword(el('password-current').value, el('password-new').value, el('password-confirm').value).catch(function (error) {
        if (error.code === 'AUTH_REQUIRED') { root.Auth.requireLogin(); return; }
        el('password-error').textContent = errorText(error); el('password-error').hidden = false;
      }).finally(function () { el('password-submit').disabled = false; });
    });
    root.addEventListener('pagehide', function () { if (!root.Auth.isOffline()) cover(); });
    root.addEventListener('pageshow', function (event) {
      if (event.persisted && !root.Auth.isOffline()) {
        cover();
        root.Auth.checkSessionSilent().then(function (data) { if (data && root.Auth.isAuthenticated() && !transitioning) showApp(); });
      }
    });
  }
  root.AuthUI = { start: function (boot) { bootApp = boot; mount(); return initialize(); } };
})(window, document);
