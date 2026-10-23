#!/usr/bin/env node
/**
 * tools/build-site.js —— 把 CommonJS 源文件包成浏览器可直接用的全局模块
 *
 * 作用（方案-网站.md §2 / §6.3）：
 *   1. 读 skill/prompts.js、skill/references.js、data/papers.js、tools/coverage-score.js 等 CommonJS 文件；
 *   2. 各包一层 (function (module, exports) { ... }) 垂直注入，末尾挂到 window.XXX；
 *   3. 输出到 site/js/vendor/{prompts,references,papers,coverage}.js；
 *   4. 顺带把 assets/ 下的 logo PNG 复制到 site/assets/（favicon 与分享图标）。
 *
 * 约束：
 *   - 零 npm 依赖，纯 Node；
 *   - 幂等：不写时间戳、不写随机串，同样的源文件跑多次得到逐字节相同的产物；
 *   - 只读 skill/ data/ tools/ assets/，只写 site/ 与 site/assets/，绝不改动小程序工程自身的文件。
 */

'use strict';

var fs = require('fs');
var path = require('path');

var ROOT = path.resolve(__dirname, '..');

/** 待打包的模块：源文件 → 产物文件 → 挂到 window 上的全局名 */
var MODULES = [
  { src: 'skill/prompts.js', out: 'site/js/vendor/prompts.js', global: 'Prompts' },
  { src: 'skill/references.js', out: 'site/js/vendor/references.js', global: 'References' },
  { src: 'data/papers.js', out: 'site/js/vendor/papers.js', global: 'Papers' },
  { src: 'tools/coverage-score.js', out: 'site/js/vendor/coverage.js', global: 'CoverageScore' }
];

/** 需要复制到 site/assets/ 的静态资源 */
var ASSETS = ['logo-144.png', 'logo-512.png', 'share-cover.png'];
var catalogFile = path.join(ROOT, 'data/paper-catalog.json');
if (fs.existsSync(catalogFile)) {
  writeIfChanged(path.join(ROOT, 'site/js/vendor/paper-catalog.js'), 'window.PaperCatalog = ' + JSON.stringify(JSON.parse(fs.readFileSync(catalogFile, 'utf8'))) + ';\n');
}

/** 保证目录存在（递归） */
function ensureDir(dir) {
  if (fs.existsSync(dir)) return;
  ensureDir(path.dirname(dir));
  fs.mkdirSync(dir);
}

/** 只有内容变化时才落盘，避免无谓的文件写入 */
function writeIfChanged(file, content) {
  ensureDir(path.dirname(file));
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === content) return false;
  fs.writeFileSync(file, content, 'utf8');
  return true;
}

/**
 * 给一段 CommonJS 源码套上浏览器外壳。
 * 外壳自己造一个 module / exports 对象，再把 module.exports 挂到 window 上，
 * 源码一行都不用改（保持「核心资产 100% 复用」）。
 * @param {string} source 源文件全文
 * @param {string} relSrc 源文件相对路径，写进文件头注释便于溯源
 * @param {string} relOut 产物相对路径，写进文件头注释便于溯源
 * @param {string} globalName 挂到 window 上的全局名
 * @returns {string}
 */
function wrap(source, relSrc, relOut, globalName) {
  var banner =
    '/**\n' +
    ' * ' + relOut + ' —— 自动生成，勿手改\n' +
    ' *\n' +
    ' * 源文件：' + relSrc + '（CommonJS，未改动一字）\n' +
    ' * 生成者：node tools/build-site.js\n' +
    ' * 用法：浏览器里直接用 window.' + globalName + '（与 require 的导出对象一致）\n' +
    ' */\n';
  return (
    banner +
    '(function (root, factory) {\n' +
    '  var module = { exports: {} };\n' +
    '  var exports = module.exports;\n' +
    '  factory(module, exports);\n' +
    '  root.' + globalName + ' = module.exports;\n' +
    '})(typeof window !== \'undefined\' ? window : this, function (module, exports) {\n' +
    source.replace(/\s+$/, '') + '\n' +
    '});\n'
  );
}

/** 处理单个模块 */
function buildModule(mod) {
  var srcFile = path.join(ROOT, mod.src);
  var outFile = path.join(ROOT, mod.out);
  if (!fs.existsSync(srcFile)) {
    throw new Error('源文件不存在：' + mod.src);
  }
  var source = fs.readFileSync(srcFile, 'utf8');
  var output = wrap(source, mod.src, mod.out, mod.global);
  var changed = writeIfChanged(outFile, output);
  return { file: mod.out, changed: changed, bytes: Buffer.byteLength(output, 'utf8') };
}

/** 复制静态资源（二进制，按字节比较） */
function copyAsset(name) {
  var srcFile = path.join(ROOT, 'assets', name);
  var outFile = path.join(ROOT, 'site', 'assets', name);
  var file = 'site/assets/' + name;
  if (!fs.existsSync(srcFile)) return { file: file, changed: false, skipped: true };
  var buf = fs.readFileSync(srcFile);
  ensureDir(path.dirname(outFile));
  var size = buf.length;
  if (fs.existsSync(outFile) && fs.readFileSync(outFile).equals(buf)) {
    return { file: file, changed: false, bytes: size };
  }
  fs.writeFileSync(outFile, buf);
  return { file: file, changed: true, bytes: size };
}

/** 主流程 */
function main() {
  var results = [];
  for (var i = 0; i < MODULES.length; i++) {
    results.push(buildModule(MODULES[i]));
  }
  for (var j = 0; j < ASSETS.length; j++) {
    results.push(copyAsset(ASSETS[j]));
  }

  var changedCount = 0;
  for (var k = 0; k < results.length; k++) {
    var r = results[k];
    if (r.changed) changedCount++;
    if (r.skipped) {
      console.log('  跳过（源文件缺失）  ' + r.file);
    } else {
      console.log('  ' + (r.changed ? '已更新' : '无变化') + '  ' + r.file + '  ' + r.bytes + ' 字节');
    }
  }
  console.log('[build-site] 完成，共 ' + results.length + ' 个产物，' + changedCount + ' 个发生变化（幂等：再跑一次应为 0）。');
}

main();
