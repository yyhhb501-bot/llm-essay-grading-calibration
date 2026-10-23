'use strict';

// 每个接收域名独立确认；不保存密钥、图片或作答到授权记录。
var CONSENT_KEY = 'slz_model_consent_v1';
var liveTasks = [];
var auth = require('./auth.js');

function request(options) {
  var owner = auth.version();
  var consentKey = require('./storage.js').scopeKey(CONSENT_KEY);
  var shared = options.url === auth.ORIGIN + '/api/mp/chat';
  var sessionToken = shared && options.header && String(options.header.Authorization || '').replace(/^Bearer /, '');
  function current() { return owner === auth.version() && !auth.isSwitching(); }
  if (options.data && options.data.model === 'glm-5.3-flash') {
    options.data.thinking = { type: 'enabled' };
    options.data.temperature = 1;
  }
  var actual = null;
  var ended = false;
  var chunks = [];
  var match = /^https:\/\/([^/?#]+)(?:[/?#]|$)/i.exec(options.url || '');
  var origin = match ? 'https://' + match[1].toLowerCase() : '';
  var task = {
    abort: function () {
      if (ended) return;
      if (actual) { actual.abort(); return; }
      fail('request:fail abort');
    },
    onChunkReceived: function (fn) {
      var guarded = function (chunk) { if (current()) fn(chunk); };
      if (actual && actual.onChunkReceived) actual.onChunkReceived(guarded);
      else chunks.push(guarded);
    }
  };
  liveTasks.push(task);

  function release() {
    var index = liveTasks.indexOf(task);
    if (index !== -1) liveTasks.splice(index, 1);
  }

  function fail(message) {
    if (ended) return;
    ended = true;
    release();
    var error = { errMsg: message };
    if (current() && options.fail) options.fail(error);
    if (current() && options.complete) options.complete(error);
  }

  function start() {
    if (ended) return;
    if (!current()) { ended = true; release(); return; }
    var wrapped = {};
    Object.keys(options).forEach(function (key) { wrapped[key] = options[key]; });
    wrapped.success = function (res) {
      if (!current()) return;
      if (options.success) options.success(res);
      if (shared && res.statusCode === 401) auth.invalidate(sessionToken);
    };
    wrapped.fail = function (res) { if (current() && options.fail) options.fail(res); };
    wrapped.complete = function (res) {
      ended = true;
      release();
      if (current() && options.complete) options.complete(res);
    };
    try { actual = wx.request(wrapped); }
    catch (e) { fail('request:fail 无法发起请求'); return; }
    if (actual && actual.onChunkReceived) {
      chunks.forEach(function (fn) { actual.onChunkReceived(fn); });
    }
  }

  if (!origin || /@/.test(match[1])) {
    fail('request:fail abort: 模型地址必须使用 HTTPS 且不能包含账号密码');
    return task;
  }
  var accepted = [];
  try { accepted = wx.getStorageSync(consentKey) || []; } catch (e) {}
  if (!Array.isArray(accepted)) accepted = [];
  if (accepted.indexOf(origin) !== -1) {
    start();
    return task;
  }
  wx.showModal({
    title: '确认向模型服务发送数据',
    content: '接收地址：' + origin + '\n使用批改、陪练或计划功能时，会发送你提交的文字、相关对话和学习设置；图片识别会发送所选答题照片。' +
      (shared ? '账号会话仅发送至本站认证；本站将内容转交配置的模型服务商处理。' : 'API Key 会发送至此地址用于认证。') +
      '请确认接收方可信，勿提交身份证号、准考证号等隐私信息。服务商的数据保存规则以其政策为准。是否同意？',
    confirmText: '同意并继续',
    cancelText: '暂不发送',
    success: function (res) {
      if (ended || !current()) return;
      if (!res.confirm) { fail('request:fail abort: 未同意向模型服务发送数据'); return; }
      // 重读以保留其他并发请求已确认的接收方。
      try {
        var list = wx.getStorageSync(consentKey) || [];
        if (!Array.isArray(list)) list = [];
        if (list.indexOf(origin) === -1) list.push(origin);
        wx.setStorageSync(consentKey, list);
      } catch (e) {}
      start();
    },
    fail: function () { fail('request:fail abort: 数据传输确认未完成，请重试'); }
  });
  return task;
}

function abortAll() {
  liveTasks.slice().forEach(function (task) { task.abort(); });
}
module.exports = { request: request, CONSENT_KEY: CONSENT_KEY, abortAll: abortAll };
