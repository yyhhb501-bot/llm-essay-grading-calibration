'use strict';
// One-shot wrapper for the overnight crawl, run by Windows Task Scheduler at 00:05.
// - Outside the night window (08:00-23:00): reschedule for the next night and exit (site
//   policy prefers 00:00-06:00 crawling; never crawl in daytime peak).
// - Otherwise run crawl-paper-content.js at 65s/request, stop at 07:30, log everything.
// - On completion: delete the scheduled task if all papers are in; otherwise reschedule
//   for the next night (max 3 nights, tracked via a marker file).
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TASK_NAME = 'ShenlunCrawlNightly';
const LOG_DIR = path.join(ROOT, 'output');
const NIGHTS_FILE = path.join(LOG_DIR, 'crawl-night-count.txt');
const PS1 = path.join(__dirname, 'register-crawl-task.ps1');

const now = new Date();
const hour = now.getHours();
const stamp = now.toISOString().slice(0, 10);
const LOG = path.join(LOG_DIR, 'crawl-night-' + stamp + '.log');

function log(s) { fs.appendFileSync(LOG, '[' + new Date().toISOString() + '] ' + s + '\n'); }

function reschedule(reason) {
  log('rescheduling task for next 00:05: ' + reason);
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS1], { encoding: 'utf8' });
  log('reschedule output: ' + ((r.stdout || '') + ' ' + (r.stderr || '')).trim());
}

function nightsLeft() {
  const n = fs.existsSync(NIGHTS_FILE) ? Number(fs.readFileSync(NIGHTS_FILE, 'utf8').trim() || '0') : 0;
  return 3 - n;
}

function remainingCount() {
  const idx = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/papers-full/index.json'), 'utf8'));
  let remaining = 0;
  for (const v of Object.values(idx.papers)) {
    if (!['ok', 'empty-page', 'external-source'].includes(v.status)) remaining++;
  }
  return remaining;
}

// Daytime guard: outside the night window just reschedule and exit.
if (hour >= 8 && hour < 23) {
  log('started at ' + now.toLocaleString() + ' — daytime; not crawling.');
  reschedule('daytime guard');
  process.exit(0);
}

log('=== crawl night start ' + now.toLocaleString() + '; nightsLeft=' + nightsLeft());
if (nightsLeft() <= 0) {
  log('no nights left — deleting task, giving up. Rerun tools/run-crawl-tonight.js to continue.');
  spawnSync('schtasks', ['/delete', '/f', '/tn', TASK_NAME], { stdio: 'ignore' });
  process.exit(0);
}

const END = new Date(now);
END.setHours(7, 30, 0, 0);
if (END <= now) END.setDate(END.getDate() + 1);

const r = spawnSync(process.execPath, [path.join(__dirname, 'crawl-paper-content.js')], {
  cwd: ROOT,
  env: { ...process.env, CRAWL_DELAY_MS: '65000', STOP_AT_ISO: END.toISOString() },
  stdio: ['ignore', 'pipe', 'pipe'],
  timeout: 8 * 3600 * 1000,
  maxBuffer: 64 * 1024 * 1024
});
if (r.stdout) log('STDOUT:\n' + r.stdout.toString('utf8'));
if (r.stderr) log('STDERR:\n' + r.stderr.toString('utf8'));
log('=== crawler exit ' + (r.status === null ? '(signal ' + r.signal + ')' : r.status));

const remaining = remainingCount();
log('remaining papers: ' + remaining);
if (r.status === 0 && remaining === 0) {
  spawnSync('schtasks', ['/delete', '/f', '/tn', TASK_NAME], { stdio: 'ignore' });
  log('=== all papers done; task deleted. complete.');
} else {
  fs.writeFileSync(NIGHTS_FILE, String((fs.existsSync(NIGHTS_FILE) ? Number(fs.readFileSync(NIGHTS_FILE, 'utf8').trim() || '0') : 0) + 1));
  reschedule('exit=' + r.status + ' remaining=' + remaining);
}
