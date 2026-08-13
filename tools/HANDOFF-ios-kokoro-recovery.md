# iOS Kokoro recovery handoff

Branch: `agent/fix-ios-resume-recovery`

Draft PR: https://github.com/WestSmith/Aloud/pull/12

Last fully validated and packaged checkpoint: `858c0e5`

Installed physical-device build: Aloud `6.24.3` (`16`), signed and installed on
the paired iPad on 2026-08-13. Automatic launch was denied only because the
iPad was locked; physical playback validation remains the next step.

## Reported failure

On iPad with native Kokoro/Fenrir, Play can do nothing or emit a brief fragment
and stop. A later word tap reports that Kokoro is finishing earlier speech.
The failure reproduced with the repaired, freshly installed web bundle, so it
is not a stale service-worker or packaging issue.

## Completed and pushed

- Native token alignment and HTML content zoom fixes.
- Persistent WebKit audio recovery/watchdog and media-services reset handling.
- MLX lifecycle checkpoints at forced evaluations.
- Native speculative generation disabled; browser runway retained.
- Cancelled native pending promises isolated by generation epoch.
- Native lifecycle event/Play ordering fixes.
- ConvWeighted retained graph mutation removed.
- IndexedDB Library recovery and bounded cache/memory improvements.
- A bounded Apple-voice fallback that preserves the neural/Fenrir selection,
  starts at the selected word, and hands back only between sentences.

## Final recovery design

- `e173012` atomically reserves one native generation across all Aloud windows.
  A concurrent request receives `native_busy`; cancellation cannot release an
  MLX evaluation still executing; and any ordered idle event is delivered
  before the terminal reply so the next chunk cannot falsely block itself.
- A request-keyed native probe reports a still-owned generation after about
  three seconds. BridgeScript exposes that stall only to the page owning the
  request while forwarding anonymized shared busy health to other windows.
- `667ac94` adds a matching first-request watchdog. A generation resolving by
  2.9 seconds remains Fenrir. If it has not settled at three seconds, the exact
  current sentence and selected word transfer once to Apple speech. Fenrir
  remains selected and receives the next sentence only after ordered idle.
- Pause, word retarget, document/engine changes, native result/deadline races,
  repeated lifecycle events, and idle-to-busy retry flaps all have explicit
  owner/intent regression coverage.
- `858c0e5` synchronizes the reviewed root page into the packaged iOS bundle.

Expected tradeoff: a healthy native sentence taking longer than three seconds
also uses Apple speech for that one sentence. This deliberately prioritizes
bounded time-to-audio over waiting silently, without changing the saved voice.

## Focused validation commands

```sh
node tools/native-lifecycle-selfcheck.mjs
node tools/native-kokoro-checkpoint-selfcheck.mjs
node tools/native-kokoro-memory-selfcheck.mjs
node tools/native-token-timing-selfcheck.mjs
node tools/library-recovery-selfcheck.mjs
./ios/sync-web-assets.sh --check
git diff --check
```

All commands above passed at `858c0e5`. The signed Release build succeeded, the
packaged `web/index.html` SHA-256 matched the source
(`2231a91e2ef658e401332a5e3974da12d39b04ec66b0405dc42e892a2c7e0ac1`),
and device inventory confirmed Aloud 6.24.3 (16). Do not merge PR 12 until the
user confirms physical Fenrir/1.5x Play, word retarget, Pause/resume, and a long
pause/background cycle.
