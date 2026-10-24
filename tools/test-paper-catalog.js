'use strict';
const assert = require('assert');
const catalog = require('../data/paper-catalog.json');
const ids = new Set();
for (const p of catalog.papers) {
  assert(!ids.has(p.id), 'duplicate '+p.id); ids.add(p.id);
  assert(p.year >= 2020 && p.year <= 2026);
  assert(p.title.includes('申论'));
  assert(/^https:\/\/(gwy\.gkzhenti\.cn\/paper\/\d+|gd\.huatu\.com\/2020\/0729\/\d+\.html|m\.aipta\.com\/article\/\d+\.html)$/.test(p.sourceUrl));
  assert.strictEqual(p.status,'source-link');
  assert(!p.questions, 'metadata must not claim complete questions');
}
assert(catalog.papers.length > 100);
for (let year=2020;year<=2026;year++) assert(catalog.papers.some(p=>p.region==='福建'&&p.year===year),'福建缺年份 '+year);
console.log('Catalog validation passed:',catalog.papers.length,'unique source links');
