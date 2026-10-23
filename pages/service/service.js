var storage = require('../../utils/storage.js');
var api = require('../../utils/api.js');
Page({
  data: { model: '', endpoint: '' },
  onShow: function () {
    var cfg = api.normalizeConfig(storage.getConfig());
    var match = /^https:\/\/([^/?#]+)/i.exec(cfg.baseURL || '');
    this.setData({ model: cfg.shared ? '账号共享模型（以站点配置为准）' : cfg.model || '未配置', endpoint: match ? 'https://' + match[1] : '未配置有效 HTTPS 地址' });
  },
  onOpenPrivacy: function () {
    if (typeof wx.openPrivacyContract !== 'function') {
      wx.showToast({ title: '请更新微信后查看隐私指引', icon: 'none' });
      return;
    }
    wx.openPrivacyContract({ fail: function () {
      wx.showToast({ title: '隐私指引暂不可用，请联系开发者', icon: 'none' });
    } });
  }
});
