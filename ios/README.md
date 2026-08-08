# Aloud for iPad / iPhone

Aloud v6.22.0 runs the full Kokoro voice model natively with Apple MLX. The
reader, library, PDF/HTML views and visual design remain the same as the PWA,
but the large model no longer loads or performs inference inside WebKit.

The supported entry point is `Aloud.xcworkspace` in Xcode on a Mac. The app is
then compiled, signed and installed onto the iPad by Xcode.

Do not open this native-MLX build in Swift Playgrounds on the iPad. MLX brings
native C, C++, Metal and shim targets that Xcode supports but the iPad
Playgrounds build service does not reliably support. The previous package also
placed the 327 MB model inside the editable document, which made that importer
failure worse. Native Kokoro needs an Xcode-built app (or a TestFlight/App Store
build), not an on-iPad Playgrounds build.

## Requirements

- A Mac with Xcode 26.6 or newer
- A connected iPhone or iPad running iOS/iPadOS 18+
- An Apple ID/development team selected in Xcode for device signing
- Internet for the first build and the one-time Kokoro model download
- At least 700 MB free while Kokoro performs its first-time setup

MLX cannot run in the iOS Simulator. The package can be compiled for a generic
arm64 iOS device on a Mac, but voice generation must be tested on a physical
iPhone or iPad.

## HTML document text size

Version 6.22.0 replaces WebKit page magnification with document-aware text
reflow for imported HTML study guides. The document text controls enlarge the
guide's text and line spacing inside its existing viewport, while Aloud's top
bar, player, responsive diagrams and other media keep their original size.
Wide tables and preformatted blocks scroll within the guide instead of widening
the reader, and flex-based headings and form controls stay usable on phones.

The floating text-size control remains beside the document on iPad and becomes
a compact horizontal control above the player on iPhone. The same percentage
control is available under Settings → Text size. Interactive sandboxed guides
and the read-only HTML view use the same reflow behavior.

## Native Kokoro

The native app's `✨ Neural · Kokoro` engine now works like this:

1. The first time you press Play with Kokoro selected, Swift downloads the
   pinned full-quality model directly into the app's private storage.
2. Swift verifies the model's exact size and SHA-256 before opening it.
3. `KokoroSwift` generates 24 kHz speech with Apple MLX, off the UI thread.
4. The model's own duration timestamps are returned with each token.
5. Swift writes a short-lived local WAV and gives the reader its loopback URL.
6. The existing Aloud player handles playback, seeking, rate changes, karaoke,
   sentence caching, background batches and lock-screen continuity.

Only a WAV URL and timestamp metadata cross the native bridge. The 327 MB model
and its MLX tensors never enter WebKit, which removes the memory ceiling and
silent-worker failure behind the endlessly pulsing play button.

Playback intentionally remains in Aloud's persistent HTML audio element. That
transport already implements the hard reader behavior—tap-to-read seeking,
pause/resume, pitch-preserving 1–4× speed, sentence transitions, pre-generation,
screen-lock batches and the karaoke clock. Moving inference native fixes the
broken component without replacing those working semantics.

iOS does not allow new Metal inference after the app enters the background.
Aloud therefore pre-generates a runway while it is foregrounded, plays only
that buffered Kokoro audio while locked, and pauses on the same sentence if the
runway runs out. It resumes generation after the app becomes active again;
content is never skipped. The native engine also caps MLX's buffer cache and
clears recyclable buffers after each sentence to avoid memory growth over long
reading sessions.

Version 6.21.6 follows SwiftUI's aggregate scene phase rather than the obsolete
UIApplicationDelegate active callbacks, which UIKit does not call for
scene-based apps. If Aloud becomes temporarily inactive during the one-time
download, verification, or model opening, Kokoro now retains the pending request
and continues automatically when any Aloud window is active again.

The Apple `📱 iOS` voice engine remains available as a model-free alternative,
including installed Premium and Enhanced voices.

## Model and dependency pins

The small Xcode source package contains:

- `voices.npz` (28 US/UK English voices)
  - 14,629,684 bytes
  - SHA-256
    `56dbfa2f2970af2e395397020393d368c5f441d09b3de4e9b77f6222e790f10f`

On first use it downloads the full BF16 model:

- `kokoro-v1_0.safetensors`
  - 327,115,152 bytes
  - SHA-256
    `4e9ecdf03b8b6cf906070390237feda473dc13327cb8d56a43deaa374c02acd8`

`NativeKokoroEngine` checks the model's exact size and SHA-256 before calling
upstream's model initializer. This is important because KokoroSwift 1.0.11
force-unwraps required tensors and would otherwise terminate on a bad file.

The model deliberately stays outside the editable `.swiftpm` document. The
previous 347 MB document put the Playgrounds importer and App Preview under
avoidable pressure on top of MLX's unsupported native dependency graph. The
corrected Xcode source package is small, and opening it does not prepare Kokoro
automatically. A deliberate Play tap starts the setup.

The downloader fetches the pinned model revision, resumes a partial file with
HTTP byte ranges, verifies the same size and hash, then moves it atomically into
Application Support. After that one-time setup, Kokoro works offline.

The iOS package vendors two small source packages:

- KokoroSwift 1.0.11 at
  `4d6d1d8ff8cd012014180c9cd4cf0151e7682354`
- MisakiSwift 1.0.6 at
  `6835a1ce4a8854075c89f18ff75c74b13ef58e15`

Their inference code and resource bytes are unchanged. Their app-local package
manifests use automatic/static linkage and copy resources under the non-reserved
`ModelResources` name; five bundle lookups use that renamed directory. This
preserves every model byte while avoiding Xcode's invalid flat-bundle signature.
The remote dependency graph includes a Swift 6.2 manifest, which is another
reason this release pins Xcode 26.6 rather than promising iPad Playgrounds
compatibility.
The app pins mlx-swift 0.30.6, which fixes incorrect NAX detection and corrupted
output on affected iPhones as well as the Xcode 26 link problem present in the
older 0.30.2 dependency.

## Package layout

```text
ios/
├── Aloud.xcworkspace/             open this in Xcode
└── Aloud.swiftpm/
    ├── Package.swift
    ├── Info.plist
    ├── AloudApp.swift
    ├── ContentView.swift
    ├── WebViewContainer.swift       WKWebView + native command routing
    ├── BridgeScript.swift           nonce-keyed JS promises and events
    ├── NativeKokoroEngine.swift     verification, MLX inference, WAV files
    ├── NativeSpeechEngine.swift     Apple Premium/Enhanced voices
    ├── LocalWebServer.swift         reader shell + native WAV route
    ├── AudioSession.swift           background/remote controls
    ├── NativeKokoroAssets/
    │   └── voices.npz
    ├── Vendor/
    │   ├── KokoroSwift/
    │   └── MisakiSwift/
    ├── Resources/Assets.xcassets
    └── web/                          bundled copy of the PWA UI
```

## Why the loopback server exists

The app loads its bundled reader from `http://127.0.0.1`, not `file://`. This
gives the library a normal origin with IndexedDB and lets the same HTML/CSS/JS
run in the app and on the web. The listener is pinned to loopback and cannot be
reached from the local network.

The origin stays fixed at private port 38473 so saved books and settings remain
available after a relaunch. This release no longer uses Network.framework's
fixed-port listener path: repeated real-device launches could leave that path
stuck with a false “address already in use” error. A small POSIX listener with
`SO_REUSEADDR` avoids that iPad-only failure while remaining loopback-only.

The package declares incoming and outgoing App Sandbox connections for Xcode's
Mac Catalyst destination. Incoming permits this loopback listener; outgoing
permits the pinned Kokoro model download. Xcode limits those entitlements to
macOS builds, and the listener still binds only to `127.0.0.1`.

Native Kokoro clips are exposed only under `/__aloud_kokoro/<UUID>.wav`. The
server rejects traversal and arbitrary cache paths, sends `no-store`, and the
service worker explicitly bypasses the route. Swift deletes each clip as soon
as the reader has converted it into its normal sentence cache.

## Keeping the bundled web UI in sync

Edit the root web app, then refresh the app's bundled copy:

```sh
./ios/sync-web-assets.sh
./ios/sync-web-assets.sh --check
```

The sync check is also run in GitHub Actions.

## Installing on an iPad with Xcode

1. Unzip the release on the Mac.
2. Open `Aloud.xcworkspace` in Xcode. Do not open the `.swiftpm` folder in
   Swift Playgrounds.
3. Connect and unlock the iPad, then select it as the run destination.
4. In Signing, choose your Apple development team.
5. Press Run. Xcode resolves and compiles the pinned MLX dependencies on the
   Mac, then installs the finished app on the iPad.
6. In Aloud, open a document, select **Native Kokoro**, and press Play. Keep
   Aloud open while the progress bar completes the one-time model download.

Kokoro downloads its pinned 312 MiB model once; subsequent launches use the
verified copy stored on the device. A free personal-team installation normally
expires after seven days and must be rebuilt, which is an Apple signing limit.

The command-line generic-device compile used for validation is:

```sh
xcodebuild -workspace Aloud.xcworkspace \
  -scheme Aloud \
  -destination 'generic/platform=iOS' \
  -configuration Release \
  CODE_SIGNING_ALLOWED=NO build
```

Plain `swift build` is not supported because `.iOSApplication` and
`AppleProductTypes` are supplied by Xcode/Swift Playgrounds rather than
open-source SwiftPM.

## Validation status

- Full Release compile for generic arm64 iOS: passing
- Clean signed iOS Simulator build and reader launch: passing
- Mac Catalyst signature and loopback reader-server test: passing
- Kokoro/Misaki resource-bundle signatures and model-file hashes: passing
- Xcode workspace load and scheme discovery: passing
- Fresh build from the exact model-free release staging folder: passing
- Web/native bridge JavaScript parse check: passing
- Bundled web-asset sync check: passing
- Model download pin and bundled voice asset hash: passing
- Physical-device Kokoro audio and timing: required before calling the build
  field-verified

The last item matters: a Simulator cannot execute MLX, so compilation alone
cannot prove real speech output, speed or timestamp behavior.

## Licences

KokoroSwift is MIT. MisakiSwift, MLXUtilsLibrary and the Kokoro model/voice
assets are Apache-2.0. mlx-swift is MIT. The vendored licence files remain next
to their source, and release packages should retain the third-party notices.
