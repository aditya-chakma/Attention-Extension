#!/usr/bin/env bash
# Packages the extension into dist/attention-<version>.zip for upload to the
# Chrome Web Store. There is no build step: the source files are shipped as-is.
set -euo pipefail

cd "$(dirname "$0")/.."

VERSION=$(node -p "require('./manifest.json').version")
OUT_DIR="dist"
OUT="$OUT_DIR/attention-$VERSION.zip"

# Only ship what the manifest needs. Tests, configs and node_modules stay out.
FILES=(
    manifest.json
    background.js
    icons.js
    bookmarkStore.js
    settingsStore.js
    statsStore.js
    screenTime.js
    contentScript.js
    hide.css
    player-buttons.css
    popup.html
    popup.js
    popup.css
    utils.js
    blocked.html
    blocked.css
    blocked.js
    videos.html
    timestamps.html
    playlist.html
    dashboard.js
    settings.html
    settings.js
    settings.css
    insights.html
    insights.js
    insights.css
    charts.js
    dashboard.css
    assets
    LICENSE
)

mkdir -p "$OUT_DIR"
rm -f "$OUT"
zip -r -X "$OUT" "${FILES[@]}" -x '*.DS_Store'

echo "Packaged $OUT"
unzip -l "$OUT"
