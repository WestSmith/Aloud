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

2. **Harness gap.** `karaoke-selfcheck.mjs` phonemises **per word**;
   production sends whole text, and espeak fuses function words
   (`of the` → one blob `ʌvðɪ`). So its 0 ms is the *clean* case; production
   has a hazard it doesn't yet reproduce. Extending it to whole-text
   phonemisation would measure the real production error. Item 1 would make
   production match the clean path by construction.

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

Fixed by segmentation, not in the harness (they need the real DOM):
`<strong>The people.</strong> Ping Lee…`, `If you remember nothing else`,
`Olga opened by saying…`, Figure 2's green half.

## Verifying a change

    node tools/karaoke-selfcheck.mjs              # warm cache
    NOWARM=1 node tools/karaoke-selfcheck.mjs     # phonemizer unavailable

Both must stay at 0 ms. `NOWARM=1` is not optional — that path was 500 ms
out while the badge read "exact".

Browser-side checks used throughout: load both study guides, confirm token
count, block count, citation-dimming count and **no page errors**. A
`favicon.ico` 404 is expected and harmless.

## What a fresh session cannot do

The container is Linux with no Mac, no Xcode, no Swift. It also can't
*listen*. Distortion needs a human ear; everything else here is measurable,
and should be measured rather than reasoned about — two fixes in this
sequence were wrong precisely because they were reasoned about instead.
