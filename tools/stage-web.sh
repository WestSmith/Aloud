#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Generated artifact: recreate it so no stale or hidden files can be deployed.
rm -rf _site
mkdir -p _site
cp index.html sw.js manifest.json kokoro-worker.js robots.txt \
  icon-192.png icon-512.png icon-maskable.png apple-touch-icon.png _site/
