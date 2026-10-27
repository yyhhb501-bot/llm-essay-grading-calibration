'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(process.argv[2] || __dirname);
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
function files(dir, prefix = '') {
  return fs.readdirSync(dir).flatMap(name => {
    const rel = prefix + name, full = path.join(dir, name), stat = fs.lstatSync(full);
    assert(!stat.isSymbolicLink(), '发布包不能包含符号链接');
    return stat.isDirectory() ? files(full, rel + '/') : [rel];
  }).sort();
}
function verifyTree(name, entries) {
  assert(Array.isArray(entries) && entries.length, name + ' 清单缺失');
  assert.deepEqual(files(path.join(root, name)), entries.map(e => e.file).sort(), name + ' 存在未列出的文件或文件缺失');
  for (const entry of entries) {
    assert(!path.isAbsolute(entry.file) && !entry.file.split(/[\\/]/).some(p => p === '..' || p === ''), '清单路径不合法');
    const bytes = fs.readFileSync(path.join(root, name, entry.file));
    assert.equal(bytes.length, entry.bytes, name + '/' + entry.file + ' 字节数变化');
    assert.equal(hash(bytes), entry.sha256, name + '/' + entry.file + ' SHA256 变化');
  }
}
verifyTree('assets', manifest.saved);
verifyTree('source', manifest.sourceSaved);
const config = fs.readFileSync(path.join(root, 'wrangler.toml'));
assert.equal(hash(config), manifest.configSha256, '发布配置发生变化');
assert.equal(hash(fs.readFileSync(path.join(root, 'verify.cjs'))), manifest.verifierSha256, '完整性验证脚本发生变化');
for (const line of ['main = "./source/worker/worker.js"', 'directory = "./assets"', 'migrations_dir = "./source/worker/migrations"']) {
  assert(config.toString().split(/\r?\n/).includes(line), '配置引用发布包外内容');
}
console.log('发布完整性通过：' + manifest.saved.length + ' 个静态文件、' + manifest.sourceSaved.length + ' 个后端/迁移文件，配置和校验器哈希一致。');
