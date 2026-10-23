'use strict';
// Preserve the currently public website when releasing only the native paper API.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ROOT = path.resolve(__dirname, '..');
const release = path.resolve(ROOT, process.argv[2] || '.agent/mp-papers-release');
if (!release.startsWith(path.join(ROOT, '.agent') + path.sep)) throw new Error('Release must remain inside .agent');
const assets = path.join(release, 'assets-' + Date.now());
function list(dir, prefix = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const name = prefix + entry.name;
    return entry.isDirectory() ? list(path.join(dir, entry.name), name + '/') : [name];
  });
}
async function main() {
  fs.mkdirSync(assets, { recursive: true });
  const candidates = list(path.join(ROOT, 'site')).filter(p => !p.split('/').some(x => x.startsWith('.')));
  let cursor = 0;
  const saved = [], missing = [];
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (cursor < candidates.length) {
      const file = candidates[cursor++];
      const response = await fetch('https://shenlundawang.asia/' + file.split('/').map(encodeURIComponent).join('/'), { signal: AbortSignal.timeout(30000) });
      if (response.status === 404) { missing.push(file); continue; }
      if (!response.ok) throw new Error(file + ' HTTP ' + response.status);
      const type = response.headers.get('Content-Type') || '';
      if (!/\.html$/i.test(file) && /text\/html/i.test(type)) throw new Error('Unexpected HTML fallback: ' + file);
      const body = Buffer.from(await response.arrayBuffer());
      const out = path.join(assets, file); fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, body);
      saved.push({ file, bytes: body.length, sha256: crypto.createHash('sha256').update(body).digest('hex') });
    }
  }));
  for (const required of ['index.html', 'css/site.css', 'js/app.js', 'js/api.js', 'js/auth.js', 'js/store.js']) {
    if (!saved.some(p => p.file === required)) throw new Error('Missing current website asset: ' + required);
  }
  let config = fs.readFileSync(path.join(ROOT, 'worker/wrangler.toml'), 'utf8');
  const quotedPath = p => JSON.stringify(p.replace(/\\/g, '/'));
  config = config.replace(/^main = .*$/m, 'main = ' + quotedPath(path.join(ROOT, 'worker/worker.js')))
    .replace(/^directory = .*$/m, 'directory = ' + quotedPath(assets))
    .replace(/^migrations_dir = .*$/m, 'migrations_dir = ' + quotedPath(path.join(ROOT, 'worker/migrations')));
  fs.writeFileSync(path.join(release, 'wrangler.toml'), config);
  fs.writeFileSync(path.join(release, 'manifest.json'), JSON.stringify({ origin: 'https://shenlundawang.asia', assets, saved: saved.sort((a,b) => a.file.localeCompare(b.file)), missing }, null, 2));
  console.log(JSON.stringify({ productionAssets: saved.length, notPublishedCandidates: missing.length, config: path.relative(ROOT, path.join(release, 'wrangler.toml')) }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
