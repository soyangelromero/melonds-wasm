#!/usr/bin/env bash
# Phase 2-4: link the libretro host (core/host/host.cpp) with dist/libmelonDS.a into dist/melonds.js + .wasm.
# Run inside the pinned emsdk image (scripts/build.sh host).
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [[ ! -f dist/libmelonDS.a ]]; then
  echo "dist/libmelonDS.a is missing; run scripts/build.sh core first." >&2
  exit 1
fi

EXTRA_ARCHIVES="$(find build/melonds -name '*.a' ! -name 'melondsds_libretro.a' ! -path '*_CMakeLTOTest*' -print | tr '\n' ' ')"
EXPORTS="_mds_create,_mds_destroy,_mds_set_option,_mds_write_system_file,_mds_load_rom,_mds_run_frame,_mds_get_frame,_mds_copy_frame,_mds_get_frame_serial,_mds_get_frame_rotation,_mds_get_geometry_serial,_mds_get_geometry,_mds_get_fps,_mds_get_sample_rate,_mds_get_frame_count,_mds_get_duplicated_frames,_mds_get_audio,_mds_get_audio_available,_mds_flush_audio,_mds_get_audio_frames_total,_mds_get_audio_overruns,_mds_get_audio_underruns,_mds_get_audio_batches,_mds_get_audio_singles,_malloc,_free"

em++ core/host/host.cpp \
  -Ibuild/melonds/_deps/libretro-common-src/include \
  -O2 \
  -pthread \
  -fwasm-exceptions \
  -msimd128 \
  -matomics \
  -mbulk-memory \
  "-sUSE_PTHREADS=1" \
  "-sPTHREAD_POOL_SIZE=4" \
  "-sMODULARIZE=1" \
  "-sEXPORT_ES6=1" \
  "-sENVIRONMENT=node,web,worker" \
  "-sALLOW_MEMORY_GROWTH=1" \
  "-sINITIAL_MEMORY=268435456" \
  "-sMAXIMUM_MEMORY=1073741824" \
  "-sSTACK_SIZE=1048576" \
  "-sEXPORTED_FUNCTIONS=$EXPORTS" \
  "-sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAP16,HEAPU32,HEAPF32,PThread" \
  -o dist/melonds.js \
  -Wl,--start-group dist/libmelonDS.a $EXTRA_ARCHIVES -Wl,--end-group

ls -l dist/melonds.js dist/melonds.wasm
