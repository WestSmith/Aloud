// swift-tools-version: 5.9

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
            teamIdentifier: "",
            displayVersion: "1.0",
            bundleVersion: "1",
            // Placeholder so the package builds with no asset catalog. To use the
            // real Aloud icon, see ios/README.md — it needs a 1024×1024 source,
            // which the repo's existing 512px icons don't provide.
            appIcon: .placeholder(icon: .book),
            accentColor: .presetColor(.purple),
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
