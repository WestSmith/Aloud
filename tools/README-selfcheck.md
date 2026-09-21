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
