#!/bin/bash
# Build and stage self-contained runtimes for SPlayer's managed translation models.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="b10066"
SHA256="9bbe00737e2692fc6aabc8dd0531bbd0f409e63569eb65ac90933e4da10a506b"
URL="https://github.com/ggml-org/llama.cpp/archive/refs/tags/${VERSION}.tar.gz"
CACHE="$ROOT/build/tool-cache"
ARCHIVE="$CACHE/llama.cpp-${VERSION}.tar.gz"
SOURCE="$ROOT/build/llama-source-${VERSION}"
BUILD="$ROOT/build/llama-static-${VERSION}"
OUT="$ROOT/build/llama"
MADLAD_VERSION="b3325"
MADLAD_SHA256="5f9c270fe370564cc9062c2e091473746eb191fb77d491fcb10a33f246488ec0"
MADLAD_URL="https://github.com/ggml-org/llama.cpp/archive/refs/tags/${MADLAD_VERSION}.tar.gz"
MADLAD_ARCHIVE="$CACHE/llama.cpp-${MADLAD_VERSION}.tar.gz"
MADLAD_SOURCE="$ROOT/build/llama-source-${MADLAD_VERSION}"
MADLAD_BUILD="$ROOT/build/madlad-worker-static-${MADLAD_VERSION}"

for tool in cmake curl shasum; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "bundle-llama: required build tool not found: $tool" >&2
    exit 1
  fi
done

mkdir -p "$CACHE"
if [ ! -f "$ARCHIVE" ] || ! echo "$SHA256  $ARCHIVE" | shasum -a 256 -c -s; then
  echo "bundle-llama: downloading verified llama.cpp ${VERSION} source"
  curl -L --fail --retry 3 --output "$ARCHIVE.part" "$URL"
  echo "$SHA256  $ARCHIVE.part" | shasum -a 256 -c
  mv "$ARCHIVE.part" "$ARCHIVE"
fi

if [ ! -f "$MADLAD_ARCHIVE" ] || ! echo "$MADLAD_SHA256  $MADLAD_ARCHIVE" | shasum -a 256 -c -s; then
  echo "bundle-llama: downloading verified llama.cpp ${MADLAD_VERSION} source"
  curl -L --fail --retry 3 --output "$MADLAD_ARCHIVE.part" "$MADLAD_URL"
  echo "$MADLAD_SHA256  $MADLAD_ARCHIVE.part" | shasum -a 256 -c
  mv "$MADLAD_ARCHIVE.part" "$MADLAD_ARCHIVE"
fi

echo "bundle-llama: building static Metal-enabled Qwen3 runtime"
rm -rf "$SOURCE" "$BUILD" "$MADLAD_SOURCE" "$MADLAD_BUILD" "$OUT"
mkdir -p "$SOURCE" "$OUT"
tar -xzf "$ARCHIVE" -C "$SOURCE" --strip-components=1

cmake -S "$SOURCE" -B "$BUILD" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_OSX_DEPLOYMENT_TARGET=12.0 \
  -DLLAMA_BUILD_NUMBER=10066 \
  -DLLAMA_BUILD_COMMIT="$VERSION" \
  -DBUILD_SHARED_LIBS=OFF \
  -DGGML_BACKEND_DL=OFF \
  -DGGML_BLAS=OFF \
  -DGGML_NATIVE=OFF \
  -DGGML_OPENMP=OFF \
  -DGGML_METAL=ON \
  -DGGML_METAL_EMBED_LIBRARY=ON \
  -DLLAMA_CURL=OFF \
  -DLLAMA_OPENSSL=OFF \
  -DLLAMA_BUILD_UI=OFF \
  -DLLAMA_USE_PREBUILT_UI=OFF \
  -DLLAMA_BUILD_TESTS=OFF \
  -DLLAMA_BUILD_EXAMPLES=OFF \
  -DLLAMA_BUILD_SERVER=ON
cmake --build "$BUILD" --target llama-server --config Release --parallel

echo "bundle-llama: building static Metal-enabled MADLAD runtime"
mkdir -p "$MADLAD_SOURCE"
tar -xzf "$MADLAD_ARCHIVE" -C "$MADLAD_SOURCE" --strip-components=1
cmake -S "$ROOT/native/madlad-worker" -B "$MADLAD_BUILD" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_OSX_DEPLOYMENT_TARGET=12.0 \
  -DLLAMA_SOURCE_DIR="$MADLAD_SOURCE" \
  -DLLAMA_BUILD_NUMBER=3325 \
  -DLLAMA_BUILD_COMMIT="$MADLAD_VERSION" \
  -DBUILD_SHARED_LIBS=OFF \
  -DGGML_BLAS=OFF \
  -DGGML_NATIVE=OFF \
  -DGGML_OPENMP=OFF \
  -DGGML_METAL=ON \
  -DGGML_METAL_EMBED_LIBRARY=ON \
  -DLLAMA_CURL=OFF \
  -DLLAMA_BUILD_TESTS=OFF \
  -DLLAMA_BUILD_EXAMPLES=OFF \
  -DLLAMA_BUILD_SERVER=OFF
cmake --build "$MADLAD_BUILD" --target splayer-madlad-worker --config Release --parallel

cp "$BUILD/bin/llama-server" "$OUT/llama-server"
cp "$MADLAD_BUILD/splayer-madlad-worker" "$OUT/madlad-worker"
cp "$SOURCE/LICENSE" "$OUT/LICENSE.llama.cpp"
strip -x "$OUT/llama-server"
strip -x "$OUT/madlad-worker"
codesign -s - -f "$OUT/llama-server" >/dev/null
codesign -s - -f "$OUT/madlad-worker" >/dev/null

"$OUT/llama-server" --version >/dev/null
if otool -L "$OUT/llama-server" "$OUT/madlad-worker" | grep -E '/opt/homebrew|/usr/local'; then
  echo "bundle-llama: unexpected package-manager dependency above" >&2
  exit 1
fi

echo "bundle-llama: ready — $(du -sh "$OUT" | cut -f1) in $OUT"
