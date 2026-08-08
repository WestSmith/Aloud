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
