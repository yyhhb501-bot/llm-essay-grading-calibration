/**
 * utils/privacy.js —— 隐私授权守卫（小程序提审必备）
 *
 * 微信要求：调用相册、剪贴板等隐私接口前，需用户同意《用户隐私保护指引》
 * （指引在小程序后台「设置 → 服务内容声明 → 用户隐私保护指引」配置）。
 * 未同意时直接调用这些接口会失败。本守卫用官方 wx.requirePrivacyAuthorize
 * 统一处理：
 *   - 授权 API 返回成功 → 放行；基础库不支持授权 API → 提示更新，不执行操作。
 *   - 未同意 → 触发 app.js 注册的授权事件，由 privacy-dialog 展示指引和同意按钮。
 *
 * 用法：privacy.ensurePrivacy(function () { ...原逻辑... }, '拒绝时的提示语');
 */
'use strict';

/**
 * @param {Function} onAllow 已同意（或无需同意）时执行
 * @param {string} [denyMsg] 用户拒绝时的提示文案
 */
function ensurePrivacy(onAllow, denyMsg) {
  if (typeof wx === 'undefined' || typeof wx.requirePrivacyAuthorize !== 'function') {
    if (typeof wx !== 'undefined') wx.showToast({ title: '请更新微信后使用此功能', icon: 'none' });
    return;
  }
  wx.requirePrivacyAuthorize({
    success: function () {
      onAllow();
    },
    fail: function () {
      wx.showToast({
        title: denyMsg || '需要同意《用户隐私保护指引》后才能继续使用该功能',
        icon: 'none',
        duration: 2500
      });
    }
  });
}

module.exports = {
  ensurePrivacy: ensurePrivacy
};
