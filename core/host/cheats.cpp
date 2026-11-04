// Phase 8: Action Replay cheats for the mds_* API (API_CONTRACT.md section 4 and 8).
//
// The core indexes cheats by POSITION in a std::vector (core.cpp CoreState::CheatSet: index < size replaces, otherwise
// push_back), so a stable, possibly sparse id from the caller has to be mapped to a slot here. Everything in this file
// relies on this being the only caller of retro_cheat_set: the number of slots we handed out is the vector's size.
// To keep that true we never call the core with anything it would silently drop (empty or invalid text), because a dropped
// "new" cheat would not grow the vector and every later slot would drift by one.
//
// Also exposes the DS main RAM (retro_get_memory_data(RETRO_MEMORY_SYSTEM_RAM)) so tests can read memory without a patch.
#include <cstdint>
#include <cstring>
#include <map>
#include <string>
#include <vector>

#include <malloc.h>

#include <emscripten.h>

#include "libretro.h"

extern "C" int mds_host_loaded();  // host.cpp

namespace {

struct Slot {
  unsigned slot;
  std::string code;  // canonical text last accepted by the core ("AAAAAAAA+BBBBBBBB+...")
  bool enabled;
};
std::map<uint32_t, Slot> g_slots;  // id -> slot
unsigned g_nextSlot = 0;           // == AREngine.Cheats.size() as long as nobody else calls retro_cheat_set

enum : int {
  kNotLoaded = -1,
  kEmpty = -2,
  kBadSyntax = -3,
  kOddWords = -4,
  kTruncated = -5,
};

bool isHex(char c) { return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'); }
bool isSep(char c) { return c == '+' || c == '-' || c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f' || c == '\v'; }

// Splits on the separators the core regex allows and requires tokens of exactly 8 hex digits.
// Output is rebuilt in canonical form so the core's own regex (^\s*H8([+\s-]*H8)*$) always accepts it.
int canonicalize(const char *text, size_t len, std::string &out) {
  std::vector<uint32_t> words;
  size_t i = 0;
  while (i < len) {
    if (isSep(text[i])) { ++i; continue; }
    size_t j = i;
    while (j < len && !isSep(text[j])) ++j;
    if (j - i != 8) return kBadSyntax;
    uint32_t w = 0;
    for (size_t k = i; k < j; ++k) {
      if (!isHex(text[k])) return kBadSyntax;
      char c = text[k];
      w = (w << 4) | static_cast<uint32_t>(c <= '9' ? c - '0' : (c | 0x20) - 'a' + 10);
    }
    words.push_back(w);
    i = j;
  }
  if (words.empty()) return kEmpty;
  // AREngine::RunCheat reads two words per instruction without bounds checks: reject what would be read past the end.
  if (words.size() % 2) return kOddWords;
  for (size_t k = 0; k < words.size(); k += 2) {
    if ((words[k] >> 24 & 0xF0) == 0xE0) {  // E-type: copies b bytes from ceil(b/8) following word pairs
      uint64_t need = 2 * ((static_cast<uint64_t>(words[k + 1]) + 7) / 8);
      if (k + 2 + need > words.size()) return kTruncated;
      k += static_cast<size_t>(need);
    }
  }
  static const char *hex = "0123456789ABCDEF";
  out.clear();
  out.reserve(words.size() * 9);
  for (size_t k = 0; k < words.size(); ++k) {
    if (k) out.push_back('+');
    for (int s = 28; s >= 0; s -= 4) out.push_back(hex[(words[k] >> s) & 0xF]);
  }
  return 0;
}

}  // namespace

extern "C" {

// Called by mds_destroy: the core (and its cheat vector) is gone.
void mds_cheats_forget() {
  g_slots.clear();
  g_nextSlot = 0;
}

// Creates or replaces cheat `id` and enables or disables it. `ptr/len` is the cheat text (see js/cheats.js for the accepted
// formats; here every token must be 8 hex digits). With len == 0 and a known id, the text stored for that id is reused,
// so a toggle does not need to resend it. Returns the slot used (>= 0) or a negative error:
//   -1 no game loaded, -2 empty text and unknown id, -3 invalid token, -4 odd number of words, -5 E-type payload truncated.
// Disabling stops the engine from re-running the code each frame; it does NOT undo what the code already wrote to RAM.
EMSCRIPTEN_KEEPALIVE int mds_cheat_set(uint32_t id, int enabled, const char *ptr, size_t len) {
  if (!mds_host_loaded()) return kNotLoaded;  // the core ignores cheats without a console; do not consume a slot
  auto it = g_slots.find(id);
  std::string canon;
  if (len == 0) {
    if (it == g_slots.end()) return kEmpty;
    canon = it->second.code;
  } else if (int rc = canonicalize(ptr, len, canon)) {
    return rc;
  }
  unsigned slot = it != g_slots.end() ? it->second.slot : g_nextSlot;
  retro_cheat_set(slot, enabled != 0, canon.c_str());
  if (it == g_slots.end()) {
    g_slots.emplace(id, Slot{slot, canon, enabled != 0});
    ++g_nextSlot;
  } else {
    it->second.code = canon;
    it->second.enabled = enabled != 0;
  }
  return static_cast<int>(slot);
}

// retro_cheat_reset + forget all ids. Safe before a game is loaded.
EMSCRIPTEN_KEEPALIVE void mds_cheat_clear() {
  if (mds_host_loaded()) retro_cheat_reset();
  mds_cheats_forget();
}

// Number of slots in use (== size of the core's cheat vector) and the slot of an id (-1 if unknown); for tests/diagnostics.
EMSCRIPTEN_KEEPALIVE int mds_cheat_count() { return static_cast<int>(g_nextSlot); }
EMSCRIPTEN_KEEPALIVE int mds_cheat_slot(uint32_t id) {
  auto it = g_slots.find(id);
  return it == g_slots.end() ? -1 : static_cast<int>(it->second.slot);
}
// 1 = enabled, 0 = disabled, -1 = unknown id
EMSCRIPTEN_KEEPALIVE int mds_cheat_enabled(uint32_t id) {
  auto it = g_slots.find(id);
  return it == g_slots.end() ? -1 : (it->second.enabled ? 1 : 0);
}

// DS main RAM (retro_get_memory_data(RETRO_MEMORY_SYSTEM_RAM)): 4 MiB, the 0x02000000 window (the core registers the mirrors in
// its memory map). The pointer is into the wasm heap and may change if the core rebuilds its console, so query it each time.
EMSCRIPTEN_KEEPALIVE const uint8_t *mds_ram_data() {
  return mds_host_loaded() ? static_cast<const uint8_t *>(retro_get_memory_data(RETRO_MEMORY_SYSTEM_RAM)) : nullptr;
}
EMSCRIPTEN_KEEPALIVE size_t mds_ram_size() { return mds_host_loaded() ? retro_get_memory_size(RETRO_MEMORY_SYSTEM_RAM) : 0; }

// Bytes currently allocated from the wasm heap (mallinfo().uordblks); the leak test compares it before/after many mds_cheat_set calls.
EMSCRIPTEN_KEEPALIVE size_t mds_heap_used() { return mallinfo().uordblks; }

}  // extern "C"
