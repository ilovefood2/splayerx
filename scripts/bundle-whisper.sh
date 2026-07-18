#!/bin/bash
#
# Build and stage a self-contained whisper.cpp in build/whisper/.
#
# Do not copy Homebrew's whisper-cli and ggml independently: the two formulae
# can be upgraded at different times, producing an ABI-mismatched bundle that
# crashes before transcription starts. Building the version-locked upstream
# source statically keeps whisper and ggml in sync and removes every Homebrew
# runtime dependency.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="1.9.1"
SHA256="147267177eef7b22ec3d2476dd514d1b12e160e176230b740e3d1bd600118447"
URL="https://github.com/ggml-org/whisper.cpp/archive/refs/tags/v${VERSION}.tar.gz"
CACHE="$ROOT/build/tool-cache"
ARCHIVE="$CACHE/whisper.cpp-v${VERSION}.tar.gz"
SOURCE="$ROOT/build/whisper-source-v${VERSION}"
BUILD="$ROOT/build/whisper-static-v${VERSION}"
OUT="$ROOT/build/whisper"

for tool in cmake curl shasum; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "bundle-whisper: required build tool not found: $tool" >&2
    exit 1
  fi
done

mkdir -p "$CACHE"
if [ ! -f "$ARCHIVE" ] || ! echo "$SHA256  $ARCHIVE" | shasum -a 256 -c -s; then
  echo "bundle-whisper: downloading verified whisper.cpp v${VERSION} source"
  curl -L --fail --retry 3 --output "$ARCHIVE.part" "$URL"
  echo "$SHA256  $ARCHIVE.part" | shasum -a 256 -c
  mv "$ARCHIVE.part" "$ARCHIVE"
fi

echo "bundle-whisper: building a static, relocatable speech engine"
rm -rf "$SOURCE" "$BUILD" "$OUT"
mkdir -p "$SOURCE" "$OUT"
tar -xzf "$ARCHIVE" -C "$SOURCE" --strip-components=1

cmake -S "$SOURCE" -B "$BUILD" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_OSX_DEPLOYMENT_TARGET=12.0 \
  -DBUILD_SHARED_LIBS=OFF \
  -DGGML_BACKEND_DL=OFF \
  -DGGML_NATIVE=OFF \
  -DGGML_OPENMP=OFF \
  -DGGML_METAL=ON \
  -DGGML_METAL_EMBED_LIBRARY=ON \
  -DWHISPER_BUILD_TESTS=OFF \
  -DWHISPER_BUILD_EXAMPLES=ON \
  -DWHISPER_BUILD_SERVER=OFF \
  -DWHISPER_SDL2=OFF
cmake --build "$BUILD" --target whisper-cli --config Release --parallel

cp "$BUILD/bin/whisper-cli" "$OUT/whisper-cli"
cp "$SOURCE/LICENSE" "$OUT/LICENSE.whisper-cpp"
strip -x "$OUT/whisper-cli"
codesign -s - -f "$OUT/whisper-cli" >/dev/null

# Smoke-test the exact binary that will ship. GPU is disabled at runtime too:
# Metal allocation failures in a busy media player currently abort whisper.cpp
# instead of returning an error, whereas the CPU backend is stable.
"$OUT/whisper-cli" \
  -m "$SOURCE/models/for-tests-ggml-tiny.bin" \
  -f "$SOURCE/samples/jfk.wav" \
  --no-gpu --no-prints

if otool -L "$OUT/whisper-cli" | grep -E '/opt/homebrew|/usr/local'; then
  echo "bundle-whisper: unexpected package-manager dependency above" >&2
  exit 1
fi

echo "bundle-whisper: ready — $(du -sh "$OUT" | cut -f1) in $OUT"
