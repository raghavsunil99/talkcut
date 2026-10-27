#!/bin/sh
# Builds whisper.cpp's CLI (with Metal on Apple Silicon) into vendor/whisper.cpp/build/bin.
# Needs Xcode Command Line Tools and CMake; if CMake is missing it is installed into a
# private Python virtual environment under vendor/.
set -eu

WHISPER_VERSION=v1.7.6
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/vendor/whisper.cpp"

if ! xcode-select -p >/dev/null 2>&1; then
  echo "Xcode Command Line Tools are required. Install them with: xcode-select --install" >&2
  exit 1
fi

CMAKE="$(command -v cmake || true)"
if [ -z "$CMAKE" ]; then
  if [ ! -x "$ROOT/vendor/cmake-venv/bin/cmake" ]; then
    echo "CMake not found; installing it into vendor/cmake-venv…"
    python3 -m venv "$ROOT/vendor/cmake-venv"
    "$ROOT/vendor/cmake-venv/bin/pip" install --quiet "cmake==3.31.6"
  fi
  CMAKE="$ROOT/vendor/cmake-venv/bin/cmake"
fi

if [ ! -d "$SRC" ]; then
  git clone --quiet --depth 1 --branch "$WHISPER_VERSION" https://github.com/ggml-org/whisper.cpp "$SRC"
fi

"$CMAKE" -S "$SRC" -B "$SRC/build" \
  -DCMAKE_BUILD_TYPE=Release \
  -DBUILD_SHARED_LIBS=OFF \
  -DWHISPER_BUILD_TESTS=OFF \
  -DWHISPER_BUILD_SERVER=OFF \
  -DGGML_METAL_EMBED_LIBRARY=ON
"$CMAKE" --build "$SRC/build" -j "$(sysctl -n hw.ncpu 2>/dev/null || echo 4)" --target whisper-cli

echo "Built $SRC/build/bin/whisper-cli"
