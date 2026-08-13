#!/usr/bin/env bash
#
# Copies the web app into the iOS app bundle.
#
# The native app ships its own copy of index.html so it launches offline and is
# not at the mercy of a GitHub Pages deploy. That means the copy under
# ios/Aloud.swiftpm/web/ has to be refreshed whenever the root web app changes —
# run this after editing index.html, then commit both.
#
# Verify without writing anything:  ./ios/sync-web-assets.sh --check

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$REPO_ROOT/ios/Aloud.swiftpm/web"

ASSETS=(
  index.html
  kokoro-worker.js
  sw.js
  manifest.json
  icon-192.png
  icon-512.png
  icon-maskable.png
  apple-touch-icon.png
)

CHECK_ONLY=0
[[ "${1:-}" == "--check" ]] && CHECK_ONLY=1

# Keep the three user-visible/build cache identities tied together. A native
# package once shipped as 6.24.5 (18) while its reader page still displayed
# 6.24.4, making a physical-device result impossible to attribute confidently.
PACKAGE="$REPO_ROOT/ios/Aloud.swiftpm/Package.swift"
DISPLAY_VERSION="$(sed -nE 's/^[[:space:]]*displayVersion: "([^"]+)",[[:space:]]*$/\1/p' "$PACKAGE")"
BUNDLE_VERSION="$(sed -nE 's/^[[:space:]]*bundleVersion: "([^"]+)",[[:space:]]*$/\1/p' "$PACKAGE")"
if [[ -z "$DISPLAY_VERSION" || -z "$BUNDLE_VERSION" ]]; then
  echo "Package.swift must contain exactly one displayVersion and bundleVersion" >&2
  exit 1
fi

EXPECTED_MARKER="v$DISPLAY_VERSION ($BUNDLE_VERSION) · web R$BUNDLE_VERSION"
EXPECTED_CACHE="aloud-v$DISPLAY_VERSION-b$BUNDLE_VERSION"
ACTUAL_MARKER="$(sed -nE 's/^<meta name="aloud-version" content="([^"]+)">$/\1/p' "$REPO_ROOT/index.html")"
ACTUAL_CACHE="$(sed -nE "s/^const VERSION = '([^']+)';$/\\1/p" "$REPO_ROOT/sw.js")"
if [[ "$ACTUAL_MARKER" != "$EXPECTED_MARKER" ]]; then
  echo "index.html version marker does not match iOS $DISPLAY_VERSION ($BUNDLE_VERSION)" >&2
  exit 1
fi
if [[ "$ACTUAL_CACHE" != "$EXPECTED_CACHE" ]]; then
  echo "sw.js cache version does not match iOS $DISPLAY_VERSION ($BUNDLE_VERSION)" >&2
  exit 1
fi

mkdir -p "$DEST"

drift=0
for asset in "${ASSETS[@]}"; do
  src="$REPO_ROOT/$asset"
  dst="$DEST/$asset"

  if [[ ! -f "$src" ]]; then
    echo "missing source: $asset" >&2
    exit 1
  fi

  if [[ ! -f "$dst" ]] || ! cmp -s "$src" "$dst"; then
    drift=1
    if [[ $CHECK_ONLY -eq 1 ]]; then
      echo "stale: ios/Aloud.swiftpm/web/$asset"
    else
      cp "$src" "$dst"
      echo "synced: $asset"
    fi
  fi
done

if [[ $CHECK_ONLY -eq 1 ]]; then
  if [[ $drift -eq 1 ]]; then
    echo
    echo "The iOS bundle is behind the web app. Run ./ios/sync-web-assets.sh" >&2
    exit 1
  fi
  echo "iOS bundle is in sync with the web app."
elif [[ $drift -eq 0 ]]; then
  echo "Already in sync — nothing to do."
fi
