/* Production lookahead ordering under advancing playback and manual seeks. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const root = process.env.ALOUD_ROOT || fileURLToPath(new URL('../', import.meta.url));
const source = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const a = source.indexOf('async function neuralPump() {');
const b = source.indexOf("/* Kokoro's context window", a);
assert(a >= 0 && b > a, 'Production lookahead not found');
async function scenario(change) {
  const S = { playing: true, pumpBusy: false, kokoro: { state: 'ready' }, engine: 'neural',
    rate: 3, curSent: 0, docGeneration: 0, speechGeneration: 0, neuralVoice: 'voice',
    sentences: Array(40), neuralCache: new Map() };
  const requests = [], skipped = new Set([2]);
  const key = i => `${S.docGeneration}|${S.speechGeneration}|${i}|${S.neuralVoice}`;
  const seekPlayable = from => { while (skipped.has(from)) from++; return from < S.sentences.length ? from : -1; };
  const generate = async i => { requests.push(i); S.neuralCache.set(key(i), {}); change?.(S, requests.length); };
  const pump = new Function('S', 'generateNeural', 'rsvpSilentActive', 'seekPlayable', 'neuralCacheKey',
    source.slice(a, b) + '\nreturn neuralPump;')(S, generate, () => false, seekPlayable, key);
  await pump();
  assert.equal(S.pumpBusy, false, 'Lookahead retained the busy lock');
  return { S, requests, pump };
}
const advancing = await scenario((S, n) => { if (n === 1) S.curSent = 3; });
assert.deepEqual(advancing.requests.slice(0, 3), [1, 4, 5], 'Advancing playback skipped the next needed sentence');
assert(!advancing.requests.includes(2), 'Lookahead generated a speech-skipped sentence');
const seeking = await scenario((S, n) => { if (n === 1) S.curSent = 10; if (n === 2) S.curSent = 4; });
assert.deepEqual(seeking.requests.slice(0, 4), [1, 11, 5, 6], 'Manual seek kept preloading the old position');
const paused = await scenario((S, n) => { if (n === 1) S.playing = false; });
assert.equal(paused.requests.length, 1, 'Lookahead continued after pause');
const changed = await scenario((S, n) => { if (n === 1) S.speechGeneration++; });
assert.equal(changed.requests.length, 1, 'Lookahead continued after speech changed');
const cached = await scenario();
const count = cached.requests.length;
await cached.pump();
assert.equal(cached.requests.length, count, 'A full runway generated beyond the configured depth');
console.log('neural preload self-check: PASS (advance, seek, skip, pause, stale speech, bounded runway)');
