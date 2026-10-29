# native-token-timing-selfcheck

Checks the production iOS Misaki-token mapper without downloading a model.
It verifies whitespace grouping, hyphen/punctuation splits, multi-word spoken
expansions, and silent display tokens against a small synthetic oracle. It
also shifts a group deliberately so the scorer proves it can fail.

```sh
node tools/native-token-timing-selfcheck.mjs
```

# karaoke-selfcheck

Measures the karaoke aligner's per-word error against **real Kokoro audio**,
with no listening required.

## Why this works

If the phoneme string is built word by word, we know exactly which input ids
belong to which display token, so summing `pred_dur` over that id range gives
the word's onset *exactly* — no inference. (Measured: waveform length divided
by the duration-tensor sum is 600.0000 samples/frame on every input, so the
frames→seconds mapping is exact.)

So the harness generates a sentence once and compares:

- **ground truth** — onsets from each token's own id range
- **shipping path** — `alignExactStarts`, which sees only the spoken-word
  blobs and must map display tokens onto them

Any gap is the aligner's error, in milliseconds, per word.

## Setup

    apt-get install -y espeak-ng
    npm i onnxruntime-node
    # model + voice from the repo Aloud uses at runtime:
    #   shawnahmed/Kokoro-82M-v1.0-ONNX-timestamped
    #   onnx/model_quantized.onnx, voices/af_heart.bin,
    #   tokenizer.json, config.json
    # place under  ./m/shawnahmed/Kokoro-82M-v1.0-ONNX-timestamped/

## Run

    node karaoke-selfcheck.mjs                 # normal: phoneme cache warm
    NOWARM=1 node karaoke-selfcheck.mjs        # phonemizer unavailable (CDN blocked)
    node karaoke-selfcheck.mjs "too busy"      # per-token detail for one case

`NOWARM=1` matters: `ensurePhonemes` gives up silently when the phonemizer
CDN is slow or blocked, and the aligner then runs with an empty phoneme
cache. That path used to drift up to 500ms while the timing badge still read
"exact", so it must be tested explicitly.

## Adding cases

Append to `CASES` as `['label', 'sentence text']`. Anything a reader reports
as out of sync belongs here — it turns "it sounds off around X" into a
number.

# kokoro-wasm-bench

Measures a Kokoro ONNX tier on the same onnxruntime-web build kokoro-js
1.2.1 loads in the browser, on the wasm backend: process memory after a
sentence and how much slower than real time it generates. `THREADS=1` is what
a GitHub Pages deploy gets on iPhone/iPad Safari (no threads without
cross-origin isolation, see the "Use all CPU cores" setting). Setup, usage
and the numbers behind the q8-on-mobile default are in the file's header.

    node tools/kokoro-wasm-bench.mjs model_quantized      # q8
    node tools/kokoro-wasm-bench.mjs model_q4
    THREADS=4 node tools/kokoro-wasm-bench.mjs model_quantized

# neural-clock-probe

The aligner checks above score the onsets fed to playback. This one scores
the playback clock itself: it drives the real page in headless Chromium with
synthetic clips of known onsets and reports every word lit before its audio.
Setup and the numbers behind v6.31.0 are in the file's header.

    http-server -p 8765 -s . &
    node tools/neural-clock-probe.mjs 2.75 0
    node tools/neural-clock-probe.mjs 2.75 8      # with CPU contention — must still be 0


# Focused native memory, Library and audio ownership checks

```sh
node tools/native-kokoro-memory-selfcheck.mjs
node tools/library-recovery-selfcheck.mjs
node tools/storage-selfcheck.mjs
node tools/neural-audio-ownership-selfcheck.mjs
node tools/neural-preload-selfcheck.mjs
```

These model-free checks run in PR CI without a browser or network. The first
checks both vendored convolution overloads for local bias views (not native heap
usage). The second extracts the production IndexedDB adapter and exercises open/
transaction timeouts, one shared reconnect, stale/closed handles and bounded
failure. The audio-ownership check extracts the production handlers and karaoke loop to
check stale pre-playing terminal events and scheduled callback ownership. It
retains genuine pre-playing end/error controls; no fallback engine is involved.
All five accept `ALOUD_ROOT=/path/to/checkout` to test another checkout. They do
not establish audible timing or physical-device lifecycle behavior; run the
clock probe and device checks independently when available.

Library recovery also verifies that temporary read/save failures preserve retained
copies, stale missing-copy flags recover, and the normal copy budget still prunes.
The storage check covers failed progress/settings writes, later recovery, external
updates and one session-only persistence notice.
The preload check verifies nearest-needed scheduling during playback/seek,
speech-skipped sentences, pause, speech changes and the bounded cache runway.
Use `RSVP=1 node tools/neural-clock-probe.mjs 3 8` to exercise the Spritz display
alongside the audio clock. `CHROME` can point at the installed Chrome executable.

# Release gate and guide compatibility

The PR workflow checks app JavaScript syntax, iOS web sync, coordinated app/cache/
native versions, scoped offline/reset behavior, the model-free native token mapper
and the focused storage/recovery checks above. It installs exactly
Playwright 1.56.1 under `tools/guide-check/` and runs a real Chromium engine:

```sh
npm install --ignore-scripts --prefix tools/guide-check
tools/guide-check/node_modules/.bin/playwright install chromium
node tools/guide-check/check.mjs
GUIDE_DIR=/absolute/path/to/private/html node tools/guide-check/check.mjs
```

Synthetic fixtures always run. GUIDE_DIR adds local HTML files, served only on
127.0.0.1 and uploaded through the real app. The runner uses a separate raw-page
context to discover authored controls, then requires the Interactive renderer to
retain their availability and actually respond to clicks. It checks quiz grading,
collapse, flip/reveal, search, storage-backed progress/mode, a full page reload and
Library reopen through the storage shim, live Skip code without replacing the
frame, content-only zoom and the read-only fixed-element boundary. It tests both
390px and 1280px. A missing feature in a private file is not invented or disabled;
the strict synthetic fixture always supplies every required capability.
The synthetic gate also requires Spritz's warmed word updates to avoid layout/font
reads and verifies fitting after font changes and desktop/phone resizing.

Read-only intentionally removes author scripts. Its assertions require the answer/
panel text to remain visible after expansion and Aloud controls to remain usable;
it does not claim author quizzes are interactive there. Interactive assertions
cannot pass by flattening/removing widgets. Do not copy private guides, captured
text, or browser artifacts into this public repository. The runner prints only
filenames and outcomes; it creates no screenshots/traces.

Heavy model checks stay **local**, not in PR CI:

```sh
node tools/karaoke-selfcheck.mjs
NOWARM=1 node tools/karaoke-selfcheck.mjs
node tools/whole-text-selfcheck.mjs
node tools/whole-text-fusion.mjs
SELFTEST=1 node tools/karaoke-selfcheck.mjs     # must FAIL (non-zero)
SELFTEST=1 node tools/whole-text-selfcheck.mjs  # must FAIL (non-zero)
```

Warm and cold alignment must have worst error at most 1ms (the measured baseline
prints 0ms). Whole-text alignment has the same requirement and excludes only
explicitly identified fused/unrecoverable onsets. Every selected fixture needs
at least 70% comparable tokens, no missing comparable onset and a scorer that
rejects a one-token shift. Missing measurements, unmatched filters, unreconciled
blob walks and invalid output fail instead of reporting a false zero. SELFTEST
is an intentionally wrong alignment and must return a failing exit status.

The fusion tool is a **diagnostic**: its known 1-of-4 result is expected, not a
release failure. A fusion count cannot measure timing; use whole-text-selfcheck
for that. It still fails if espeak fails or no actual phonemes were measured.
The neural clock probe fails on early paints, page errors, inadequate measured
coverage, missing sentence boundaries and a failed early-paint negative control.
Run it independently in a browser-capable environment; compilation alone does
not establish playback timing.
