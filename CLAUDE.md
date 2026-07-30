# Aloud

Read-aloud reader with karaoke word highlighting, neural voices, RSVP speed
reading, and native PDF/HTML views.

## Shape of the repo

`index.html` is the app — ~5,700 lines, ~2.1 MB, everything inline including a
bundled pdf.js. There is no build step and no bundler. It ships two ways from
that one file:

- **Web PWA** — GitHub Pages, deployed from `main` by `.github/workflows/pages.yml`.
  Live at <https://westsmith.github.io/Aloud/> (capital A; the lowercase path 404s).
- **iOS app** — `ios/Aloud.swiftpm`, a Swift Playgrounds App package that opens
  in Swift Playgrounds on an iPad *and* in Xcode on a Mac. It bundles a copy of
  the web app and serves it from a loopback HTTP server. See `ios/README.md`.

**The two are one codebase, deliberately.** The iOS app does not fork
`index.html`; it bundles a byte-identical copy and injects `window.__aloudNative`.
On the web that is undefined, so every native branch is dead code. A fix lands
in both because there is only one file to fix.

### If you edit index.html

Run `./ios/sync-web-assets.sh` and commit the refreshed copy under
`ios/Aloud.swiftpm/web/`. The **iOS bundle in sync** workflow fails on drift.
It is separate from `pages.yml` on purpose — a stale bundle must never block a
web deploy.

Bump `<meta name="aloud-version">` for anything user-visible. Nothing else
tracks the version.

Quick syntax check (there is no linter):

    START=$(grep -n '^<script>$' index.html | tail -1 | cut -d: -f1)
    END=$(grep -n '^</script>$' index.html | tail -1 | cut -d: -f1)
    awk -v s=$START -v e=$END 'NR>s && NR<e' index.html > /tmp/app.js
    node --check /tmp/app.js

### Declaration order is a real hazard

The script is one long classic `<script>`, so a top-level `const`/`let`
referenced by a function defined *earlier* in the file is a temporal-dead-zone
`ReferenceError`, not a harmless `undefined`. Anything read by `pauseAll`,
`setPlayIcon` or `loadKokoro` belongs up with the app state near the top —
that is why `NATIVE`, `nativeUtter` and the Kokoro cover flags live there.

## Karaoke sync — read the handoff before touching it

**`tools/HANDOFF-karaoke-sync.md` first.** Nine independent causes have produced
the same "highlight runs ahead of the audio" symptom, which is why it keeps
coming back. Assume yours is a tenth and verify before building on it.

The single most important rule, learned the expensive way: **measure, don't
reason.** Two fixes in that sequence were wrong precisely because they were
reasoned about instead of measured.

    node tools/karaoke-selfcheck.mjs              # must be 0 ms
    NOWARM=1 node tools/karaoke-selfcheck.mjs     # must be 0 ms, not optional
    node tools/whole-text-fusion.mjs              # must be 0 hazards

The first two need espeak-ng, onnxruntime-node and the Kokoro model — setup is
in the handoff. `whole-text-fusion.mjs` needs only espeak and answers a question
the other two structurally cannot, because they phonemise per word while
production sends whole text.

Two traps worth knowing before you start: the timing badge reading "exact" is
**not** a correctness signal (it means the aligner returned something, not that
it mapped onto the right blobs), and a 0 ms self-check does **not** clear a
sentence for production.

## Engines

Three, behind `S.engine`:

- `device` — Web Speech API. Instant, but timing is *estimated*
  (`buildTimeline` + `calibFactor`) and calibrates over a sentence or two, so
  its first words drift. On iOS it only ever reaches Apple's compact voices.
- `neural` — Kokoro via kokoro-js, weights from HuggingFace. Best quality;
  onsets read from the model's own durations, so sync is exact. Costs a
  155–305 MB one-time download.
- `native` — `AVSpeechSynthesizer`, **iOS app only**. Reaches Premium/Enhanced
  voices Safari cannot see, no download, real word-boundary callbacks.

Do not silently substitute one for another. Swapping `neural` for `device`
trades exact timing for estimated timing, which reads to a user as the sync bug
returning — see `KOKORO_COVER_DELAY_MS` in `index.html` for the guard that
exists because this was shipped and regressed twice.

## What this container cannot do

Linux, no Mac, no Xcode, no Swift toolchain — the iOS app cannot be compiled or
tested here, only written. It also cannot *listen*, so audio distortion needs a
human ear. Everything else is measurable and should be measured.
