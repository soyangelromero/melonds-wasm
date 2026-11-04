#!/usr/bin/env bash
# Phase 1 acceptance: link dist/libmelonDS.a into a tiny Node program.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [[ ! -f dist/libmelonDS.a ]]; then
  echo "dist/libmelonDS.a is missing; run scripts/build.sh core first." >&2
  exit 1
fi

EXTRA_ARCHIVES="$(find build/melonds -name '*.a' ! -name 'melondsds_libretro.a' -print | tr '\n' ' ')"

em++ core/test/phase1_main.cpp \
  -Ibuild/melonds/_deps/libretro-common-src/include \
  -O2 \
  -pthread \
  -msimd128 \
  -matomics \
  -mbulk-memory \
  "-sUSE_PTHREADS=1" \
  "-sMODULARIZE=1" \
  "-sEXPORT_ES6=1" \
  "-sENVIRONMENT=node" \
  "-sALLOW_MEMORY_GROWTH=1" \
  "-sEXIT_RUNTIME=1" \
  --extern-post-js core/test/phase1_autorun.js \
  -o dist/phase1.js \
  -Wl,--start-group dist/libmelonDS.a $EXTRA_ARCHIVES -Wl,--end-group

echo "Built dist/phase1.js"
