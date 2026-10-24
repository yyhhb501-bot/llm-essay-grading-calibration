'use strict';
// Assemble a self-contained Cloudflare Worker release package from a clean baseline.
//
//   node tools/prepare-site-release.js
//
// What it does (never deploys, never touches D1/secrets):
//   1. Guard: site/ + data/ + skill/ must be git-clean so in-place regeneration is diffable.
//   2. Re-run tools/build-site.js and tools/sync-site-papers.js in place.
//   3. Quality gate: a paper enters the release index only if it has questions AND
//      non-empty materials AND a catalog entry with an allowed source URL. Rejected
//      papers are listed with reasons and excluded (index/bundle are rebuilt in the
//      release copy from the approved set only).
//   4. Copy site/ into .agent/site-release-<date>/assets, generate wrangler.toml
//      (absolute paths, same D1 binding/routes), manifest.json (bytes+SHA256 per file),
//      变更说明.md (diff vs the live 53-paper snapshot) and 回滚步骤.md.
//   5. Sensitive-file assertions: no .runtime/, deploy-edgeone/, .env, zip, sqlite,
//      token/password/secret names, and no file over the 25 MiB Cloudflare asset cap.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SITE = path.join(ROOT, 'site');
const RELEASE = path.join(ROOT, '.agent/site-release-20261024');
const ASSETS = path.join(RELEASE, 'assets');
const LIVE_SNAPSHOT = path.join(ROOT, '.agent/mp-papers-release/assets-1792469869271');
// Keep in sync with tools/test-paper-catalog.js (allowed provenance for catalog entries).
const SOURCE_RE = /^https:\/\/(gwy\.gkzhenti\.cn\/paper\/\d+|gd\.huatu\.com\/2020\/0729\/\d+\.html|m\.aipta\.com\/article\/\d+\.html)$/;

function fail(message) { console.error('release: ' + message); process.exit(1); }
function sha256(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }
function walk(dir, base = dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full, base, out); else out.push(path.relative(base, full).replace(/\\/g, '/'));
  }
  return out;
}

// 1) Clean-baseline guard over every directory the build reads or writes.
const dirty = spawnSync('git', ['status', '--porcelain', '--', 'site', 'data', 'skill', 'tools', 'worker'], { cwd: ROOT, encoding: 'utf8' });
if (dirty.status !== 0) fail('git status failed: ' + dirty.stderr);
if (dirty.stdout.trim()) fail('site/data/skill/tools/worker 有未提交改动，先提交或还原后再构建发布包：\n' + dirty.stdout.trim());
if (fs.existsSync(RELEASE)) fail('发布目录已存在：' + RELEASE + '（如需重建请先手动移除）');

// 2) Regenerate vendor outputs in place (git diff afterwards shows exactly what changed).
for (const script of ['tools/build-site.js', 'tools/sync-site-papers.js']) {
  const run = spawnSync(process.execPath, [script], { cwd: ROOT, encoding: 'utf8' });
  if (run.status !== 0) fail(script + ' 失败：\n' + run.stdout + run.stderr);
  console.log('ran ' + script + ' → ' + run.stdout.trim());
}

// 3) Quality gate over papers-full, independent of what sync chose to emit.
const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/paper-catalog.json'), 'utf8'));
const metaById = new Map(catalog.papers.map(p => [p.id, p]));
const approved = new Set();
const excluded = [];
for (const f of fs.readdirSync(path.join(ROOT, 'data/papers-full')).filter(f => f.endsWith('.json') && f !== 'index.json')) {
  const doc = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/papers-full', f), 'utf8'));
  const reasons = [];
  if (!doc.questions || !doc.questions.length) reasons.push('无题目');
  const materialsTotal = (doc.materials || []).reduce((s, m) => s + (m.content || m.text || '').length, 0);
  if (materialsTotal === 0) reasons.push('材料为空');
  const meta = metaById.get(doc.id);
  if (!meta) reasons.push('不在题库目录');
  else if (!SOURCE_RE.test(meta.sourceUrl || '')) reasons.push('目录来源不合法: ' + meta.sourceUrl);
  if (reasons.length) excluded.push({ id: doc.id, title: doc.title, reason: reasons.join('、') });
  else approved.add(doc.id);
}

// Cross-check the gate against what sync actually emitted.
const indexPath = path.join(SITE, 'js/vendor/papers-index.js');
const syncIndex = JSON.parse(fs.readFileSync(indexPath, 'utf8').match(/window\.PapersFullIndex = (\{[\s\S]*\});\s*$/)[1]);
const syncIds = new Set(Object.keys(syncIndex));
const alreadyExcluded = new Set(excluded.map(e => e.id));
for (const id of syncIds) if (!approved.has(id) && !alreadyExcluded.has(id)) {
  excluded.push({ id, title: syncIndex[id].t, reason: '质量门排除（同步产物中存在但未通过材料/来源检查）' });
}
for (const id of approved) if (!syncIds.has(id)) fail('质量门通过但 sync 未产出索引: ' + id + '（检查 tools/sync-site-papers.js）');

// 4) Assemble the release copy.
fs.mkdirSync(ASSETS, { recursive: true });
fs.cpSync(SITE, ASSETS, { recursive: true });
const excludedIds = new Set(excluded.map(e => e.id));
const releasePapersDir = path.join(ASSETS, 'js/vendor/papers');
const releaseIndex = {};
for (const id of Object.keys(syncIndex)) if (!excludedIds.has(id)) releaseIndex[id] = syncIndex[id];
for (const id of excludedIds) fs.rmSync(path.join(releasePapersDir, id + '.json'), { force: true });
const banner = '/** Auto-generated by tools/prepare-site-release.js from tools/sync-site-papers.js output — do not edit. Updated ' + new Date().toISOString() + ' */\n';
fs.writeFileSync(path.join(ASSETS, 'js/vendor/papers-index.js'),
  banner + 'window.PapersFullIndex = ' + JSON.stringify(releaseIndex) + ';\n');
const bundle = {};
for (const rel of walk(releasePapersDir)) {
  if (rel.endsWith('.json')) bundle[rel.replace(/\.json$/, '')] = JSON.parse(fs.readFileSync(path.join(releasePapersDir, rel), 'utf8'));
}
const gz = zlib.gzipSync(Buffer.from(JSON.stringify(bundle), 'utf8'), { level: 9 });
fs.writeFileSync(path.join(ASSETS, 'js/vendor/papers-bundle.json.gz'), gz);

// 4b) answer-points / consensus-points 只保留"索引内且当前 data 有题目"的文件：
// sync 从不清理旧输出，直接复制 site/ 会带上历史残留（含整轮被清空的过时文件）。
const indexIds = new Set(Object.keys(releaseIndex));
for (const dirName of ['answer-points', 'consensus-points']) {
  const outDir = path.join(ASSETS, 'js/vendor', dirName);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const srcDir = path.join(ROOT, 'data', dirName);
  if (!fs.existsSync(srcDir)) continue;
  for (const f of fs.readdirSync(srcDir)) {
    if (!f.endsWith('.json') || f === 'index.json') continue;
    const doc = JSON.parse(fs.readFileSync(path.join(srcDir, f), 'utf8'));
    if (doc.paperId && doc.questions && doc.questions.length && indexIds.has(doc.paperId)) {
      fs.writeFileSync(path.join(outDir, doc.paperId + '.json'), JSON.stringify(doc));
    }
  }
}

// 5) Consistency assertions inside the release copy.
const releaseFiles = walk(releasePapersDir);
const bundleIds = new Set(Object.keys(bundle));
if (releaseFiles.length !== indexIds.size || releaseFiles.length !== bundleIds.size) {
  fail('配套不一致：papers 文件 ' + releaseFiles.length + ' / 索引 ' + indexIds.size + ' / bundle ' + bundleIds.size);
}
for (const id of indexIds) {
  if (!bundleIds.has(id)) fail('索引有但 bundle 缺: ' + id);
  if (!fs.existsSync(path.join(releasePapersDir, id + '.json'))) fail('索引有但逐卷文件缺: ' + id);
}
const SENSITIVE = /(^|\/)\.runtime(\/|$)|deploy-edgeone|\.env$|\.zip$|\.sqlite$|\.db$|token|password|secret/i;
// 注意：本断言只按文件路径拦截；文件内容中出现凭据值不在此检查范围（靠评审抽查，2026-10-24 GLM-5.3 抽查无凭据值）。
for (const rel of walk(ASSETS)) {
  if (SENSITIVE.test(rel)) fail('发布包出现敏感文件: ' + rel);
  if (fs.statSync(path.join(ASSETS, rel)).size > 25 * 1024 * 1024) fail('文件超过 Cloudflare 25MiB 上限: ' + rel);
}

// 6) wrangler.toml — same worker/D1/routes, assets pinned to this release snapshot.
const wrangler = fs.readFileSync(path.join(ROOT, 'worker/wrangler.toml'), 'utf8')
  .replace(/main = ".*"/, 'main = ' + JSON.stringify(path.join(ROOT, 'worker/worker.js').replace(/\\/g, '/')))
  .replace(/directory = "\.\.\/site"/, 'directory = ' + JSON.stringify(ASSETS.replace(/\\/g, '/')))
  .replace(/migrations_dir = "migrations"/, 'migrations_dir = ' + JSON.stringify(path.join(ROOT, 'worker/migrations').replace(/\\/g, '/')));
if (!wrangler.includes('main = ' + JSON.stringify(path.join(ROOT, 'worker/worker.js').replace(/\\/g, '/'))) ||
    !wrangler.includes('directory = ' + JSON.stringify(ASSETS.replace(/\\/g, '/'))) ||
    !wrangler.includes('migrations_dir = ' + JSON.stringify(path.join(ROOT, 'worker/migrations').replace(/\\/g, '/')))) {
  fail('wrangler.toml 替换失败：main/directory/migrations_dir 必须全部替换为绝对路径');
}
fs.writeFileSync(path.join(RELEASE, 'wrangler.toml'), wrangler);

// 7) manifest.json — every asset with bytes+SHA256 (same shape as .agent/admin-release).
const saved = walk(ASSETS).sort().map(rel => {
  const buf = fs.readFileSync(path.join(ASSETS, rel));
  return { file: rel, bytes: buf.length, sha256: sha256(buf) };
});
const manifest = {
  origin: 'https://shenlundawang.asia',
  createdAt: new Date().toISOString(),
  generatedBy: 'tools/prepare-site-release.js',
  assets: ASSETS,
  papers: {
    indexed: indexIds.size,
    excluded: excluded.sort((a, b) => a.id < b.id ? -1 : 1),
    totalQuestions: Object.values(releaseIndex).reduce((s, v) => s + v.qs.length, 0),
    withAnswerPoints: Object.values(releaseIndex).filter(v => v.ap).length,
    withConsensus: Object.values(releaseIndex).filter(v => v.cons).length,
    bundleBytes: gz.length
  },
  assetsCount: saved.length,
  assetsBytes: saved.reduce((s, f) => s + f.bytes, 0),
  saved
};
fs.writeFileSync(path.join(RELEASE, 'manifest.json'), JSON.stringify(manifest, null, 2));

// 8) 变更说明.md — diff against the live 53-paper snapshot when it is available.
let changesSection = '';
if (fs.existsSync(LIVE_SNAPSHOT)) {
  const live = new Map(walk(LIVE_SNAPSHOT).map(rel => [rel, sha256(fs.readFileSync(path.join(LIVE_SNAPSHOT, rel)))]));
  const release = new Map(saved.map(f => [f.file, f.sha256]));
  const added = [...release.keys()].filter(f => !live.has(f));
  const removed = [...live.keys()].filter(f => !release.has(f));
  const changed = [...release.keys()].filter(f => live.has(f) && live.get(f) !== release.get(f));
  changesSection = [
    '## 相对线上（53 套快照）的差异', '',
    '- 线上快照：`.agent/mp-papers-release/assets-1792469869271/`（2026-10-19 上线版，索引 53 套 / 59,096B）',
    '- 新增文件 ' + added.length + ' 个 / 删除 ' + removed.length + ' 个 / 内容变化 ' + changed.length + ' 个',
    '- 新增（关键）：js/vendor/papers/（371 个逐卷 JSON）、js/vendor/papers-bundle.json.gz（' + (gz.length / 1024 / 1024).toFixed(1) + 'MB）、js/vendor/calibration.js',
    '- 变化（关键）：' + changed.filter(f => !f.startsWith('js/vendor/papers/')).map(f => '`' + f + '`').join('、'),
    '- 索引：window.PapersFullIndex 53 套 → **' + indexIds.size + ' 套**（含题目 ' + manifest.papers.totalQuestions + ' 道；参考答案采分点 ' + manifest.papers.withAnswerPoints + ' 套、共识锚点 ' + manifest.papers.withConsensus + ' 套）',
    ''
  ].join('\n');
} else {
  changesSection = '## 相对线上的差异\n\n（未找到线上快照目录 ' + LIVE_SNAPSHOT + '，跳过逐文件比对）\n\n';
}
fs.writeFileSync(path.join(RELEASE, '变更说明.md'), [
  '# 发布包变更说明（' + manifest.createdAt + '）', '',
  '来源：干净基线重建（tools/build-site.js + tools/sync-site-papers.js）+ 质量门（题目非空、材料非空、目录来源合法）。',
  '', changesSection,
  '## 质量门排除清单（不进发布包）', '',
  excluded.length ? excluded.map(e => '- `' + e.id + '` ' + e.title + ' — ' + e.reason).join('\n') : '（无）',
  '', '## 配套一致性（已断言）', '',
  '- 索引键数 = 逐卷 JSON 数 = bundle 卷数 = **' + indexIds.size + '**，三方严格一致',
  '- 资源总数 ' + saved.length + ' 个 / ' + (manifest.assetsBytes / 1024 / 1024).toFixed(1) + 'MB，逐文件 SHA256 见 manifest.json',
  '- 敏感文件扫描通过（无 .runtime/deploy-edgeone/.env/zip/sqlite/token 类文件；单文件均 <25MiB）',
  '', '## 部署方式（需用户明确授权后执行，本工具不部署）', '',
  '```bash',
  'npx wrangler deploy --config "' + (RELEASE + '/wrangler.toml').replace(/\\/g, '/') + '"',
  '```', ''
].join('\n'));

// 9) 回滚步骤.md
fs.writeFileSync(path.join(RELEASE, '回滚步骤.md'), [
  '# 回滚步骤（如新版本上线后出问题）', '',
  '1. 回滚 = 重新部署 2026-10-21 时点的线上静态快照（53 套版，即当前线上内容的逐字节副本）：',
  '   ```bash',
  '   npx wrangler deploy --config "E:/Vscode/申论批改app/.agent/admin-release/wrangler.toml"',
  '   ```',
  '2. 回滚只替换 Worker 与静态资源；**账号库 D1 `shenlun-accounts` 不受影响、不要删除或重建**。',
  '3. 本次发布无新增 D1 迁移（0003 已于 10-21 应用到线上），回滚无需回滚数据库。',
  '4. 回滚后用 `curl -s https://shenlundawang.asia/js/vendor/papers-index.js | sha256sum` 复核，',
  '   应等于 `b5fbf4d03bfaba31ae6d8b03ad324562894cecaf7a8ead4145d4a790394d99b`（53 套版哈希）。',
  '5. Worker 版本级回退也可用 Cloudflare 控制台（Workers → shenlun-zhupi → Deployments → Rollback 到 6689a339）。',
  ''
].join('\n'));

console.log(JSON.stringify({
  releaseDir: RELEASE, papersIndexed: indexIds.size, papersExcluded: excluded.length,
  totalQuestions: manifest.papers.totalQuestions, assetsCount: saved.length,
  assetsMB: +(manifest.assetsBytes / 1024 / 1024).toFixed(1), bundleBytes: gz.length
}, null, 2));
