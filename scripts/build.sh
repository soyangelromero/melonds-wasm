#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="emscripten/emsdk:6.0.13"
TARGET="${1:-hello}"

# Without a working Docker daemon (no `docker` binary, or no daemon), `core` / `core-test` run directly with a locally activated emsdk
# (source emsdk_env.sh first). Set USE_DOCKER=1 to force Docker.
if [[ "${USE_DOCKER:-}" != "1" ]] && ! docker info >/dev/null 2>&1 && command -v emcmake >/dev/null 2>&1; then
  case "$TARGET" in
    core)
      exec bash "$ROOT/scripts/build-core.sh" ;;
    core-test)
      bash "$ROOT/scripts/build-core.sh" && bash "$ROOT/scripts/verify-core.sh"
      node "$ROOT/dist/phase1.js"
      exit $? ;;
    host)
      exec bash "$ROOT/scripts/build-host.sh" ;;
    host-test)
      bash "$ROOT/scripts/build-host.sh" && node "$ROOT/tests/phase2-smoke.mjs"
      exit $? ;;
  esac
fi

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
  core)
    docker run --rm \
      -v "$ROOT:/src" \
      -w /src \
      "$IMAGE" \
      bash scripts/build-core.sh
    ;;
  core-test)
    docker run --rm \
      -v "$ROOT:/src" \
      -w /src \
      "$IMAGE" \
      bash -lc "bash scripts/build-core.sh && bash scripts/verify-core.sh"
    node "$ROOT/tests/run-phase1.mjs"
    ;;
  host)
    docker run --rm \
      -v "$ROOT:/src" \
      -w /src \
      "$IMAGE" \
      bash scripts/build-host.sh
    ;;
  host-test)
    docker run --rm \
      -v "$ROOT:/src" \
      -w /src \
      "$IMAGE" \
      bash scripts/build-host.sh
    node "$ROOT/tests/phase2-smoke.mjs"
    ;;
  *)
    echo "Unknown target: $TARGET (available: hello, core, core-test, host, host-test)" >&2
    exit 2
    ;;
esac
