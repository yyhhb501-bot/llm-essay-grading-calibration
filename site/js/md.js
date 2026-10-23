/**
 * site/js/md.js —— 浏览器版受限 markdown 块解析器（方案-网站.md §4 第 7 条）
 *
 * 解析思路与小程序的 utils/md.js 一致（块级解析 + 行内 **加粗** 拆分），
 * 额外提供 parseScores / stripScores，语义照搬小程序 pages/result/result.js：
 *   - parseScores 取文本中**最后一个** ```scores 围栏（模型偶尔吐两遍，取新的那份）；
 *   - 容忍 ```json 语言标注、容忍尾随逗号；解析失败返回 null（流式期间围栏未闭合属正常）。
 * parseBlocks 会把 ```scores 围栏整体剔除，不进正文块。
 */
(function (root) {
  'use strict';

  /**
   * 行内加粗解析：**文字** 为加粗段，其余按纯文本处理。
   * @param {string} text
   * @returns {Array<{text:string,bold:boolean}>}
   */
  function parseInline(text) {
    var segments = [];
    var rest = text == null ? '' : String(text);
    var guard = 0;
    while (guard++ < 2000) {
      var a = rest.indexOf('**');
      if (a === -1) break;
      var b = rest.indexOf('**', a + 2);
      if (b === -1) break;
      if (a > 0) segments.push({ text: rest.slice(0, a), bold: false });
      segments.push({ text: rest.slice(a + 2, b), bold: true });
      rest = rest.slice(b + 2);
    }
    if (rest.length > 0) segments.push({ text: rest, bold: false });
    if (segments.length === 0) segments.push({ text: '', bold: false });
    return segments;
  }

  function mkBlock(type, raw) {
    return { type: type, text: raw || '', segments: parseInline(raw || '') };
  }

  /** 去掉行首的无序列表符号 */
  function stripBullet(s) {
    if (s.indexOf('- ') === 0 || s.indexOf('* ') === 0) return s.slice(2);
    return s;
  }

  /** 去掉行首的有序列表符号（1. / 1、/ 1)） */
  function stripOrdered(s) {
    var m = /^(\d{1,2})[.、)]\s*/.exec(s);
    return m ? s.slice(m[0].length) : s;
  }

  /**
   * 解析受限 markdown 子集为块数组。
   * 支持：h2 / h3 / 段落 / 有序无序列表 / 引用块 / 分隔线 / 加粗；
   * 围栏代码块（scores 等）整体跳过。
   * @param {string} mdText
   * @returns {Array<{type:string,text:string,segments:Array}>}
   */
  function parseBlocks(mdText) {
    var blocks = [];
    if (!mdText) return blocks;
    var lines = String(mdText).replace(/\r\n?/g, '\n').split('\n');

    var para = [];
    var inFence = false;

    function flushPara() {
      if (para.length === 0) return;
      var text = para.join('').trim();
      if (text) blocks.push(mkBlock('p', text));
      para = [];
    }

    for (var i = 0; i < lines.length; i++) {
      var trimmed = lines[i].trim();

      // ---- 围栏代码块整体跳过（scores 围栏不进正文）----
      if (trimmed.indexOf('```') === 0) {
        if (!inFence) {
          flushPara();
          inFence = true;
        } else {
          inFence = false;
        }
        continue;
      }
      if (inFence) continue;

      if (trimmed === '') {
        flushPara();
        continue;
      }

      if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
        flushPara();
        blocks.push({ type: 'hr', text: '', segments: [{ text: '', bold: false }] });
        continue;
      }

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

      if (trimmed.indexOf('> ') === 0 || trimmed === '>') {
        flushPara();
        blocks.push(mkBlock('quote', trimmed.replace(/^>\s?/, '').trim()));
        continue;
      }

      if (/^[-*]\s+/.test(trimmed)) {
        flushPara();
        blocks.push(mkBlock('li', stripBullet(trimmed)));
        continue;
      }
      if (/^\d{1,2}[.、)]\s+/.test(trimmed)) {
        flushPara();
        blocks.push(mkBlock('li', stripOrdered(trimmed)));
        continue;
      }

      para.push(trimmed);
    }

    flushPara();
    return blocks;
  }

  /**
   * 抽取文本中最后一个 ```scores 围栏里的 JSON。
   * 流式期间围栏可能还没闭合或 JSON 不完整，一律返回 null。
   * @param {string} text
   * @returns {object|null}
   */
  function parseScores(text) {
    if (!text) return null;
    var s = String(text);
    var marker = '```scores';
    var start = s.toLowerCase().lastIndexOf(marker); // 取最后一个围栏
    if (start === -1) return null;
    var bodyStart = start + marker.length;
    var end = s.indexOf('```', bodyStart);
    var body = (end === -1 ? s.slice(bodyStart) : s.slice(bodyStart, end)).trim();
    if (!body) return null;
    body = body.replace(/^json\s*/i, '');
    body = body.replace(/,\s*([}\]])/g, '$1'); // 容忍模型多写的尾随逗号
    try {
      var obj = JSON.parse(body);
      return (obj && typeof obj === 'object') ? obj : null;
    } catch (e) {
      return null;
    }
  }

  /**
   * 去掉正文里所有 ```scores 围栏（复制全文给人看时不能带 JSON）。
   * @param {string} text
   * @returns {string}
   */
  function stripScores(text) {
    var s = String(text == null ? '' : text);
    var out = '';
    var guard = 0;
    while (guard++ < 20) {
      var start = s.toLowerCase().indexOf('```scores');
      if (start === -1) break;
      var bodyStart = start + markerLength();
      var end = s.indexOf('```', bodyStart);
      if (end === -1) { // 围栏没闭合（流式中途复制）
        out += s.slice(0, start);
        return out;
      }
      out += s.slice(0, start);
      s = s.slice(end + 3);
    }
    return out + s;
  }

  function markerLength() {
    return '```scores'.length;
  }

  root.MD = {
    parseBlocks: parseBlocks,
    parseInline: parseInline,
    parseScores: parseScores,
    stripScores: stripScores
  };
})(typeof window !== 'undefined' ? window : this);