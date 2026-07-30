# Aloud for iPad / iPhone

A native app wrapper around the Aloud web app, built to fix the problems that
cannot be fixed from inside Safari.

`Aloud.swiftpm` is a **Swift Playgrounds App package**. It opens two ways from
the same directory, with no separate Xcode project to keep in step:

- **Swift Playgrounds on the iPad** — builds and installs straight onto the
  device. No Mac required at any point.
- **Xcode on a Mac** — `File ▸ Open…` the `Aloud.swiftpm` directory. It builds,
  signs, and archives like a normal app target.

---

## Why a native app at all

The web app is genuinely good and stays the primary target. Three things,
though, are simply not reachable from a web page on iOS.

### 1. Sound that the mute switch can't kill

This is the "loads, but no sound" bug.

Audio from a web page runs in an **ambient** audio session, and ambient audio
obeys the silent switch. A muted iPad plays nothing: no error, no crash, the
karaoke highlight still sweeps across the words in perfect silence. Nothing a
web page can call opts out of that.

A native app sets `AVAudioSession` to `.playback` (`AudioSession.swift`), which
is defined to ignore the silent switch, and `.spokenAudio` mode, which gets the
interruption behaviour audiobooks want. Because the WKWebView's audio runs
inside that same session, this fixes **both** engines at once — Kokoro included.

### 2. Autoplay that survives generation latency

Aloud generates a sentence and *then* calls `play()`, seconds after the tap that
started playback, so the call no longer traces back to a user gesture and Safari
refuses it. `index.html` works around this with a silent-WAV priming trick
(`primeAudioGesture`). The native app just sets
`mediaTypesRequiringUserActionForPlayback = []` and the restriction is gone.

### 3. Lock-screen playback

`UIBackgroundModes: audio` plus `MPRemoteCommandCenter` means playback continues
with the screen off, and the lock screen controls drive the real transport.

---

## Architecture

```
Aloud.swiftpm/
├── Package.swift              iOSApplication product (needs AppleProductTypes —
│                              Playgrounds/Xcode only, not plain SwiftPM)
├── Info.plist                 background audio, ATS, file sharing
├── AloudApp.swift             launch order: audio session → server → web view
├── ContentView.swift          loading / loaded / failed states
├── WebViewContainer.swift     WKWebView + the Swift half of the bridge
├── BridgeScript.swift         the JS half, injected at document start
├── LocalWebServer.swift       loopback static server for the bundled app
├── AudioSession.swift         .playback session + lock-screen controls
├── NativeSpeechEngine.swift   AVSpeechSynthesizer engine
└── web/                       bundled copy of the web app (see "Keeping in sync")
```

### Why a loopback HTTP server rather than `loadFileURL`

A `file://` origin in WKWebView has **no IndexedDB, no Cache Storage and no
service worker**. Aloud needs all three: the Continue library lives in
IndexedDB, and transformers.js caches the ~305 MB Kokoro weights in Cache
Storage. Loading from `file://` would quietly reduce the app to a stateless
reader that re-downloads the model on every launch.

`http://127.0.0.1:<port>/` is a *potentially trustworthy* origin under the
secure-context rules, so the page gets the full storage API surface, exactly as
it does on GitHub Pages. The listener is pinned to the loopback interface, so
nothing is reachable off-device.

If every candidate port fails to bind, `AppModel` falls back to loading
<https://westsmith.github.io/Aloud/> so the app still works with a network
connection. Only offline launch is lost.

---

## The third voice engine

Kokoro is untouched and remains the best-sounding option. The native engine is
an **addition** next to it, not a replacement — the voice sheet now has three
segments (`⚡ Device`, `✨ Neural`, `📱 iOS`), and the third only appears when
the bridge is present. On the web, `window.__aloudNative` is undefined and every
native branch in `index.html` is dead code.

What it adds over the existing Web Speech (`device`) engine, which nominally
reaches the same iOS voices:

- **Premium and Enhanced voices.** Safari's `speechSynthesis` only ever exposes
  the compact system set. `AVSpeechSynthesisVoice.speechVoices()` sees
  everything installed under *Settings ▸ Accessibility ▸ Spoken Content ▸
  Voices*.
- **Exact karaoke timing.** `willSpeakRangeOfSpeechString` is a real word
  boundary callback. The web `device` engine carries a whole estimated-timing
  fallback (`buildTimeline` + `calibFactor`) precisely because iOS fires
  boundary events unreliably through the web API. None of that machinery is used
  here.
- **Instant and free** — no download, no WASM heap, so it works on a device that
  cannot hold the Kokoro model.

`NSRange` is UTF-16, which is exactly what JavaScript string indices are, so
`charIndex` lines up with the offsets the web app computed with no conversion.

---

## Keeping the bundled copy in sync

The app ships its own copy of the web app under `Aloud.swiftpm/web/`. Refresh it
after editing the root `index.html`:

```sh
./ios/sync-web-assets.sh          # copy
./ios/sync-web-assets.sh --check  # verify only, non-zero exit on drift
```

`.github/workflows/ios-sync-check.yml` runs the `--check` form on every push, so
drift shows up as a failed check rather than as an app that mysteriously lags a
release behind.

---

## Building

### On the iPad (no Mac)

1. Get the repo onto the iPad — Working Copy, or clone into Files, or just
   AirDrop the `Aloud.swiftpm` folder across.
2. Open `Aloud.swiftpm` in **Swift Playgrounds**.
3. Press ▶︎ to run, or **⋯ ▸ Build to Device** to install it to the Home Screen
   with a real icon.

Swift Playgrounds signs with a personal team, so the installed app expires after
7 days and needs a rebuild. That is an Apple limitation, not a project one.

### On a Mac

1. `File ▸ Open…` the `ios/Aloud.swiftpm` directory in Xcode.
2. Set your team under *Signing & Capabilities*.
3. Build and run to a connected iPad, or archive for TestFlight.

Note that `swift build` from a terminal will **not** work — `AppleProductTypes`
ships only with Swift Playgrounds and Xcode, not with open-source SwiftPM. That
is expected.

---

## App icon

`Package.swift` currently uses `appIcon: .placeholder(icon: .book)` so the
package builds with no asset catalog present.

To use the real Aloud icon you need a **1024×1024** source; the repo's existing
icons top out at 512×512, so they'd need regenerating first. Once you have one,
add `Assets.xcassets` with an `AppIcon` app-icon set and change the line to
`appIcon: .asset("AppIcon")`.

---

## Not done / worth knowing

- **None of the Swift here has been compiled.** It was written in a Linux
  container with no macOS toolchain, so treat the first build as a real review
  pass rather than a formality.
- **Qwen TTS** is not wired up, and it is not a drop-in. Qwen3-TTS is a hosted
  API (Alibaba DashScope) rather than a local model, so it would mean network
  calls, an API key, and per-character cost — a different privacy and offline
  story from Kokoro, which runs entirely on-device. There is no
  browser-runnable Qwen TTS in transformers.js today. If the goal is *better
  voices*, the Premium AVSpeech voices and Kokoro already cover it offline; if
  the goal is *cloud-quality voices* and the tradeoff is acceptable, it belongs
  behind an explicit opt-in with a key field, and is worth its own change.
- **COOP/COEP headers are deliberately not sent** by the local server. They
  would unlock `SharedArrayBuffer` and multi-threaded WASM (a faster Kokoro),
  but they also make every cross-origin load — jsDelivr's kokoro-js,
  HuggingFace's weights — fail unless it opts in correctly. Worth trying as a
  measured experiment in `LocalWebServer.send`, not worth defaulting to.
- **Native engine speed mapping is approximate.** `AVSpeechUtterance.rate` is
  0…1 with a non-linear response above default, so `avRate(forMultiplier:)` is a
  piecewise fit. It affects how fast the voice actually is, not sync accuracy —
  the highlight follows real boundary callbacks either way.
