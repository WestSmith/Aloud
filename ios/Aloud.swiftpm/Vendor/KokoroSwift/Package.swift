// swift-tools-version: 5.9

import PackageDescription

// Pinned, app-local packaging of mlalma/kokoro-ios 1.0.11
// (4d6d1d8ff8cd012014180c9cd4cf0151e7682354). Upstream publishes a dynamic
// framework, which the generated app target can link without embedding.
// Keeping the product automatic/static makes the installed app self-contained.
let package = Package(
    name: "KokoroSwift",
    platforms: [.iOS("18.0"), .macOS("15.0")],
    products: [
        .library(name: "KokoroSwift", targets: ["KokoroSwift"]),
    ],
    dependencies: [
        // 0.30.6 fixes incorrect NAX detection and corrupted output on affected
        // iPhones, and fixes the Xcode 26 link regression present in 0.30.2.
        .package(url: "https://github.com/ml-explore/mlx-swift", exact: "0.30.6"),
        .package(path: "../MisakiSwift"),
        .package(url: "https://github.com/mlalma/MLXUtilsLibrary.git", exact: "0.0.6"),
    ],
    targets: [
        .target(
            name: "KokoroSwift",
            dependencies: [
                .product(name: "MLX", package: "mlx-swift"),
                .product(name: "MLXNN", package: "mlx-swift"),
                .product(name: "MLXRandom", package: "mlx-swift"),
                .product(name: "MLXFFT", package: "mlx-swift"),
                .product(name: "MisakiSwift", package: "MisakiSwift"),
                .product(name: "MLXUtilsLibrary", package: "MLXUtilsLibrary"),
            ],
            // Keep model/config bytes as exact copies. A nested directory
            // literally named "Resources" makes a flat iOS .bundle fail
            // CodeSign, so the app-local package uses a non-reserved name.
            resources: [.copy("ModelResources")]
        ),
    ]
)
