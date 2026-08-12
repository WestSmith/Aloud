# Vendored native Kokoro packages

These two packages are pinned source snapshots used by the iOS app only:

- `KokoroSwift`: mlalma/kokoro-ios 1.0.11, commit
  `4d6d1d8ff8cd012014180c9cd4cf0151e7682354` (MIT).
- `MisakiSwift`: 1.0.6, commit
  `6835a1ce4a8854075c89f18ff75c74b13ef58e15` (Apache-2.0).

Resource bytes and inference math are unchanged. One local KokoroSwift repair
keeps each convolution's stored bias anchored to its original model tensor
instead of assigning a new lazy reshape node back to it on every sentence. That
prevents an ever-growing retained MLX graph without changing the convolution.
The app-local snapshots also expose an optional, throwing inference checkpoint
with a no-op default. Aloud uses it to stop between lazy MLX evaluation
boundaries after cancellation or an iOS inactive transition; model operations,
weights, and successful-output math remain unchanged.
Static decoder scale and stride constants are also multiplied as Swift integers
instead of creating and immediately evaluating temporary MLX arrays during
model preparation.

The manifests make the libraries static/automatic, copy resources beneath the
non-reserved `ModelResources` directory, and pin mlx-swift 0.30.6. Five resource
lookups use that renamed directory. Those packaging changes avoid
missing-framework and invalid-bundle-signature failures, as well as the
incorrect-output bug affecting older MLX releases on some iPhones.
