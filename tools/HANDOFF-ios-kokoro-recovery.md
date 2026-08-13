# iOS Kokoro recovery handoff

Branch: `agent/fix-ios-resume-recovery`

Draft PR: https://github.com/WestSmith/Aloud/pull/12

Failed physical-device build: Aloud `6.24.3` (`16`). The user confirmed that
fresh Fenrir playback still failed in that build. Do not use it as a recovery
baseline.

Previous control build: Aloud `6.24.4` (`17`), signed and installed on the
paired iPad on 2026-08-13. It restores the fresh Play path from physically
working `5108b79`. Its clean Release build succeeded; the packaged
`web/index.html` SHA-256 exactly matched the source
(`0aef45ae710e274eb639ff2cd39f4493a2c3d2ddb6b67774a083e429eb51c1f1`).
Device inventory confirmed 6.24.4 (17). The user then physically confirmed that
fresh Fenrir playback at 1.5x starts and continues past the former three-second
cancellation point. This validates 6.24.4 as the fresh-Play control. Word
retarget, ordinary Pause/resume, and the original long-pause/background recovery
sequence remain to be verified before merge.

Current installed candidate: Aloud `6.24.5` (`18`), signed, installed in place,
and launched on the paired iPad on 2026-08-13. Device inventory explicitly
confirmed 6.24.5 (18). Its clean Release build succeeded, and the source,
synced iOS asset, and packaged `web/index.html` share SHA-256
`4c47a3fed24ee7aafd205d129daab83316c946d131668fd68a28d7fb94e0281e`.
The development-signature trust warning reported by macOS is identical to the
warning for the successfully installed 6.24.4 (17) control, and both packages
embed the same provisioning profile; the device accepted the new package.
The first word-retarget test was reported as still not working. That result is
not a clean build-18 attribution: the initial launch did not terminate an
already-running process, and the web version label was accidentally left at
6.24.4. A later `--terminate-existing` launch replaced PID 16249 with PID 16264,
proving the new native package was then running, but no second build-18 test was
requested after that forced relaunch. Treat the user report as a real unresolved
retarget failure and do not mark build 18 verified.

Next candidate: Aloud `6.24.6` (`19`), web marker
`v6.24.6 (19) · web R19`. It has not yet been built, installed, or physically
tested. The asset-sync check now derives the exact visible marker
and service-worker cache key (`aloud-v6.24.6-b19`) from Package.swift, then
requires byte-identical root/iOS assets. This prevents the build-18 version
ambiguity from recurring.

## Post-control audit

After fresh Play passed, an adversarial transport review found that a word tap
paused but retained the previous `S.audioPlay` while its replacement sentence
was generating. A quick Pause/Play or foreground activity event could therefore
resume the superseded clip and jump back to the old location. Build 18 fixed
ownership by disposing the entire player, but that also discarded the iPad
media element that had already proved it could produce Fenrir audio. A new
element can silently fail even when `play()` resolves, so build 19 instead
clears the superseded clip owner while preserving an audibly advancing player.
Unplayed, stalled, errored, long-paused, or recovery-probation players still get
the full rebuild. Captured karaoke ticks and pre-playing terminal-event guards
prevent old callbacks from adopting a cached replacement.

The lifecycle self-check now executes the production word-start, transport,
and native activity helpers. It covers a rolling player retarget, foreground
activity, quick Pause/Play, a second pending retarget, stale/long-paused and
unproven players, busy-to-idle latest-word ownership, and old karaoke callbacks.

The same review found that the one WebKit player rebuilt after a proven stalled
resume was not itself watched. The recovery-only replacement now gets the
four-second progress watchdog; a second dead pipeline pauses with an explicit
retry notice. Fresh generated Fenrir clips remain outside that watchdog, so
normal inference/start latency is still unbounded. These post-control patches
are now installed as the Aloud `6.24.5` (`18`) candidate but have not yet been
physically verified.

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

## Regression found after 6.24.3 physical test

The first-request stall protection itself broke normal playback:

- `667ac94` wrapped the entire current-sentence generation (including G2P and
  every chunk) in a three-second JavaScript deadline.
- `e173012` independently classified any still-owned native request as stalled
  after three seconds.
- Full-quality Fenrir inference can legitimately exceed three seconds. Both
  paths therefore cancelled healthy generation before its WAV could play and
  transferred the sentence to an unreliable fallback path.

The 6.24.4 control patch removes both elapsed-time cancellation mechanisms,
starts fresh Play immediately in its gesture turn while audio-session
reactivation proceeds fire-and-forget, and confines the WebKit media watchdog
to resuming an existing paused clip. A visible explicit Play also no longer
trusts a possibly stale JavaScript activity flag; Swift re-samples
`UIApplication` at the actual generation boundary.

## Recovery design retained in 6.24.4

- `e173012` atomically reserves one native generation across all Aloud windows.
  A concurrent request receives `native_busy`; cancellation cannot release an
  MLX evaluation still executing; and any ordered idle event is delivered
  before the terminal reply so the next chunk cannot falsely block itself.
- An actually older admitted request still produces `native_busy`; that path
  retains its bounded Apple-voice coverage and sentence-boundary handoff.
- Native speculative generation remains disabled, preventing expensive MLX
  work from starting while playback is paused. Browser runway is unchanged.
- MLX lifecycle checkpoints remain at all forced evaluation boundaries.
- Long-paused/suspended WebKit audio is rebuilt inside the next Play gesture,
  and the progress watchdog is used only when resuming retained audio.
- Cancelled native promises remain generation-epoch scoped, so retargeting
  cannot reuse an abandoned same-sentence promise.

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

All focused commands passed for the 6.24.5 candidate, and the root/iOS web
assets are byte-identical. Keep the branch checkpoint pushed before handoff.
Do not merge PR 12 until the user confirms physical Fenrir/1.5x fresh Play,
word retarget, Pause/resume, and then a long pause/background cycle.
