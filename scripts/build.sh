#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="emscripten/emsdk:6.0.13"
TARGET="${1:-hello}"

case "$TARGET" in
  hello)
    mkdir -p "$ROOT/dist"
    docker run --rm \
      -v "$ROOT:/src" \
      -w /src \
      "$IMAGE" \
      em++ core/hello/hello.cpp \
        -o dist/hello.js \
        -O3 \
        -pthread \
        -msimd128 \
        -sUSE_PTHREADS=1 \
        -sPTHREAD_POOL_SIZE=2 \
        -sMODULARIZE=1 \
        -sEXPORT_ES6=1 \
        -sENVIRONMENT=web,worker \
        -sEXPORTED_FUNCTIONS=_mds_hello,_mds_pthreads_enabled \
        -sEXPORTED_RUNTIME_METHODS=ccall,cwrap \
        -sALLOW_MEMORY_GROWTH=1
    ;;
  *)
    echo "Unknown target: $TARGET (available: hello)" >&2
    exit 2
    ;;
esac
