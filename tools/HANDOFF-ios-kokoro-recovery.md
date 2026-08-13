# iOS Kokoro recovery handoff

Branch: `agent/fix-ios-resume-recovery`

Draft PR: https://github.com/WestSmith/Aloud/pull/12

Last fully validated checkpoint: `7c01f78` (`Add safe Kokoro busy voice fallback`)

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

## Current uncommitted work

The current diff begins a native admission gate and makes JavaScript treat a
`native_busy` rejection as authoritative. It compiles and focused checks pass,
but it is intentionally not release-ready yet.

### Remaining blockers

1. Admission must be an atomic synchronous reservation. The current check of
   `generationStartedAt` occurs before `queue.async`, but that field is set only
   later on the queue. Two rapid or multiwindow calls can both pass and queue.
2. A first admitted request that itself becomes stuck has no three-second
   fallback trigger. Existing tests begin with an already-busy state and miss
   this exact one-Play path.
3. Release the reservation before delivering terminal success/failure, or the
   next chunk can receive a false `native_busy` while cleanup is still running.
4. Waiting -> idle -> scheduled retry has a busy-flap race: if busy returns
   before the zero-delay retry, the resume marker is already cleared and the
   request can be stranded without spinner or fallback.

### Recommended native design

- Under `healthLock`, synchronously reserve `{requestID, admittedAt,
  stallReported}` in `generate()` before dispatching to the MLX queue.
- Reject other requests through `kokoroReply` with `code: native_busy`.
- Schedule one request-ID-keyed three-second health probe. If the reservation
  still exists, broadcast bridge-compatible `kokoroHealth` with `active`,
  `busy`, `kokoroBusy`, and `kokoroBusySeconds`.
- Release exactly once and owner-check every release. Do not clear a reservation
  for an evaluation that is still executing merely because JavaScript cancelled.
- Release before terminal reply; keep a defensive owner-checked defer.
- Make `publishActivity()` report the reservation from admission onward.

### Required regressions

- Fresh idle + one Play + never-settling first native request: after about 3s,
  exactly one Apple fallback starts at the selected word, with no second MLX job.
- Resolve at 2.9s: no fallback. Pause/retarget before deadline: no stale cover.
- Two concurrent/multiwindow generate calls: one reservation, one native_busy.
- Terminal reply is delivered only after reservation release.
- waiting -> idle -> busy before scheduled retry retains the pending intent.

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

Do not install or merge until the four blockers above are fixed and the iOS web
bundle has been synchronized. Build 6.24.3 (16) was versioned but not installed.
