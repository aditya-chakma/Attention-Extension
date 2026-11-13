#!/usr/bin/env bash
# Builds the Web Store zip (scripts/package.sh) and runs the end-to-end tests
# against its unpacked contents instead of the source folder, so a file the
# zip forgot fails a test before the package is uploaded.
# Extra arguments go to Playwright, e.g. a spec file or --headed.
set -euo pipefail

cd "$(dirname "$0")/.."

bash scripts/package.sh > /dev/null

VERSION=$(node -p "require('./manifest.json').version")
UNPACKED=$(mktemp -d)
trap 'rm -rf "$UNPACKED"' EXIT

unzip -q "dist/attention-$VERSION.zip" -d "$UNPACKED"
echo "Testing dist/attention-$VERSION.zip ($(find "$UNPACKED" -type f | wc -l | tr -d ' ') files)"

ATTENTION_EXTENSION_PATH="$UNPACKED" npx playwright test "$@"
