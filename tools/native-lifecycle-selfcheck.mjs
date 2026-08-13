/* Native iOS pause/foreground recovery regression check.
 *
 * Loads the production helpers from index.html instead of keeping test-only
 * copies. No model, browser, iPad, or network access is required.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.ALOUD_ROOT
  || path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const INDEX = path.join(ROOT, 'index.html');
const src = fs.readFileSync(INDEX, 'utf8');
const bridgeSrc = fs.readFileSync(path.join(ROOT, 'ios/Aloud.swiftpm/BridgeScript.swift'), 'utf8');
const nativeEngineSrc = fs.readFileSync(path.join(ROOT, 'ios/Aloud.swiftpm/NativeKokoroEngine.swift'), 'utf8');

function fail(message) {
  console.error(`native lifecycle self-check: FAIL — ${message}`);
  process.exitCode = 1;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function extractNamedFunction(source, name) {
  const match = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(source);
  if (!match) throw new Error(`missing production ${name}()`);
  const open = source.indexOf('{', match.index + match[0].length);
  if (open < 0) throw new Error(`could not find body of ${name}()`);
  let depth = 0, mode = 'code';
  for (let i = open; i < source.length; i++) {
    const ch = source[i], next = source[i + 1];
    if (mode === 'line') { if (ch === '\n') mode = 'code'; continue; }
    if (mode === 'block') { if (ch === '*' && next === '/') { mode = 'code'; i++; } continue; }
    if (mode === 'single' || mode === 'double' || mode === 'template') {
      if (ch === '\\') { i++; continue; }
      if ((mode === 'single' && ch === "'") || (mode === 'double' && ch === '"') ||
          (mode === 'template' && ch === '`')) mode = 'code';
      continue;
    }
    if (ch === '/' && next === '/') { mode = 'line'; i++; continue; }
    if (ch === '/' && next === '*') { mode = 'block'; i++; continue; }
    if (ch === "'") { mode = 'single'; continue; }
    if (ch === '"') { mode = 'double'; continue; }
    if (ch === '`') { mode = 'template'; continue; }
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return source.slice(match.index, i + 1);
  }
  throw new Error(`unterminated production ${name}()`);
}

function grab(from, to) {
  const a = src.indexOf(from), b = src.indexOf(to, a + from.length);
  if (a < 0 || b < 0) throw new Error(`could not extract source between ${from} and ${to}`);
  return src.slice(a, b);
}

function testNativeChunkCap() {
  /* This helper contains a character-class regex with a literal quote. Use the
     stable production-function boundary instead of making this tiny test
     harness pretend to be a complete JavaScript parser. */
  const fnSource = grab('function kokoroTokenEstimate', '\n\nasync function generateNeuralNow');
  const make = nativeKokoro => new Function('NATIVE', 'phonemeCache', 'spokenFor',
    `${fnSource}\nreturn { kokoroChunkRanges, splitOversizeKokoroToken, kokoroTokenEstimate };`
  )({ nativeKokoro }, new Map(), value => value);
  const tokens = Array.from({ length: 72 }, () => 'abcdefghij'); // estimate: 11 phones each
  const nativeAPI = make(true), browserAPI = make(false);
  const nativeRanges = nativeAPI.kokoroChunkRanges(tokens);
  const browserRanges = browserAPI.kokoroChunkRanges(tokens);
  const widest = ranges => Math.max(...ranges.map(([a, b]) => (b - a) * 11));
  assert(widest(nativeRanges) <= 140, `native chunk estimate exceeded 140 (${widest(nativeRanges)})`);
  assert(widest(browserRanges) <= 300, `browser chunk estimate exceeded 300 (${widest(browserRanges)})`);
  assert(nativeRanges.length > browserRanges.length, 'native default did not split more conservatively');
  assert(nativeAPI.kokoroChunkRanges(tokens, 22).every(([a, b]) => b - a <= 2), 'explicit cap override stopped working');
  const giant = 'A'.repeat(500);
  const fragments = nativeAPI.splitOversizeKokoroToken(giant);
  assert(fragments.length > 1, 'oversize display token was still sent as one native MLX request');
  assert(fragments.join('') === giant, 'oversize display token lost spoken content');
  assert(fragments.every(fragment => fragment.length * 8 + 1 <= 140),
         'oversize fallback fragment still exceeded the native estimate cap');
  const initialism = 'W'.repeat(40);
  const initialismFragments = nativeAPI.splitOversizeKokoroToken(initialism);
  assert(nativeAPI.kokoroTokenEstimate(initialism) > 140 && initialismFragments.length > 1,
         'medium unknown initialism bypassed the native phoneme cap');
  assert(initialismFragments.join('') === initialism &&
         initialismFragments.every(fragment => nativeAPI.kokoroTokenEstimate(fragment) <= 140),
         'medium initialism split lost text or retained an oversize fragment');
  console.log(`native chunk cap                 ${nativeRanges.length} chunks vs browser ${browserRanges.length}`);
}

function makeCacheHarness(nativeKokoro, entries, activeUrl = '') {
  const S = { neuralCache: new Map(entries), audio: activeUrl ? { src: activeUrl } : null };
  const revoked = [];
  const cacheSource = grab('const NEURAL_CACHE_ENTRY_LIMIT', '\nfunction invalidateNeuralSpeech');
  const api = new Function('NATIVE', 'S', 'URL',
    `${cacheSource}\nreturn { trimNeuralCache, budget: NEURAL_PCM_CACHE_BUDGET, limit: NEURAL_CACHE_ENTRY_LIMIT };`
  )({ nativeKokoro }, S, { revokeObjectURL: url => revoked.push(url) });
  return { S, revoked, ...api };
}

function pcmEntry(index, bytes) {
  return [`k${index}`, { url: `blob:${index}`, pcmBytes: bytes, durationSec: bytes / 48000 }];
}

function testCacheBudget() {
  const mib = 1024 * 1024;
  const native = makeCacheHarness(true,
    Array.from({ length: 16 }, (_, i) => pcmEntry(i, 3 * mib)), 'blob:0');
  native.trimNeuralCache();
  const nativeBytes = [...native.S.neuralCache.values()].reduce((n, entry) => n + entry.pcmBytes, 0);
  assert(nativeBytes <= native.budget, `native PCM cache remained over budget (${nativeBytes})`);
  assert(native.S.neuralCache.has('k0'), 'trim revoked the actively playing URL');
  assert(native.S.neuralCache.has('k15'), 'trim revoked the just-created entry');

  const browser = makeCacheHarness(false,
    Array.from({ length: 16 }, (_, i) => pcmEntry(i, 3 * mib)));
  browser.trimNeuralCache();
  assert(browser.S.neuralCache.size === 16, 'browser 64 MiB budget was reduced unexpectedly');

  const count = makeCacheHarness(true,
    Array.from({ length: 30 }, (_, i) => pcmEntry(i, 1024)));
  count.trimNeuralCache();
  assert(count.S.neuralCache.size === count.limit, `entry cap returned ${count.S.neuralCache.size}, expected ${count.limit}`);
  console.log(`PCM cache budget                  native ${(nativeBytes / mib).toFixed(0)} MiB; browser entries ${browser.S.neuralCache.size}`);
}

function makePumpHarness({ playing = true, hidden = false, active = true, busy = false, native = true } = {}) {
  const lifecycle = { active, busy };
  const document = { hidden };
  const calls = [];
  const S = {
    pumpBusy: false,
    kokoro: { state: 'ready' },
    engine: 'neural',
    playing,
    rate: 1,
    curSent: 0,
    sentences: Array.from({ length: 8 }, () => ({})),
  };
  const fnSource = extractNamedFunction(src, 'neuralPump');
  const canGenerateSource = extractNamedFunction(src, 'nativeKokoroCanGenerate');
  const api = new Function(
    'NATIVE', 'S', 'document', 'lifecycle', 'calls',
    `const rsvpSilentActive = () => false;
     let nativeKokoroAppActive = lifecycle.active;
     let nativeKokoroBusy = lifecycle.busy;
     const generateNeural = async index => { calls.push(index); };
     ${canGenerateSource}
     ${fnSource}
     return {
       pump: neuralPump,
       sync() { nativeKokoroAppActive = lifecycle.active; nativeKokoroBusy = lifecycle.busy; }
     };`
  )({ nativeKokoro: native }, S, document, lifecycle, calls);
  return {
    S, document, lifecycle, calls,
    async neuralPump() { api.sync(); await api.pump(); },
  };
}

async function testNativePumpGates() {
  for (const [label, options] of [
    ['paused', { playing: false }],
    ['hidden', { hidden: true }],
    ['busy', { busy: true }],
    ['inactive', { active: false }],
  ]) {
    const harness = makePumpHarness(options);
    await harness.neuralPump();
    assert(harness.calls.length === 0, `native pump generated while ${label}`);
  }

  /* Even active foreground playback must not run speculative native MLX.
     Current-sentence generation is requested directly by speakNeural(); this
     helper is only look-ahead and made a later Pause collide with Metal. */
  const active = makePumpHarness({ playing: true, hidden: false, active: true, busy: false });
  await active.neuralPump();
  assert(active.calls.length === 0, 'native pump generated speculative foreground speech');

  /* Browser Kokoro intentionally retains its historical paused runway. */
  const browser = makePumpHarness({ playing: false, hidden: true, active: false, busy: true, native: false });
  await browser.neuralPump();
  assert(browser.calls.length > 0, 'browser paused runway changed unexpectedly');
  console.log(`native generation pump             disabled; browser runway kept ${browser.calls.length} requests`);
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function flushUntil(predicate, message) {
  for (let i = 0; i < 20 && !predicate(); i++) await Promise.resolve();
  assert(predicate(), message);
}

function makeNativePendingEpochHarness() {
  const generations = [];
  const calls = { epochs: [], cancels: 0 };
  const S = {
    docGeneration: 1,
    speechGeneration: 1,
    neuralVoice: 'am_fenrir',
    neuralCache: new Map(),
    neuralPending: new Map(),
  };
  const generateSource = extractNamedFunction(src, 'generateNeural');
  const cancelSource = extractNamedFunction(src, 'cancelNativeKokoroGenerations');
  const api = new Function('S', 'generations', 'calls',
    `const NATIVE = {
       nativeKokoro: true,
       kokoro: { cancelGenerations() { calls.cancels++; } }
     };
     let nativeKokoroGenerationEpoch = 0;
     let genTail = Promise.resolve();
     const neuralCacheKey = (sentIdx, voice, doc, speech) =>
       doc + '|' + speech + '|' + sentIdx + '|' + voice;
     const generateNeuralNow = (sentIdx, key, doc, speech, voice, epoch) => {
       calls.epochs.push(epoch);
       const generation = generations.shift();
       if (!generation) throw new Error('unexpected native generation');
       return generation.promise;
     };
     ${generateSource}
     ${cancelSource}
     return {
       generate: generateNeural,
       cancel: cancelNativeKokoroGenerations,
       clearPending() { S.neuralPending.clear(); },
       pendingOwns(job) { return [...S.neuralPending.values()].includes(job); },
       pendingCount() { return S.neuralPending.size; },
       epoch() { return nativeKokoroGenerationEpoch; }
     };`
  )(S, generations, calls);
  return { ...api, S, calls, generations };
}

async function testNativePendingGenerationEpoch() {
  /* The reported failure: a replacement Play for the same sentence reused a
     cancelled pending promise. Its EngineReset was then mistaken for the
     replacement's own teardown, leaving playing=true with no audio/spinner. */
  const epoch = makeNativePendingEpochHarness();
  const staleNative = deferred(), freshNative = deferred();
  epoch.generations.push(staleNative, freshNative);
  const stale = epoch.generate(0);
  stale.catch(() => {});
  await flushUntil(() => epoch.calls.epochs.length === 1, 'stale native generation did not start');
  epoch.cancel();
  assert(epoch.epoch() === 1 && epoch.calls.cancels === 1,
         'native cancellation did not advance the pending-generation epoch');
  const replacement = epoch.generate(0);
  assert(replacement !== stale, 'replacement Play reused the cancelled same-sentence promise');
  staleNative.reject(Object.assign(new Error('cancelled'), { name: 'EngineReset' }));
  await Promise.allSettled([stale]);
  await flushUntil(() => epoch.calls.epochs.length === 2, 'fresh generation stayed behind cancelled pending work');
  assert(epoch.calls.epochs.join(',') === '0,1',
         `replacement used the wrong native epoch (${epoch.calls.epochs.join(',')})`);
  freshNative.resolve({ fresh: true });
  assert((await replacement).fresh, 'replacement did not receive fresh generation output');

  /* A stale finally must not delete a new map owner even if another reset
     clears and repopulates the same key before the old job settles. */
  const cleanup = makeNativePendingEpochHarness();
  const oldNative = deferred(), newNative = deferred();
  cleanup.generations.push(oldNative, newNative);
  const oldJob = cleanup.generate(3);
  oldJob.catch(() => {});
  await flushUntil(() => cleanup.calls.epochs.length === 1, 'cleanup old generation did not start');
  cleanup.clearPending();
  const newJob = cleanup.generate(3);
  oldNative.reject(Object.assign(new Error('old owner'), { name: 'EngineReset' }));
  await Promise.allSettled([oldJob]);
  await flushUntil(() => cleanup.calls.epochs.length === 2, 'cleanup replacement did not start');
  assert(cleanup.pendingOwns(newJob) && cleanup.pendingCount() === 1,
         'old finally deleted the newer same-key pending owner');
  newNative.resolve({ fresh: true });
  await newJob;
  console.log('native pending generation           cancelled promise isolated by epoch; cleanup identity-safe');
}

function fakeTimers() {
  let next = 1;
  const intervals = new Map(), timeouts = new Map();
  return {
    setInterval(fn) { const id = next++; intervals.set(id, fn); return id; },
    clearInterval(id) { intervals.delete(id); },
    setTimeout(fn) { const id = next++; timeouts.set(id, fn); return id; },
    clearTimeout(id) { timeouts.delete(id); },
    tick() { for (const fn of [...intervals.values()]) fn(); },
    expire() {
      const due = [...timeouts.entries()];
      timeouts.clear();
      for (const [, fn] of due) fn();
    },
    get pendingTimeouts() { return timeouts.size; },
  };
}

function makeResumeHarness(playResult) {
  const timers = fakeTimers();
  const audio = {
    currentTime: 12,
    paused: true,
    ended: false,
    play() { this.paused = false; return playResult; },
  };
  const play = { id: 1, hasPlayed: false };
  const S = { audio, audioPlay: play, playing: true, engine: 'neural', curWord: 37, sentences: [{}] };
  const calls = { dispose: 0, prime: 0, words: [], warnings: 0 };
  const watchSource = extractNamedFunction(src, 'armNativeNeuralAudioWatchdog');
  const fnSource = extractNamedFunction(src, 'resumePersistentNeuralAudio');
  const api = new Function(
    'NATIVE', 'S', 'document', 'nativeKokoroAppActive',
    'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout',
    'dispose', 'prime', 'playCurrent', 'log',
    `let neuralResumeEpoch = 0, neuralAudioRecoveryPending = false, nativeNeuralAudioNeedsRefresh = true, NA = S.audio;
     const disposeNeuralAudio = () => { neuralResumeEpoch++; NA = null; S.audio = null; S.audioPlay = null; dispose(); };
     const primeAudioGesture = prime;
     const pauseAll = () => { S.playing = false; };
     const toast = () => {};
     const console = log;
     ${watchSource}
     ${fnSource}
     return {
       resumePersistentNeuralAudio,
       replaceAudio(audio, play) { NA = audio; S.audio = audio; S.audioPlay = play; S.playing = true; },
       needsRefresh() { return nativeNeuralAudioNeedsRefresh; }
     };`
  )(
    { nativeKokoro: true }, S, { hidden: false }, true,
    timers.setInterval, timers.clearInterval, timers.setTimeout, timers.clearTimeout,
    () => { calls.dispose++; }, () => { calls.prime++; }, word => calls.words.push(word),
    { warn: () => { calls.warnings++; } },
  );
  return { audio, S, calls, timers, ...api };
}

async function testResumeWatchdog() {
  const stalled = makeResumeHarness(Promise.resolve());
  assert(stalled.resumePersistentNeuralAudio(), 'native persistent resume was not watched');
  await Promise.resolve();
  stalled.timers.expire();
  assert(stalled.calls.dispose === 1, 'stalled resolved play did not rebuild exactly once');
  assert(stalled.calls.prime === 1, 'rebuilt audio was not primed');
  assert(stalled.calls.words.join(',') === '37', 'rebuild did not resume from the captured word');
  stalled.timers.expire();
  assert(stalled.calls.dispose === 1, 'watchdog rebuilt more than once');

  /* The replacement also stalls. It must stop after this second attempt;
     seek/timeupdate noise may not clear the one-rebuild latch. */
  const replacement = {
    currentTime: 0,
    paused: true,
    ended: false,
    play() { this.paused = false; return Promise.resolve(); },
  };
  stalled.replaceAudio(replacement, { id: 2, hasPlayed: false });
  assert(stalled.resumePersistentNeuralAudio(), 'replacement audio was not watched');
  stalled.timers.expire();
  assert(stalled.calls.dispose === 2, 'second stalled pipeline was not disposed');
  assert(stalled.calls.prime === 1 && stalled.calls.words.length === 1,
         'second stall entered an unbounded rebuild loop');
  assert(!stalled.S.playing, 'second stalled pipeline did not settle paused');

  const pending = makeResumeHarness(new Promise(() => {}));
  pending.resumePersistentNeuralAudio();
  pending.timers.expire();
  assert(pending.calls.dispose === 1, 'pending play did not trigger recovery');

  const brief = makeResumeHarness(Promise.resolve());
  brief.resumePersistentNeuralAudio();
  brief.S.audioPlay.hasPlayed = true;
  brief.audio.currentTime += 0.1;
  brief.timers.tick();                              // post-playing baseline
  brief.audio.currentTime += 0.1;
  brief.timers.tick();                              // a brief audible burst
  assert(brief.needsRefresh(), 'brief audio incorrectly cleared the stale-pipeline marker');
  assert(brief.timers.pendingTimeouts === 1,
         'brief media progress permanently disarmed the watchdog');
  brief.timers.expire();                            // then no progress for 4s
  assert(brief.calls.dispose === 1 && brief.calls.words.join(',') === '37',
         'brief-then-frozen audio was not rebuilt from the current word');

  /* A replacement that only coughs briefly must stop after the one allowed
     rebuild, rather than clearing the latch and recursing forever. */
  const briefReplacement = {
    currentTime: 0,
    paused: true,
    ended: false,
    play() { this.paused = false; return Promise.resolve(); },
  };
  brief.replaceAudio(briefReplacement, { id: 2, hasPlayed: true });
  assert(brief.resumePersistentNeuralAudio(), 'brief replacement was not watched');
  briefReplacement.currentTime += 0.1;
  brief.timers.tick();
  briefReplacement.currentTime += 0.1;
  brief.timers.tick();
  brief.timers.expire();
  assert(brief.calls.dispose === 2 && brief.calls.prime === 1 && brief.calls.words.length === 1,
         'brief replacement authorized an unbounded rebuild loop');
  assert(!brief.S.playing, 'second brief stall did not settle paused');

  const moving = makeResumeHarness(Promise.resolve());
  moving.resumePersistentNeuralAudio();
  moving.S.audioPlay.hasPlayed = true;
  moving.audio.currentTime += 0.1;
  moving.timers.tick();
  for (let i = 0; i < 10; i++) {
    moving.audio.currentTime += 0.1;
    moving.timers.tick();
    assert(moving.timers.pendingTimeouts === 1, 'moving audio lost its inactivity deadline');
  }
  assert(!moving.needsRefresh(), 'sustained healthy playback retained the stale-pipeline marker');
  assert(moving.calls.dispose === 0, 'continuously moving audio was rebuilt');

  const seekOnly = makeResumeHarness(Promise.resolve());
  seekOnly.resumePersistentNeuralAudio();
  seekOnly.audio.currentTime += 5;
  seekOnly.timers.tick();
  assert(seekOnly.timers.pendingTimeouts === 1, 'metadata seek falsely satisfied the watchdog');
  seekOnly.timers.expire();
  assert(seekOnly.calls.dispose === 1, 'seek-only dead pipeline was not rebuilt');

  const shortSuccess = makeResumeHarness(Promise.resolve());
  shortSuccess.resumePersistentNeuralAudio();
  shortSuccess.S.audioPlay.hasPlayed = true;
  /* Production's ended listener clears the recovery latch before releasing
     S.audioPlay; verify that exact integration exists, then simulate the
     listener releasing ownership before the watchdog's next poll. */
  const ensureAudioSource = extractNamedFunction(src, 'ensureNeuralAudio');
  const endedAt = ensureAudioSource.indexOf("na.addEventListener('ended'");
  const clearAt = ensureAudioSource.indexOf('neuralAudioRecoveryPending = false', endedAt);
  const releaseAt = ensureAudioSource.indexOf('S.audioPlay = null', endedAt);
  assert(endedAt >= 0 && clearAt > endedAt && releaseAt > clearAt,
         'real audio-ended path does not clear the recovery latch before releasing ownership');
  shortSuccess.audio.ended = true;
  shortSuccess.S.audioPlay = null;
  shortSuccess.timers.tick();
  shortSuccess.timers.expire();
  assert(shortSuccess.calls.dispose === 0,
         'short successful clip was mistaken for a stalled media pipeline');
  console.log('persistent audio watchdog           resolved stalls, brief freezes, and ignored seeks');
}

function makeActivationHarness({ stale = false, pausedFor = 0 } = {}) {
  let resolveActivation, rejectActivation;
  const activation = new Promise((resolve, reject) => {
    resolveActivation = resolve;
    rejectActivation = reject;
  });
  const calls = { begin: [], toasts: 0, icon: [], primed: [], disposed: 0, warnings: 0 };
  let gestureActive = true;
  const source = extractNamedFunction(src, 'requestPlaybackStart');
  const api = new Function(
    'activation', 'calls', 'gestureIsActive',
    `let nativePlayIntent = 0, nativePlayActivationPending = false, nativeKokoroAppActive = false;
     let nativeNeuralAudioNeedsRefresh = ${stale ? 'true' : 'false'};
     let nativeNeuralPausedAt = ${pausedFor ? `Date.now() - ${pausedFor}` : '0'};
     const NATIVE_AUDIO_STALE_AFTER_MS = 15000;
     const S = { engine: 'neural', audioPlay: ${stale ? '{}' : 'null'} };
     const NATIVE = { nativeKokoro: true, reactivateAudio: () => activation };
     const console = { warn() { calls.warnings++; } };
     const $ = () => ({ classList: { add() {}, remove() {} } });
     const disposeNeuralAudio = () => { calls.disposed++; S.audioPlay = null; nativeNeuralAudioNeedsRefresh = false; };
     const primeAudioGesture = () => calls.primed.push(gestureIsActive());
     const beginRequestedPlayback = options => calls.begin.push(options || {});
     const setPlayIcon = value => calls.icon.push(value);
     const toast = () => { calls.toasts++; };
     ${source}
     return {
       requestPlaybackStart,
       cancel() { nativePlayIntent++; nativePlayActivationPending = false; },
       state() { return { nativePlayActivationPending, nativeKokoroAppActive }; }
     };`
  )(activation, calls, () => gestureActive);
  return {
    ...api, calls, resolveActivation, rejectActivation,
    endGesture() { gestureActive = false; },
  };
}

async function testActivationOrdering() {
  const success = makeActivationHarness();
  success.requestPlaybackStart();
  assert(success.calls.primed.length === 1 && success.calls.primed[0] === true,
         'persistent audio was not primed inside the iOS Play gesture');
  assert(success.calls.begin.length === 1,
         'fresh Play was gated on a native bridge reply instead of starting in the gesture turn');
  success.endGesture();
  success.resolveActivation({ active: true });
  await Promise.resolve(); await Promise.resolve();
  assert(success.calls.begin.length === 1 && success.state().nativeKokoroAppActive,
         'late native activation reply restarted Play or failed to refresh health');

  const cancelled = makeActivationHarness();
  cancelled.requestPlaybackStart();
  cancelled.endGesture();
  cancelled.cancel();
  cancelled.resolveActivation({ active: true });
  await Promise.resolve(); await Promise.resolve();
  assert(cancelled.calls.begin.length === 1 && !cancelled.state().nativeKokoroAppActive,
         'late activation reply overrode the newer Pause intent');

  const forced = makeActivationHarness();
  forced.requestPlaybackStart({ forceRestart: true });
  forced.endGesture();
  forced.resolveActivation({ active: true });
  await Promise.resolve(); await Promise.resolve();
  assert(forced.calls.begin[0]?.forceRestart === true,
         'word-start force-restart intent was lost on immediate Play');

  const failed = makeActivationHarness();
  failed.requestPlaybackStart();
  failed.endGesture();
  failed.rejectActivation(new Error('activation failed'));
  await Promise.resolve(); await Promise.resolve();
  assert(failed.calls.begin.length === 1 && failed.calls.toasts === 0 && failed.calls.warnings === 1,
         'fire-and-forget audio reactivation blocked or rewound fresh Play');

  const stale = makeActivationHarness({ stale: true });
  stale.requestPlaybackStart();
  stale.endGesture();
  assert(stale.calls.disposed === 1 && stale.calls.primed[0] === true,
         'long-suspended paused audio was not replaced and primed inside Play');

  const background = makeActivationHarness({ stale: true });
  background.requestPlaybackStart({ allowBackground: true });
  background.endGesture();
  assert(background.calls.disposed === 0,
         'remote background Play discarded the lock-screen audio pipeline');

  const foregroundPause = makeActivationHarness({ pausedFor: 16000 });
  foregroundPause.requestPlaybackStart();
  foregroundPause.endGesture();
  assert(foregroundPause.calls.disposed === 1 && foregroundPause.calls.primed[0] === true,
         'long foreground pause was not replaced and primed inside Play');
  console.log('native audio activation             fresh Play immediate; late health reply intent-safe');
}

function makeBusyHandoffHarness({ busySeconds = 7 } = {}) {
  let nextTimer = 1;
  const timers = new Map();
  const setTimeoutFake = (fn, delay = 0) => {
    const id = nextTimer++;
    timers.set(id, { fn, delay });
    return id;
  };
  const clearTimeoutFake = id => timers.delete(id);
  const runDelay = delay => {
    const due = [...timers.entries()].filter(([, timer]) => timer.delay === delay);
    for (const [id, timer] of due) {
      if (!timers.delete(id)) continue;
      timer.fn();
    }
  };
  const loading = new Set();
  const calls = {
    kokoroStarts: [], nativeSpeaks: [], advances: [], cancels: 0,
    toasts: 0, loading: [], pauses: 0, stops: 0, refreshes: 0,
  };
  const S = {
    playing: true,
    engine: 'neural',
    neuralVoice: 'am_fenrir',
    audioPlay: null,
    sentences: [{}, {}, {}],
    curSent: 0,
    curWord: 14,
    neuralCache: new Map(),
  };
  const holdSource = extractNamedFunction(src, 'holdKokoroForBusyQueue');
  const clearSource = extractNamedFunction(src, 'clearNativeKokoroBusyWait');
  const clearFallbackSource = extractNamedFunction(src, 'clearNativeKokoroBusyFallback');
  const startFallbackSource = extractNamedFunction(src, 'startNativeKokoroBusyFallback');
  const timeoutSource = extractNamedFunction(src, 'armNativeKokoroBusyTimeout');
  const routeSource = extractNamedFunction(src, 'routeNativeKokoroBusyFallback');
  const failureSource = extractNamedFunction(src, 'handleNeuralFailure');
  const resumeSource = extractNamedFunction(src, 'resumeKokoroAfterForeground');
  const suspendSource = extractNamedFunction(src, 'suspendNativeKokoroWork');
  const remoteAdvanceSource = extractNamedFunction(src, 'remoteAdvanceSentence');
  const api = new Function(
    'S', 'document', 'calls', 'loading', 'setTimeout', 'clearTimeout', 'initialBusySeconds',
    `const NATIVE = {
       nativeKokoro: true,
       refreshAppActivity() { calls.refreshes++; }
     };
     let nativeKokoroBusy = true, nativeKokoroAppActive = true;
     let nativeKokoroBusySeconds = initialBusySeconds, nativeKokoroBusyNoticeAt = 0;
     let nativeKokoroBusyTimer = null, nativeKokoroResumeTimer = null;
     let kokoroResumeOnForeground = false;
     let nativePlayIntent = 0;
     const NATIVE_KOKORO_BUSY_COVER_AFTER_MS = 3000;
     const nativeKokoroBusyFallback = { phase: 'idle', handoffReady: false };
     const $ = () => ({ classList: {
       add(value) { loading.add(value); calls.loading.push('add:' + value); },
       remove(value) { loading.delete(value); calls.loading.push('remove:' + value); }
     }});
     const cancelNativeKokoroGenerations = () => { calls.cancels++; };
     const clearNativeKokoroGenerationWatchdog = () => {};
     const toast = () => { calls.toasts++; };
     const setPlayIcon = () => {};
     const invalidateNeuralSpeech = () => {};
     const neuralCacheKey = sentIdx => 'sentence:' + sentIdx;
     const speakNative = (sentIdx, word, owner) => {
       calls.nativeSpeaks.push({ sentIdx, word, owner });
       S.playing = true;
     };
     const playCurrent = word => { calls.kokoroStarts.push(word); S.playing = true; };
     const advanceSentence = (dir, keepPlaying) => {
       calls.advances.push([dir, keepPlaying]);
       S.curSent += dir;
       S.curWord += dir * 10;
     };
     ${clearSource}
     ${clearFallbackSource}
     const pauseAll = () => {
       calls.pauses++;
       if (nativeKokoroBusyFallback.phase === 'covering') calls.stops++;
       S.playing = false;
       clearNativeKokoroBusyFallback();
       nativePlayIntent++;
       loading.delete('loading');
       calls.loading.push('pause');
     };
     ${startFallbackSource}
     ${timeoutSource}
     ${holdSource}
     ${routeSource}
     ${resumeSource}
     ${failureSource}
     ${suspendSource}
     ${remoteAdvanceSource}
     return {
       hold: holdKokoroForBusyQueue,
       fail: handleNeuralFailure,
       route: routeNativeKokoroBusyFallback,
       setBusy(value, seconds = nativeKokoroBusySeconds) {
         nativeKokoroBusy = value;
         nativeKokoroBusySeconds = seconds;
       },
       idle() {
         nativeKokoroBusy = false;
         nativeKokoroBusySeconds = 0;
         if (nativeKokoroBusyFallback.phase === 'covering') {
           nativeKokoroBusyFallback.handoffReady = true;
           return;
         }
         clearTimeout(nativeKokoroBusyTimer);
         nativeKokoroBusyTimer = null;
         resumeKokoroAfterForeground(0);
       },
       busyEvent(seconds = nativeKokoroBusySeconds) {
         nativeKokoroBusy = true;
         nativeKokoroBusySeconds = seconds;
         if (nativeKokoroBusyFallback.phase === 'covering') {
           nativeKokoroBusyFallback.handoffReady = false;
           return;
         }
         holdKokoroForBusyQueue();
       },
       hide() {
         document.hidden = true;
         nativeKokoroAppActive = false;
         suspendNativeKokoroWork();
       },
       showBusy(seconds = nativeKokoroBusySeconds) {
         document.hidden = false;
         nativeKokoroAppActive = true;
         this.busyEvent(seconds);
       },
       cache(sentIdx) { S.neuralCache.set(neuralCacheKey(sentIdx), {}); },
       moveTo(sentIdx, word) { S.curSent = sentIdx; S.curWord = word; },
       pause: pauseAll,
       explicitCancel() {
         nativePlayIntent++;
         clearNativeKokoroBusyFallback();
       },
       remoteNext() { remoteAdvanceSentence(1); },
       activeRemoteNext() { S.playing = true; remoteAdvanceSentence(1); },
       state() {
         return {
           playing: S.playing,
           resume: kokoroResumeOnForeground,
           busy: nativeKokoroBusy,
           loading: loading.has('loading'),
           timers: nativeKokoroBusyTimer == null ? 0 : 1,
           pauses: calls.pauses,
           phase: nativeKokoroBusyFallback.phase,
           handoff: nativeKokoroBusyFallback.handoffReady,
         };
       }
     };`
  )(
    S, { hidden: false }, calls, loading, setTimeoutFake, clearTimeoutFake, busySeconds,
  );
  return {
    ...api, S, calls, runDelay,
    timerDelays: () => [...timers.values()].map(timer => timer.delay),
  };
}

function testBusyHandoff() {
  const fresh = makeBusyHandoffHarness({ busySeconds: 0 });
  assert(fresh.route(0, 14), 'busy route did not take ownership before generation');
  assert(fresh.calls.nativeSpeaks.length === 0 && fresh.state().phase === 'waiting' &&
         fresh.state().resume && fresh.state().loading,
         'fresh busy request did not retain a visible bounded wait');
  assert(fresh.timerDelays().join(',') === '3000',
         `fresh busy grace was not 3 seconds (${fresh.timerDelays()})`);

  const old = makeBusyHandoffHarness({ busySeconds: 7 });
  assert(old.route(0, 14), 'old busy route did not take ownership');
  assert(old.timerDelays().join(',') === '250',
         'already-old MLX call did not receive the minimum adaptive grace');
  old.runDelay(250);
  assert(old.state().phase === 'covering' && old.state().playing &&
         !old.state().resume && !old.state().loading,
         'bounded wait did not enter audible fallback cleanly');
  assert(JSON.stringify(old.calls.nativeSpeaks) ===
         JSON.stringify([{ sentIdx: 0, word: 14, owner: 'kokoro-busy' }]),
         'fallback did not start the iOS voice from the selected word');
  assert(old.S.engine === 'neural' && old.S.neuralVoice === 'am_fenrir',
         'temporary fallback rewrote the Neural/Fenrir preference');

  const repeated = old.calls.nativeSpeaks.length;
  const pausesBeforeHealth = old.calls.pauses;
  old.busyEvent(9);
  old.busyEvent(10);
  assert(old.state().phase === 'covering' && !old.state().handoff &&
         old.calls.nativeSpeaks.length === repeated && old.calls.pauses === pausesBeforeHealth,
         'repeated busy lifecycle reports stopped or restarted Apple coverage');

  old.moveTo(1, 24);
  assert(old.route(1, 24) && old.calls.nativeSpeaks.at(-1)?.word === 24,
         'continued busy state did not cover the next sentence');
  const beforeIdle = old.calls.nativeSpeaks.length;
  old.idle();
  assert(old.state().phase === 'covering' && old.state().handoff &&
         old.calls.nativeSpeaks.length === beforeIdle,
         'idle health event cut into the current Apple sentence');
  old.moveTo(2, 34);
  assert(!old.route(2, 34) && old.state().phase === 'idle',
         'idle handoff did not return the next sentence to Kokoro');

  const flapped = makeBusyHandoffHarness({ busySeconds: 8 });
  flapped.route(0, 14);
  flapped.runDelay(250);
  flapped.idle();
  flapped.busyEvent(9);
  flapped.moveTo(1, 24);
  assert(flapped.route(1, 24) && flapped.calls.nativeSpeaks.length === 2,
         'busy-again lifecycle failed to withdraw a pending handoff');

  const cached = makeBusyHandoffHarness({ busySeconds: 8 });
  cached.cache(0);
  assert(!cached.route(0, 14) && cached.state().phase === 'idle' &&
         cached.calls.nativeSpeaks.length === 0 && cached.state().timers === 0,
         'cached Fenrir sentence unnecessarily entered native fallback');

  const hiddenCover = makeBusyHandoffHarness({ busySeconds: 8 });
  hiddenCover.route(0, 14);
  hiddenCover.runDelay(250);
  hiddenCover.hide();
  assert(hiddenCover.state().phase === 'covering' && hiddenCover.calls.pauses === 1 &&
         hiddenCover.calls.stops === 0,
         'background lifecycle stopped the Apple fallback');

  const remoteSkip = makeBusyHandoffHarness({ busySeconds: 0 });
  remoteSkip.route(0, 14);
  remoteSkip.remoteNext();
  assert(remoteSkip.S.curWord === 24 && remoteSkip.state().resume &&
         remoteSkip.state().loading && remoteSkip.state().timers === 1,
         'lock-screen Next cancelled or hid the queued native start');
  remoteSkip.idle();
  remoteSkip.runDelay(0);
  assert(remoteSkip.calls.kokoroStarts.join(',') === '24' &&
         !remoteSkip.state().resume && remoteSkip.state().timers === 0,
         'lock-screen Next did not resume its new target and settle busy UI');

  const superseded = makeBusyHandoffHarness();
  superseded.route(0, 14);
  superseded.idle();                              // schedules its zero-delay retry
  superseded.explicitCancel();                    // a newer user action owns transport
  superseded.runDelay(0);
  assert(superseded.calls.kokoroStarts.length === 0,
         'scheduled native idle retry overrode a newer transport action');

  const idleBusyFlap = makeBusyHandoffHarness({ busySeconds: 0 });
  idleBusyFlap.route(0, 14);
  idleBusyFlap.idle();                         // schedules the zero-delay retry
  idleBusyFlap.busyEvent(1);                   // MLX is reoccupied before it runs
  idleBusyFlap.runDelay(0);
  assert(idleBusyFlap.calls.kokoroStarts.length === 0 &&
         idleBusyFlap.state().phase === 'waiting' && idleBusyFlap.state().resume &&
         idleBusyFlap.state().loading && idleBusyFlap.state().timers === 1,
         'idle/busy flap discarded the pending retry marker or started a second MLX request');
  idleBusyFlap.runDelay(2000);
  assert(idleBusyFlap.calls.nativeSpeaks.length === 1 &&
         idleBusyFlap.state().phase === 'covering',
         'flapped retry did not retain its bounded audible fallback');

  /* Admission is authoritative even when the most recent health sample still
     says idle. Never immediately resubmit; wait for refreshed health or cover
     after the same bounded grace used by an observed busy event. */
  const staleIdle = makeBusyHandoffHarness();
  staleIdle.setBusy(false);
  staleIdle.fail(Object.assign(new Error('native admission occupied'), { code: 'native_busy' }));
  assert(staleIdle.state().busy && staleIdle.state().phase === 'waiting' &&
         staleIdle.state().resume && staleIdle.state().loading &&
         staleIdle.timerDelays().join(',') === '3000' && staleIdle.calls.refreshes === 1,
         'stale-idle native_busy rejection bypassed the bounded wait/health refresh');
  staleIdle.runDelay(0);
  assert(staleIdle.calls.kokoroStarts.length === 0,
         'stale-idle native_busy rejection immediately resubmitted to MLX');
  staleIdle.runDelay(3000);
  assert(staleIdle.state().phase === 'covering' &&
         staleIdle.calls.nativeSpeaks.at(-1)?.word === 14,
         'stale-idle native_busy rejection did not enter audible fallback');

  const refreshedIdle = makeBusyHandoffHarness();
  refreshedIdle.setBusy(false);
  refreshedIdle.fail(Object.assign(new Error('native admission occupied'), { code: 'native_busy' }));
  refreshedIdle.idle();
  refreshedIdle.runDelay(0);
  assert(refreshedIdle.calls.kokoroStarts.join(',') === '14' &&
         refreshedIdle.calls.nativeSpeaks.length === 0 && refreshedIdle.state().phase === 'idle',
         'refreshed idle health did not release the inferred busy wait exactly once');

  const cancelled = makeBusyHandoffHarness();
  cancelled.route(0, 14);
  cancelled.pause();
  cancelled.runDelay(250);
  assert(cancelled.state().phase === 'idle' && !cancelled.state().resume &&
         !cancelled.state().loading && cancelled.state().timers === 0 &&
         cancelled.calls.nativeSpeaks.length === 0,
         'Pause did not clear a queued fallback and its late timer');
  console.log('native busy fallback                bounded cover; boundary handoff; controls safe');
}

async function testNeuralErrorOwnership() {
  const source = extractNamedFunction(src, 'speakNeural');
  const makeHarness = () => {
    let rejectGeneration;
    const generation = new Promise((_, reject) => { rejectGeneration = reject; });
    const loading = new Set(['loading']);
    const calls = { failures: 0, removes: 0, errors: 0 };
    const S = {
      kokoro: { state: 'ready' },
      sentences: [{ start: 0, end: 1 }, { start: 1, end: 2 }],
      curSent: 0,
      curWord: 0,
      neuralGenToken: 0,
      playing: true,
      engine: 'neural',
    };
    const api = new Function(
      'S', 'generation', 'loading', 'calls',
      `const $ = () => ({ classList: {
         add(value) { loading.add(value); },
         remove(value) { loading.delete(value); calls.removes++; }
       }});
       const console = { error() { calls.errors++; }, warn() {} };
       const clearTimeout = () => {};
       const loadKokoro = () => {};
       const armKokoroCover = () => {};
       const routeNativeKokoroBusyFallback = () => false;
       const stopAll = () => {};
       const generateNeural = () => generation;
       const handleNeuralFailure = () => { calls.failures++; S.playing = false; };
       const ensureNeuralAudio = () => { throw new Error('success path not expected'); };
       const leadTrimSec = () => 0;
       const neuralPump = () => {};
       const showTimingBadge = () => {};
       const highlightWord = () => {};
       const NATIVE = { nativeKokoro: true };
       const synth = null;
       let kokoroStopgapActive = false, kokoroCoverTimer = null;
       ${source}
       return { speakNeural };`
    )(S, generation, loading, calls);
    return { ...api, S, loading, calls, rejectGeneration };
  };

  const stale = makeHarness();
  const old = stale.speakNeural(0, 0);
  stale.S.neuralGenToken++;                         // a newer word owns transport
  stale.S.curSent = 1;
  stale.loading.add('loading');
  stale.rejectGeneration(Object.assign(new Error('old failure'), { code: 'native_busy' }));
  await old;
  assert(stale.loading.has('loading') && stale.calls.removes === 0 && stale.calls.failures === 0,
         'old neural rejection cleared or paused the newer word request');

  const current = makeHarness();
  const live = current.speakNeural(0, 0);
  current.rejectGeneration(Object.assign(new Error('live failure'), { code: 'native_busy' }));
  await live;
  assert(!current.loading.has('loading') && current.calls.removes === 1 && current.calls.failures === 1,
         'current neural rejection no longer cleared and handled its own failure');
  console.log('neural request ownership            stale errors ignored; current error handled');
}

try {
  testNativeChunkCap();
  testCacheBudget();
  await testNativePumpGates();
  await testNativePendingGenerationEpoch();
  await testResumeWatchdog();
  await testActivationOrdering();
  testBusyHandoff();
  await testNeuralErrorOwnership();
  const pauseSource = extractNamedFunction(src, 'pauseAll');
  const toggleSource = extractNamedFunction(src, 'togglePlay');
  const beginPlaySource = extractNamedFunction(src, 'beginRequestedPlayback');
  const requestPlaySource = extractNamedFunction(src, 'requestPlaybackStart');
  const requestWordSource = extractNamedFunction(src, 'requestPlaybackFromWord');
  const playWordSource = extractNamedFunction(src, 'playFromWordElement');
  const speakNeuralSource = extractNamedFunction(src, 'speakNeural');
  const speakNativeSource = extractNamedFunction(src, 'speakNative');
  const busyRouteSource = extractNamedFunction(src, 'routeNativeKokoroBusyFallback');
  const stitchedSource = extractNamedFunction(src, 'speakNeuralStitched');
  const failureSource = extractNamedFunction(src, 'handleNeuralFailure');
  const suspendNativeSource = extractNamedFunction(src, 'suspendNativeKokoroWork');
  const generateSource = extractNamedFunction(src, 'generateNeural');
  const pumpSource = extractNamedFunction(src, 'neuralPump');
  const nativeGenerateSource = extractNamedFunction(src, 'nativeKokoroGenerate');
  const generateNowSource = extractNamedFunction(src, 'generateNeuralNow');
  const nativeInitSource = extractNamedFunction(src, 'initNativeEngine');
  const resetDocSource = extractNamedFunction(src, 'resetDocState');
  const cancelDocSource = extractNamedFunction(src, 'cancelDocumentWork');
  /* setEngine has a destructured default parameter; use its stable function
     boundary because this test's lightweight extractor intentionally is not
     a full JavaScript parameter parser. */
  const setEngineSource = grab('function setEngine', '\nfunction setRate');
  const advanceSource = extractNamedFunction(src, 'advanceSentence');
  const interactiveHtmlSource = grab('function renderHtmlInteractive', '\nfunction renderHtmlNative');
  assert(pauseSource.includes('cancelNativeKokoroGenerations()'), 'pauseAll no longer cancels native generation');
  assert(pauseSource.includes('clearNativeKokoroBusyFallback()'),
         'Pause no longer clears native busy wait/coverage state');
  assert(pauseSource.includes('nativeNeuralPausedAt = Date.now()') &&
         toggleSource.includes('nativeNeuralPausedAt = Date.now()'),
         'foreground neural pauses no longer age the retained audio pipeline');
  assert(beginPlaySource.includes('resumePersistentNeuralAudio()'), 'transport no longer uses the resume watchdog');
  assert(requestPlaySource.includes('Promise.resolve(NATIVE.reactivateAudio(allowBackground))') &&
         requestPlaySource.includes('.then(status =>') &&
         requestPlaySource.includes('beginRequestedPlayback({ allowBackground, forceRestart })') &&
         !requestPlaySource.includes('nativePlayActivationPending = true') &&
         !requestPlaySource.includes("$('btn-play').classList.add('loading')"),
         'fresh Play is again gated on native audio-session acknowledgement');
  assert(requestPlaySource.indexOf('primeAudioGesture()') >= 0 &&
         requestPlaySource.indexOf('primeAudioGesture()') < requestPlaySource.indexOf('NATIVE.reactivateAudio'),
         'Play no longer primes persistent audio before losing the iOS gesture');
  assert(requestPlaySource.includes('nativeNeuralAudioNeedsRefresh') &&
         requestPlaySource.includes('nativeNeuralPausedAt') &&
         requestPlaySource.indexOf('disposeNeuralAudio()') < requestPlaySource.indexOf('primeAudioGesture()'),
         'long-suspended audio is not replaced before the fresh gesture prime');
  assert(toggleSource.includes("S.engine === 'neural' && !nativeUtter"),
         'Pause can leave native fallback speech running behind the paused UI');
  assert(beginPlaySource.includes('NATIVE?.nativeKokoro && document.hidden') &&
         !beginPlaySource.includes('document.hidden || !nativeKokoroAppActive'),
         'a stale native activity sample can again block a visible explicit Play');
  assert(requestWordSource.includes('requestPlaybackStart({ forceRestart: true })') &&
         !requestWordSource.includes('primeAudioGesture()'),
         'word-start helper bypasses native audio-session activation');
  assert(beginPlaySource.includes('!forceRestart && S.engine') &&
         requestPlaySource.includes('forceRestart'),
         'word-start intent can still resume an unrelated paused neural clip');
  assert(playWordSource.includes('requestPlaybackFromWord(wIdx)'),
         'read-only word tap bypasses the ordered word-start helper');
  assert(generateSource.includes('nativeGenerationEpoch') &&
         generateSource.includes('pendingKey') &&
         generateSource.includes('S.neuralPending.get(pendingKey) === job'),
         'native same-sentence pending work is not epoch-scoped and identity-cleaned');
  assert(generateNowSource.includes('nativeGenerationEpoch !== nativeKokoroGenerationEpoch') &&
         generateNowSource.split('generationChanged()').length - 1 >= 5,
         'cancelled native generation can still publish stale audio or continue another chunk');
  assert(pumpSource.includes('if (NATIVE?.nativeKokoro) return;'),
         'native speculative MLX runway was re-enabled');
  assert(speakNeuralSource.indexOf('routeNativeKokoroBusyFallback(sentIdx, fromWord)') >= 0 &&
         speakNeuralSource.indexOf('routeNativeKokoroBusyFallback(sentIdx, fromWord)') <
         speakNeuralSource.indexOf('generateNeural(sentIdx)'),
         'native busy fallback gate moved behind a new MLX request');
  assert(!speakNeuralSource.includes('armNativeKokoroGenerationWatchdog') &&
         !speakNeuralSource.includes('settleNativeKokoroGenerationWatchdog') &&
         !src.includes('function commitNativeKokoroGenerationFallback'),
         'normal first Fenrir generation is again cancelled by an elapsed-time watchdog');
  assert(busyRouteSource.includes("speakNative(sentIdx, fromWord, 'kokoro-busy')") &&
         busyRouteSource.includes('S.neuralCache.has(neuralCacheKey(sentIdx))') &&
         busyRouteSource.includes('holdKokoroForBusyQueue(true)'),
         'busy routing no longer covers uncached work while preserving cached Fenrir audio');
  assert(!speakNeuralSource.includes('armNativeNeuralAudioWatchdog') &&
         !stitchedSource.includes('armNativeNeuralAudioWatchdog'),
         'fresh generated clips again invoke the resume-only media watchdog');
  assert(failureSource.includes("error?.code === 'native_busy'") &&
         failureSource.includes('nativeKokoroBusy = true') &&
         failureSource.includes('nativeKokoroBusySeconds = 0') &&
         failureSource.includes('NATIVE.refreshAppActivity?.()') &&
         failureSource.indexOf('nativeKokoroBusy = true') <
         failureSource.indexOf('if (nativeKokoroBusy) holdKokoroForBusyQueue()'),
         'native_busy admission rejection can again immediately retry against stale idle state');
  assert(speakNativeSource.includes("owner = 'native'") &&
         speakNativeSource.includes('lastWi: 0, owner'),
         'native utterances no longer identify Kokoro-busy coverage');
  assert(interactiveHtmlSource.includes("m.t === 'aloud:tap'") &&
         interactiveHtmlSource.includes('requestPlaybackFromWord(wIdx)'),
         'interactive HTML word tap bypasses the ordered word-start helper');
  assert(nativeInitSource.includes("ev.type === 'audioServicesReset'") &&
         nativeInitSource.includes('disposeNeuralAudio()'),
         'media-services reset no longer disposes the orphaned WebKit player');
  assert(nativeInitSource.includes('inactiveFor >= NATIVE_AUDIO_STALE_AFTER_MS') &&
         nativeInitSource.includes('nativeNeuralAudioNeedsRefresh = true'),
         'a long native suspension no longer marks paused media for replacement');
  assert(!nativeInitSource.includes('kokoroOwnedStall') &&
         !bridgeSrc.includes('kokoroOwnedStall') && !bridgeSrc.includes('kokoroStalled') &&
         !nativeEngineSrc.includes('generationStallThreshold') &&
         !nativeEngineSrc.includes('reportGenerationStallIfNeeded') &&
         !nativeEngineSrc.includes('kokoroStalled'),
         'three-second native generation stall cancellation was reintroduced');
  assert(nativeInitSource.includes('!kokoroResumeOnForeground) togglePlay({ allowBackground: true })') &&
         nativeInitSource.includes('nativePlayActivationPending || kokoroResumeOnForeground'),
         'lock-screen Play/Pause no longer preserves or cancels a queued native start');
  assert(nativeInitSource.includes('next:  () => remoteAdvanceSentence(1)') &&
         nativeInitSource.includes('prev:  () => remoteAdvanceSentence(-1)'),
         'lock-screen skip no longer retargets a queued native start');
  const coveringHealthAt = nativeInitSource.indexOf("nativeKokoroBusyFallback.phase === 'covering'");
  const ordinaryBusyAt = nativeInitSource.indexOf('if (nativeKokoroBusy)');
  assert(coveringHealthAt >= 0 && coveringHealthAt < ordinaryBusyAt &&
         nativeInitSource.slice(coveringHealthAt, ordinaryBusyAt).includes('return;'),
         'busy lifecycle reports can again pause an active Apple fallback');
  assert(suspendNativeSource.indexOf("nativeKokoroBusyFallback.phase === 'covering'") >= 0 &&
         suspendNativeSource.indexOf("nativeKokoroBusyFallback.phase === 'covering'") <
         suspendNativeSource.indexOf('const waitingForCurrent') &&
         suspendNativeSource.includes('handoffReady = false'),
         'visibility suspension can again stop Apple fallback speech');
  assert(nativeInitSource.includes("ev.type === 'audioServicesReset'") &&
         nativeInitSource.includes('clearNativeKokoroBusyFallback()') &&
         resetDocSource.includes('clearNativeKokoroBusyFallback()') &&
         cancelDocSource.includes('clearNativeKokoroBusyFallback()') &&
         setEngineSource.includes('clearNativeKokoroBusyFallback()') &&
         advanceSource.includes('clearNativeKokoroBusyFallback()') &&
         requestWordSource.includes('clearNativeKokoroBusyFallback()') &&
         toggleSource.includes('clearNativeKokoroBusyFallback()'),
         'transport, reset, retarget, engine change, or document end can retain busy fallback state');
  const retryGateAt = nativeGenerateSource.indexOf('nativeKokoroGenerationGateError()');
  assert(retryGateAt >= 0 && retryGateAt <
         nativeGenerateSource.indexOf('nativeKokoroGenerateOnce(text, voice)'),
         'native retry can bypass the lifecycle gate');
  assert(nativeGenerateSource.slice(retryGateAt, nativeGenerateSource.indexOf('nativeKokoroGenerateOnce(text, voice)'))
           .includes('if (gateError) throw gateError'),
         'native retry computes but ignores the lifecycle gate');
  assert(generateNowSource.includes('S.neuralCache.set(key, entry)') &&
         generateNowSource.includes('trimNeuralCache()'),
         'generated neural clips are no longer integrated with cache trimming');
  assert(generateNowSource.includes('splitOversizeKokoroToken(tokens[a], chunkCap)') &&
         generateNowSource.includes('continuation: index > 0') &&
         generateNowSource.includes('if (!p.continuation)'),
         'oversize display-token fragments are not integrated into generation/timing');
  if (!process.exitCode) console.log('\nnative lifecycle self-check: PASS');
} catch (error) {
  fail(error?.stack || String(error));
}
