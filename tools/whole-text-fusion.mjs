/* Measures the harness gap — open item 2 in HANDOFF-karaoke-sync.md.
 *
 * karaoke-selfcheck.mjs phonemises PER WORD, so every display token owns a
 * known id range and its onset is exact by construction. That is the CLEAN
 * case, and it reports 0ms.
 *
 * Production does something different: it hands Kokoro the whole sentence, and
 * espeak — given a sentence rather than a word — fuses short function words
 * into a single blob. When it does, there are fewer spoken blobs than display
 * tokens, and alignExactStarts has to guess which token lost its blob. Every
 * word after the fusion point maps to the NEXT word's audio.
 *
 * This tool needs no model and no ONNX: espeak alone answers the question.
 * It runs the same text both ways and reports where the two disagree.
 *
 *   node tools/whole-text-fusion.mjs
 *   node tools/whole-text-fusion.mjs "some sentence to check"
 *
 * A non-zero GAP means that sentence carries the hazard in production even
 * though karaoke-selfcheck.mjs scores it 0ms.
 */
import { execFileSync } from 'child_process';

function phonemize(text) {
  try {
    return execFileSync('espeak-ng', ['-v', 'en-us', '-q', '--ipa=3', text], { encoding: 'utf8' })
      .replace(/‍/g, '').replace(/\s+/g, ' ').trim();
  } catch {
    return '';
  }
}

/* espeak marks primary/secondary stress differently in isolation than in a
   sentence ("ˈɪf" alone vs "ɪf" in context). That is not a fusion and must not
   be counted as one, so compare on the segments only. */
const bare = (s) => s.replace(/[ˈˌ]/g, '');

const CASES = [
  // Week 13 "Closing Your Business" — reader-reported desync around "The standard".
  ['week13: withdrawal', 'Slide 7, verbatim: "If you have outstanding client matters that will not be completed before the closure of your practice, you are effectively withdrawing from representation " and must comply with the withdrawal rule.'],
  ['week13: the standard', 'The standard (Slide 7): "A paralegal may only withdraw service if there is good cause and on reasonable notice to the client."'],
  ['control: plain prose', 'The duty of confidentiality is a forever duty: it continues after the client terminates you.'],
  ['control: too busy', 'The "too busy" line diverted students — but it\'s irrelevant.'],
];

const argText = process.argv[2];
const cases = argText ? [['argv', argText]] : CASES;

let hazards = 0;

for (const [label, text] of cases) {
  const tokens = text.split(/\s+/).filter(Boolean);

  const perWord = [];
  for (const t of tokens) {
    for (const b of phonemize(t).split(' ').filter(Boolean)) perWord.push({ blob: b, owner: t });
  }
  const whole = phonemize(text).split(' ').filter(Boolean);
  const gap = whole.length - perWord.length;
  if (gap !== 0) hazards++;

  console.log(`\n${label}`);
  console.log(`  display tokens    ${tokens.length}`);
  console.log(`  per-word blobs    ${perWord.length}   (what karaoke-selfcheck measures)`);
  console.log(`  whole-text blobs  ${whole.length}   (what production actually sends)`);
  console.log(`  GAP               ${gap}${gap ? '   <- alignExactStarts must guess here' : ''}`);

  // Walk both sequences and name the fusions.
  let i = 0, j = 0;
  while (i < perWord.length && j < whole.length) {
    if (bare(perWord[i].blob) === bare(whole[j])) { i++; j++; continue; }
    const pair = perWord[i + 1] ? bare(perWord[i].blob) + bare(perWord[i + 1].blob) : null;
    if (pair && bare(whole[j]) === pair) {
      console.log(`  FUSED  "${perWord[i].owner}" + "${perWord[i + 1].owner}"  ->  ${whole[j]}`);
      console.log(`         every token after this point maps to the next token's audio`);
      i += 2; j++; continue;
    }
    i++; j++;   // stress-only difference, or a substitution — not a fusion
  }
}

console.log(`\n${hazards} of ${cases.length} sentences carry the production hazard.`);
