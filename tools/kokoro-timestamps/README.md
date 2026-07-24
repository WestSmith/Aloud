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

## Status — 2026-07-24 (session handoff)

- Phase 1 (heuristic timing fixes, v6.7.0) is merged — PR #1 landed on
  `main` and auto-deployed via Pages.
- Phase 2 (this kit) is ready to execute but remains blocked: a second
  session (2026-07-24, branch `claude/kokoro-timestamps-mcrvw4`) also
  could not reach huggingface.co — the environment's egress proxy
  returns a policy denial (403 on CONNECT to huggingface.co:443), while
  other hosts (github.com, pypi.org) work. This is the environment's
  network policy, not a transient failure; do not retry or route around
  it. Fix: the owner must edit this Claude Code environment's network
  access settings to allow Hugging Face — simplest is to allow
  `huggingface.co` and its subdomains plus `hf.co` and its subdomains
  (model downloads also use `cdn-lfs*.huggingface.co` and
  `*.xethub.hf.co`) — then start a fresh session. See
  https://code.claude.com/docs/en/claude-code-on-the-web for where the
  network policy lives.
- The owner has a free HF account and a Write token (they will paste it
  in chat — NEVER write it to a file or commit it). The token was NOT
  used or stored in the 2026-07-24 session (nothing to verify it
  against with HF unreachable).
- Remaining, in order: (1) verify token via whoami; (2) run
  export_timestamps.py for the four tiers; (3) create a model repo under
  the owner's HF account, upload the full onnx-community repo layout with
  patched onnx/ files; (4) wire the worker per "Step 3" above with
  feature-detected fallback; (5) test in-browser; (6) remind the owner to
  revoke the token.
- The owner is not a programmer: do every step for them, explain in
  plain language, and confirm before anything user-visible goes live.
