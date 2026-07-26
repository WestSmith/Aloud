/* Measures the karaoke aligner's error on REAL sentences with REAL Kokoro audio.
 *
 * The trick that makes this possible without listening: if Aloud builds the
 * phoneme string itself, word by word, it knows exactly which input ids belong
 * to which display token. Summing pred_dur over that id range gives the word's
 * onset EXACTLY — no inference. (samples/frame was measured at 600.0000 on
 * every input, so the frames->seconds mapping is exact.)
 *
 * So: generate once, then compare
 *    (a) phoneme-direct onsets  = ground truth, exact by construction
 *    (b) alignExactStarts       = what Aloud ships today
 * Any gap is the aligner's error, in milliseconds, per word.
 */
import fs from 'fs';
import { execFileSync } from 'child_process';
import ort from 'onnxruntime-node';

const DIR = '/tmp/claude-0/-home-user-Aloud/21015b46-e5c7-58be-b91c-271100e209ee/scratchpad/m/shawnahmed/Kokoro-82M-v1.0-ONNX-timestamped';
const SR = 24000;
const vocab = JSON.parse(fs.readFileSync(DIR + '/tokenizer.json', 'utf8')).model.vocab;

/* ---- Aloud's own spoken-text layer, lifted from index.html ---- */
const src = fs.readFileSync('/home/user/Aloud/index.html', 'utf8');
const grab1 = (from, to) => src.slice(src.indexOf(from), src.indexOf(to));
const S = { skipCode: true, dict: {}, skipCitations: true };
const phonemeCache = new Map();
const aloud = new Function('S', 'phonemeCache',
  'const BUILTIN_SPOKEN={};' +
  grab1('function coreOf(tok) {', '/* ---- source citations') +
  grab1('function countPhones(ph)', 'async function ensurePhonemes') +
  grab1('const IPA_VOWEL', 'function countPhones') +
  grab1('function kokoroSpokenWords', 'function instrumentKokoroTTS') +
  grab1('const NONSPEECH_RE', 'function leadSilenceSec') +
  grab1('function alignExactStarts', 'function audioBlobParts') +
  '\nreturn {spokenFor, alignExactStarts, kokoroSpokenWords, countPhones};'
)(S, phonemeCache);

/* ---- espeak-ng, the same G2P engine Kokoro uses ---- */
const g2pCache = new Map();
function phonemize(text) {
  if (g2pCache.has(text)) return g2pCache.get(text);
  let out = '';
  try {
    out = execFileSync('espeak-ng', ['-v', 'en-us', '-q', '--ipa=3', text],
      { encoding: 'utf8' }).replace(/‍/g, '').replace(/\s+/g, ' ').trim();
  } catch { out = ''; }
  g2pCache.set(text, out);
  return out;
}

const sess = await ort.InferenceSession.create(DIR + '/onnx/model_quantized.onnx');
const vbuf = fs.readFileSync(DIR + '/voices/af_heart.bin');
const voices = new Float32Array(vbuf.buffer, vbuf.byteOffset, vbuf.length / 4);
const idChar = [];
for (const ch of Object.keys(vocab)) idChar[vocab[ch]] = ch;

/* mirror ensurePhonemes: the running app warms this cache before generating,
   and alignExactStarts reads it to learn which tokens espeak voices at all */
function warmCache(tokens) {
  for (const t of tokens) {
    const spoken = aloud.spokenFor(t).toLowerCase();
    if (!spoken || phonemeCache.has(spoken)) continue;
    const ph = phonemize(spoken);
    const e = aloud.countPhones(ph);
    e.w = ph ? ph.split(/\s+/).filter(x => /[^\sˈˌ',.\-()]/u.test(x)).length : 0;
    phonemeCache.set(spoken, e);
  }
}

async function runSentence(tokens) {
  if (!process.env.NOWARM) warmCache(tokens);
  /* build the phoneme string word by word, recording each token's id range */
  const ids = [0];
  const spans = [];                       // [tokenIndex] -> {a,b} into ids, or null
  for (const t of tokens) {
    const spoken = aloud.spokenFor(t).trim();
    if (!spoken) { spans.push(null); continue; }
    const ph = phonemize(spoken);
    if (!ph) { spans.push(null); continue; }
    if (ids.length > 1) ids.push(vocab[' ']);
    const a = ids.length;
    let any = false;
    for (const c of ph) { const id = vocab[c]; if (id !== undefined) { ids.push(id); any = true; } }
    spans.push(any ? { a, b: ids.length } : null);
  }
  ids.push(0);
  if (ids.length > 510) return null;      // past the context window; skip
  const style = voices.slice((ids.length - 1) * 256, ids.length * 256);
  const out = await sess.run({
    input_ids: new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
    style: new ort.Tensor('float32', style, [1, 256]),
    speed: new ort.Tensor('float32', new Float32Array([1]), [1]),
  });
  const audio = out.waveform.data;
  const dur = Array.from(out.pred_dur.data, Number);
  if (dur.length !== ids.length) return null;
  const total = dur.reduce((a, c) => a + c, 0);
  const spf = audio.length / total;

  /* (a) ground truth: cumulative duration up to each token's first id */
  const cum = [0];
  for (let i = 0; i < dur.length; i++) cum.push(cum[i] + dur[i]);
  const truth = spans.map(s => s ? (cum[s.a] * spf) / SR : null);

  /* (b) what Aloud ships: reconstruct pwords from the tensor, then align */
  const pwords = aloud.kokoroSpokenWords(idChar, ids, dur, audio.length, SR);
  const got = pwords ? aloud.alignExactStarts(tokens, pwords, audio.length / SR) : null;
  return { truth, got, dur: audio.length / SR, nTok: tokens.length, pw: pwords };
}

/* ---- real sentences from the Week 10 guide, incl. every spot reported ---- */
const DETAIL = process.argv[2];
const CASES = [
  ['reported: money', 'Referral fee cap: 15% of the first $50,000 + 5% of the excess, max $25,000 — and it must never increase the client\'s total fee.'],
  ['reported: rule nums', 'Division of fees (5.01(11)) with client consent, proportional, between licensees = legal.'],
  ['reported: 5.01(16)', 'And under 5.01(16), the referee must note the referral fee on the client\'s account and obtain the client\'s acknowledgement.'],
  ['reported: $0.00', 'Answer: $0.00.'],
  ['reported: too busy', 'The "too busy" line diverted students — but it\'s irrelevant.'],
  ['reported: glyph sep', '8.04(1) obtain & maintain adequate E&O insurance · 8.04(2) give prompt notice of any circumstance that may give rise to a claim'],
  ['control: no numbers', 'On the exam: look for the conflict before you compute. The percentage answer is the planted trap.'],
  ['control: plain prose', 'The duty of confidentiality is a forever duty: it continues after the client terminates you.'],
];

console.log('word-onset error of the shipping aligner, against exact ground truth');
console.log('(same audio, same duration tensor — the only difference is how onsets are derived)\n');
let worst = 0, allErrs = [];
for (const [label, text] of CASES) {
  const tokens = text.split(/\s+/).filter(Boolean);
  const r = await runSentence(tokens);
  if (!r) { console.log(`${label.padEnd(22)} skipped (too long)`); continue; }
  if (!r.got) { console.log(`${label.padEnd(22)} aligner FAILED -> would fall back to estimated`); continue; }
  const errs = [];
  for (let i = 0; i < tokens.length; i++)
    if (r.truth[i] != null && r.got[i] != null) errs.push({ i, e: Math.abs(r.got[i] - r.truth[i]) });
  if (!errs.length) continue;
  const mean = errs.reduce((a, c) => a + c.e, 0) / errs.length;
  const mx = errs.reduce((a, c) => c.e > a.e ? c : a, errs[0]);
  allErrs.push(...errs.map(x => x.e));
  worst = Math.max(worst, mx.e);
  const flag = mx.e > 0.15 ? '  <== BAD' : mx.e > 0.06 ? '  <-- drifting' : '';
  if (DETAIL && label.includes(DETAIL)) {
    console.log('\n   token            truth    aligner   error');
    for (let i = 0; i < tokens.length; i++) {
      const t = r.truth[i], gg = r.got[i];
      console.log('   ' + tokens[i].padEnd(15) +
        (t==null?'   —  ':(t).toFixed(3)) + '   ' + (gg==null?'  —  ':(gg).toFixed(3)) +
        '   ' + (t!=null&&gg!=null?((gg-t)*1000).toFixed(0)+'ms':''));
    }
    console.log('   spoken-word blobs the aligner had to map onto:');
    console.log('   ' + (r.pw||[]).map(w=>w.ph).join(' | '));
    console.log('');
  }
  console.log(`${label.padEnd(22)} ${String(tokens.length).padStart(3)} tok  ${r.dur.toFixed(1)}s   ` +
    `mean ${(mean * 1000).toFixed(0).padStart(4)}ms   worst ${(mx.e * 1000).toFixed(0).padStart(4)}ms ` +
    `on "${tokens[mx.i]}"${flag}`);
}
const m = allErrs.reduce((a, c) => a + c, 0) / (allErrs.length || 1);
console.log(`\nacross ${allErrs.length} words: mean ${(m * 1000).toFixed(0)}ms, worst ${(worst * 1000).toFixed(0)}ms`);
console.log(allErrs.filter(e => e > 0.15).length + ' words off by more than 150ms (clearly visible desync)');
