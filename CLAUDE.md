# Aloud

Read-aloud reader with karaoke word highlighting, neural voices, RSVP speed
reading, and native PDF/HTML views.

## Shape of the repo

`index.html` is the app — one inline HTML file, everything inline including a
bundled pdf.js. There is no build step and no bundler. It ships two ways from
that one file:

- **Web PWA** — GitHub Pages, deployed from `main` by `.github/workflows/pages.yml`.
  Live at <https://westsmith.github.io/Aloud/> (capital A; the lowercase path 404s).
- **iOS app** — open `ios/Aloud.xcworkspace` in Xcode on a Mac. MLX native
  targets are not supported by the iPad Swift Playgrounds build service. The
  app bundles the web UI and serves it from a loopback HTTP server. See
  `ios/README.md`.

**The two are one codebase, deliberately.** The iOS app does not fork
`index.html`; it bundles a byte-identical copy and injects `window.__aloudNative`.
On the web that is undefined, so every native branch is dead code. A fix lands
in both because there is only one file to fix.

### If you edit index.html

Run `./ios/sync-web-assets.sh` and commit the refreshed copy under
`ios/Aloud.swiftpm/web/`. The **iOS bundle in sync** workflow fails on drift.
It is separate from `pages.yml` on purpose — a stale bundle must never block a
web deploy.

Bump `<meta name="aloud-version">` for anything user-visible and keep
`sw.js` VERSION (`aloud-` + that value), Package.swift displayVersion and the
iOS README release line in step. Run `node tools/check-versions.mjs`; CI rejects
drift. A changed worker VERSION rolls the shell cache even for HTML-only releases.

Quick syntax check (there is no linter):

    START=$(grep -n '^<script>$' index.html | tail -1 | cut -d: -f1)
    END=$(grep -n '^</script>$' index.html | tail -1 | cut -d: -f1)
    awk -v s=$START -v e=$END 'NR>s && NR<e' index.html > /tmp/app.js
    node --check /tmp/app.js

### Declaration order is a real hazard

The app script is one long classic `<script>`. Defining a function before a
`let`/`const` declaration is safe; **calling it before that binding's initializer
runs** is a temporal-dead-zone `ReferenceError`. Inspect synchronous startup call
paths, not just function-definition order. State read by early calls to
`pauseAll`, `setPlayIcon` or `loadKokoro` belongs with the early app state.

## Karaoke sync — read the handoff before touching it

**`tools/HANDOFF-karaoke-sync.md` first.** Nine independent causes have produced
the same "highlight runs ahead of the audio" symptom, which is why it keeps
coming back. Assume yours is a tenth and verify before building on it.

The single most important rule, learned the expensive way: **measure, don't
reason.** Two fixes in that sequence were wrong precisely because they were
reasoned about instead of measured.

    node tools/karaoke-selfcheck.mjs              # must be 0 ms
    NOWARM=1 node tools/karaoke-selfcheck.mjs     # must be 0 ms, not optional
    node tools/whole-text-fusion.mjs              # diagnostic: known 1-of-4 fusion is expected
    node tools/whole-text-selfcheck.mjs           # measures whole-text alignment; must be 0 ms

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
  92–326 MB one-time browser model download (327 MB in the native app).
- `native` — `AVSpeechSynthesizer`, **iOS app only**. Reaches Premium/Enhanced
  voices Safari cannot see, no download, real word-boundary callbacks.

Fresh installs default to Kokoro; saved engine choices are preserved. Aloud never
substitutes engines automatically. While Kokoro downloads or initializes, wait
with visible setup progress, a loading play button and Cancel. Existing cached
models prepare automatically on selection/launch; a required download waits for
Start setup, Play or Preview. If Kokoro is unavailable, explain why and point to
Voice so the user can explicitly choose another engine.

## Release checks and environment limits

PR CI runs syntax, iOS sync, native token timing, version consistency, scoped
offline/reset checks and the Chromium synthetic guide gate. See
`tools/README-selfcheck.md`. Heavy ONNX/model checks stay local: run warm, NOWARM
and whole-text alignment plus the fusion diagnostic before release. Fusions
alone are not timing failures; missing measurements, non-zero alignment error
or a broken negative control fail.

Use the capabilities actually available in the session. Browser-engine tests and
physical-device speech need independent verification when unavailable locally.
A successful build cannot prove audible quality or lock-screen behavior.

## Merging is the assistant's job

The owner has asked (2026-09-21) that every change be carried all the way:
open the PR, wait for its checks, take it out of draft, squash-merge it, and
clean up — reset the local checkout to `main` and delete the branch. Do not
stop at "PR opened" and hand the merge back. The git proxy in the remote
container returns 403 on branch deletes; if that is still the case, say so
once rather than reporting the branch as deleted.
