/* Exercise the production settings/progress store under failed writes. */
import fs from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = process.env.ALOUD_ROOT || fileURLToPath(new URL('../', import.meta.url));
const source = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const start = source.indexOf('const _mem =');
const end = source.indexOf('/* The iOS app', start);
assert(start >= 0 && end > start, 'Production storage adapter not found');
const data = new Map(), notices = [], deferred = [];
let failWrites = false, failReads = false;
const localStorage = {
  getItem(key) { if (failReads) throw Error('storage unavailable'); return data.get(key) ?? null; },
  setItem(key, value) { if (failWrites) throw Error('quota exceeded'); data.set(key, value); },
};
const store = new Function('localStorage', 'queueMicrotask', 'toast',
  source.slice(start, end) + '\nreturn store;'
)(localStorage, fn => deferred.push(fn), message => notices.push(message));
store.set('pos.book', { word: 1 });
failWrites = true;
store.set('pos.book', { word: 12 });
assert.deepEqual(store.get('pos.book'), { word: 12 }, 'Failed write reverted reading progress');
store.set('autoScroll', false);
assert.equal(store.get('autoScroll', true), false, 'New failed setting was lost');
for (const fn of deferred.splice(0)) fn();
assert.equal(notices.length, 1, 'Storage failure should be announced once per session');
failWrites = false;
store.set('pos.book', { word: 13 });
assert.deepEqual(JSON.parse(data.get('aloud.pos.book')), { word: 13 }, 'Recovered write was not persisted');
// A recovered key must return to normal cross-window reads, rather than
// permanently preferring a stale memory copy.
data.set('aloud.pos.book', JSON.stringify({ word: 14 }));
assert.deepEqual(store.get('pos.book'), { word: 14 }, 'Recovered key ignored an external update');
failReads = true;
assert.deepEqual(store.get('pos.book'), { word: 13 }, 'Unreadable storage lost the in-session fallback');
assert.equal(store.get('unknown', 'default'), 'default');
console.log('storage self-check: PASS (failed writes, recovery, external updates, one notice)');
