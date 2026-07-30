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

### Ruled out by measurement, 2026-07-30 (Mac + iPad simulator)

Three sentence-start hypotheses were tested and **all three refuted**. They are
listed because each is plausible from code reading alone, and re-deriving them
costs a session.

- **Whole-text fusion does not misplace onsets.** Open item 2 below has the
  numbers: four sentences carrying real blob fusions all score 0 ms through
  `alignExactStarts`. The `mergeable` branch recovers.
- **The lead-in seek is not silently lost.** `na.currentTime = seekTo` inside
  the one-shot `loadedmetadata` handler sticks on both desktop Chrome and iOS
  WebKit — reads back 0.400 from a 0.400 assignment, `seekable=[0.00-2.00]`,
  playback genuinely starts there. Registering the listener *after* `na.src`
  (production's order) still catches the event. **Trap:** an early run of this
  probe served the clip over `python3 -m http.server`, which ignores Range, so
  every seek was reported LOST — a rig artefact, not the app. Production plays
  from `URL.createObjectURL`, which is fully seekable; test with a blob.
- **`rolling` going true early costs nothing.** On iOS WebKit (unlike Chrome)
  the post-seek `timeupdate` *does* set `rolling` before `playing` — the
  precondition for `naMediaPos` extrapolating through a silent window. Measured
  phantom is **0 ms** anyway, including with a 14.3 s clip and 900 ms of CPU
  burned right after `play()`: the gap between the two is ~5 ms because the
  `timeupdate` handler calls `syncClock()` as it sets the flag, re-anchoring
  `clock.media` to the true position. The comment on the `currentTime > 0`
  test is inaccurate for iOS, but the behaviour is safe.

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

   **ANSWERED (2026-07-30, on a Mac with the full harness).**
   `tools/whole-text-selfcheck.mjs` is the extension this item asked for: it
   phonemises the whole sentence exactly as `generateNeuralNow` does, generates
   real audio, and scores `alignExactStarts` against ground truth derived from
   the same clip. Result across the reported spots:

       reported: withdrawal    34 tok  mean 0ms  worst 0ms   [33->32 blobs]
       reported: money         25 tok  mean 0ms  worst 0ms   [31->29 blobs]
       reported: 5.01(16)      19 tok  mean 0ms  worst 0ms   [23->22 blobs]
       control:  quote glued   33 tok  mean 0ms  worst 0ms   [33->32 blobs]
       across 150 words: mean 0ms, worst 0ms

   So the `mergeable` branch **does** recover: four sentences carrying genuine
   fusions all score 0 ms. The fusion is real, but on this evidence it is not
   what the reader saw, and **item 1 would not fix the reported symptom** —
   there is no onset error in this path left to remove. Item 1 may still be
   worth doing to delete the DP, but it is no longer a desync fix and should
   not be sold as one.

   The 0 ms is load-bearing, so it is guarded two ways. `SELFTEST=1` shifts
   every onset one token late and must report a large error (it reports mean
   349 ms, worst 2275 ms, 100/150 words visible) — if that ever reads 0 ms the
   two sides have gone circular and the run proves nothing. And a sentence
   whose blob walk does not reconcile prints `UNSCORED` rather than a number.

   Two traps cost real time here and are worth not repeating. Matching the
   per-word and whole-text blob streams **cannot be exact-string**: espeak
   applies sentence-level allophony, so "of the" before a vowel is `ʌvðɪ` while
   the per-word strings concatenate to `ʌvðə`. An identity test misses that
   fusion, slips one blob, and reports a confident **650 ms error that is
   purely the harness's own** — it was briefly believed. Nor is a
   low-similarity 1:1 step evidence of a slip: `"A"` reduces to `ɐ` and `to` to
   `tə` in context, and failing sentences on that signal marked two clean ones
   UNSCORED. The honest invariant is `per_blobs - fusions == whole_blobs`.

   **Caveat, untested:** the harness calls the `espeak-ng` CLI directly, while
   production reaches espeak through kokoro-js, which applies its own text
   normalisation first. Aloud has already normalised via `spokenFor` by that
   point so the remaining difference should be small, but "should be" is not
   measured, and a normalisation difference would move the blob boundaries this
   whole comparison rests on.

3. **Distortion is not fully explained — and it is now the leading suspect
   for the drift too.** Reduced but reported as still present. Onset error and
   audio quality are different questions and the harness only measures the
   first. Candidates: CPU contention (Kokoro inference starves the audio
   pipeline and stalls the rAF paint, which looks like drift), and very short
   clips — segmentation went 734 → ~1150 sentences on the Week 10 guide, so
   there are far more inference calls.

   This moved up the list on 2026-07-30: the three *timing* explanations for
   sentence-start drift were measured and refuted (see "Ruled out" above), so
   the remaining candidates are the paint path and the audio pipeline rather
   than the onsets fed to them. Note the 900 ms busy-loop in that probe blocked
   the main thread without moving the audio clock at all — which is exactly the
   shape of "the highlight stalls and then jumps", and is a *paint* failure,
   not a timing one.

   **Untested diagnostic, and still the highest-value single observation
   available:** pause 30–60 s so the runway pre-generates, then play. If it
   cleans up, it's contention, not timing. It needs a human ear, which is why
   it is still open.

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
    node tools/whole-text-selfcheck.mjs           # onset error on the SHIPPING path
    SELFTEST=1 node tools/whole-text-selfcheck.mjs   # must NOT be 0ms

The two self-check runs must stay at 0 ms. `NOWARM=1` is not optional — that
path was 500 ms out while the badge read "exact". `whole-text-fusion.mjs`
needs only espeak, runs in seconds, and flags sentences where espeak fuses
function words; note that a flagged sentence is **not** by itself a
misalignment — measured, `alignExactStarts` recovers the fusions it finds
(open item 2). `whole-text-selfcheck.mjs` is the one that scores the shipping
path end to end, and its `SELFTEST=1` run must report a LARGE error: a 0 ms
there means the harness has gone circular and its real-data 0 ms is worthless.

All four tools now refuse to run without `espeak-ng` rather than reporting a
green result from having measured nothing — that footgun was live until
2026-07-30 and was hiding the fusion this handoff documents.

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
