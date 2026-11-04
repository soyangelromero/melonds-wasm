// Phase 6: save RAM + savestates (API_CONTRACT.md sections 6 and 8). See tests/PHASE6_REPORT.md for what was verified.
//
// How melonDS DS v1.4.0 hands over the cartridge save (src/libretro/sram.cpp, core/core.cpp):
//  * The core owns one "staging" buffer (SaveManager) with exactly the cart's SRAM size (NDSCart's SRAMLength, 0 for
//    homebrew and for carts without save memory). retro_get_memory_data/size(RETRO_MEMORY_SAVE_RAM) expose it.
//  * The frontend fills it between retro_load_game and the FIRST retro_run; the first frame copies it into the emulated
//    cart (InstallNdsSram -> NDS::SetNDSSave). Writes the game makes afterwards come back into the same buffer through
//    Platform::WriteNDSSave (SaveManager::Flush), and so does retro_unserialize (CartRetail::DoSavestate).
//  * The bytes are the raw cart memory: no header, no footer (same as a melonDS desktop .sav).
#include "saves.hpp"

#include <cstring>
#include <vector>

#include <emscripten.h>

#include "libretro.h"

extern "C" uint64_t mds_get_frame_count();  // host.cpp

namespace {

// ---- container (API_CONTRACT.md section 6) ----
constexpr char kMagic[8] = {'M', 'D', 'S', 'S', 'T', 'A', 'T', 'E'};
constexpr uint32_t kVersion = 1;
constexpr size_t kHeaderLen = 8 + 5 * 4;  // magic, version, flags, coreAbi, sramLen, stateLen
constexpr size_t kCrcLen = 4;

// Stable id of this core build. Bump the trailing revision when a patch in core/patches/ changes the savestate layout
// or when third_party/melonds-ds / the engine fork pin moves (MELONDS_SHA in scripts/build-core.sh).
constexpr const char kCoreAbiText[] = "melonds-ds f394adba;melonDS 16f127db;state-layout 1";

// Result codes of mds_load_state (negative = failure). Mirrored in js/saves.js.
enum : int {
  kOk = 0,
  kNotLoaded = -1,
  kUnsupported = -3,     // retro_serialize_size() == 0 (DSi mode) or retro_serialize failed
  kCorrupt = -10,        // STATE_CORRUPT
  kVersion_ = -11,       // STATE_VERSION
  kIncompatible = -12,   // STATE_INCOMPATIBLE (other core build)
  kRejected = -13,       // STATE_INCOMPATIBLE (sizes do not fit the loaded game, or the core refused the blob)
};

struct SaveState {
  bool loaded = false;
  int saveStatus = 0;               // see mds_get_save_status
  std::vector<uint8_t> snapshot;    // last SRAM contents the poller saw
  uint32_t revision = 0;            // bumped by mds_poll_save when the SRAM differs from `snapshot`
  std::vector<uint8_t> stateOut;    // buffer behind mds_save_state's result
} S;

uint32_t crc32Update(uint32_t crc, const uint8_t *data, size_t len) {
  static uint32_t table[256];
  static bool ready = false;
  if (!ready) {
    for (uint32_t n = 0; n < 256; n++) {
      uint32_t c = n;
      for (int k = 0; k < 8; k++) c = (c & 1) ? 0xEDB88320u ^ (c >> 1) : c >> 1;
      table[n] = c;
    }
    ready = true;
  }
  crc = ~crc;
  for (size_t i = 0; i < len; i++) crc = table[(crc ^ data[i]) & 0xFF] ^ (crc >> 8);
  return ~crc;
}

uint32_t coreAbi() { return crc32Update(0, reinterpret_cast<const uint8_t *>(kCoreAbiText), sizeof(kCoreAbiText) - 1); }

void put32(uint8_t *p, uint32_t v) { p[0] = v; p[1] = v >> 8; p[2] = v >> 16; p[3] = v >> 24; }
uint32_t get32(const uint8_t *p) { return p[0] | (p[1] << 8) | (p[2] << 16) | (uint32_t(p[3]) << 24); }

uint8_t *sramPtr() { return static_cast<uint8_t *>(retro_get_memory_data(RETRO_MEMORY_SAVE_RAM)); }
size_t sramLen() { return S.loaded ? retro_get_memory_size(RETRO_MEMORY_SAVE_RAM) : 0; }

void syncSnapshot() {
  size_t n = sramLen();
  uint8_t *p = sramPtr();
  S.snapshot.assign(p ? p : nullptr, p ? p + n : nullptr);
}

}  // namespace

namespace mds {

void savesOnLoaded(const uint8_t *save, size_t saveLen) {
  S = SaveState{};
  S.loaded = true;
  size_t n = sramLen();
  uint8_t *dst = sramPtr();
  // A blank cartridge reads 0xFF (melonDS desktop's CartRetail constructor and flash chips do too). The core's staging
  // buffer starts zeroed, which would be installed as the "save" on the first frame, so start from 0xFF.
  if (n && dst) std::memset(dst, 0xFF, n);
  if (save && saveLen) {
    if (!n || !dst) {
      S.saveStatus = 2;  // a save was given but this cartridge has no save memory (homebrew, or a game without SRAM)
    } else {
      // Same rule as the engine's CartRetail constructor: copy what fits, the rest stays 0xFF.
      std::memcpy(dst, save, saveLen < n ? saveLen : n);
      S.saveStatus = saveLen == n ? 0 : 1;
    }
  }
  syncSnapshot();
}

void savesReset() { S = SaveState{}; }

}  // namespace mds

extern "C" {

// Identifier of this core build, stored in every savestate container (`coreAbi`).
EMSCRIPTEN_KEEPALIVE uint32_t mds_get_core_abi() { return coreAbi(); }

// 0 = nothing special, 1 = the save passed to mds_load_rom/mds_set_save had a different length than the cartridge's
// SRAM (truncated or padded with 0xFF, like melonDS desktop), 2 = a save was given but the cartridge has no save memory.
EMSCRIPTEN_KEEPALIVE int mds_get_save_status() { return S.saveStatus; }

// Pointer to the core's SRAM staging buffer (NOT a copy) and its length. len 0 / ptr NULL = this game has no save
// memory. The pointer stays valid until mds_destroy; copy the bytes out before running more frames.
// Returns 0, or -1 when no game is loaded.
EMSCRIPTEN_KEEPALIVE int mds_get_save(const uint8_t **ptrOut, size_t *lenOut) {
  if (!S.loaded) return -1;
  *lenOut = sramLen();
  *ptrOut = *lenOut ? sramPtr() : nullptr;
  return 0;
}

// Replaces the cartridge save at run time ("loadSave" = apply + restart): resets the console, then rewrites the
// staging buffer, which the first frame after the reset installs. (Writing first would be lost: CoreState::Reset
// copies the LIVE cart memory back into the buffer.) Before the first frame no reset is needed.
// Returns 0 ok, 1 ok but the length differed (see mds_get_save_status), -1 not loaded, -2 the game has no save memory.
EMSCRIPTEN_KEEPALIVE int mds_set_save(const uint8_t *data, size_t len) {
  if (!S.loaded) return -1;
  size_t n = sramLen();
  if (!n) return -2;
  if (mds_get_frame_count() > 0) retro_reset();
  uint8_t *dst = sramPtr();
  std::memset(dst, 0xFF, n);
  std::memcpy(dst, data, len < n ? len : n);
  S.saveStatus = len == n ? 0 : 1;
  syncSnapshot();
  return S.saveStatus;
}

// Change detector for onSave: compares the staging buffer with what the previous call saw and returns a counter that
// grows by one each time it differs. Cost: one memcmp of the SRAM (<= 1 MiB for retail carts); call it every few frames.
EMSCRIPTEN_KEEPALIVE uint32_t mds_poll_save() {
  if (!S.loaded) return S.revision;
  size_t n = sramLen();
  uint8_t *p = sramPtr();
  if (n && p && (S.snapshot.size() != n || std::memcmp(S.snapshot.data(), p, n) != 0)) {
    S.snapshot.assign(p, p + n);
    ++S.revision;
  }
  return S.revision;
}

// Builds the container into an internal buffer and returns a pointer to it (valid until the next call).
// Returns 0 ok, -1 not loaded, -3 the core cannot serialize (DSi mode) or failed to.
EMSCRIPTEN_KEEPALIVE int mds_save_state(const uint8_t **ptrOut, size_t *lenOut) {
  if (!S.loaded) return kNotLoaded;
  size_t stateLen = retro_serialize_size();
  if (!stateLen) return kUnsupported;
  size_t sLen = sramLen();
  S.stateOut.assign(kHeaderLen + sLen + stateLen + kCrcLen, 0);
  uint8_t *out = S.stateOut.data();
  std::memcpy(out, kMagic, 8);
  put32(out + 8, kVersion);
  put32(out + 12, 0);  // flags, reserved
  put32(out + 16, coreAbi());
  put32(out + 20, static_cast<uint32_t>(sLen));
  put32(out + 24, static_cast<uint32_t>(stateLen));
  if (sLen) std::memcpy(out + kHeaderLen, sramPtr(), sLen);
  if (!retro_serialize(out + kHeaderLen + sLen, stateLen)) return kUnsupported;
  put32(out + kHeaderLen + sLen + stateLen, crc32Update(0, out + kHeaderLen, sLen + stateLen));
  *ptrOut = out;
  *lenOut = S.stateOut.size();
  return kOk;
}

// Validates the container (magic, version, coreAbi, lengths, CRC32) BEFORE touching the emulator, then restores it.
// Returns 0 ok, -1 not loaded, -10 STATE_CORRUPT, -11 STATE_VERSION, -12 STATE_INCOMPATIBLE (other core build),
// -13 STATE_INCOMPATIBLE (does not fit the loaded game), -3 the core cannot unserialize (DSi mode).
EMSCRIPTEN_KEEPALIVE int mds_load_state(const uint8_t *data, size_t len) {
  if (!S.loaded) return kNotLoaded;
  if (len < kHeaderLen + kCrcLen || std::memcmp(data, kMagic, 8) != 0) return kCorrupt;
  if (get32(data + 8) != kVersion) return kVersion_;
  if (get32(data + 16) != coreAbi()) return kIncompatible;
  uint64_t sLen = get32(data + 20), stateLen = get32(data + 24);
  if (kHeaderLen + sLen + stateLen + kCrcLen != len) return kCorrupt;
  const uint8_t *payload = data + kHeaderLen;
  if (crc32Update(0, payload, sLen + stateLen) != get32(data + kHeaderLen + sLen + stateLen)) return kCorrupt;

  size_t curSram = sramLen(), curState = retro_serialize_size();
  if (!curState) return kUnsupported;
  if (sLen != curSram || stateLen != curState) return kRejected;
  if (!retro_unserialize(payload + sLen, stateLen)) return kRejected;
  // CartRetail::DoSavestate rewrote the cart SRAM and notified the staging buffer; make sure the buffer holds exactly
  // what the container carried (they are equal for a container made by mds_save_state).
  if (curSram && std::memcmp(sramPtr(), payload, curSram) != 0) std::memcpy(sramPtr(), payload, curSram);
  return kOk;
}

}  // extern "C"
