#!/bin/bash
# Stage the pinned macOS sherpa-onnx runtime used by ReazonSpeech.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="1.13.6"
ORT_VERSION="1.17.1"
ARCHIVE_NAME="sherpa-onnx-v${VERSION}-onnxruntime-${ORT_VERSION}-osx-arm64-shared.tar.bz2"
ARCHIVE_SHA256="5fa8d0557398b7e6db1f17e0d2fc5ab544e61d29a9bc9f5baea8dafcf9fa90f6"
ARCHIVE_URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/v${VERSION}/${ARCHIVE_NAME}"
SHERPA_LICENSE_SHA256="cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30"
SHERPA_LICENSE_URL="https://raw.githubusercontent.com/k2-fsa/sherpa-onnx/v${VERSION}/LICENSE"
ORT_LICENSE_SHA256="2f07c72751aed99790b8a4869cf2311df85a860b22ded05fa22803587a48922c"
ORT_LICENSE_URL="https://raw.githubusercontent.com/microsoft/onnxruntime/v${ORT_VERSION}/LICENSE"
CACHE="$ROOT/build/tool-cache"
ARCHIVE="$CACHE/$ARCHIVE_NAME"
SHERPA_LICENSE="$CACHE/LICENSE.sherpa-onnx-v${VERSION}"
ORT_LICENSE="$CACHE/LICENSE.onnxruntime-v${ORT_VERSION}"
SOURCE="$ROOT/build/reazonspeech-source-v${VERSION}"
OUT="$ROOT/build/reazonspeech"
BUILD_ARCH="${SPLAYER_BUILD_ARCH:-arm64}"

if [ "$BUILD_ARCH" != "arm64" ]; then
  rm -rf "$OUT"
  echo "bundle-reazonspeech: skipped for unsupported architecture $BUILD_ARCH"
  exit 0
fi

for tool in codesign curl grep otool shasum tar; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "bundle-reazonspeech: required tool not found: $tool" >&2
    exit 1
  fi
done

download_verified() {
  local url="$1"
  local sha256="$2"
  local destination="$3"

  if [ ! -f "$destination" ] || ! echo "$sha256  $destination" | shasum -a 256 -c -s; then
    curl -L --fail --retry 3 --output "$destination.part" "$url"
    echo "$sha256  $destination.part" | shasum -a 256 -c
    mv "$destination.part" "$destination"
  fi
}

mkdir -p "$CACHE"
echo "bundle-reazonspeech: staging verified sherpa-onnx v${VERSION} runtime"
download_verified "$ARCHIVE_URL" "$ARCHIVE_SHA256" "$ARCHIVE"
download_verified "$SHERPA_LICENSE_URL" "$SHERPA_LICENSE_SHA256" "$SHERPA_LICENSE"
download_verified "$ORT_LICENSE_URL" "$ORT_LICENSE_SHA256" "$ORT_LICENSE"

rm -rf "$SOURCE" "$OUT"
mkdir -p "$SOURCE" "$OUT"
tar -xjf "$ARCHIVE" -C "$SOURCE" --strip-components=1

cp "$SOURCE/bin/sherpa-onnx-offline" "$OUT/sherpa-onnx-offline"
cp "$SOURCE/lib/libonnxruntime.${ORT_VERSION}.dylib" "$OUT/libonnxruntime.${ORT_VERSION}.dylib"
cp "$SHERPA_LICENSE" "$OUT/LICENSE.sherpa-onnx"
cp "$ORT_LICENSE" "$OUT/LICENSE.onnxruntime"

codesign -s - -f "$OUT/libonnxruntime.${ORT_VERSION}.dylib" >/dev/null
codesign -s - -f "$OUT/sherpa-onnx-offline" >/dev/null
codesign --verify --strict "$OUT/libonnxruntime.${ORT_VERSION}.dylib"
codesign --verify --strict "$OUT/sherpa-onnx-offline"

if ! otool -L "$OUT/sherpa-onnx-offline" \
  | grep -Fq "@rpath/libonnxruntime.${ORT_VERSION}.dylib"; then
  echo "bundle-reazonspeech: expected ONNX Runtime dependency not found" >&2
  exit 1
fi
if otool -L "$OUT/sherpa-onnx-offline" "$OUT/libonnxruntime.${ORT_VERSION}.dylib" \
  | grep -E '/opt/homebrew|/usr/local'; then
  echo "bundle-reazonspeech: unexpected package-manager dependency above" >&2
  exit 1
fi

"$OUT/sherpa-onnx-offline" --help >/dev/null 2>&1

echo "bundle-reazonspeech: ready — $(du -sh "$OUT" | cut -f1) in $OUT"
