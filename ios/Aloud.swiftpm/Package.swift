// swift-tools-version: 5.9
//
// Confirmed working: the "failed to load" was never the manifest — it was three
// ordinary compile errors in the sources, and this manifest evaluated fine to
// produce them. Don't lower this speculatively; 5.9 language mode is what the
// sources are written against.

// This is an Apple *App* package opened through ../Aloud.xcworkspace in Xcode.
// Native Kokoro depends on MLX's C/C++/Metal targets, so the iPad Playgrounds
// build service is not a supported compiler for this project.
//
// `AppleProductTypes` is only available in those two contexts (it is not part of
// open-source SwiftPM), which is why a plain `swift build` from a terminal won't
// work here. That is expected, not a misconfiguration.
//
// Everything that would normally live in an Xcode target's settings — background
// audio, orientations, ATS — is in Info.plist next to this file, so the two
// toolchains agree.

import Foundation
import PackageDescription
import AppleProductTypes

// Developers may keep a private validation copy of the model beside the
// sources. Exclude it only when it is actually present: distributed archives
// omit the model and should not emit SwiftPM's "Invalid Exclude" warning.
let localModelPath = "NativeKokoroAssets/kokoro-v1_0.safetensors"
let packageRoot = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
let localModelExcludes = FileManager.default.fileExists(
    atPath: packageRoot.appendingPathComponent(localModelPath).path
) ? [localModelPath] : []

let package = Package(
    name: "Aloud",
    platforms: [.iOS("18.0")],
    products: [
        .iOSApplication(
            name: "Aloud",
            targets: ["AppModule"],
            bundleIdentifier: "com.westsmith.aloud",
            displayVersion: "6.21.6",
            bundleVersion: "10",
            appIcon: .asset("AppIcon"),
            supportedDeviceFamilies: [.pad, .phone],
            supportedInterfaceOrientations: [
                .portrait,
                .portraitUpsideDown,
                .landscapeLeft,
                .landscapeRight,
            ],
            // The reader shell and native Kokoro WAVs are served by a private
            // listener pinned to 127.0.0.1. These App Sandbox capabilities are
            // needed when Xcode runs the iOS app as Mac Catalyst; they do not
            // expose the listener to the LAN. Outgoing access is also needed
            // there for the one-time pinned model download.
            capabilities: [
                .incomingNetworkConnections(),
                .outgoingNetworkConnections(),
            ],
            additionalInfoPlistContentFilePath: "Info.plist"
        )
    ],
    dependencies: [
        .package(path: "Vendor/KokoroSwift"),
        .package(url: "https://github.com/ml-explore/mlx-swift", exact: "0.30.6"),
        .package(url: "https://github.com/mlalma/MLXUtilsLibrary.git", exact: "0.0.6"),
    ],
    targets: [
        .executableTarget(
            name: "AppModule",
            dependencies: [
                .product(name: "KokoroSwift", package: "KokoroSwift"),
                .product(name: "MLX", package: "mlx-swift"),
                .product(name: "MLXUtilsLibrary", package: "MLXUtilsLibrary"),
            ],
            path: ".",
            exclude: [
                "Info.plist",
                "Vendor",
            ] + localModelExcludes,
            resources: [
                // .copy (not .process) — the local web server serves these by
                // relative path, so the directory layout must survive the build
                // exactly as it is on disk.
                .copy("web"),
                // The compact 28-voice embedding set ships with the app. The
                // full 327 MB model deliberately does not live inside the
                // editable .swiftpm document: native dependencies and a file
                // that large are a poor fit for the Playgrounds importer.
                // NativeKokoroEngine
                // downloads the pinned BF16 model once, verifies its exact
                // size and SHA-256, and keeps it in Application Support.
                .copy("NativeKokoroAssets/voices.npz"),
                .copy("NativeKokoroAssets/THIRD_PARTY_NOTICES.md")
            ]
        )
    ]
)
