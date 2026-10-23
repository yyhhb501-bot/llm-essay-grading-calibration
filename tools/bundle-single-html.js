#!/usr/bin/env node
/**
 * tools/bundle-single-html.js —— 打包单文件离线 HTML（方案 C）
 *
 * 把 site/ 目录下的 index.html、site.css、logo-144.png 与全部 js 脚本
 * 打包合并为一个独立的「申论朱批.html」文件。
 *
 * 特性：
 *   1. 零依赖单文件：图片转 Data URL，CSS 与 JS 全部内联；
 *   2. 双模自适应：既可脱离服务器双击在浏览器中直接打开（自带 Key 模式直连大模型），
 *      也可以放到任何静态托管或带 /api/chat 的后端上运行；
 *   3. 方便微信/QQ/网盘发送给考公伙伴。
 *
 * 运行：node tools/bundle-single-html.js
 */

'use strict';

var fs = require('fs');
var path = require('path');

var ROOT = path.resolve(__dirname, '..');
var SITE_DIR = path.join(ROOT, 'site');
var OUT_FILE = path.join(ROOT, '申论朱批.html');

function read(relPath) {
  return fs.readFileSync(path.join(SITE_DIR, relPath), 'utf8');
}

function readBase64(relPath) {
  return fs.readFileSync(path.join(SITE_DIR, relPath)).toString('base64');
}

console.log('[bundle-single-html] 开始打包单文件 HTML...');

// 1. 读取基础模板
var html = read('index.html');

// 2. 内联图标 (Base64 Data URL)
var logoBase64 = readBase64('assets/logo-144.png');
var logoDataUrl = 'data:image/png;base64,' + logoBase64;
html = html.replace(/href="assets\/logo-144\.png"/g, 'href="' + logoDataUrl + '"');

// 3. 内联 CSS
var css = read('css/site.css');
html = html.replace(
  '<link rel="stylesheet" href="css/site.css">',
  '<style>\n' + css + '\n</style>'
);

// 4. 内联 JS
var jsFiles = [
  'js/vendor/prompts.js',
  'js/vendor/references.js',
  'js/vendor/papers.js',
  'js/vendor/paper-catalog.js',
  'js/vendor/coverage.js',
  'js/vendor/calibration.js',
  'js/auth.js',
  'js/store.js',
  'js/md.js',
  'js/api.js',
  'js/app.js'
];

var combinedJs = [];
for (var i = 0; i < jsFiles.length; i++) {
  var fileRel = jsFiles[i];
  var content = read(fileRel);
  combinedJs.push('/* ===== ' + fileRel + ' ===== */\n' + content);
}

// 移除 index.html 里原有的外链 script 标签（JS 全部改为内联）
var scriptRegex = /<script src="js\/(?:vendor\/)?[a-zA-Z0-9_-]+\.js"><\/script>\s*/g;
html = html.replace(scriptRegex, '');

// 在 </body> 前注入打包后的 JS
var inlineScript = '<script>\n' + combinedJs.join('\n\n') + '\n</script>\n';
html = html.replace('</body>', inlineScript + '</body>');

// 写入目标文件：根目录（发给朋友的成品）+ site/ 内一份（随站点部署，可被下载）
fs.writeFileSync(OUT_FILE, html, 'utf8');
var SITE_COPY = path.join(SITE_DIR, 'single.html');
fs.writeFileSync(SITE_COPY, html, 'utf8');

var sizeMb = (Buffer.byteLength(html, 'utf8') / 1024 / 1024).toFixed(2);
console.log('[bundle-single-html] 打包完成！');
console.log('  生成路径：' + OUT_FILE);
console.log('  同步副本：' + SITE_COPY);
console.log('  文件大小：' + Buffer.byteLength(html, 'utf8') + ' 字节 (' + sizeMb + ' MB)');
