/**
 * tools/validate.js —— 全项目静态校验（方案 §8 质量门槛）
 * 只用 Node 内置模块，零 npm 依赖。用法：node tools/validate.js
 * 校验项：
 *   1. app.json 可解析；9 个页面路径都有 js/json/wxml/wxss 四件套
 *   2. tabBar 页面均在 pages 中；tabBar 引用的图标文件存在
 *   3. 所有 .json 可解析
 *   4. 所有 .js 通过语法检查（new Function）
 *   5. skill/prompts.js 导出 GRADE_PROMPT / COACH_PROMPT，长度均 ≥ 2000 字
 *   6. data/papers.js 导出 ≥ 3 套真题
 * 结果与失败详情打到 stdout；全部通过 exit 0，任一失败 exit 1。
 */

'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');

var ROOT = path.join(__dirname, '..');
var SKIP_DIRS = ['node_modules', '.git', '.zcode', '.agent', '.wrangler', '.runtime', '.playwright-cli', '.opencode', 'miniprogram_npm', 'skills', 'tools'];

// prompt 最低字数（方案 §8）
var PROMPT_MIN_LENGTH = 2000;
var REQUIRED_PROMPTS = ['GRADE_PROMPT', 'COACH_PROMPT'];
// 真题套数下限（方案 §8）
var PAPERS_MIN = 3;

var failures = [];
var passed = 0;

function ok(msg) {
  passed++;
  console.log('[通过] ' + msg);
}

function fail(msg, details) {
  failures.push({ msg: msg, details: details || [] });
  console.log('[失败] ' + msg);
  if (details && details.length) {
    details.forEach(function (d) {
      console.log('         - ' + d);
    });
  }
}

function rel(p) {
  return path.relative(ROOT, p).replace(/\\/g, '/');
}

function exists(p) {
  try {
    fs.accessSync(p, fs.constants.F_OK);
    return true;
  } catch (e) {
    return false;
  }
}

function readText(p) {
  return fs.readFileSync(p, 'utf8');
}

/** 递归列出项目内所有文件（跳过 node_modules/.git/.zcode 等） */
function walk(dir, out) {
  var result = out || [];
  var entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return result;
  }
  entries.forEach(function (entry) {
    var full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.indexOf(entry.name) !== -1) return;
      walk(full, result);
    } else if (entry.isFile()) {
      result.push(full);
    }
  });
  return result;
}

/**
 * 以 CommonJS 方式在沙箱里加载一个模块，取出 module.exports。
 * @returns {{ok:boolean, exports:any, error:string}}
 */
function loadModule(file) {
  var code;
  try {
    code = readText(file);
  } catch (e) {
    return { ok: false, exports: null, error: '无法读取文件：' + e.message };
  }
  var wrapper = '(function (exports, require, module, __filename, __dirname) {\n' +
    code + '\n})';
  var moduleObj = { exports: {} };
  var sandbox = {
    module: moduleObj,
    exports: moduleObj.exports,
    require: function (id) {
      throw new Error('validate 沙箱不允许 require(' + String(id) + ')');
    },
    console: console,
    __filename: file,
    __dirname: path.dirname(file)
  };
  try {
    var fn = vm.runInNewContext(wrapper, vm.createContext(sandbox), { filename: file });
    fn(moduleObj.exports, sandbox.require, moduleObj, file, path.dirname(file));
    return { ok: true, exports: moduleObj.exports, error: '' };
  } catch (e) {
    return { ok: false, exports: null, error: String(e && e.message ? e.message : e) };
  }
}

// ---------------- 校验 1：app.json 与页面四件套 ----------------

function checkAppJson(files) {
  var appJsonPath = path.join(ROOT, 'app.json');
  var app;
  try {
    app = JSON.parse(readText(appJsonPath));
  } catch (e) {
    fail('app.json 可解析', [rel(appJsonPath) + ' 解析失败：' + e.message]);
    return null;
  }
  ok('app.json 可解析');

  if (!app || !Array.isArray(app.pages) || app.pages.length === 0) {
    fail('app.json 的 pages 为非空数组', ['实际 pages = ' + JSON.stringify(app && app.pages)]);
    return null;
  }
  ok('app.json 的 pages 为非空数组（共 ' + app.pages.length + ' 页）');

  // 每个页面四件套
  var missing = [];
  app.pages.forEach(function (p) {
    ['.js', '.json', '.wxml', '.wxss'].forEach(function (ext) {
      var f = path.join(ROOT, p + ext);
      if (!exists(f)) missing.push(rel(f));
    });
  });
  if (missing.length) {
    fail('每个页面都有 js/json/wxml/wxss 四件套', missing);
  } else {
    ok('每个页面都有 js/json/wxml/wxss 四件套（' + app.pages.length + ' 页 × 4）');
  }

  // tabBar
  if (!app.tabBar || !Array.isArray(app.tabBar.list) || app.tabBar.list.length === 0) {
    fail('app.json 含非空 tabBar.list', ['tabBar = ' + JSON.stringify(app && app.tabBar)]);
  } else {
    ok('app.json 含非空 tabBar.list（' + app.tabBar.list.length + ' 项）');
    var notInPages = [];
    var noIcon = [];
    var iconMissing = [];
    app.tabBar.list.forEach(function (item) {
      if (app.pages.indexOf(item.pagePath) === -1) {
        notInPages.push(item.pagePath);
      }
      ['iconPath', 'selectedIconPath'].forEach(function (key) {
        var v = item[key];
        if (!v) {
          // 方案 §3 允许降级为纯文字 tabBar，此时两项都应缺省
          noIcon.push((item.pagePath || '(未填 pagePath)') + ' 缺 ' + key);
          return;
        }
        var f = path.join(ROOT, v);
        if (!exists(f)) iconMissing.push(rel(f));
      });
    });
    if (notInPages.length) {
      fail('tabBar 页面都在 app.json 的 pages 中', notInPages);
    } else {
      ok('tabBar 页面都在 app.json 的 pages 中');
    }
    if (noIcon.length) {
      fail('tabBar 图标字段齐全（纯文字 tabBar 需整体不设 iconPath）', noIcon);
    } else if (iconMissing.length) {
      fail('tabBar 引用的图标文件都存在', iconMissing);
    } else {
      ok('tabBar 引用的图标文件都存在');
    }
  }
  return app;
}

// ---------------- 校验 3：所有 .json 可解析 ----------------

function checkAllJson(files) {
  var bad = [];
  var count = 0;
  files.forEach(function (f) {
    if (path.extname(f).toLowerCase() !== '.json') return;
    count++;
    try {
      JSON.parse(readText(f));
    } catch (e) {
      bad.push(rel(f) + '：' + e.message);
    }
  });
  if (bad.length) {
    fail('所有 .json 均可解析', bad);
  } else {
    ok('所有 .json 均可解析（共 ' + count + ' 个）');
  }
}

// ---------------- 校验 4：所有 .js 语法检查 ----------------

function checkAllJs(files) {
  var bad = [];
  var count = 0;
  files.forEach(function (f) {
    if (path.extname(f).toLowerCase() !== '.js') return;
    count++;
    var code;
    try {
      code = readText(f);
    } catch (e) {
      bad.push(rel(f) + '：无法读取 ' + e.message);
      return;
    }
    // 剥离行首 shebang（如 #!/usr/bin/env node）
    var cleanCode = code.replace(/^#!.*\r?\n/, '');
    try {
      if (/\bexport\s+(?:default|async\s+function|const|let|var|function|class|\{)|\bimport\s+/.test(cleanCode)) {
        // ES Module 文件（如 worker/worker.js、deploy-edgeone/functions/api/chat.js）
        var cjsShim = cleanCode
          .replace(/^\s*import\s+[\s\S]*?from\s+['"][^'"]+['"];?/gm, '')
          .replace(/^\s*import\s+['"][^'"]+['"];?/gm, '')
          .replace(/\bexport\s+default\b/g, 'var __default__ =')
          .replace(/\bexport\s+async\s+function\b/g, 'async function')
          .replace(/\bexport\s+(const|let|var|function|class)\b/g, '$1')
          .replace(/\bexport\s*\{[^}]*\};?/g, '');
        new Function('module', 'exports', 'require', '__filename', '__dirname', cjsShim);
      } else {
        // 用 Function 构造器做纯语法检查，不执行
        new Function('module', 'exports', 'require', '__filename', '__dirname', cleanCode);
      }
    } catch (e) {
      bad.push(rel(f) + '：' + (e && e.message ? e.message : String(e)));
    }
  });
  if (bad.length) {
    fail('所有 .js 通过语法检查', bad);
  } else {
    ok('所有 .js 通过语法检查（共 ' + count + ' 个）');
  }
}

// ---------------- 校验 5：skill/prompts.js ----------------

function checkPrompts() {
  var f = path.join(ROOT, 'skill', 'prompts.js');
  if (!exists(f)) {
    fail('skill/prompts.js 存在', ['缺少 ' + rel(f)]);
    return;
  }
  var r = loadModule(f);
  if (!r.ok) {
    fail('skill/prompts.js 可加载', [r.error]);
    return;
  }
  var ex = r.exports || {};
  var missing = [];
  var tooShort = [];
  REQUIRED_PROMPTS.forEach(function (name) {
    var v = ex[name];
    if (typeof v !== 'string' || !v) {
      missing.push(name);
      return;
    }
    var len = v.trim().length;
    if (len < PROMPT_MIN_LENGTH) {
      tooShort.push(name + ' 长度 ' + len + ' < ' + PROMPT_MIN_LENGTH);
    } else {
      ok('skill/prompts.js 导出 ' + name + ' 且长度 ' + len + ' ≥ ' + PROMPT_MIN_LENGTH);
    }
  });
  if (missing.length) {
    fail('skill/prompts.js 导出 ' + REQUIRED_PROMPTS.join(' / '), ['缺少或非字符串：' + missing.join('、')]);
  }
  if (tooShort.length) {
    fail('skill/prompts.js 的 prompt 长度均 ≥ ' + PROMPT_MIN_LENGTH, tooShort);
  }

  // 校验 5.5：skill/references.js（正版 shenlunseven 专题参考库）
  var rf = path.join(ROOT, 'skill', 'references.js');
  if (!exists(rf)) {
    fail('skill/references.js 存在', ['缺少 ' + rel(rf) + '，请运行 node tools/gen-references.js']);
    return;
  }
  var rr = loadModule(rf);
  if (!rr.ok) {
    fail('skill/references.js 可加载', [rr.error]);
    return;
  }
  var refMap = (rr.exports || {}).REF;
  if (!refMap || typeof refMap !== 'object') {
    fail('skill/references.js 导出 REF 映射', ['REF 缺失或不是对象']);
    return;
  }
  var refKeys = Object.keys(refMap);
  var refTotal = 0;
  var refTooShort = [];
  refKeys.forEach(function (k) {
    var len = typeof refMap[k] === 'string' ? refMap[k].length : 0;
    refTotal += len;
    if (len < 3000) refTooShort.push(k + ' 长度 ' + len);
  });
  if (refKeys.length < 15) {
    fail('skill/references.js 含 ≥15 个专题', ['实际 ' + refKeys.length + ' 个，请重跑 node tools/gen-references.js']);
  } else {
    ok('skill/references.js 含 ' + refKeys.length + ' 个专题，共 ' + refTotal + ' 字符');
  }
  if (refTooShort.length) {
    fail('skill/references.js 各专题长度均 ≥ 3000 字符', refTooShort);
  }
}

// ---------------- 校验 6：data/papers.js ----------------

/** 从模块导出里找出真题数组：优先 PAPERS，其次任意长度达标的数组值 */
function findPapersArray(ex) {
  if (Array.isArray(ex)) return ex;
  if (!ex || typeof ex !== 'object') return null;
  var preferred = ['PAPERS', 'papers', 'data', 'list', 'items'];
  for (var i = 0; i < preferred.length; i++) {
    if (Array.isArray(ex[preferred[i]])) return ex[preferred[i]];
  }
  var keys = Object.keys(ex);
  for (var j = 0; j < keys.length; j++) {
    if (Array.isArray(ex[keys[j]])) return ex[keys[j]];
  }
  return null;
}

function checkPapers() {
  var f = path.join(ROOT, 'data', 'papers.js');
  if (!exists(f)) {
    fail('data/papers.js 存在', ['缺少 ' + rel(f)]);
    return;
  }
  var r = loadModule(f);
  if (!r.ok) {
    fail('data/papers.js 可加载', [r.error]);
    return;
  }
  var arr = findPapersArray(r.exports);
  if (!arr) {
    fail('data/papers.js 导出真题数组', ['module.exports 中找不到数组，keys = ' +
      Object.keys(r.exports || {}).join('、')]);
    return;
  }
  if (arr.length < PAPERS_MIN) {
    fail('data/papers.js 导出 ≥ ' + PAPERS_MIN + ' 套真题', ['实际 ' + arr.length + ' 套']);
    return;
  }
  ok('data/papers.js 导出 ' + arr.length + ' 套真题（≥ ' + PAPERS_MIN + '）');
}

// ---------------- 主流程 ----------------

/**
 * 校验 7：每个页面 WXML 中绑定的事件处理函数（bind 系列 / catch 系列，含 bind:tap 写法）
 * 必须能在对应 js 源码里找到同名标识符（字符串级检查，防「绑定了没实现」的硬伤）。
 */
function checkWxmlBindings(files) {
  var bound = 0;
  var missing = [];
  files.forEach(function (f) {
    var relPath = path.relative(ROOT, f).replace(/\\/g, '/');
    if (!/^pages\/[^/]+\/[^/]+\.wxml$/.test(relPath)) return;
    var jsFile = f.replace(/\.wxml$/, '.js');
    var wxml = fs.readFileSync(f, 'utf8');
    var jsText = exists(jsFile) ? fs.readFileSync(jsFile, 'utf8') : '';
    var re = /(?:bind|catch):?[a-z]+\s*=\s*["']([A-Za-z0-9_]+)["']/g;
    var m;
    var seen = {};
    while ((m = re.exec(wxml)) !== null) {
      var name = m[1];
      if (seen[name]) continue;
      seen[name] = true;
      bound += 1;
      if (!jsText || !new RegExp('\\b' + name + '\\b').test(jsText)) {
        missing.push(relPath + ' 缺少处理函数 ' + name);
      }
    }
  });
  if (missing.length) {
    fail('页面 WXML 绑定的处理函数在对应 js 中都存在', missing);
  } else if (bound > 0) {
    ok('页面 WXML 绑定的处理函数在对应 js 中都存在（共 ' + bound + ' 个绑定）');
  }
}

function main() {
  var files = walk(ROOT);
  console.log('校验根目录：' + ROOT);
  console.log('扫描到 ' + files.length + ' 个文件');
  console.log('--------------------------------------------------');

  var app = checkAppJson(files);
  checkAllJson(files);
  checkAllJs(files);
  checkPrompts();
  checkPapers();
  checkWxmlBindings(files);

  console.log('--------------------------------------------------');
  if (failures.length === 0) {
    console.log('全部通过：' + passed + ' 项校验');
    process.exit(0);
  } else {
    console.log('校验失败：' + failures.length + ' 项未通过，' + passed + ' 项通过');
    failures.forEach(function (f, i) {
      console.log('第 ' + (i + 1) + ' 项：' + f.msg);
      f.details.forEach(function (d) {
        console.log('    - ' + d);
      });
    });
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  loadModule: loadModule,
  findPapersArray: findPapersArray
};