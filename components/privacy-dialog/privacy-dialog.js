Component({
  data: { visible: false, contractName: '用户隐私保护指引' },
  lifetimes: {
    detached: function () { this.onDecline(); }
  },
  methods: {
    requestConsent: function (resolve) {
      if (this._resolve) this._resolve({ event: 'disagree' });
      this._resolve = resolve;
      this.setData({ visible: true });
      var self = this;
      if (typeof wx.getPrivacySetting === 'function') {
        wx.getPrivacySetting({ success: function (res) {
          self.setData({ contractName: res.privacyContractName || '用户隐私保护指引' });
        } });
      }
    },
    onOpenContract: function () {
      wx.openPrivacyContract({ fail: function () {
        wx.showToast({ title: '指引暂不可用，请稍后重试', icon: 'none' });
      } });
    },
    onAgree: function () {
      var resolve = this._resolve;
      this._resolve = null;
      this.setData({ visible: false });
      if (resolve) resolve({ event: 'agree', buttonId: 'privacy-agree-button' });
    },
    onDecline: function () {
      var resolve = this._resolve;
      this._resolve = null;
      if (resolve) resolve({ event: 'disagree' });
      if (this.data.visible) this.setData({ visible: false });
    },
    stopTouch: function () {}
  }
});
