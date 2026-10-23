/**
 * utils/md.js —— 极简 markdown 块解析器（零依赖）
 * 支持受限子集（见方案 §5.1）：h2/h3 标题、段落、无序/有序列表、引用块、分隔线、加粗。
 * 输出块数组：{type:'h2'|'h3'|'p'|'li'|'quote'|'hr', segments:[{text,bold}]}
 * 页面用原生 view/wx:for 渲染，便于套用 .quote-red 等朱批样式。
 *
 * 额外提供 parseScores：抽取报告末尾 ```scores 围栏代码块中的结构化评分 JSON，
 * 该围栏不进入正文块（方案 §7）。
 */

// 行内加粗：**文字**；其余按纯文本处理（不使用任何正则库）
function parseInline(text) {
  var segments = [];
  var str = text == null ? '' : String(text);
  var rest = str;
  var guard = 0;
  while (guard++ < 2000) {
    var a = rest.indexOf('**');
    if (a === -1) break;
    var b = rest.indexOf('**', a + 2);
    if (b === -1) break;
    if (a > 0) {
      segments.push({ text: rest.slice(0, a), bold: false });
    }
    segments.push({ text: rest.slice(a + 2, b), bold: true });
    rest = rest.slice(b + 2);
  }
  if (rest.length > 0) {
    segments.push({ text: rest, bold: false });
  }
  if (segments.length === 0) {
    segments.push({ text: '', bold: false });
  }
  return segments;
}

function mkBlock(type, raw) {
  return { type: type, text: raw || '', segments: parseInline(raw || '') };
}

/** 去掉行首的列表符号与引用符号 */
function stripBullet(s) {
  if (s.indexOf('- ') === 0 || s.indexOf('* ') === 0) return s.slice(2);
  return s;
}

function parseOrdered(s) {
  var m = /^(\d{1,2})[.、)]\s*/.exec(s);
  if (!m) return null;
  return {
    order: m[1],
    text: s.slice(m[0].length)
  };
}

/**
 * 解析 markdown 文本为块数组。
 * @param {string} md 原始 markdown（含 ```scores 围栏，围栏会被剔除）
 * @returns {Array<{type:string, text:string, order?:string, segments:Array<{text:string,bold:boolean}>}>}
 */
function parseBlocks(md) {
  var blocks = [];
  if (!md) return blocks;
  var lines = String(md).replace(/\r\n?/g, '\n').split('\n');

  var para = [];
  var inScoresFence = false;
  var inOtherFence = false;

  function flushPara() {
    if (para.length === 0) return;
    var res = '';
    for (var p = 0; p < para.length; p++) {
      var cur = para[p];
      if (p === 0) {
        res = cur;
      } else {
        var prevChar = res.charAt(res.length - 1);
        var nextChar = cur.charAt(0);
        if (/[A-Za-z0-9]/.test(prevChar) || /[A-Za-z0-9]/.test(nextChar)) {
          res += ' ' + cur;
        } else {
          res += cur;
        }
      }
    }
    var text = res.trim();
    if (text) blocks.push(mkBlock('p', text));
    para = [];
  }

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var trimmed = line.trim();

    // ---- 专门识别 ```scores 评分围栏：整体跳过，不进正文 ----
    if (trimmed.indexOf('```') === 0) {
      var fenceTag = trimmed.slice(3).trim().toLowerCase();
      if (!inScoresFence && !inOtherFence) {
        if (fenceTag.indexOf('scores') === 0) {
          flushPara();
          inScoresFence = true;
          continue;
        } else {
          flushPara();
          inOtherFence = true;
          continue;
        }
      } else if (inScoresFence) {
        inScoresFence = false;
        continue;
      } else if (inOtherFence) {
        inOtherFence = false;
        continue;
      }
    }
    if (inScoresFence) continue;

    if (trimmed === '') {
      flushPara();
      continue;
    }

    // ---- 分隔线 ----
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flushPara();
      blocks.push({ type: 'hr', text: '', segments: [{ text: '', bold: false }] });
      continue;
    }

    // ---- 标题 ----
    if (trimmed.indexOf('### ') === 0) {
      flushPara();
      blocks.push(mkBlock('h3', trimmed.slice(4).trim()));
      continue;
    }
    if (trimmed.indexOf('## ') === 0) {
      flushPara();
      blocks.push(mkBlock('h2', trimmed.slice(3).trim()));
      continue;
    }
    if (trimmed.indexOf('# ') === 0) {
      flushPara();
      blocks.push(mkBlock('h2', trimmed.slice(2).trim()));
      continue;
    }

    // ---- 引用块（朱批样式：支持 > 与 > 无空格）----
    if (/^>\s*/.test(trimmed)) {
      flushPara();
      blocks.push(mkBlock('quote', trimmed.replace(/^>\s*/, '').trim()));
      continue;
    }

    // ---- 列表 ----
    if (/^[-*]\s+/.test(trimmed)) {
      flushPara();
      blocks.push(mkBlock('li', stripBullet(trimmed)));
      continue;
    }
    var ord = parseOrdered(trimmed);
    if (ord) {
      flushPara();
      var blk = mkBlock('oli', ord.text);
      blk.order = ord.order;
      blocks.push(blk);
      continue;
    }

    // ---- 普通文本：相邻非空行合并成一段 ----
    para.push(trimmed);
  }

  flushPara();
  return blocks;
}

/**
 * 抽取 ```scores 围栏中的 JSON。
 * @param {string} md
 * @returns {object|null} 解析成功返回对象，失败返回 null
 */
function parseScores(md) {
  if (!md) return null;
  var text = String(md);
  var marker = '```scores';
  var lower = text.toLowerCase();
  var start = lower.lastIndexOf(marker);
  if (start === -1) return null;
  var bodyStart = start + marker.length;
  var end = text.indexOf('```', bodyStart);
  var body = end === -1 ? text.slice(bodyStart) : text.slice(bodyStart, end);
  body = body.trim();
  if (!body) return null;
  // 去掉可能存在的 json 语言标注行
  body = body.replace(/^json\s*/i, '').trim();
  // 清洗尾随逗号与非法控制字符
  body = body.replace(/,\s*([}\]])/g, '$1');
  try {
    var obj = JSON.parse(body);
    return (obj && typeof obj === 'object') ? obj : null;
  } catch (e) {
    // 尝试容错未转义的真实换行
    try {
      var sanitized = body.replace(/[\r\n]+/g, ' ');
      var obj2 = JSON.parse(sanitized);
      return (obj2 && typeof obj2 === 'object') ? obj2 : null;
    } catch (e2) {
      return null;
    }
  }
}

/**
 * 去掉 ```scores 围栏，只留正文，便于"复制全文"时不带 JSON。
 * @param {string} md
 * @returns {string}
 */
function stripScores(md) {
  if (!md) return '';
  var text = String(md);
  // 模型可能重复输出评分，复制时全部移除，流式未闭合也不泄出JSON。
  return text.replace(/```scores\b[^\S\r\n]*[\s\S]*?(?:```|$)/gi, '');
}

module.exports = {
  parseBlocks: parseBlocks,
  parseInline: parseInline,
  parseScores: parseScores,
  stripScores: stripScores
};
