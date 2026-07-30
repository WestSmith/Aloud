# Karaoke sync — where this stands

Written at **v6.15.0**. Everything below is committed; nothing important
lives only in a chat log. Start by reading this, then
`tools/README-selfcheck.md`.

The reader's report that opened all of it: with the Kokoro neural voice at
**1.75×** and breathers on **Max**, the word highlight ran ahead of the
audio — worst at the start of a sentence — plus intermittent distortion.

---

## The one thing to understand first

There was never a single bug. **Nine independent causes** produced the same
symptom, which is why it kept coming back after each fix. Anyone continuing
should assume the same: verify a hypothesis before building on it.

| Ver | Cause | How it was found |
|-----|-------|------------------|
| 6.12.0 | Clock extrapolated through the silent load of each new clip; `shownAbs` then pinned the highlight ahead | code reading |
| 6.12.0 | Inline source citations read aloud ("(Tr P1 [~0:03])") | reader request |
| 6.12.1 | `rolling` survived a pause, so resume extrapolated from a stale wall-clock stamp — up to the 1.5 s cap | code reading |
| 6.12.2 | Kokoro pads **every** clip with 350–450 ms of silence; playback started at 0 | measured (ONNX probe) |
| 6.13.0 | Frame agent posted a flat token list — no block boundaries, so labels/headings fused into neighbouring prose | reader named a spot |
| 6.13.1 | The 6.12.2 trim clipped the first phoneme (the pad *overshoots* the real onset) | measured, predicted by 6.12.2's own data |
| 6.13.2 | SVG `<text>` isn't an HTML block tag → every figure label shared one block; 2-token micro-clips | reader named a spot |
| 6.14.0 | Numeric tokens expand unpredictably; aligner guessed in a 40-wide window | timing badge read "exact" |
| 6.14.1 | Chunk joins re-inserted the lead-in pad **inside** a sentence | reader named a spot |
| 6.15.0 | Aligner depended on the phoneme cache, which silently goes cold | **measured by the self-check** |

## Established facts — don't re-derive these

- **Waveform length ÷ duration-tensor sum = 600.0000 samples/frame, exactly,
  on every input.** The frames→seconds mapping is exact; onsets from
  `pred_dur` carry no systematic scale error. (An earlier theory that this
  calibration skewed clip starts was tested and **refuted**.)
- **Kokoro pads every clip with ~350–450 ms of leading silence**
  (`pred_dur[0]` = 14–18 frames), and that pad **overshoots** the true
  acoustic onset by up to 70 ms. Never trim using `starts[0]` alone —
  bound it by silence measured in the waveform (`leadSilenceSec`).
- **The timing badge is not a correctness signal.** "exact" only means
  `alignExactStarts` returned something. It reads "exact" while mapping onto
  the wrong blobs.
- **Output latency was investigated and is not the main cause.** A constant
  offset can't explain errors concentrated at clip starts. The
  Speed → Karaoke sync control exists for genuine device latency; default
  Auto. It is *not* a workaround for alignment.
- **`countPhones` floors `v` at 0.5**, so `v + c === 0` can never be true.
  Use the word count (`e.w`) to detect "espeak says nothing".

## Open items

1. **Feed Kokoro per-word phonemes instead of text** — the big one.
   `generate_from_ids` is public on the Kokoro instance (`generate(text)` is
   just normalise → tokenize → `generate_from_ids`). Building the phoneme
   string per word makes each token's id range known, so onsets need no
   alignment at all: `alignExactStarts` and its DP could be deleted.
   Aloud already phonemises per word for its timing model.
   *Risk:* kokoro-js's normaliser handles things Aloud's spoken-text layer
   may not. Ship behind the self-check.

2. **Harness gap — now measured, and it is real.** `karaoke-selfcheck.mjs`
   phonemises **per word**; production sends whole text, and espeak fuses
   function words. So its 0 ms is the *clean* case and does **not** clear a
   sentence for production.

   `tools/whole-text-fusion.mjs` measures the gap directly (espeak only — no
   model, no ONNX). On the Week 13 guide's reported sentence:

       display tokens    34
       per-word blobs    33   <- karaoke-selfcheck scores this 0ms
       whole-text blobs  32   <- what production actually sends
       FUSED  "with" + "the"  ->  wɪððə

   One blob short, so every token from `the` onward maps to the *next*
   token's audio — `the` gets "withdrawal"'s onset, `withdrawal` gets
   "rule"'s. That lands exactly where the reader said it drifts, and
   `karaoke-selfcheck.mjs` scores the same sentence 0 ms warm **and**
   `NOWARM=1`. Compare stress-stripped: espeak marks stress differently in
   isolation (`ˈɪf` alone vs `ɪf` in context) and that is not a fusion.

   The `mergeable` branch in `alignExactStarts` exists for this case, but a
   0 ms harness score is no evidence it recovers — the harness never feeds it
   a fused blob. Item 1 removes the class by construction; short of that,
   extending the harness to whole-text phonemisation would at least measure
   the error instead of hiding it.

3. **Distortion is not fully explained.** Reduced but reported as still
   present. Onset error and audio quality are different questions and the
   harness only measures the first. Candidates: CPU contention (Kokoro
   inference starves the audio pipeline and stalls the rAF paint, which
   looks like drift), and very short clips — segmentation went 734 → ~1150
   sentences on the Week 10 guide, so there are far more inference calls.
   **Untested diagnostic:** pause 30–60 s so the runway pre-generates, then
   play. If it cleans up, it's contention, not timing.

4. **Native macOS app** was raised. Honest scorecard: it decisively fixes
   the clock class (AVAudioEngine gives sample-accurate position) and the
   CPU class (CoreML on the Neural Engine). It does **nothing** for block
   boundaries, SVG labels, micro-clips or the lead-in pad — roughly half the
   bugs above. And the documents are interactive HTML, so it would render
   them in WKWebView and inherit the same tokenisation work. Item 1 is the
   higher-leverage move and ports either way.

## Reported spots (regression cases)

In `CASES` in the self-check: the money sentence, `(5.01(11))`,
`And under 5.01(16)`, `Answer: $0.00.`, `The "too busy" line…`, the
`8.04(1) … · 8.04(2)` glyph line, plus two number-free controls.

Week 13 "Closing Your Business" — `…withdrawing from representation" and must
comply with the withdrawal rule.` and the `The standard (Slide 7):` sentence
after it. Both score 0 ms in the self-check; the first carries a `with`+`the`
fusion that only `whole-text-fusion.mjs` sees (open item 2). Its markup puts
the closing `"` in its own text node, so that quote is its own display token —
the case string reproduces that with an explicit space, and removing the space
(`control: quote glued`) is the isolating control.

Fixed by segmentation, not in the harness (they need the real DOM):
`<strong>The people.</strong> Ping Lee…`, `If you remember nothing else`,
`Olga opened by saying…`, Figure 2's green half.

## Verifying a change

    node tools/karaoke-selfcheck.mjs              # warm cache
    NOWARM=1 node tools/karaoke-selfcheck.mjs     # phonemizer unavailable
    node tools/whole-text-fusion.mjs              # production fusion hazard

The two self-check runs must stay at 0 ms. `NOWARM=1` is not optional — that
path was 500 ms out while the badge read "exact". `whole-text-fusion.mjs`
needs only espeak, runs in seconds, and answers a question the other two
structurally cannot: it should report 0 hazards, and any sentence it flags is
misaligned in production no matter what the self-check says.

Setup, since a fresh container has none of it:

    apt-get install -y espeak-ng
    npm i onnxruntime-node        # postinstall needs a proxy-aware fetch;
                                  # --ignore-scripts then re-run script/install
    # model files (curl works where node's fetch may not):
    #   https://huggingface.co/shawnahmed/Kokoro-82M-v1.0-ONNX-timestamped
    #   onnx/model_quantized.onnx, voices/af_heart.bin, tokenizer.json, config.json
    KOKORO_DIR=/path/to/model node tools/karaoke-selfcheck.mjs

`KOKORO_DIR` defaults to `./m/shawnahmed/Kokoro-82M-v1.0-ONNX-timestamped`.
Note ESM ignores `NODE_PATH`, so run the self-check from a directory that can
resolve `onnxruntime-node`.

Browser-side checks used throughout: load both study guides, confirm token
count, block count, citation-dimming count and **no page errors**. A
`favicon.ico` 404 is expected and harmless.

## What a fresh session cannot do

The container is Linux with no Mac, no Xcode, no Swift. It also can't
*listen*. Distortion needs a human ear; everything else here is measurable,
and should be measured rather than reasoned about — two fixes in this
sequence were wrong precisely because they were reasoned about instead.
