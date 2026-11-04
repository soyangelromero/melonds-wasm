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
EXPORTS="_mds_create,_mds_destroy,_mds_set_option,_mds_write_system_file,_mds_load_rom,_mds_run_frame,_mds_get_frame,_mds_copy_frame,_mds_get_frame_serial,_mds_get_frame_rotation,_mds_get_geometry_serial,_mds_get_geometry,_mds_get_fps,_mds_get_sample_rate,_mds_get_frame_count,_mds_get_duplicated_frames,_mds_get_audio,_mds_get_audio_available,_mds_flush_audio,_mds_get_audio_frames_total,_mds_get_audio_overruns,_mds_get_audio_underruns,_mds_get_audio_batches,_mds_get_audio_singles,_mds_set_key_mask,_mds_set_pointer,_mds_get_input_queries,_mds_get_core_abi,_mds_get_save_status,_mds_get_save,_mds_set_save,_mds_poll_save,_mds_save_state,_mds_load_state,_mds_cheat_set,_mds_cheat_clear,_mds_cheat_count,_mds_cheat_slot,_mds_cheat_enabled,_mds_ram_data,_mds_ram_size,_mds_heap_used,_malloc,_free"

em++ core/host/host.cpp core/host/saves.cpp \
  core/host/cheats.cpp \
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
