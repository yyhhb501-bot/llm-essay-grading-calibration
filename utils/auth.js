'use strict';

// Account credentials are sent only to this fixed first-party service.
var ORIGIN = 'https://shenlundawang.asia';
var SESSION_KEY = 'slz_auth_session_v1';
var generation = 0;
var switching = false;

function readSession() {
  try {
    var value = wx.getStorageSync(SESSION_KEY);
    if (value && value.user && /^[a-zA-Z0-9_-]{1,80}$/.test(value.user.id) &&
        typeof value.user.username === 'string' && /^[a-f0-9]{64}$/.test(value.token) &&
        isFinite(value.expiresAt) && value.expiresAt > 0) return value;
  } catch (_) {}
  return null;
}
function getSession() {
  var session = readSession();
  return session && session.expiresAt > Date.now() ? session : null;
}
function request(action, data, token) {
  return new Promise(function (resolve, reject) {
    var header = { 'Content-Type': 'application/json' };
    if (token) header.Authorization = 'Bearer ' + token;
    wx.request({
      url: ORIGIN + '/api/mp/auth/' + action,
      method: action === 'session' ? 'GET' : 'POST',
      header: header, data: data || {}, timeout: 20000,
      success: function (res) {
        var body = res.data;
        if (res.statusCode >= 200 && res.statusCode < 300 && body && body.ok) { resolve(body); return; }
        var message = body && typeof body.error === 'string' ? body.error :
          (res.statusCode === 404 || typeof body === 'string' ? '小程序账号接口尚未上线，请联系站主发布后端。' : '账号请求未完成，请稍后重试。');
        var error = new Error(message);
        error.statusCode = res.statusCode;
        error.code = body && body.code;
        reject(error);
      },
      fail: function (err) {
        reject(new Error(/domain|合法域名/i.test((err && err.errMsg) || '')
          ? '请在微信公众平台配置 request 合法域名 https://shenlundawang.asia。'
          : '无法连接账号服务，请检查网络后重试。'));
      }
    });
  });
}
function clearRuntime() {
  var app = getApp();
  if (!app || !app.globalData) return;
  app.globalData.gradeStream = null;
  app.globalData.gradePrefillId = '';
  app.globalData.gradePrefillPayload = null;
  app.globalData.chatViewId = '';
  app.globalData.gradeReset = false;
  app.globalData.gradeStreamStopped = false;
  app.refreshGlobalData();
}
function transition(session) {
  if (switching) return Promise.reject(new Error('正在切换账号，请稍后。'));
  switching = true;
  generation++;
  // Keep the old storage scope until onUnload has saved the old pages.
  require('./model-request.js').abortAll();
  return new Promise(function (resolve, reject) {
    function failed(message) {
      switching = false;
      var pages = getCurrentPages();
      var current = pages[pages.length - 1];
      if (current && current.route === 'pages/account/account') current.setData({ busy: false, errorMsg: message });
      reject(new Error(message));
    }
    wx.reLaunch({
      url: '/pages/account/account?transition=1',
      success: function () {
        try {
          if (session) {
            wx.setStorageSync(SESSION_KEY, { user: session.user, token: session.token, expiresAt: session.expiresAt });
          } else wx.removeStorageSync(SESSION_KEY);
          generation++;
          switching = false;
          clearRuntime();
          wx.switchTab({ url: '/pages/mine/mine', fail: function () {
            wx.showToast({ title: '账号已切换，请点击底部“我的”', icon: 'none' });
          } });
          resolve();
        } catch (_) {
          failed('无法保存账号状态，请清理设备存储后重试。');
        }
      },
      fail: function () { failed('页面切换失败，请重试。'); }
    });
  });
}
function accept(result) {
  if (!result || !result.user || !/^[a-zA-Z0-9_-]{1,80}$/.test(result.user.id) ||
      typeof result.user.username !== 'string' || !/^[a-f0-9]{64}$/.test(result.token) || !(result.expiresAt > Date.now())) {
    return Promise.reject(new Error('账号服务返回的会话无效，请重试。'));
  }
  return transition(result).catch(function (error) {
    request('logout', {}, result.token).catch(function () {});
    throw error;
  });
}
function invalidate(token) {
  var old = readSession();
  if (!old || old.token !== token || switching) return;
  transition(null).then(function () {
    wx.showToast({ title: '登录已失效，请重新登录', icon: 'none' });
  }).catch(function (err) { wx.showToast({ title: err.message, icon: 'none' }); });
}
function refresh() {
  var session = readSession();
  if (!session || switching) return Promise.resolve();
  if (session.expiresAt <= Date.now()) { invalidate(session.token); return Promise.resolve(); }
  var started = generation;
  return request('session', null, session.token).then(function (result) {
    if (started !== generation) return;
    if (!result.authenticated || !result.user || result.user.id !== session.user.id) invalidate(session.token);
  }).catch(function (error) {
    // An offline device retains its account partition; only authoritative rejection clears it.
    if (started === generation && error.statusCode === 401) invalidate(session.token);
  });
}
function logout(localOnly, expectedToken) {
  var session = readSession();
  if (expectedToken && (!session || session.token !== expectedToken)) return Promise.resolve();
  var started = generation;
  if (localOnly || !session) return transition(null);
  return request('logout', {}, session.token).then(function () {
    var current = readSession();
    if (started !== generation || !current || current.token !== session.token) return;
    return transition(null);
  });
}
function deleteLocalData() {
  var session = readSession();
  var started = generation;
  var revoke = session ? request('logout', {}, session.token).then(function () { return true; }, function () { return false; }) : Promise.resolve(true);
  return revoke.then(function (revoked) {
    if (started !== generation) throw new Error('账号状态已改变，请重新确认删除操作。');
    return transition(null).then(function () {
      require('./storage.js').removeAllLocalData();
      clearRuntime();
      var pages = getCurrentPages();
      var current = pages[pages.length - 1];
      if (current && current.onShow) current.onShow();
      return revoked;
    });
  });
}

module.exports = {
  ORIGIN: ORIGIN, SESSION_KEY: SESSION_KEY, getSession: getSession, request: request,
  accept: accept, logout: logout, invalidate: invalidate, refresh: refresh,
  deleteLocalData: deleteLocalData,
  version: function () { return generation; },
  isSwitching: function () { return switching; }
};
