# Exact neural karaoke timing — Kokoro duration-tensor export

## Why

Aloud's neural karaoke currently *estimates* word timing: a phoneme-count
model (`wordCostMs`/`buildTimeline`) stretched onto silences detected in the
generated waveform (`analyzeWave`/`alignTimeline`). v6.7.0 made that robust
on citation-heavy documents, but it is still open-loop estimation between
anchor points.

Kokoro doesn't need to be estimated. It is a StyleTTS2-family model: an
internal duration head computes **exactly how many audio frames each input
token gets**, and the vocoder renders precisely that. The Python
`kokoro` package already surfaces these as per-token `start_ts`/`end_ts`.
The onnx-community export that kokoro-js loads simply doesn't list the
duration tensor as a graph output, so the browser never sees it.

Exposing that one tensor turns karaoke/RSVP timing from "calibrated guess"
into "read off the model" — sample-accurate at any playback speed, immune
to citations, numbers, and abbreviations, with **zero** extra inference
cost and no extra download.

kokoro-js upstream does not provide this (still 1.2.1 as of 2026-07-24),
hence this kit.

## Step 1 — patch the ONNX files (one time, on any machine with internet)

```sh
pip install onnx onnxruntime huggingface_hub numpy
python export_timestamps.py --file onnx/model_q4.onnx        --out model_q4.onnx        --verify   # Lite
python export_timestamps.py --file onnx/model_q4f16.onnx     --out model_q4f16.onnx     --verify   # Lite+
python export_timestamps.py --file onnx/model_quantized.onnx --out model_quantized.onnx --verify   # Standard (q8)
python export_timestamps.py --file onnx/model.onnx           --out model.onnx           --verify   # High (fp32)
```

`--list` prints the candidate duration tensors if the auto-pick looks wrong
(open the graph in Netron to confirm; the right tensor is the rounded
duration that feeds the alignment `CumSum`/`Expand`). `--verify` asserts the
waveform is bit-identical to the stock model and prints the duration sum.

## Step 2 — host the patched repo

Create a Hugging Face model repo (e.g. `WestSmith/Kokoro-82M-ONNX-ts`):
copy **everything** from `onnx-community/Kokoro-82M-v1.0-ONNX` (config,
tokenizer files, `voices/`), replacing the files in `onnx/` with the
patched ones. transformers.js resolves models by repo id, so the only app
change for loading is the id string. (GitHub Pages hosting also works for
the ≤100 MB quantized tiers via `env.remoteHost`, but HF is the path of
least resistance and is what the browser already has cached/CORS-approved.)

## Step 3 — wire the worker (app change, ~40 lines)

In `KOKORO_WORKER_SRC` (index.html), generate via the model directly so the
extra output is visible, instead of `tts.generate()` (which discards
unknown outputs). Sketch — exact property names may drift with kokoro-js
versions; vendor the few lines from its `generate()` if so:

```js
const { phonemize } = await import('https://cdn.jsdelivr.net/npm/phonemizer@1.2.1/+esm');
const phonemes = (await phonemize(text, 'en-us')).join(' ');
const { input_ids } = tts.tokenizer(phonemes, { truncation: true });
const ids = Array.from(input_ids.data);                  // [0, ...tokens, 0]
const style = await tts.get_voice_style?.(voice, ids.length)   // per-length style row
           ?? /* vendor: voices[voice][ids.length - 2] */;
const out = await tts.model({ input_ids, style, speed: ones([1]) });
const audio = out.waveform.data;
const dur = Array.from(out.pred_dur?.data ?? []);        // frames per input token

// frames → seconds without magic constants: the audio IS the durations
const spf = audio.length / dur.reduce((a, b) => a + b, 0);   // samples per frame
// word starts: the phoneme string uses ' ' between words; token k of
// input_ids corresponds to phonemes[k-1] (ids are $-padded at both ends)
const starts = [];
let acc = dur[0] ?? 0;                                   // leading $
let w = 0;
starts.push(0);
for (let k = 1; k < ids.length - 1; k++) {
  if (phonemes[k - 1] === ' ') starts[++w] = null;       // next word starts at next token
  if (starts[w] === null) starts[w] = (acc * spf) / sr;
  acc += dur[k];
}
```

Return `starts` next to the audio; in `generateNeuralNow`, use them
directly when present and keep `analyzeWave`/`alignTimeline` as the
fallback path (feature-detect: does the session expose the extra output?).
That keeps the app fully working with the stock onnx-community model.

Note `speed` stays 1 — Aloud already renders at 1× and speeds up playback
with `playbackRate`, so the timestamps hold at every speed automatically.

## Acceptance checks before shipping

- word starts strictly non-decreasing; last start < audio duration
- detected silences (`analyzeWave`) coincide with punctuation-boundary
  timestamps within ~30 ms (the old aligner becomes the test oracle)
- A/B the karaoke on a citation-dense legal PDF at 2.5×–4×
- all four quality tiers load and play on: desktop WebGPU, desktop wasm,
  iPhone Safari (q4) — the tiers OOM-crash differently, test on-device

## If graph surgery proves unworkable

Plan B is browser-side forced alignment: after generation, align the known
sentence text to the audio with a small CTC acoustic model (transformers.js)
in the same worker, off the realtime path. ~±20–50 ms/word, no model
surgery, engine-agnostic — at the cost of an extra model download and
per-sentence compute (gate it on capable devices). Only reach for this if
the duration tensor can't be exposed; it should not be needed.

## Status — 2026-07-24 (Phase 2 executed)

- Phase 1 (heuristic timing fixes, v6.7.0) is on branch
  `claude/aloud-karaoke-sync-41k0fd`; PR opened:
  https://github.com/WestSmith/Aloud/pull/1 — the owner merges it
  themselves (merging auto-deploys the live site via Pages).
- Phase 2 is DONE end-to-end (branch `claude/kokoro-timestamps-q79tqo`):
  - All four tiers patched & verified (waveform bit-identical; the tensor
    is `/encoder/Clip_output_0`, found via the Round→Clip→…→CumSum chain —
    the name-based auto-pick was wrong, hence `find_rounded_duration`).
    The output is exposed as `pred_dur` through a Cast-to-float32 (the
    fp16 tiers carry it as float16, which browsers can't reliably read).
    Every tier measures exactly 600 samples per duration frame.
  - Hosted at `shawnahmed/Kokoro-82M-v1.0-ONNX-timestamped` (public):
    full onnx-community layout, four patched files + four stock variants.
  - Worker wired (v6.8.0): rather than re-implementing generate() with a
    raw phonemizer (the sketch above — it would bypass kokoro-js's text
    normalization), the app wraps `tts.model` to capture `pred_dur` +
    `input_ids` per call, probes the tokenizer for the space token id,
    and derives word starts from space-token boundaries. Strict guard:
    starts must map 1:1 onto display tokens, be monotonic and in range,
    else the old silence-pinned aligner runs (it also covers the stock
    fallback repo, which loads if the timestamped one is unreachable).
  - v6.8.1 (owner feedback: no visible improvement on a real factum —
    correct observation, the strict 1:1 word-count guard sent nearly every
    citation/number sentence to the old aligner): replaced the guard with
    a monotonic DP alignment (`alignExactStarts`). Spoken phoneme words
    (exact onsets from pred_dur, decoded via the tokenizer vocab) map onto
    display tokens; plain-word tokens consume exactly their word count,
    digit/currency tokens absorb kokoro-js's normalization expansions
    ("$5.30" → five spoken words), trailing punctuation (passed through
    phonemization verbatim) anchors the pairing, silent tokens (dot
    leaders, skipped URLs) consume nothing. Verified in Node against the
    uploaded bytes on real factum sentences: 9/9 exact, incl.
    "DC-26-00000035-00JR" (4 display tokens, 14 spoken words); every
    onset lands on speech energy. Anything unmappable still returns null
    → silence-pinned fallback. Also: model-download progress now shows in
    a floating pill visible from any screen (was only inside the voice
    sheet — looked like a hang).
  - v6.8.2 (owner feedback: "went off the rails around
    thestudent@gmail.com"): two aligner fixes. (1) flex now means ANY
    non-letter inside a word, not just digits — espeak expands emails
    ("… at gmail dot com"), "and/or" ("and slash or"), etc.; a mis-typed
    plain token forced its expansion onto a neighbouring number and
    desynced everything between them. (2) espeak sometimes FUSES function
    words ("of the" → one blob "ʌvðə", "for the" → "fɚðə"): short bare
    function words may now merge into the preceding word's group, gated
    by a phoneme-surplus check (host's claimed audio must be bigger than
    the host alone) so the DP picks the right fusion partner, with a
    phoneme-length plausibility cost (via the existing phonemeCache) so
    "of" can't claim "percent". Node-verified: 14/14 exact incl. all
    prior regressions.
  - v6.8.3 (owner feedback: "trips on the phone number"): root cause was
    NOT the aligner — Kokoro's context window is 510 phoneme tokens and
    kokoro-js silently truncates. The factum's service pages become
    60-token run-on "sentences" (Aloud's PDF splitter safety cap) dense
    with emails, dotted phone numbers ("416.864.7355" → "416 point
    8 6 4 …") and LSO numbers: measured 800+ phonemes → ids hit 512 →
    the AUDIO IS MISSING THE TAIL of the chunk while the timeline maps
    all of it. Pre-existing bug (the old aligner had it too), newly
    visible. Fix: kokoroChunkRanges() splits long sentences into ~300-
    phoneme ranges (cut after trailing punctuation), each generated
    separately and stitched; per-chunk exact alignment with offsets;
    worker reports nIds so a chunk that still comes back 512 is split in
    half and redone. Verified on the real backsheet blocks: 25.4s of
    truncated audio became 56.5s complete, 3/3 chunks exact.
  - v6.9.0: honest tier labels (measured downloads: q4 305MB, q4f16
    155MB, q8 92MB, fp32 326MB — Lite downloads MORE than Standard but
    is the phone-safe tier), and an opt-in "Show timing accuracy"
    Settings toggle that badges the playing sentence exact / mixed /
    estimated (entry.timing from generateNeuralNow's per-chunk result).
- Owner tested on the factum through three feedback rounds (strict-guard
  fallbacks → email expansion → context-window truncation) and signed
  off; merged to main at their direction. Tier sweep on desktop and
  iPhone was deferred by the owner — if a phone report comes in, start
  at kokoroConfig()/the crash-loop guard.
- The owner should REVOKE the HF token now that the upload is done
  (reminded three times; not yet confirmed).
- The owner is not a programmer: do every step for them, explain in
  plain language, and confirm before anything user-visible goes live.
