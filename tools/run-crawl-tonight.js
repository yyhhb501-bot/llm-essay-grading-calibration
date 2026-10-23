'use strict';
// Overnight-compliant crawler for gkzhenti.cn paper pages.
// Site policy (stated on its block page): crawlers allowed at >1 request/minute,
// preferably 00:00-06:00. Temp-bans auto-release; repeated bans risk permanent blacklist.
// This script waits until the 00:05 window, probes until unbanned, then crawls at 65s/req,
// pausing 30 min on any block-page response, and stops at 07:30 (resumes next night if needed).
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CRAWLER = path.join(__dirname, 'crawl-paper-content.js');
const WINDOW_START = { h: 0, m: 5 };   // start crawling at 00:05
const WINDOW_END = { h: 7, m: 30 };    // hard stop at 07:30
const PROBE_INTERVAL_MIN = 15;         // while banned: probe every 15 min (1 lightweight request)
const MAX_NIGHTS = 3;

const sleep = ms => new Promise(r => setTimeout(r, ms));
function now() { return new Date(); }
function nextWindowStart(from) {
  const t = new Date(from);
  t.setHours(WINDOW_START.h, WINDOW_START.m, 0, 0);
  if (t <= from) t.setDate(t.getDate() + 1);
  return t;
}
function windowEndOf(start) {
  const t = new Date(start);
  t.setHours(WINDOW_END.h, WINDOW_END.m, 0, 0);
  return t;
}

function indexStats() {
  const p = path.join(ROOT, 'data/papers-full/index.json');
  const idx = JSON.parse(fs.readFileSync(p, 'utf8'));
  let ok = 0, total = 0;
  for (const v of Object.values(idx.papers)) { total++; if (v.status === 'ok') ok++; }
  return { ok, total };
}

async function isUnbanned() {
  try {
    const r = await fetch('https://gwy.gkzhenti.cn/api', { signal: AbortSignal.timeout(25000) });
    const text = await r.text();
    return !text.includes('临时黑名单') && !text.includes('访问异常');
  } catch (e) {
    console.log('[probe] network error:', e.message);
    return false; // treat network errors as "not ready"
  }
}

async function crawlUntil(endAt) {
  return new Promise(resolve => {
    const child = spawn('node', [CRAWLER], {
      cwd: ROOT, env: { ...process.env, CRAWL_DELAY_MS: '65000', STOP_AT_ISO: endAt.toISOString() },
      stdio: ['ignore', 'inherit', 'inherit']
    });
    child.on('exit', code => resolve(code));
  });
}

async function main() {
  for (let night = 1; night <= MAX_NIGHTS; night++) {
    const start = nextWindowStart(now());
    const ms = start - now();
    console.log(`[wait] night ${night}: sleeping ${(ms / 3600000).toFixed(1)}h until ${start.toLocaleString()}`);
    // sleep in 60s chunks so a kill/restart loses nothing (script is resumable)
    while (now() < start) await sleep(Math.min(60000, start - now()));

    // probe until unbanned (max until window end minus margin)
    const endAt = windowEndOf(start);
    let unbanned = false;
    while (now() < endAt) {
      unbanned = await isUnbanned();
      console.log(`[probe] ${now().toLocaleTimeString()} unbanned=${unbanned}`);
      if (unbanned) break;
      await sleep(PROBE_INTERVAL_MIN * 60000);
    }
    if (!unbanned) { console.log('[abort] still banned at window end'); continue; }

    console.log(`[crawl] starting compliant crawl at 65s/request until ${endAt.toLocaleString()}`);
    const code = await crawlUntil(endAt);
    const { ok, total } = indexStats();
    console.log(`[crawl] exited code=${code}; progress ${ok}/${total}`);
    if (ok >= total) { console.log('[done] all papers crawled'); return; }
    if (code === 10) { console.log('[done] window ended; remaining papers resume next night'); continue; }
  }
  console.log('[end] giving up after max nights; rerun this script to continue');
  process.exitCode = 2;
}
main().catch(e => { console.error(e); process.exitCode = 1; });
