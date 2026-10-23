/**
 * tools/gen-icons.js —— 纯 Node 生成 tabBar 图标（仅用内置模块 fs/path/zlib）
 * 手写 PNG 编码（IHDR/IDAT/IEND + CRC32 + zlib deflate），不依赖任何 npm 包。
 * 生成 icons/{home,grade,chat,mine}{,-active}.png，共 8 张 81×81 图标。
 *   常态：墨灰 #8A8378
 *   选中：朱红 #B03A2E
 * 用法：node tools/gen-icons.js
 */

'use strict';

var fs = require('fs');
var path = require('path');
var zlib = require('zlib');

var SIZE = 81;            // 方案 §3 规定 81×81
var SUPERSAMPLE = 4;      // 每边 4 倍超采样做抗锯齿
var COLOR_NORMAL = [0x8A, 0x83, 0x78]; // 常态墨灰
var COLOR_ACTIVE = [0xB0, 0x3A, 0x2E]; // 选中朱红
var OUT_DIR = path.join(__dirname, '..', 'icons');

// ---------------- PNG 编码 ----------------

var CRC_TABLE = (function () {
  var table = new Int32Array(256);
  for (var n = 0; n < 256; n++) {
    var c = n;
    for (var k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  var c = 0xFFFFFFFF;
  for (var i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  var len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  var typeBuf = Buffer.from(type, 'ascii');
  var body = Buffer.concat([typeBuf, data], typeBuf.length + data.length);
  var crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc], 4 + body.length + 4);
}

/**
 * 把 RGBA 像素缓冲编码为 PNG。
 * @param {number} w 宽
 * @param {number} h 高
 * @param {Buffer} rgba 长度 w*h*4
 * @returns {Buffer}
 */
function encodePNG(w, h, rgba) {
  var sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

  var ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: truecolor + alpha
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // 每行前置一个 filter 字节（0 = None）
  var raw = Buffer.alloc(h * (1 + w * 4));
  for (var y = 0; y < h; y++) {
    var src = y * w * 4;
    var dst = y * (1 + w * 4);
    raw[dst] = 0;
    rgba.copy(raw, dst + 1, src, src + w * 4);
  }

  var idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ], sig.length + 25 + idat.length + 12 + 12);
}

// ---------------- 极简几何图形（归一化坐标 0..1） ----------------

function inRect(x, y, x0, y0, x1, y1) {
  return x >= x0 && x <= x1 && y >= y0 && y <= y1;
}

function inTriangle(x, y, p1, p2, p3) {
  // 三顶点须按一致方向（顺时针或逆时针）给出
  function cross(ax, ay, bx, by) {
    return (x - ax) * (by - ay) - (y - ay) * (bx - ax);
  }
  var d1 = cross(p1[0], p1[1], p2[0], p2[1]);
  var d2 = cross(p2[0], p2[1], p3[0], p3[1]);
  var d3 = cross(p3[0], p3[1], p1[0], p1[1]);
  var neg = (d1 < 0) || (d2 < 0) || (d3 < 0);
  var pos = (d1 > 0) || (d2 > 0) || (d3 > 0);
  return !(neg && pos);
}

function inEllipse(x, y, cx, cy, rx, ry) {
  var dx = (x - cx) / rx;
  var dy = (y - cy) / ry;
  return dx * dx + dy * dy <= 1;
}

function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (!(x >= x0 && x <= x1 && y >= y0 && y <= y1)) return false;
  var cx = Math.min(Math.max(x, x0 + r), x1 - r);
  var cy = Math.min(Math.max(y, y0 + r), y1 - r);
  var dx = x - cx;
  var dy = y - cy;
  // 落在中间行/中间列且靠边的区域直接算命中
  if (x <= x0 + r || x >= x1 - r) return true;
  if (y <= y0 + r || y >= y1 - r) return true;
  // 其余交给四个角的圆判定
  return dx * dx + dy * dy <= r * r;
}

/** 房子：屋顶三角 + 屋身 + 门洞（门洞为镂空） */
function shapeHome(x, y) {
  var roof = inTriangle(x, y, [0.50, 0.10], [0.10, 0.46], [0.90, 0.46]);
  var body = inRect(x, y, 0.20, 0.42, 0.80, 0.88);
  var door = inRect(x, y, 0.42, 0.60, 0.58, 0.88);
  return (roof || body) && !door;
}

/** 钢笔：竖置的笔杆 + 笔箍 + 笔尖（蘸水钢笔剪影） */
function shapeGrade(x, y) {
  var barrel = inRoundRect(x, y, 0.44, 0.12, 0.56, 0.55, 0.06);
  var collar = inRect(x, y, 0.39, 0.52, 0.61, 0.61);
  var nib = inTriangle(x, y, [0.39, 0.60], [0.61, 0.60], [0.50, 0.88]);
  return barrel || collar || nib;
}

/** 对话泡：圆角矩形 + 左下角尖角 + 三个镂空小点 */
function shapeChat(x, y) {
  var bubble = inRoundRect(x, y, 0.10, 0.18, 0.90, 0.68, 0.12);
  var tail = inTriangle(x, y, [0.24, 0.64], [0.24, 0.88], [0.46, 0.64]);
  var body = bubble || tail;
  if (!body) return false;
  var dot1 = inEllipse(x, y, 0.36, 0.43, 0.045, 0.055);
  var dot2 = inEllipse(x, y, 0.50, 0.43, 0.045, 0.055);
  var dot3 = inEllipse(x, y, 0.64, 0.43, 0.045, 0.055);
  return !(dot1 || dot2 || dot3);
}

/** 人形：头 + 肩 */
function shapeMine(x, y) {
  var head = inEllipse(x, y, 0.50, 0.30, 0.175, 0.175);
  var shoulders = (y >= 0.54) && (Math.abs(x - 0.5) <= 0.30) &&
    (Math.pow((x - 0.5) / 0.30, 2) + Math.pow((y - 0.86) / 0.30, 2) <= 1);
  return head || shoulders;
}

var SHAPES = {
  home: shapeHome,
  grade: shapeGrade,
  chat: shapeChat,
  mine: shapeMine
};

// ---------------- 光栅化 ----------------

/**
 * 用超采样把一个形状函数渲染成 RGBA 缓冲。
 * @param {function(number,number):boolean} shape 归一化坐标内的形状判定
 * @param {number[]} rgb 前景色
 * @returns {Buffer} 长度 SIZE*SIZE*4
 */
function rasterize(shape, rgb) {
  var rgba = Buffer.alloc(SIZE * SIZE * 4);
  var step = 1 / (SIZE * SUPERSAMPLE);
  var total = SIZE * SUPERSAMPLE;
  var hits = new Uint8Array(total * total);

  for (var py = 0; py < total; py++) {
    var ny = (py + 0.5) * step;
    for (var px = 0; px < total; px++) {
      var nx = (px + 0.5) * step;
      hits[py * total + px] = shape(nx, ny) ? 1 : 0;
    }
  }

  var per = SUPERSAMPLE * SUPERSAMPLE;
  for (var y = 0; y < SIZE; y++) {
    for (var x = 0; x < SIZE; x++) {
      var sum = 0;
      for (var sy = 0; sy < SUPERSAMPLE; sy++) {
        var row = (y * SUPERSAMPLE + sy) * total + x * SUPERSAMPLE;
        for (var sx = 0; sx < SUPERSAMPLE; sx++) {
          sum += hits[row + sx];
        }
      }
      var alpha = Math.round((sum / per) * 255);
      var o = (y * SIZE + x) * 4;
      rgba[o] = rgb[0];
      rgba[o + 1] = rgb[1];
      rgba[o + 2] = rgb[2];
      rgba[o + 3] = alpha;
    }
  }
  return rgba;
}

function main() {
  if (!fs.existsSync(OUT_DIR)) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
  }
  var written = [];
  Object.keys(SHAPES).forEach(function (name) {
    [
      { suffix: '', color: COLOR_NORMAL },
      { suffix: '-active', color: COLOR_ACTIVE }
    ].forEach(function (variant) {
      var file = name + variant.suffix + '.png';
      var png = encodePNG(SIZE, SIZE, rasterize(SHAPES[name], variant.color));
      fs.writeFileSync(path.join(OUT_DIR, file), png);
      written.push(file + ' (' + png.length + ' bytes)');
    });
  });
  console.log('已生成 ' + written.length + ' 张 ' + SIZE + '×' + SIZE + ' tabBar 图标到 ' + path.relative(path.join(__dirname, '..'), OUT_DIR));
  written.forEach(function (line) {
    console.log('  - ' + line);
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  encodePNG: encodePNG,
  rasterize: rasterize,
  SHAPES: SHAPES,
  SIZE: SIZE,
  COLOR_NORMAL: COLOR_NORMAL,
  COLOR_ACTIVE: COLOR_ACTIVE
};