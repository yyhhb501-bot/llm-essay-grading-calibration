'use strict';
var auth = require('../../utils/auth.js');

Page({
  data: {
    mode: 'login', username: '', password: '', confirmPassword: '', inviteCode: '',
    oldPassword: '', newPassword: '', busy: false, errorMsg: '', authenticated: false, accountName: ''
  },
  onLoad: function (options) {
    this._alive = true;
    this._generation = auth.version();
    var session = auth.getSession();
    var mode = options && options.mode;
    this.setData({
      mode: mode === 'password' && session ? 'password' : (mode === 'register' ? 'register' : 'login'),
      authenticated: !!session, accountName: session ? session.user.username : '',
      busy: auth.isSwitching()
    });
  },
  onShow: function () {
    if (!auth.isSwitching()) this.setData({ busy: false });
  },
  onUnload: function () { this._alive = false; },
  onModeTap: function (event) {
    if (this.data.busy) return;
    var mode = event.currentTarget.dataset.mode;
    if (mode !== 'login' && mode !== 'register') return;
    this.setData({ mode: mode, password: '', confirmPassword: '', inviteCode: '', oldPassword: '', newPassword: '', errorMsg: '' });
  },
  onUsernameInput: function (e) { this.setData({ username: e.detail.value }); },
  onPasswordInput: function (e) { this.setData({ password: e.detail.value }); },
  onConfirmPasswordInput: function (e) { this.setData({ confirmPassword: e.detail.value }); },
  onInviteInput: function (e) { this.setData({ inviteCode: e.detail.value }); },
  onOldPasswordInput: function (e) { this.setData({ oldPassword: e.detail.value }); },
  onNewPasswordInput: function (e) { this.setData({ newPassword: e.detail.value }); },
  onGoLocal: function () { if (!this.data.busy) wx.switchTab({ url: '/pages/mine/mine' }); },
  onGoService: function () { if (!this.data.busy) wx.navigateTo({ url: '/pages/service/service' }); },
  onSubmit: function () {
    if (this.data.busy) return;
    var self = this, mode = this.data.mode;
    var data = this.data;
    var username = String(data.username || '').trim();
    var password = mode === 'password' ? data.newPassword : data.password;
    var error = '';
    if (mode !== 'password' && (!username || username.length > 48)) error = '请输入用户名（注册支持 3–24 位中文、字母、数字、_、-）';
    if (!error && (password.length < 8 || password.length > 128)) error = '密码须为 8–128 个字符';
    if (!error && mode === 'register' && password !== data.confirmPassword) error = '两次输入的密码不一致';
    if (!error && mode === 'register' && !String(data.inviteCode).trim()) error = '请填写站主提供的注册邀请码';
    if (!error && mode === 'password' && !data.oldPassword) error = '请填写当前密码';
    var session = auth.getSession();
    if (!error && mode === 'password' && !session) error = '登录已失效，请重新登录';
    if (error) { this.setData({ errorMsg: error }); return; }
    var body = mode === 'password' ? { oldPassword: data.oldPassword, newPassword: password } : { username: username, password: password };
    if (mode === 'register') body.inviteCode = String(data.inviteCode).trim();
    this.setData({ busy: true, errorMsg: '' });
    var started = auth.version();
    auth.request(mode, body, session && session.token).then(function (result) {
      // Navigating away cancels acceptance; revoke the unused newly issued token.
      if (!self._alive || started !== auth.version()) {
        if (result.token) auth.request('logout', {}, result.token).catch(function () {});
        return;
      }
      self.setData({ password: '', confirmPassword: '', inviteCode: '', oldPassword: '', newPassword: '' });
      return auth.accept(result);
    }).catch(function (err) {
      if (self._alive) self.setData({ errorMsg: err.message, busy: false });
    });
  }
});
