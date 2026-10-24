# Vendored native Kokoro packages

These two packages are pinned source snapshots used by the iOS app only:

- `KokoroSwift`: mlalma/kokoro-ios 1.0.11, commit
  `4d6d1d8ff8cd012014180c9cd4cf0151e7682354` (MIT).
- `MisakiSwift`: 1.0.6, commit
  `6835a1ce4a8854075c89f18ff75c74b13ef58e15` (Apache-2.0).

Resource bytes are unchanged. Their manifests make the
libraries static/automatic, copy resources beneath the non-reserved
`ModelResources` directory, and pin mlx-swift 0.30.6. Five resource lookups use
that renamed directory. Those packaging changes avoid missing-framework and
invalid-bundle-signature failures, as well as the incorrect-output bug affecting
older MLX releases on some iPhones.

Local KokoroSwift change: `Sources/KokoroSwift/BuildingBlocks/ConvWeighted.swift`
differs from upstream in both convolution overloads. Each call uses a local
reshaped bias view rather than assigning the lazy reshape back to the stored
bias, which otherwise retains successive MLX reshape graphs across inference.
`node tools/native-kokoro-memory-selfcheck.mjs` guards this narrow source fix;
it does not measure device heap usage.
