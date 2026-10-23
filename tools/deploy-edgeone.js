'use strict';
// 一键同步并部署 EdgeOne：
//   node tools/deploy-edgeone.js [--site=global|china] [--anonymous]
// 步骤：site/ -> deploy-edgeone/（保留 functions 与 .env，去掉逐卷 papers/，用 gzip bundle）-> edgeone makers deploy
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DST = path.join(ROOT, 'deploy-edgeone');
const SITE = path.join(ROOT, 'site');
const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true];
}));
const SITE_AREA = args.site === 'china' ? 'china' : 'global';

function copyDir(src, dst, skip) {
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    if (skip && skip(name, src)) continue;
    const s = path.join(src, name), d = path.join(dst, name);
    const st = fs.statSync(s);
    if (st.isDirectory()) copyDir(s, d, skip);
    else fs.copyFileSync(s, d);
  }
}

// 1) 同步站点
for (const name of ['assets', 'css', 'js', 'index.html', 'single.html']) {
  const s = path.join(SITE, name), d = path.join(DST, name);
  if (!fs.existsSync(s)) continue;
  if (fs.statSync(s).isDirectory()) { fs.rmSync(d, { recursive: true, force: true }); copyDir(s, d, (n, p) => p.endsWith(path.join('vendor')) && n === 'papers'); }
  else fs.copyFileSync(s, d);
}
// 2) 清理会递归进包的文件
for (const f of ['deploy-edgeone.zip']) { try { fs.unlinkSync(path.join(DST, f)); } catch (e) {} }

// 3) 部署
const cmd = ['edgeone', 'makers', 'deploy', '.', '--site', SITE_AREA, '-n', 'shenlun-zhupi', '--json'];
if (args.anonymous) cmd.push('--anonymous');
console.log('deploy:', 'npx ' + cmd.join(' '));
const r = spawnSync('npx', cmd, { cwd: DST, encoding: 'utf8', shell: true });
const out = (r.stdout || '').trim().split('\n').filter(Boolean);
console.log(out[out.length - 1] || '(no output)');
if (r.stderr && r.status) console.error(r.stderr.slice(-500));
