/* Native Kokoro token-to-display timing regression check.
 *
 * Swift/Misaki returns token timestamps plus `whitespace`, which preserves the
 * boundary of a display token even when Misaki splits it (`well`, `-`,
 * `known`) or emits terminal punctuation separately (`example`, `.`). This
 * harness extracts the production alignNativeTokenStarts() implementation
 * from index.html and checks it against small, privacy-safe fixtures shaped
 * like that native payload. No model download, WebKit or listening required.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.ALOUD_ROOT
  || path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const INDEX = path.join(ROOT, 'index.html');
const src = fs.readFileSync(INDEX, 'utf8');
const FUNCTION_NAME = 'alignNativeTokenStarts';
const TOLERANCE_SEC = 0.001;

function extractNamedFunction(source, name) {
  const match = new RegExp(`function\\s+${name}\\s*\\(`).exec(source);
  if (!match) return null;
  const open = source.indexOf('{', match.index + match[0].length);
  if (open < 0) return null;

  let depth = 0;
  let mode = 'code';
  for (let i = open; i < source.length; i++) {
    const ch = source[i], next = source[i + 1];
    if (mode === 'line-comment') {
      if (ch === '\n') mode = 'code';
      continue;
    }
    if (mode === 'block-comment') {
      if (ch === '*' && next === '/') { mode = 'code'; i++; }
      continue;
    }
    if (mode === 'single' || mode === 'double' || mode === 'template') {
      if (ch === '\\') { i++; continue; }
      if ((mode === 'single' && ch === "'") ||
          (mode === 'double' && ch === '"') ||
          (mode === 'template' && ch === '`')) mode = 'code';
      continue;
    }
    if (ch === '/' && next === '/') { mode = 'line-comment'; i++; continue; }
    if (ch === '/' && next === '*') { mode = 'block-comment'; i++; continue; }
    if (ch === "'") { mode = 'single'; continue; }
    if (ch === '"') { mode = 'double'; continue; }
    if (ch === '`') { mode = 'template'; continue; }
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return source.slice(match.index, i + 1);
  }
  return null;
}

const functionSource = extractNamedFunction(src, FUNCTION_NAME);
if (!functionSource) {
  console.error(
    `native-token timing self-check: MISSING production ${FUNCTION_NAME}()\n` +
    `Expected a named function declaration in ${INDEX}.\n` +
    'This is a real failure: native Kokoro token grouping cannot be verified.'
  );
  process.exit(1);
}

/* The mapper may use the same spoken-text and non-speech helpers it uses in
   production. Extract those too rather than maintaining a test-only copy. */
function grab(from, to) {
  const a = src.indexOf(from), b = src.indexOf(to, a + from.length);
  if (a < 0 || b < 0) throw new Error(`Could not extract production source between ${from} and ${to}`);
  return src.slice(a, b);
}

let alignNativeTokenStarts;
try {
  const S = { skipCode: true, dict: {}, skipCitations: true };
  const phonemeCache = new Map();
  alignNativeTokenStarts = new Function('S', 'phonemeCache',
    grab('const BUILTIN_SPOKEN', '/* ---- source citations') +
    grab('const IPA_VOWEL', 'async function ensurePhonemes') +
    grab('const NONSPEECH_RE', 'function leadSilenceSec') +
    functionSource +
    `\nreturn ${FUNCTION_NAME};`
  )(S, phonemeCache);
} catch (error) {
  console.error(`native-token timing self-check: could not load production ${FUNCTION_NAME}():`);
  console.error(error?.stack || error);
  process.exit(1);
}

const tok = (text, whitespace, phonemes, startSec, endSec) =>
  ({ text, whitespace, phonemes, startSec, endSec });

/* groupCounts is fixture-side oracle metadata, not an implementation hint:
   it records how many whitespace-delimited spoken groups belong to each
   display token. A normalized display token may intentionally own several. */
const CASES = [
  {
    label: 'grouped hyphen + terminal punctuation',
    displayTokens: ['This', 'is', 'well-known', 'example.'],
    groupCounts: [1, 1, 1, 1],
    durationSec: 3.4,
    nativeTokens: [
      tok('This', ' ', 'ðɪs', 0.20, 0.48),
      tok('is', ' ', 'ɪz', 0.48, 0.66),
      tok('well', '', 'wˈɛl', 0.80, 1.28),
      tok('-', '', '—', 1.28, 1.36),
      tok('known', ' ', 'nˈoʊn', 1.36, 1.72),
      tok('example', '', 'ɪɡzˈæmpəl', 2.10, 2.82),
      tok('.', '', '.', 2.82, 2.96),
    ],
  },
  {
    label: 'multi-word spoken expansion',
    displayTokens: ['Limit:', '25%', 'maximum.'],
    groupCounts: [1, 3, 1],
    durationSec: 3.6,
    nativeTokens: [
      tok('Limit', '', 'lˈɪmɪt', 0.18, 0.76),
      tok(':', ' ', ':', 0.76, 0.86),
      tok('twenty', ' ', 'twˈɛnti', 1.08, 1.55),
      tok('five', ' ', 'fˈaɪv', 1.55, 1.92),
      tok('percent', ' ', 'pɚsˈɛnt', 1.92, 2.52),
      tok('maximum', '', 'mˈæksɪməm', 2.70, 3.24),
      tok('.', '', '.', 3.24, 3.36),
    ],
  },
  {
    label: 'silent group + empty display token',
    displayTokens: ['Alpha', '—', '', 'omega.'],
    groupCounts: [1, 1, 0, 1],
    durationSec: 2.5,
    nativeTokens: [
      tok('Alpha', ' ', 'ˈælfə', 0.16, 0.72),
      tok('—', ' ', '—', 0.72, 0.86),
      tok('omega', '', 'oʊmˈeɡə', 1.12, 1.86),
      tok('.', '', '.', 1.86, 2.00),
    ],
  },
];

function voiced(token) {
  return Number.isFinite(Number(token?.startSec)) && /[\p{L}\p{N}]/u.test(String(token?.phonemes || ''));
}

function whitespaceGroups(nativeTokens) {
  const groups = [];
  let group = [];
  for (const token of nativeTokens) {
    group.push(token);
    if (String(token.whitespace || '').length) { groups.push(group); group = []; }
  }
  if (group.length) groups.push(group);
  return groups;
}

function oracleStarts(testCase) {
  const groups = whitespaceGroups(testCase.nativeTokens);
  const claimed = testCase.groupCounts.reduce((a, b) => a + b, 0);
  if (claimed !== groups.length || testCase.groupCounts.length !== testCase.displayTokens.length)
    throw new Error(`${testCase.label}: invalid fixture oracle (${claimed} claimed groups, ${groups.length} native groups)`);

  const starts = [];
  let groupIndex = 0;
  for (const count of testCase.groupCounts) {
    const owned = groups.slice(groupIndex, groupIndex + count).flat();
    const first = owned.find(voiced);
    starts.push(first ? Number(first.startSec) : null);
    groupIndex += count;
  }

  /* Silent/muted display tokens consume either a silent native group or no
     native group. They share the next voiced onset, as the karaoke scan uses
     the later token when starts are equal; a trailing silent token uses the
     last voiced onset. */
  let next = null;
  for (let i = starts.length - 1; i >= 0; i--) {
    if (starts[i] == null && next != null) starts[i] = next;
    else if (starts[i] != null) next = starts[i];
  }
  let previous = 0;
  for (let i = 0; i < starts.length; i++) {
    if (starts[i] == null) starts[i] = previous;
    else previous = starts[i];
  }
  return starts;
}

function score(label, expected, actual, displayTokens, report = true) {
  const errors = [];
  if (!Array.isArray(actual)) throw new Error(`${label}: mapper returned ${String(actual)}, expected an array`);
  if (actual.length !== expected.length)
    throw new Error(`${label}: mapper returned ${actual.length} starts for ${expected.length} display tokens`);
  for (let i = 0; i < expected.length; i++) {
    const got = Number(actual[i]);
    if (!Number.isFinite(got)) throw new Error(`${label}: non-finite start for token ${i} (${JSON.stringify(displayTokens[i])})`);
    errors.push(Math.abs(got - expected[i]));
  }
  const worst = Math.max(0, ...errors);
  if (report) console.log(`${label.padEnd(43)} worst ${(worst * 1000).toFixed(0).padStart(4)} ms`);
  return { errors, worst };
}

let failed = false;
let controlBase = null;
console.log('native token timing self-check (production mapper vs native whitespace-group oracle)\n');
for (const testCase of CASES) {
  const expected = oracleStarts(testCase);
  let actual;
  try {
    actual = alignNativeTokenStarts(testCase.displayTokens, testCase.nativeTokens, testCase.durationSec);
    const result = score(testCase.label, expected, actual, testCase.displayTokens);
    if (result.worst > TOLERANCE_SEC) {
      failed = true;
      for (let i = 0; i < expected.length; i++) {
        const errorMs = Math.round((Number(actual[i]) - expected[i]) * 1000);
        if (Math.abs(errorMs) > TOLERANCE_SEC * 1000)
          console.error(`  ${String(i).padStart(2)} ${JSON.stringify(testCase.displayTokens[i])}: expected ${expected[i].toFixed(3)}, got ${Number(actual[i]).toFixed(3)} (${errorMs >= 0 ? '+' : ''}${errorMs} ms)`);
      }
    }
    if (!controlBase) controlBase = { testCase, expected, actual };
  } catch (error) {
    failed = true;
    console.error(`${testCase.label}: FAILED — ${error.message}`);
  }
}

/* Negative control: move every mapped onset one display group later. The
   scorer must detect this obvious mapping slip; otherwise a zero-ms report is
   circular or broken and the positive results are meaningless. */
if (controlBase) {
  const { testCase, expected, actual } = controlBase;
  const shifted = actual.map((_, i) => Number(actual[Math.min(i + 1, actual.length - 1)]));
  const negative = score('negative control: shifted one display group', expected, shifted, testCase.displayTokens);
  if (negative.worst <= 0.15) {
    failed = true;
    console.error('negative control FAILED — the scorer did not detect a one-group timing slip');
  } else {
    console.log('negative control correctly rejected');
  }
} else {
  failed = true;
  console.error('negative control could not run because no positive fixture produced a mapping');
}

if (failed) {
  console.error('\nnative token timing self-check FAILED');
  process.exit(1);
}
console.log('\nnative token timing self-check PASS');
