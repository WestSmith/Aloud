/* Word-onset error of the SHIPPING path — open item 2 in HANDOFF-karaoke-sync.md.
 *
 * karaoke-selfcheck.mjs builds the phoneme string per word, so every display
 * token owns a known id range and its onset is exact by construction. It scores
 * 0 ms. But production does not do that: generateNeuralNow joins the tokens
 *
 *     const text = ctoks.map(spokenFor).join(' ').trim();
 *
 * and hands the whole string to Kokoro, which phonemises it in one go — and
 * espeak, given a sentence rather than a word, fuses short function words.
 * So the per-word harness measures an architecture Aloud does not ship, and
 * its 0 ms cannot clear a sentence for production.
 *
 * whole-text-fusion.mjs proves a fusion EXISTS but stops there: it counts
 * blobs and never generates audio, so it cannot say how far the highlight
 * actually lands from the voice. This tool closes that gap. It phonemises the
 * whole sentence exactly as production does, generates real audio, and scores
 * alignExactStarts against ground truth derived from the same clip.
 *
 *   node tools/whole-text-selfcheck.mjs           # all cases
 *   node tools/whole-text-selfcheck.mjs withdraw  # substring-filter the labels
 *
 * Ground truth here is per-token, not per-blob. The per-word phonemisation says
 * which blobs each token should own; walking that against the whole-text blob
 * list (the same walk whole-text-fusion.mjs uses) says which blob each token
 * ACTUALLY landed in once espeak fused things. A token's true onset is the
 * start of the blob carrying it. Where two tokens share one fused blob the
 * second one's true onset is genuinely unrecoverable from this audio — that is
 * the irreducible cost of whole-text phonemisation, not a measurement artefact,
 * and it is reported as FUSED rather than scored.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import ort from 'onnxruntime-node';

const DIR = process.env.KOKORO_DIR
  || './m/shawnahmed/Kokoro-82M-v1.0-ONNX-timestamped';
const SR = 24000;

try {
  execFileSync('espeak-ng', ['--version'], { stdio: 'ignore' });
} catch {
  console.error('espeak-ng not found on PATH — this tool phonemises with it.\n' +
    '  macOS:   brew install espeak-ng\n' +
    '  Debian:  apt-get install -y espeak-ng');
  process.exit(1);
}

const vocab = JSON.parse(fs.readFileSync(DIR + '/tokenizer.json', 'utf8')).model.vocab;

/* ---- Aloud's own spoken-text layer, lifted from index.html ---- */
const ROOT = process.env.ALOUD_ROOT
  || path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
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

const g2pCache = new Map();
function phonemize(text) {
  if (g2pCache.has(text)) return g2pCache.get(text);
  let out;
  try {
    out = execFileSync('espeak-ng', ['-v', 'en-us', '-q', '--ipa=3', text],
      { encoding: 'utf8' }).replace(/‍/g, '').replace(/\s+/g, ' ').trim();
  } catch (err) {
    throw new Error(`espeak-ng failed on ${JSON.stringify(text)}: ${err.message}`);
  }
  g2pCache.set(text, out);
  return out;
}

/* espeak marks stress differently in isolation than in a sentence ("ˈɪf" alone
   vs "ɪf" in context). Not a fusion; compare on segments only. */
const bare = (s) => s.replace(/[ˈˌ]/g, '');

/* Matching the two blob streams cannot be exact-string. espeak also applies
   sentence-level allophony: "the" is "ðə" alone but "ðɪ" before a vowel, so
   "of the excess" fuses to "ʌvðɪ" while the per-word strings concatenate to
   "ʌvðə". An identity test misses that fusion, the walk slips by one blob, and
   every later token is scored against its neighbour's audio — which manifests
   as a confident several-hundred-millisecond "error" that is entirely an
   artefact of the harness. Compare by similarity so a vowel swap still
   matches, and require the fused reading to beat the unfused one. */
function lev(a, b) {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, k) => k);
  for (let x = 1; x <= a.length; x++) {
    const cur = [x];
    for (let y = 1; y <= b.length; y++) {
      cur[y] = Math.min(prev[y] + 1, cur[y - 1] + 1,
        prev[y - 1] + (a[x - 1] === b[y - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}
const sim = (a, b) => (!a.length && !b.length) ? 1
  : 1 - lev(a, b) / Math.max(a.length, b.length);

const sess = await ort.InferenceSession.create(DIR + '/onnx/model_quantized.onnx');
const vbuf = fs.readFileSync(DIR + '/voices/af_heart.bin');
const voices = new Float32Array(vbuf.buffer, vbuf.byteOffset, vbuf.length / 4);
const idChar = [];
for (const ch of Object.keys(vocab)) idChar[vocab[ch]] = ch;

/* mirror ensurePhonemes: production warms this cache before generating, and
   alignExactStarts reads it to learn which tokens espeak voices at all */
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

  /* ---- the production path, verbatim: normalise per token, JOIN, phonemise
     the whole string in one espeak call ---- */
  const wholeText = tokens.map(t => aloud.spokenFor(t)).join(' ').trim();
  if (!wholeText || !/[\p{L}\p{N}]/u.test(wholeText)) return null;
  const wholePh = phonemize(wholeText);
  const wholeBlobs = wholePh.split(' ').filter(Boolean);

  /* ids, recording where each blob starts so a blob index maps to a time */
  const ids = [0];
  const blobStart = [];
  let inBlob = false;
  for (const c of wholePh) {
    const id = vocab[c];
    if (id === undefined) continue;
    if (c === ' ') { inBlob = false; ids.push(id); continue; }
    if (!inBlob) { blobStart.push(ids.length); inBlob = true; }
    ids.push(id);
  }
  ids.push(0);
  if (ids.length > 510) return { skip: 'past the context window' };
  if (blobStart.length !== wholeBlobs.length) return { skip: 'blob/id mismatch' };

  const style = voices.slice((ids.length - 1) * 256, ids.length * 256);
  const out = await sess.run({
    input_ids: new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
    style: new ort.Tensor('float32', style, [1, 256]),
    speed: new ort.Tensor('float32', new Float32Array([1]), [1]),
  });
  const audio = out.waveform.data;
  const dur = Array.from(out.pred_dur.data, Number);
  if (dur.length !== ids.length) return { skip: 'no pred_dur' };
  const total = dur.reduce((a, c) => a + c, 0);
  const spf = audio.length / total;
  const cum = [0];
  for (let i = 0; i < dur.length; i++) cum.push(cum[i] + dur[i]);
  const timeAt = (idIdx) => (cum[idIdx] * spf) / SR;

  /* ---- ground truth: which whole-text blob does each token actually land in?
     The per-word phonemisation says what each token SHOULD contribute; walking
     it against the whole-text blobs shows where espeak merged two into one. ---- */
  const perBlobs = [];
  tokens.forEach((t, ti) => {
    const spoken = aloud.spokenFor(t).trim();
    if (!spoken) return;
    for (const b of phonemize(spoken).split(' ').filter(Boolean)) perBlobs.push({ blob: b, tok: ti });
  });

  const assign = new Array(tokens.length).fill(null);
  const fused = new Set();
  let nFuse = 0;
  let i = 0, j = 0;
  while (i < perBlobs.length && j < wholeBlobs.length) {
    if (assign[perBlobs[i].tok] === null) assign[perBlobs[i].tok] = j;
    const w = bare(wholeBlobs[j]);
    const one = sim(bare(perBlobs[i].blob), w);
    const two = perBlobs[i + 1]
      ? sim(bare(perBlobs[i].blob) + bare(perBlobs[i + 1].blob), w) : -1;
    if (two > one && two >= 0.75) {
      /* two tokens, one blob: the second token's true onset is inside the blob
         and cannot be recovered from this audio at all */
      const t2 = perBlobs[i + 1].tok;
      if (assign[t2] === null) { assign[t2] = j; fused.add(t2); }
      nFuse++; i += 2; j++; continue;
    }
    i++; j++;
  }
  /* Reconciliation invariant: every fusion turns two per-word blobs into one
     whole-text blob and everything else is 1:1, so per - fusions MUST equal
     whole. If it doesn't, the walk missed or invented a fusion and every
     assignment after that point is off by a blob — no ground truth.
     A low-similarity 1:1 step is NOT evidence of that: espeak reduces function
     words in context ("A" -> ɐ, "to" -> tə) and those pair up correctly. An
     earlier revision failed sentences on that signal alone. */
  const slipped = (perBlobs.length - nFuse) !== wholeBlobs.length;
  const truth = assign.map(b => (b == null ? null : timeAt(blobStart[b])));

  /* ---- what Aloud ships ---- */
  const pwords = aloud.kokoroSpokenWords(idChar, ids, dur, audio.length, SR);
  const got = pwords ? aloud.alignExactStarts(tokens, pwords, audio.length / SR) : null;

  /* SELFTEST=1 shifts every onset one token late — exactly the off-by-one-blob
     failure this tool exists to catch. A harness that reports 0ms on real data
     is only meaningful if it reports a large error here; if both read 0ms, the
     two sides are being computed circularly and the whole run proves nothing. */
  if (process.env.SELFTEST && got) { got.pop(); got.unshift(got[0]); }

  return { truth, got, fused, slipped, nBlobWhole: wholeBlobs.length,
           nBlobPer: perBlobs.length, dur: audio.length / SR };
}

const CASES = [
  ['reported: withdrawal', 'Slide 7, verbatim: "If you have outstanding client matters that will not be completed before the closure of your practice, you are effectively withdrawing from representation " and must comply with the withdrawal rule.'],
  ['reported: the standard', 'The standard (Slide 7): "A paralegal may only withdraw service if there is good cause and on reasonable notice to the client."'],
  ['reported: money', 'Referral fee cap: 15% of the first $50,000 + 5% of the excess, max $25,000 — and it must never increase the client\'s total fee.'],
  ['reported: 5.01(16)', 'And under 5.01(16), the referee must note the referral fee on the client\'s account and obtain the client\'s acknowledgement.'],
  ['reported: too busy', 'The "too busy" line diverted students — but it\'s irrelevant.'],
  ['control: quote glued', 'Slide 7, verbatim: "If you have outstanding client matters that will not be completed before the closure of your practice, you are effectively withdrawing from representation" and must comply with the withdrawal rule.'],
  ['control: plain prose', 'The duty of confidentiality is a forever duty: it continues after the client terminates you.'],
];

const filter = process.argv[2];
const cases = filter ? CASES.filter(([l]) => l.includes(filter)) : CASES;

console.log('word-onset error of the SHIPPING path (whole-text phonemisation)');
console.log('ground truth = the blob each token actually lands in, same clip\n');

let worstAll = 0, allErrs = [], visible = 0;
for (const [label, text] of cases) {
  const tokens = text.split(/\s+/).filter(Boolean);
  const r = await runSentence(tokens);
  if (!r) { console.log(`${label.padEnd(22)} nothing pronounceable`); continue; }
  if (r.skip) { console.log(`${label.padEnd(22)} skipped (${r.skip})`); continue; }
  if (!r.got) { console.log(`${label.padEnd(22)} aligner FAILED -> falls back to estimated`); continue; }
  if (r.slipped) {
    /* Refusing to print a number is the whole point: an earlier revision of
       this walk missed an allophonic fusion ("of the" -> "ʌvðɪ" before a
       vowel), slipped one blob, and reported a confident 650ms error that was
       purely its own. An unreconciled walk means NO ground truth, not a
       finding. */
    console.log(`${label.padEnd(22)} UNSCORED — blob walk did not reconcile; no ground truth`);
    continue;
  }

  const errs = [];
  for (let i = 0; i < tokens.length; i++) {
    if (r.fused.has(i)) continue;                        // unrecoverable by construction
    if (r.truth[i] == null || r.got[i] == null) continue;
    errs.push({ i, e: Math.abs(r.got[i] - r.truth[i]) });
  }
  if (!errs.length) { console.log(`${label.padEnd(22)} no comparable tokens`); continue; }
  errs.sort((a, b) => b.e - a.e);
  const worst = errs[0];
  const mean = errs.reduce((a, c) => a + c.e, 0) / errs.length;
  const bad = errs.filter(e => e.e > 0.15).length;
  worstAll = Math.max(worstAll, worst.e);
  visible += bad;
  allErrs.push(...errs.map(e => e.e));

  const gapNote = r.nBlobWhole !== r.nBlobPer ? `  [${r.nBlobPer}->${r.nBlobWhole} blobs]` : '';
  console.log(`${label.padEnd(22)} ${String(tokens.length).padStart(3)} tok  ` +
    `mean ${(mean * 1000).toFixed(0).padStart(4)}ms  worst ${(worst.e * 1000).toFixed(0).padStart(5)}ms ` +
    `on "${tokens[worst.i]}"${gapNote}`);
  if (bad) console.log(`${' '.repeat(22)} ${bad} word(s) off by >150ms — visible desync`);
}

const mean = allErrs.length ? allErrs.reduce((a, c) => a + c, 0) / allErrs.length : 0;
console.log(`\nacross ${allErrs.length} words: mean ${(mean * 1000).toFixed(0)}ms, worst ${(worstAll * 1000).toFixed(0)}ms`);
console.log(`${visible} words off by more than 150ms (clearly visible desync)`);
