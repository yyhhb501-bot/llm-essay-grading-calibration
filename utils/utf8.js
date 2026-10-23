/**
 * utils/utf8.js —— 增量 UTF-8 解码器
 * 流式请求（wx.request + enableChunked + onChunkReceived）返回的每个分块是
 * ArrayBuffer，网络层可能在任意字节位置切断一个多字节字符，因此必须用增量解码：
 * 残缺字节缓存到下一次 feed 再解码。
 * 零依赖，仅使用 TypedArray。
 */

// 单个 Unicode 标量值所需的最大 UTF-8 字节数
var MAX_SEQUENCE = 4;
// 解析单个码点所需的最大字节数（决定缓存阈值）
var CHAR = String.fromCharCode;

function codePointToString(code) {
  if (code <= 0xFFFF) return CHAR(code);
  // 超过基本多文种平面的码点转成 UTF-16 代理对
  code -= 0x10000;
  return CHAR(((code >>> 10) & 0x3FF) | 0xD800) +
    CHAR((code & 0x3FF) | 0xDC00);
}

/**
 * 创建一个增量 UTF-8 解码器。
 * @returns {{feed:(buf:ArrayBuffer|TypedArray|Uint8Array)=>string,
 *            push:(bytes:Array)=>string,
 *            reset:()=>void, pending:()=>number, decode:(buf:any)=>string}}
 */
function createIncrementalDecoder() {
  var carry = new Uint8Array(MAX_SEQUENCE); // 残缺字节缓冲区
  var carryLen = 0;

  function reset() {
    carryLen = 0;
  }

  function pending() {
    return carryLen;
  }

  function ensureCapacity(n) {
    if (n <= carry.length) return;
    var bigger = new Uint8Array(n);
    bigger.set(carry.subarray(0, carryLen), 0);
    carry = bigger;
  }

  // 统一入口：把任意 ArrayBuffer / TypedArray 规整成 Uint8Array

  /**
   * 喂入一段字节（推荐直接 feed ArrayBuffer），返回本次新增的字符串。
   * @param {ArrayBuffer|Uint8Array} buf
   * @returns {string}
   */
  function feed(buf) {
    if (buf === null || buf === undefined) return '';
    var bytes;
    if (buf instanceof Uint8Array) {
      bytes = buf;
    } else if (buf instanceof ArrayBuffer) {
      bytes = new Uint8Array(buf);
    } else if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(buf)) {
      bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    } else {
      return '';
    }
    if (bytes.length === 0) return '';

    // 把上一次残留的字节接到本次数据前面；无残留时零拷贝直接用本次字节
    var data;
    var total;
    if (carryLen === 0) {
      data = bytes;
      total = bytes.length;
    } else {
      ensureCapacity(carryLen + bytes.length);
      carry.set(bytes, carryLen);
      data = carry;
      total = carryLen + bytes.length;
    }
    var start = 0;

    // 跨块残留字节已经拼到 data 头部，直接进入解码主循环：
    // 若某个字符仍不完整，i + needed > total 会 break，并把尾部留给下一次 feed。
    var out = '';
    var i = start;
    while (i < total) {
      var byte = data[i];
      var needed;

      if (byte < 0x80) {
        out += CHAR(byte);
        i++;
        continue;
      } else if (byte >= 0xC2 && byte <= 0xDF) {
        needed = 2;
      } else if (byte >= 0xE0 && byte <= 0xEF) {
        needed = 3;
      } else if (byte >= 0xF0 && byte <= 0xF4) {
        needed = 4;
      } else {
        // 0x80~0xC1 与 0xF5~0xFF 均为无效起始字节
        out += '�';
        i++;
        continue;
      }

      if (i + needed > total) {
        // 字符被本块截断：剩余字节留给下一次
        break;
      }

      var b1 = data[i + 1];
      var b2;
      var b3;
      var ok = true;

      if (needed === 2) {
        ok = (b1 & 0xC0) === 0x80;
      } else if (needed === 3) {
        b2 = data[i + 2];
        ok = (b1 & 0xC0) === 0x80 && (b2 & 0xC0) === 0x80;
        if (ok && byte === 0xE0) ok = b1 >= 0xA0;            // 拒绝过长编码
        else if (ok && byte === 0xED) ok = b1 <= 0x9F;       // 拒绝代理区
      } else {
        b2 = data[i + 2];
        b3 = data[i + 3];
        ok = (b1 & 0xC0) === 0x80 && (b2 & 0xC0) === 0x80 && (b3 & 0xC0) === 0x80;
        if (ok && byte === 0xF0) ok = b1 >= 0x90;
        else if (ok && byte === 0xF4) ok = b1 <= 0x8F;
      }

      if (!ok) {
        out += '�';
        i++;
        continue;
      }

      var code;
      if (needed === 2) {
        code = ((byte & 0x1F) << 6) | (b1 & 0x3F);
      } else if (needed === 3) {
        code = ((byte & 0x0F) << 12) | ((b1 & 0x3F) << 6) | (b2 & 0x3F);
      } else {
        code = ((byte & 0x07) << 18) | ((b1 & 0x3F) << 12) | ((b2 & 0x3F) << 6) | (b3 & 0x3F);
      }
      out += codePointToString(code);
      i += needed;
    }

    // 把未消费的尾部字节搬到缓冲区头部
    var remain = total - i;
    if (remain > MAX_SEQUENCE) remain = MAX_SEQUENCE; // 安全阀
    if (remain > 0) {
      carry.set(data.subarray(i, i + remain), 0);
    }
    carryLen = remain;
    return out;
  }

  /**
   * 用普通字节数组（0-255）喂入，便于测试与手工排错。
   * @param {number[]} bytes
   * @returns {string}
   */
  function push(bytes) {
    return feed(new Uint8Array(bytes || []));
  }

  /** 一次性整段解码（不分块的场景） */
  function decode(buf) {
    var d = createIncrementalDecoder();
    return d.feed(buf);
  }

  /** 刷出末尾残留的未完成字节为替换字符 */
  function flush() {
    if (carryLen === 0) return '';
    var out = '';
    for (var k = 0; k < carryLen; k++) {
      out += '';
    }
    carryLen = 0;
    return out;
  }

  return {
    feed: feed,
    push: push,
    flush: flush,
    reset: reset,
    pending: pending,
    decode: decode
  };
}

module.exports = {
  createIncrementalDecoder: createIncrementalDecoder,
  decode: function (buf) {
    return createIncrementalDecoder().decode(buf);
  }
};