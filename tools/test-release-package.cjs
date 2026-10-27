'use strict';
// Verify the delivered package, then corrupt disposable copies to ensure the
// integrity gate actually rejects changed backend, assets and configuration.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const release = path.resolve(process.env.SLZ_RELEASE_DIR || '.agent/site-release-20261026-final');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'slz-release-'));
function verify(dir) {
  return spawnSync(process.execPath, [path.join(release, 'verify.cjs'), dir], { encoding: 'utf8' });
}
try {
  assert.equal(verify(release).status, 0, '原发布包应通过');
  for (const rel of ['assets', 'source', 'wrangler.toml', 'manifest.json', 'verify.cjs']) {
    fs.cpSync(path.join(release, rel), path.join(temporary, rel), { recursive: true });
  }
  assert.equal(verify(temporary).status, 0, '迁移到其他目录后仍可校验');
  for (const rel of ['source/worker/worker.js', 'source/server/model-policy.cjs', 'assets/js/api.js', 'wrangler.toml']) {
    const file = path.join(temporary, rel), before = fs.readFileSync(file);
    fs.appendFileSync(file, '\n// deliberate test corruption\n');
    assert.notEqual(verify(temporary).status, 0, '必须拒绝变动：' + rel);
    fs.writeFileSync(file, before);
  }
  fs.writeFileSync(path.join(temporary, 'assets/unlisted.txt'), 'test');
  assert.notEqual(verify(temporary).status, 0, '必须拒绝未列出的资源');
  fs.unlinkSync(path.join(temporary, 'assets/unlisted.txt'));
  const models = spawnSync(process.execPath, ['tools/test-model-policy.mjs'], {
    cwd: path.resolve(__dirname, '..'), encoding: 'utf8', env: { ...process.env, SLZ_RELEASE_DIR: temporary }
  });
  assert.equal(models.status, 0, '迁移后的后端必须独立运行：' + models.stdout + models.stderr);
  assert.equal(verify(temporary).status, 0);
  console.log('发布包验证通过：完整性、目录迁移、后端/依赖/静态/配置篡改拒绝、额外文件拒绝、包内 Worker 独立执行。');
} finally {
  // mkdtemp creates this exact task-owned directory under the OS temp root.
  const resolved = path.resolve(temporary);
  assert(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('slz-release-'));
  fs.rmSync(resolved, { recursive: true, force: true });
}
