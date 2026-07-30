// swift-tools-version: 5.9
//
// Confirmed working: the "failed to load" was never the manifest — it was three
// ordinary compile errors in the sources, and this manifest evaluated fine to
// produce them. Don't lower this speculatively; 5.9 language mode is what the
// sources are written against.

// This is a Swift Playgrounds *App* package. It opens two ways:
//   • Swift Playgrounds on the iPad — build and install straight onto the device, no Mac.
//   • Xcode on a Mac — File ▸ Open this .swiftpm directory; it builds like any app target.
//
// `AppleProductTypes` is only available in those two contexts (it is not part of
// open-source SwiftPM), which is why a plain `swift build` from a terminal won't
// work here. That is expected, not a misconfiguration.
//
// Everything that would normally live in an Xcode target's settings — background
// audio, orientations, ATS — is in Info.plist next to this file, so the two
// toolchains agree.

import PackageDescription
import AppleProductTypes

let package = Package(
    name: "Aloud",
    platforms: [.iOS("16.0")],
    products: [
        .iOSApplication(
            name: "Aloud",
            targets: ["AppModule"],
            bundleIdentifier: "com.westsmith.aloud",
            displayVersion: "1.0",
            bundleVersion: "1",
            // appIcon/accentColor/teamIdentifier are deliberately omitted. Every
            // one of them is optional, and each is a spelling of an enum case
            // that varies between Swift Playgrounds versions — i.e. a way for
            // the build to fail before it has run once. Swift Playgrounds fills
            // in a default icon; set a real one from its own UI (or see
            // ios/README.md) once the app is running.
            supportedDeviceFamilies: [.pad, .phone],
            supportedInterfaceOrientations: [
                .portrait,
                .landscapeLeft,
                .landscapeRight,
            ],
            additionalInfoPlistContentFilePath: "Info.plist"
        )
    ],
    targets: [
        .executableTarget(
            name: "AppModule",
            path: ".",
            exclude: ["Info.plist"],
            resources: [
                // .copy (not .process) — the local web server serves these by
                // relative path, so the directory layout must survive the build
                // exactly as it is on disk.
                .copy("web")
            ]
        )
    ]
)
