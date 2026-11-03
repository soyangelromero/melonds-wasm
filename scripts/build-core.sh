#!/usr/bin/env bash
# Configure and build melonDS DS v1.4.0 as a static Emscripten library.
# Run inside the pinned emscripten/emsdk image (scripts/build.sh core).
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

PATCH_DIR="$PWD/core/patches"
for patch in "$PATCH_DIR"/*.patch; do
  if git -C third_party/melonds-ds apply --check "$patch" 2>/dev/null; then
    git -C third_party/melonds-ds apply "$patch"
  fi
done

MELONDS_SHA="16f127dbb587a73371827ce79689c5d237c4b59b"

emcmake cmake -S third_party/melonds-ds -B build/melonds \
  -DCMAKE_BUILD_TYPE=Release \
  -UHAVE_MMAP \
  -UHAVE_MMAN \
  -DCMAKE_C_FLAGS="-pthread -msimd128 -matomics -mbulk-memory" \
  -DCMAKE_CXX_FLAGS="-pthread -msimd128 -matomics -mbulk-memory" \
  -DMELONDSDS_STATIC=ON \
  -DMELONDS_REPOSITORY_TAG="$MELONDS_SHA" \
  -DENABLE_JIT=OFF \
  -DENABLE_OPENGL=OFF \
  -DENABLE_COMPUTE_RENDERER=OFF \
  -DENABLE_NETWORKING=OFF \
  -DENABLE_DYNAMIC=OFF \
  -DENABLE_EGL=OFF \
  -DENABLE_THREADED_RENDERER=ON \
  -DTRACY_ENABLE=OFF \
  -DBUILD_AS_SHARED_LIBRARY=OFF \
  -DBUILD_TESTING=OFF \
  -DENABLE_LTO=OFF \
  -DENABLE_LTO_RELEASE=OFF

cmake --build build/melonds --target melondsds_libretro --parallel "$(nproc)"

mkdir -p dist
cp build/melonds/src/libretro/melondsds_libretro.a dist/libmelonDS.a
ls -l dist/libmelonDS.a
