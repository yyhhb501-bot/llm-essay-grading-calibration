'use strict';

var LABEL = '内容由 AI 生成，仅供学习参考，请核实后使用。';

function forClipboard(text) {
  var body = String(text || '');
  return body.indexOf(LABEL + '\n\n') === 0 ? body : LABEL + '\n\n' + body;
}

module.exports = { LABEL: LABEL, forClipboard: forClipboard };
