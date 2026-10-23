/**
 * tools/gen-references.js —— 从 skills/shenlunseven/（RedSkill 商店正版 shenlunseven
 * 技能，已购买）的 references/ 与 examples/ 生成小程序可 require 的
 * skill/references.js 模块。
 *
 * 用法：node tools/gen-references.js
 * 正版技能目录更新后重跑一次即可。输出文件幂等（不含时间戳）。
 */
'use strict';

var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
var SRC_DIR = path.join(ROOT, 'skills', 'shenlunseven');
var REF_DIR = path.join(SRC_DIR, 'references');
var EX_DIR = path.join(SRC_DIR, 'examples');
var OUT = path.join(ROOT, 'skill', 'references.js');

function readIfExists(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (e) {
    return null;
  }
}

var ref = {};
var keys = [];

if (fs.existsSync(REF_DIR)) {
  fs.readdirSync(REF_DIR).forEach(function (name) {
    if (!/\.md$/.test(name)) return;
    var key = name.replace(/\.md$/, '');
    var text = readIfExists(path.join(REF_DIR, name));
    if (text) {
      ref[key] = text;
      keys.push(key);
    }
  });
}
if (fs.existsSync(EX_DIR)) {
  fs.readdirSync(EX_DIR).forEach(function (name) {
    if (!/\.md$/.test(name)) return;
    var key = name.replace(/\.md$/, '');
    var text = readIfExists(path.join(EX_DIR, name));
    if (text) {
      ref[key] = text;
      keys.push(key);
    }
  });
}

keys.sort();

if (keys.length < 10) {
  console.error('[失败] 正版参考库文件不足（' + keys.length + ' 个），请确认 skills/shenlunseven/ 已安装正式内容。');
  process.exit(1);
}

var total = keys.reduce(function (sum, k) { return sum + ref[k].length; }, 0);

var header = [
  '/**',
  ' * skill/references.js —— 申论名师专题参考库（由 tools/gen-references.js 生成，勿手改）',
  ' *',
  ' * 来源：RedSkill 商店正版技能 shenlunseven（七位申论名师公开教学精华，已购买安装于',
  ' * skills/shenlunseven/）。本文件把其 references/ 与 examples/ 的 markdown 全文',
  ' * 内嵌为 CommonJS 模块，供聊天页按问题主题路由注入、批改页注入规范表达速查。',
  ' *',
  ' * 共 ' + keys.length + ' 个专题，合计约 ' + Math.round(total / 1000) + 'K 字符。',
  ' */',
  '',
  "'use strict';",
  '',
  'var SOURCE = ' + JSON.stringify('shenlunseven (RedSkill)') + ';',
  '',
  'var REF = {'
].join('\n');

var body = keys.map(function (k) {
  return '  ' + JSON.stringify(k) + ': ' + JSON.stringify(ref[k]);
}).join(',\n');

var out = header + '\n' + body + '\n};\n\nmodule.exports = {\n  SOURCE: SOURCE,\n  REF: REF\n};\n';

fs.writeFileSync(OUT, out, 'utf8');
console.log('[ok] 生成 ' + path.relative(ROOT, OUT) + '：' + keys.length + ' 个专题，' + total + ' 字符');
console.log('     专题列表：' + keys.join(', '));
