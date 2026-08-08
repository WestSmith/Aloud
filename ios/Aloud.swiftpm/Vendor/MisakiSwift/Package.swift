// swift-tools-version: 5.9

import PackageDescription

// Pinned, app-local packaging of MisakiSwift 1.0.6
// (6835a1ce4a8854075c89f18ff75c74b13ef58e15). Its source and models are
// unchanged; only linkage/resource packaging and the MLX bug-fix pin differ.
let package = Package(
    name: "MisakiSwift",
    platforms: [.iOS("18.0"), .macOS("15.0")],
    products: [
        .library(name: "MisakiSwift", targets: ["MisakiSwift"]),
    ],
    dependencies: [
        .package(url: "https://github.com/ml-explore/mlx-swift", exact: "0.30.6"),
        .package(url: "https://github.com/mlalma/MLXUtilsLibrary.git", exact: "0.0.6"),
    ],
    targets: [
        .target(
            name: "MisakiSwift",
            dependencies: [
                .product(name: "MLX", package: "mlx-swift"),
                .product(name: "MLXNN", package: "mlx-swift"),
                .product(name: "MLXUtilsLibrary", package: "MLXUtilsLibrary"),
            ],
            // See KokoroSwift's local manifest: the non-reserved directory
            // name keeps the hierarchy and bytes while remaining signable.
            resources: [.copy("ModelResources")]
        ),
    ]
)
