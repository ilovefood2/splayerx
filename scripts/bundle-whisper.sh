#!/bin/bash
#
# Stage a self-contained whisper.cpp into build/whisper/ for bundling in the app.
#
# whisper-cli from Homebrew is dynamically linked to libwhisper / libggml and
# loads its compute backends (Metal, BLAS, per-chip CPU) as separate .so files
# from the Homebrew Cellar — none of which exist on a user's machine. This copies
# the whole closure into one flat directory, rewrites every install name to
# @loader_path so it runs from anywhere, and ad-hoc signs each file (the rewrite
# invalidates the original signature).
#
# ggml discovers its backends by scanning the directory the executable lives in,
# so keeping the backend .so files as siblings of whisper-cli (verified on a Mac
# with the Homebrew Cellar removed) is all that's needed — no env var required.
# Build-time only: reads from the build machine's Homebrew, ships a copy that
# needs none.
#
# Requires: brew install whisper-cpp  (on the build machine)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/build/whisper"
BREW="$(brew --prefix 2>/dev/null || echo /opt/homebrew)"

WHISPER_BIN="$(command -v whisper-cli || echo "$BREW/bin/whisper-cli")"
if [ ! -x "$WHISPER_BIN" ]; then
  echo "bundle-whisper: whisper-cli not found. Run: brew install whisper-cpp" >&2
  exit 1
fi

GGML_LIB="$BREW/opt/ggml/lib"
GGML_LIBEXEC="$(dirname "$(readlink -f "$GGML_LIB/libggml.0.dylib" 2>/dev/null || echo "$GGML_LIB/libggml.0.dylib")")/../libexec"
GGML_LIBEXEC="$(cd "$GGML_LIBEXEC" 2>/dev/null && pwd || echo "$BREW/opt/ggml/libexec")"

echo "bundle-whisper: staging into $OUT"
rm -rf "$OUT"
mkdir -p "$OUT"

# Executable + core libraries.
cp "$WHISPER_BIN" "$OUT/whisper-cli"
cp "$BREW/opt/whisper-cpp/lib/libwhisper.1.dylib" "$OUT/"
cp "$GGML_LIB/libggml.0.dylib" "$OUT/"
cp "$GGML_LIB/libggml-base.0.dylib" "$OUT/"
cp "$BREW/opt/libomp/lib/libomp.dylib" "$OUT/"

# Runtime compute backends (Metal, BLAS, every Apple-silicon CPU variant).
cp "$GGML_LIBEXEC"/libggml-*.so "$OUT/"

chmod -R u+w "$OUT"

# Rewrite every Homebrew / @rpath dependency to a flat @loader_path sibling.
for f in "$OUT"/whisper-cli "$OUT"/*.dylib "$OUT"/*.so; do
  [ -e "$f" ] || continue
  # each library announces itself as @rpath/<name>
  case "$f" in *.dylib|*.so)
    install_name_tool -id "@rpath/$(basename "$f")" "$f" 2>/dev/null || true ;;
  esac
  otool -L "$f" 2>/dev/null | tail -n +2 | awk '{print $1}' | while read -r dep; do
    case "$dep" in
      "$BREW"/*|/opt/homebrew/*|@rpath/*)
        install_name_tool -change "$dep" "@loader_path/$(basename "$dep")" "$f" 2>/dev/null || true ;;
    esac
  done
done

# The install-name rewrite invalidates signatures; ad-hoc re-sign so they load.
for f in "$OUT"/whisper-cli "$OUT"/*.dylib "$OUT"/*.so; do
  [ -e "$f" ] || continue
  codesign --remove-signature "$f" 2>/dev/null || true
  codesign -s - -f "$f" >/dev/null 2>&1 || true
done

# Sanity: no Homebrew paths should remain in any dependency list.
if otool -L "$OUT"/whisper-cli "$OUT"/*.dylib "$OUT"/*.so 2>/dev/null \
    | grep -E "$BREW|/opt/homebrew" | grep -v ":$"; then
  echo "bundle-whisper: WARNING — Homebrew paths remain above (self-IDs are fine)." >&2
fi

SIZE="$(du -sh "$OUT" | cut -f1)"
echo "bundle-whisper: done — $SIZE in $OUT"
ls "$OUT"
