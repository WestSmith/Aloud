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

   Measured 2026-09-21 (cause 11 in HANDOFF-karaoke-sync.md):
     v6.30.0  2.75× load 0: lit-before-audio 18   (2 per sentence start)
     v6.30.0  2.75× load 8: lit-before-audio 18, each ~0.19s of media early
     v6.31.0  2.75× load 0/8, 1× , 4× load 8: 0   late mean 15ms max 89ms */
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
const text = Array.from({ length: 12 }, (_, i) =>
  `Sentence number ${i + 1} carries eight plain words here. Another short line follows it quickly now.`).join(' ');
await page.evaluate(t => { $('paste-input').value = t; $('paste-read').click(); }, text);
await page.waitForFunction(() => S.sentences.length > 10);
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
    const total = Math.round((LEAD + n * W + 0.1) * sr);
    const audio = new Float32Array(total);
    const starts = [];
    for (let k = 0; k < n; k++) {
      const t0 = LEAD + k * W; starts.push(t0);
      const a = Math.round(t0 * sr), b = Math.round((t0 + 0.22) * sr);
      for (let i = a; i < b; i++) audio[i] = 0.4 * Math.sin(2 * Math.PI * 220 * (i / sr));
    }
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
    log.push({ t: now(), w, sent: S.curSent, ct: +na.currentTime.toFixed(3), rolling: !!P?.rolling, paused: na.paused, rs: na.readyState,
      playingFired: !!P?._playingFired });
    return origHl(w, f);
  };
  na.addEventListener('playing', () => { if (S.audioPlay) S.audioPlay._playingFired = true; });
  const origPause = pauseAll; window.pauseAll = () => { console.log('PAUSE from ' + new Error().stack.split('\n').slice(2,6).join(' | ')); return origPause(); };
  const origToast = toast; window.toast = (m, d) => { console.log('toast: ' + m); return origToast(m, d); };
  setSentence(0);
  playCurrent();
  await new Promise(r => setTimeout(r, 9000));
  pauseAll();
  return { log, ev, sentences: S.sentences.map(s => [s.start, s.end]) };
}, { RATE, LOAD });
await browser.close();
// analyse: for each highlight, true media position at that instant is na.currentTime (live in Chrome).
// starts[w-rel] > ct + 0.03 means the word was lit before its audio was reached.
const W = 0.28, LEAD = 0.40;
let phantom = 0, bySent = {};
for (const h of res.log) {
  const s = res.sentences[h.sent]; if (!s) continue;
  const rel = h.w - s[0]; const onset = LEAD + rel * W;
  const ahead = onset - h.ct;
  if (ahead > 0.03 && rel > 0) { phantom++; bySent[h.sent] = (bySent[h.sent] || 0) + 1; }
}
const lates = res.log.filter(h => h.playingFired && !h.paused).map(h => { const s = res.sentences[h.sent]; return +(h.ct - (LEAD + (h.w - s[0]) * W)).toFixed(3); });
const mean = lates.reduce((a, b) => a + b, 0) / lates.length;
console.log(`rate ${RATE} load ${LOAD} ${FILE}: highlights ${res.log.length}, lit-before-audio ${phantom}`, JSON.stringify(bySent), `late: mean ${mean.toFixed(3)}s max ${Math.max(...lates)}s min ${Math.min(...lates)}s`);
const s1 = res.ev.findIndex(e => e.e === 'ended');
console.log('events around first boundary:');
for (const e of res.ev.slice(Math.max(0, s1 - 1), s1 + 14)) console.log('  ', JSON.stringify(e));
console.log('highlights around it:');
const tEnd = res.ev[s1]?.t || 0;
for (const h of res.log.filter(h => h.t > tEnd - 50 && h.t < tEnd + 700)) console.log('  ', JSON.stringify(h));
