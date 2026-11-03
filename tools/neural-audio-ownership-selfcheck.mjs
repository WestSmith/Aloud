/* Focused port of PR #12's terminal-event and scheduled-tick ownership tests.
 * Extracts shipping helpers; no browser, native bridge, model or fallback.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = process.env.ALOUD_ROOT || path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
function assert(condition, message) { if (!condition) throw new Error(message); }

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


function makePreplayingTerminalHarness() {
  const listeners = new Map();
  const calls = { advances: 0, failures: 0, revocations: 0, sentences: [], tails: [], next: 1, delay: false };
  class FakeAudio {
    constructor() {
      this.currentTime = 0;
      this.ended = false;
      this.error = null;
      this.paused = true;
      this.src = 'blob:new-fenrir';
    }
    addEventListener(type, listener) {
      const handlers = listeners.get(type) || [];
      handlers.push(listener);
      listeners.set(type, handlers);
    }
    emit(type) {
      for (const listener of listeners.get(type) || []) listener();
    }
  }
  const S = {
    audio: null,
    audioPlay: null,
    playing: true,
    engine: 'neural',
    curSent: 0,
    sleep: {mode: 'off'},
  };
  const ensureSource = extractNamedFunction(src, 'ensureNeuralAudio');
  const api = new Function(
    'S', 'Audio', 'calls',
    `let NA = null;
     const performance = { now: () => 0 };
     const document = { hidden: false };
     const URL = { revokeObjectURL() { calls.revocations++; } };
     const naTickStart = () => {};
     const setSentence = sentIdx => { S.curSent = sentIdx; calls.sentences.push(sentIdx); };
     const rsvpSilentActive = () => false;
     const batchNext = () => { throw new Error('unexpected hidden batch'); };
     const advanceAfterBreather = () => { calls.advances++; };
     const seekPlayable = () => calls.next;
     const queueNeuralTail = (play, done) => { calls.tails.push(done); return calls.delay; };
     const nativeKokoroError = message => new Error(message);
     const handleNeuralFailure = () => { calls.failures++; };
     ${ensureSource}
     return {
       audio: ensureNeuralAudio(),
       install(play) { S.audioPlay = play; }
     };`
  )(S, FakeAudio, calls);
  const newPlay = () => ({
    hasPlayed: false,
    rolling: false,
    shownAbs: -1,
    clock: { media: 0, wall: 0 },
    segs: [{ sentIdx: 0 }],
  });
  return { ...api, S, calls, newPlay };
}

function testPreplayingTerminalOwnership() {
  const ended = makePreplayingTerminalHarness();
  const replacement = ended.newPlay();
  ended.install(replacement);
  ended.audio.ended = false;
  ended.audio.emit('ended');
  assert(ended.S.audioPlay === replacement && ended.calls.advances === 0,
         'stale ended event claimed an unplayed replacement with a live current source');

  ended.audio.ended = true;
  ended.audio.emit('ended');
  assert(ended.S.audioPlay === null && ended.calls.advances === 1,
         'genuine current-source ended event was swallowed before playing');

  const errored = makePreplayingTerminalHarness();
  const errorReplacement = errored.newPlay();
  errored.install(errorReplacement);
  errored.audio.error = null;
  errored.audio.emit('error');
  assert(errored.S.audioPlay === errorReplacement && errored.calls.failures === 0,
         'stale error event claimed an unplayed replacement with no current media error');

  errored.audio.error = { code: 3 };
  errored.audio.emit('error');
  assert(errored.S.audioPlay === null && errored.calls.failures === 1,
         'genuine current-source error was swallowed before playing');
  console.log('pre-playing terminal events         stale ignored; current ended/error handled');
}


function testRetargetTickOwnership() {
  const callbacks = [];
  const oldPlay = { ticking: false };
  const newPlay = { ticking: false };
  const S = { audioPlay: oldPlay, playing: true };
  const startSource = extractNamedFunction(src, 'naTickStart');
  const tickSource = extractNamedFunction(src, 'naTick');
  const calls = { highlights: 0, sentences: 0 };
  const api = new Function(
    'S', 'callbacks', 'calls',
    `const requestAnimationFrame = fn => callbacks.push(fn);
     const NA = { paused: false, ended: false };
     const naMediaPos = () => { throw new Error('superseded tick read media position'); };
     const karaokeLagSec = () => 0;
     const setSentence = () => { calls.sentences++; };
     const highlightWord = () => { calls.highlights++; };
     const maybeScroll = () => {};
     ${startSource}
     ${tickSource}
     return { start: naTickStart };`
  )(S, callbacks, calls);
  api.start();
  assert(oldPlay.ticking && callbacks.length === 1,
         'old audio play did not schedule its identity-bound karaoke tick');
  S.audioPlay = newPlay;
  callbacks.shift()();
  assert(!oldPlay.ticking && !newPlay.ticking && callbacks.length === 0 &&
         calls.highlights === 0 && calls.sentences === 0,
         'superseded karaoke tick attached itself to the replacement play');
  console.log('retarget karaoke tick              stale callback stays with old play identity');
}

function testChromeClockStall() {
  const audio={currentTime:.250083,paused:false,ended:false,readyState:4,playbackRate:3,duration:10};
  const clock=new Function('NA','NATIVE','navigator','performance',
    extractNamedFunction(src,'naMediaPos')+';return naMediaPos;'
  );
  const state=()=>({lastCt:audio.currentTime,rolling:true,clock:{media:audio.currentTime,wall:0}});
  const get=clock(audio,null,{userAgent:'Chrome/156.0.0.0'},{now:()=>100});
  assert(get(state())===audio.currentTime,'Chrome extrapolated through a stalled media clock');
  audio.currentTime=.6;
  assert(get(state())===.6,'Chrome did not follow the resumed media clock');
  const native=clock(audio,{}, {userAgent:'Chrome/156.0.0.0'},{now:()=>100});
  assert(Math.abs(native(state())-.9)<1e-9,'Native interpolation changed');
  const safari=clock(audio,null,{userAgent:'Version/18 Safari/605.1.15'},{now:()=>100});
  assert(Math.abs(safari(state())-.9)<1e-9,'Other-browser interpolation changed');
  console.log('Chrome clock stall                real media position held; resume follows audio');
}

function testEndTransitionPacing() {
  const normal = makePreplayingTerminalHarness();
  normal.calls.delay = true;
  normal.install(normal.newPlay()); normal.audio.ended = true;
  normal.audio.emit('ended');
  assert(normal.calls.advances === 1 && normal.calls.tails.length === 1 && normal.calls.tails[0] === null,
    'normal sentence transition waited for the visual tail');
  const final = makePreplayingTerminalHarness();
  final.calls.delay = true; final.calls.next = -1;
  final.install(final.newPlay()); final.audio.ended = true;
  final.audio.emit('ended');
  assert(final.calls.advances === 0 && typeof final.calls.tails[0] === 'function',
    'document stop discarded the delayed final words');
  final.calls.tails[0]();
  assert(final.calls.advances === 1, 'document did not finish after its final visual tail');
  console.log('end transition pacing             next clip starts immediately; final stop drains');
}

function testDelayedFinalWords() {
  const callbacks = new Map(), paints = [];
  let now = 0, id = 0, stops = 0;
  const S = { playing: true, engine: 'neural', neuralTails: [], neuralTailFrame: 0,
    paintedWord: 0, curSent: 1, words: Array.from({length: 12}, () => ({el: {}})) };
  const audio = { currentTime: 1, playbackRate: 4 };
  const source = ['paintNeuralPosition', 'queueNeuralTail', 'tickNeuralTails', 'cancelNeuralTails']
    .map(name => extractNamedFunction(src, name)).join('\n');
  const api = new Function('S', 'NA', 'performance', 'requestAnimationFrame', 'cancelAnimationFrame',
    'highlightWord', 'document', `
    const karaokeLagSec = () => .24 * NA.playbackRate;
    const heldWord = i => i;
    const setSentence = () => { throw new Error('tail rewound the live transport'); };
    const maybeScroll = () => {};
    ${source}
    return { queue: queueNeuralTail, cancel: cancelNeuralTails };
  `)(S, audio, {now: () => now}, fn => { callbacks.set(++id, fn); return id; },
    key => callbacks.delete(key),
    wi => {S.paintedWord = wi; paints.push([now, wi]);}, {hidden: false});
  const play = (base = 0) => ({shownAbs: -1,
    segs: [{sentIdx: 0, sentStart: base, t0: 0, starts: [.1, .3, .5, .7]}]});
  const frame = time => {
    now = time;
    const batch = [...callbacks.values()]; callbacks.clear();
    for (const fn of batch) fn();
  };
  api.queue(play(), () => {stops++;});
  // The previous implementation lost all three after the first word: the
  // final media position minus 240ms at 4x is only .04 source seconds.
  for (let t = 10; t <= 240; t += 10) frame(t);
  assert(paints.map(p => p[1]).join() === '1,2,3', 'delayed final words were omitted or repeated');
  for (const [time, wi] of paints) {
    const expected = (.1 + wi * .2 - 1) / 4 * 1000 + 240;
    assert(time >= expected - 5.01 && time <= expected + 10, 'tail word did not follow the output-delay clock');
  }
  assert(stops === 1 && callbacks.size === 0 && S.curSent === 1, 'final stop did not drain once');

  // A new clip may already be running. Neither its clock/speed nor a newer
  // painted word can pull an outgoing clip backwards.
  S.paintedWord = 0; paints.length = 0; now = 300;
  audio.currentTime = 1; audio.playbackRate = 4; api.queue(play());
  audio.currentTime = 0; audio.playbackRate = 1;
  frame(380);
  assert(paints.at(-1)?.[1] === 1, 'replacement media clock/rate corrupted the old tail');
  S.paintedWord = 9; frame(500);
  assert(S.paintedWord === 9, 'old tail rewound a newer clip highlight');

  // Pause/seek cancellation must also reject an already-dispatched callback.
  now = 600; audio.currentTime = 1; audio.playbackRate = 4;
  S.paintedWord = 0; api.queue(play(), () => {stops++;});
  const stale = [...callbacks.values()][0];
  api.cancel();
  api.queue(play(4));
  const owner = S.neuralTailFrame, before = paints.length;
  stale();
  assert(S.neuralTailFrame === owner && paints.length === before && stops === 1,
    'cancelled callback claimed a replacement or completed an old stop');
  api.cancel();
  S.playing = false; api.queue(play()); frame(1000);
  assert(callbacks.size === 0 && stops === 1, 'paused tail kept running');
  console.log('delayed final words               4x / 240ms complete; next clip, stop and cancellation safe');
}

let failed = false;
for (const check of [testPreplayingTerminalOwnership, testRetargetTickOwnership, testChromeClockStall, testEndTransitionPacing, testDelayedFinalWords]) {
  try { check(); }
  catch (error) { failed = true; console.error(`${check.name}: FAIL — ${error.stack}`); }
}
if (failed) process.exitCode = 1;
else console.log('neural audio ownership self-check: PASS');
