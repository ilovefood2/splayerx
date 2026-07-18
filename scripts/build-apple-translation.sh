#!/bin/bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  exit 0
fi

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUTPUT_DIR="$ROOT_DIR/build/apple-translation"
OUTPUT="$OUTPUT_DIR/apple-translation-helper"

mkdir -p "$OUTPUT_DIR"
xcrun swiftc \
  -O \
  -parse-as-library \
  -module-cache-path /private/tmp/splayer-apple-translation-module-cache \
  -target arm64-apple-macos26.0 \
  "$ROOT_DIR/native/apple-translation/main.swift" \
  -o "$OUTPUT"
codesign --force --sign - "$OUTPUT"
echo 'build-apple-translation: bundled Apple Translation helper'
