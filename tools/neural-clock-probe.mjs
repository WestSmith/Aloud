#!/usr/bin/env node
/* neural-clock-probe — does the karaoke light a word before its audio?

   Drives the REAL index.html in headless Chromium with synthetic neural
   clips whose word onsets are known exactly (0.40s lead silence, then one
   0.28s slot per word), and logs every highlightWord() call against the
   <audio> element's own currentTime at that instant. No model, no espeak:
   this measures the CLOCK path (naMediaPos / naTick / the sentence-boundary
   events), which the aligner self-checks cannot see.

   Setup:  the repo served on http://127.0.0.1:8765  (http-server -p 8765 -s .)
           Playwright (any 1.5x) — edit PW below if it is not the global one
   Run:    node tools/neural-clock-probe.mjs [rate] [busyWorkers] [file]
           node tools/neural-clock-probe.mjs 2.75 0
           node tools/neural-clock-probe.mjs 2.75 8      # CPU contention
   Read:   "lit-before-audio N" must be 0. The per-sentence map says where.
           "late" is the other side: mean/max of (audio position − onset)
           at the moment a word lit; a large max means the highlight lags.
           "punctuation-only tokens painted" must be 0: every other test
           sentence ends in a detached " ." token, as markup that puts a
           period in its own text node produces (v6.33.0).
           "first words painted before their audio": the paint of word one
           when YOU press play is expected (1); anything more is the next
           sentence being painted at the previous clip's end (v6.33.0).
           "lag" is what Auto karaoke sync detected (v6.32.0).
           "ticks per frame" must stay ~1: >1 means leaked rAF chains.
   Env:    N=60 RUN_MS=40000 for a long run; PW / CHROME to point at
           another Playwright package / Chromium binary.

   Measured 2026-09-21 (cause 11 in HANDOFF-karaoke-sync.md):
     v6.30.0  2.75× load 0: lit-before-audio 18   (2 per sentence start)
     v6.30.0  2.75× load 8: lit-before-audio 18, each ~0.19s of media early
     v6.31.0  2.75× load 0/8, 1× , 4× load 8: 0   late mean 15ms max 89ms
     v6.32.1  2.75×: punctuation-only painted 5, first words early 19 of 10
     v6.33.0  2.75×: punctuation-only painted 0, first words early 1 of 10
              (the press-play paint), every first word still painted */
import { createRequire } from 'node:module';
const PW = process.env.PW || '/opt/node22/lib/node_modules/playwright/package.json';
const { chromium } = createRequire(PW)('playwright');
const RATE = +(process.argv[2] || 2.75), LOAD = +(process.argv[3] || 0), FILE = process.argv[4] || 'index.html';
const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined,
  args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
page.on('pageerror', e => console.log('PAGEERROR', e.message));
page.on('console', m => { if (/PAUSE|error|warn|toast/i.test(m.text()) || m.type()!=='log') console.log('CONSOLE', m.type(), m.text().slice(0,300)); });
await page.goto('http://127.0.0.1:8765/' + FILE);
await page.waitForFunction(() => typeof S === 'object' && S.words);
const text = Array.from({ length: +(process.env.N || 12) }, (_, i) =>
  `Sentence number ${i + 1} carries eight plain words here . Another short line follows it quickly now.`).join(' ');
await page.evaluate(t => { $('paste-input').value = t; $('paste-read').click(); }, text);
await page.waitForFunction(() => S.sentences.length > 10);
await page.evaluate(ms => { window.__RUN_MS = ms; }, +(process.env.RUN_MS || 9000));
const res = await page.evaluate(async ({ RATE, LOAD }) => {
  const log = [], ev = [];
  const T0 = performance.now();
  const now = () => +(performance.now() - T0).toFixed(1);
  for (let k = 0; k < LOAD; k++) {
    const w = new Worker(URL.createObjectURL(new Blob(['for(;;){let x=0;for(let i=0;i<1e6;i++)x+=Math.sqrt(i);}'], { type: 'text/javascript' })));
  }
  // synthetic clip: 0.40 s lead silence, then per word 0.22 s tone + 0.06 s gap
  const sr = 24000, LEAD = 0.40, W = 0.28;
  window.generateNeural = async (si) => {
    const sent = S.sentences[si];
    const n = sent.end - sent.start;
    const spoken = []; for (let k = 0; k < n; k++) spoken.push(/[\p{L}\p{N}]/u.test(S.words[sent.start + k].text));
    const nSpoken = spoken.filter(Boolean).length;
    const total = Math.round((LEAD + nSpoken * W + 0.1) * sr);
    const audio = new Float32Array(total);
    const starts = [];
    let slot = 0;
    for (let k = 0; k < n; k++) {
      if (!spoken[k]) { starts.push(starts.length ? starts[starts.length - 1] : LEAD); continue; }
      const t0 = LEAD + slot * W; starts.push(t0); slot++;
      const a = Math.round(t0 * sr), b = Math.round((t0 + 0.22) * sr);
      for (let i = a; i < b; i++) audio[i] = 0.4 * Math.sin(2 * Math.PI * 220 * (i / sr));
    }
    window.__starts = window.__starts || {}; window.__starts[si] = starts;
    await new Promise(r => setTimeout(r, 5));
    return { url: audioBlobParts({ audio, sampling_rate: sr }), starts, durationSec: total / sr, timing: 'model', leadSec: LEAD };
  };
  window.loadKokoro = async () => {}; S.kokoro.state = 'ready'; setEngine('neural'); S.kokoro.state = 'ready'; S.breather = 0;
  setRate(RATE);
  const na = ensureNeuralAudio();
  ['loadedmetadata', 'play', 'playing', 'timeupdate', 'seeking', 'seeked', 'pause', 'ended', 'waiting'].forEach(e =>
    na.addEventListener(e, () => ev.push({ t: now(), e, ct: +na.currentTime.toFixed(3), rs: na.readyState, rolling: !!S.audioPlay?.rolling })));
  const origHl = highlightWord;
  window.highlightWord = (w, f) => {
    const P = S.audioPlay;
    const ws = S.words[w]; const sIdx = ws?.sent ?? S.curSent; const st = window.__starts?.[sIdx];
    log.push({ t: now(), w, sent: S.curSent, wsent: sIdx, text: ws?.text, onset: st ? st[w - S.sentences[sIdx].start] : null,
      first: !!(st && w === S.sentences[sIdx].start), ct: +na.currentTime.toFixed(3), rolling: !!P?.rolling, paused: na.paused, rs: na.readyState,
      playingFired: !!P?._playingFired, ended: na.ended });
    return origHl(w, f);
  };
  na.addEventListener('playing', () => { if (S.audioPlay) S.audioPlay._playingFired = true; });
  const origPause = pauseAll; window.pauseAll = () => { console.log('PAUSE from ' + new Error().stack.split('\n').slice(2,6).join(' | ')); return origPause(); };
  const origToast = toast; window.toast = (m, d) => { console.log('toast: ' + m); return origToast(m, d); };
  // count naTick calls per animation frame (every rAF chain calls the global naTick)
  const origTick = naTick; let tickCalls = 0; const perFrame = [];
  window.naTick = () => { tickCalls++; return origTick(); };
  const frameCounter = () => { perFrame.push(tickCalls); tickCalls = 0; requestAnimationFrame(frameCounter); };
  requestAnimationFrame(frameCounter);
  setSentence(0);
  playCurrent();
  await new Promise(r => setTimeout(r, +(window.__RUN_MS || 9000)));
  window.__perFrame = perFrame;
  pauseAll();
  return { log, ev, sentences: S.sentences.map(s => [s.start, s.end]), perFrame: window.__perFrame, curSent: S.curSent, lag: { det: detectOutputLatency(), base: audioLagCtx?.baseLatency, out: audioLagCtx?.outputLatency, state: audioLagCtx?.state, karaokeLag: S.karaokeLag } };
}, { RATE, LOAD });
await browser.close();
// analyse: for each highlight, true media position at that instant is na.currentTime (live in Chrome).
// starts[w-rel] > ct + 0.03 means the word was lit before its audio was reached.
const W = 0.28, LEAD = 0.40;
let phantom = 0, bySent = {}, punctPaints = 0, firstEarly = 0;
for (const h of res.log) {
  if (h.onset == null) continue;
  const rel = h.w - res.sentences[h.wsent][0];
  const ahead = h.onset - h.ct;
  if (/^[^\p{L}\p{N}]+$/u.test(h.text || '')) punctPaints++;
  /* a first word painted while the element is still on the PREVIOUS clip (ended) or before its own onset */
  if (h.first && (h.ended || h.paused || ahead > 0.03)) firstEarly++;
  if (ahead > 0.03 && rel > 0 && !h.paused) { phantom++; bySent[h.wsent] = (bySent[h.wsent] || 0) + 1; }
}
for (const h of res.log.filter(h => h.first && (h.ended || h.paused || (h.onset - h.ct) > 0.03))) console.log('  early-first', JSON.stringify(h));
console.log(`punctuation-only tokens painted: ${punctPaints}; first words painted before their audio: ${firstEarly}; first words painted at all: ${res.log.filter(h => h.first).length} of ${res.curSent + 1} sentences`);
const lates = res.log.filter(h => h.playingFired && !h.paused && h.onset != null && !h.first).map(h => +(h.ct - h.onset).toFixed(3));
const mean = lates.reduce((a, b) => a + b, 0) / lates.length;
console.log(`rate ${RATE} load ${LOAD} ${FILE}: highlights ${res.log.length}, lit-before-audio ${phantom}`, JSON.stringify(bySent), `late: mean ${mean.toFixed(3)}s max ${Math.max(...lates)}s min ${Math.min(...lates)}s`);
const s1 = res.ev.findIndex(e => e.e === 'ended');
console.log('events around first boundary:');
for (const e of res.ev.slice(Math.max(0, s1 - 1), s1 + 14)) console.log('  ', JSON.stringify(e));
console.log('highlights around it:');
const tEnd = res.ev[s1]?.t || 0;
for (const h of res.log.filter(h => h.t > tEnd - 50 && h.t < tEnd + 700)) console.log('  ', JSON.stringify(h));

console.log('lag', JSON.stringify(res.lag));
const pf = res.perFrame || [];
const q = n => pf.slice(Math.max(0, n - 30), n).reduce((a, b) => a + b, 0) / Math.min(30, n);
console.log(`ticks per frame: at 1s ${q(60).toFixed(1)}, at 5s ${q(300).toFixed(1)}, at 20s ${q(1200).toFixed(1)}, at end ${q(pf.length).toFixed(1)}; sentences played ${res.curSent + 1}`);
