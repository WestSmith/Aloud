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
