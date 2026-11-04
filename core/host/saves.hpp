// Phase 6: save RAM and savestate support for the mds_* API (core/host/saves.cpp). Kept out of host.cpp so the
// parallel phases (audio, input, cheats) do not collide with it; host.cpp only calls the two hooks below.
#pragma once
#include <cstddef>
#include <cstdint>

namespace mds {

// Called by mds_load_rom right after retro_load_game succeeded. Copies `save` (may be null) into the core's SRAM
// staging buffer. The result is readable through mds_get_save_status().
void savesOnLoaded(const uint8_t *save, size_t saveLen);

// Called by mds_destroy: forget everything about the loaded game.
void savesReset();

}  // namespace mds
