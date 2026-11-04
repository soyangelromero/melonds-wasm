// Minimal libretro frontend for the melonDS DS core, exposed as the mds_* C API (API_CONTRACT.md section 8).
// Phase 2 scope: create / load / run / frame. Audio, input and saves are neutral stubs (TODO phase 3-5).
#include <cstdarg>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <map>
#include <string>
#include <vector>

#include <emscripten.h>
#include <sys/stat.h>

#include "libretro.h"

namespace {

constexpr const char *kSystemDir = "/system";
constexpr const char *kSaveDir = "/save";

struct Host {
  std::map<std::string, std::string> options;
  bool optionsDirty = false;
  std::vector<uint8_t> frame;  // last composed XRGB8888 frame, rows `stride` bytes apart
  unsigned width = 0;
  unsigned height = 0;
  size_t stride = 0;
  uint64_t frameCount = 0;
  uint64_t duplicatedFrames = 0;
  uint64_t audioFrames = 0;
  std::vector<std::string> unhandled;
  std::string romPath;
  bool created = false;
  bool loaded = false;
  bool verbose = false;
};
Host H;

void logCb(enum retro_log_level level, const char *fmt, ...) {
  if (level < RETRO_LOG_INFO && !H.verbose) return;
  static const char *names[] = {"DEBUG", "INFO", "WARN", "ERROR"};
  std::fprintf(stderr, "[core %s] ", level < 4 ? names[level] : "?");
  va_list ap;
  va_start(ap, fmt);
  std::vfprintf(stderr, fmt, ap);
  va_end(ap);
}

void noteUnhandled(unsigned cmd) {
  std::string tag = std::to_string(cmd & 0xFFFF) + ((cmd & RETRO_ENVIRONMENT_EXPERIMENTAL) ? "x" : "");
  for (auto &u : H.unhandled)
    if (u == tag) return;
  H.unhandled.push_back(tag);
  std::fprintf(stderr, "[host] unhandled RETRO_ENVIRONMENT %s\n", tag.c_str());
}

void storeDefaults(const retro_core_options_v2 *opts) {
  for (const retro_core_option_v2_definition *d = opts->definitions; d && d->key; ++d) {
    const char *def = d->default_value ? d->default_value : d->values[0].value;
    if (def) H.options[d->key] = def;
  }
}

bool environmentCb(unsigned cmd, void *data) {
  switch (cmd) {
    case RETRO_ENVIRONMENT_SET_PIXEL_FORMAT:
      return *static_cast<const retro_pixel_format *>(data) == RETRO_PIXEL_FORMAT_XRGB8888;
    case RETRO_ENVIRONMENT_GET_SYSTEM_DIRECTORY:
      *static_cast<const char **>(data) = kSystemDir;
      return true;
    case RETRO_ENVIRONMENT_GET_SAVE_DIRECTORY:
      *static_cast<const char **>(data) = kSaveDir;
      return true;
    case RETRO_ENVIRONMENT_GET_LOG_INTERFACE:
      static_cast<retro_log_callback *>(data)->log = logCb;
      return true;
    case RETRO_ENVIRONMENT_GET_CORE_OPTIONS_VERSION:
      *static_cast<unsigned *>(data) = 2;
      return true;
    case RETRO_ENVIRONMENT_SET_CORE_OPTIONS_V2:
      storeDefaults(static_cast<const retro_core_options_v2 *>(data));
      return true;
    case RETRO_ENVIRONMENT_GET_VARIABLE: {
      auto *var = static_cast<retro_variable *>(data);
      auto it = var->key ? H.options.find(var->key) : H.options.end();
      if (it == H.options.end()) return false;
      var->value = it->second.c_str();
      return true;
    }
    case RETRO_ENVIRONMENT_GET_VARIABLE_UPDATE:
      *static_cast<bool *>(data) = H.optionsDirty;
      H.optionsDirty = false;
      return true;
    case RETRO_ENVIRONMENT_SET_GEOMETRY:
    case RETRO_ENVIRONMENT_SET_SYSTEM_AV_INFO:
    case RETRO_ENVIRONMENT_SET_CORE_OPTIONS_DISPLAY:
    case RETRO_ENVIRONMENT_SET_CORE_OPTIONS_UPDATE_DISPLAY_CALLBACK:
    case RETRO_ENVIRONMENT_SET_CONTROLLER_INFO:
    case RETRO_ENVIRONMENT_SET_SUBSYSTEM_INFO:
    case RETRO_ENVIRONMENT_SET_MEMORY_MAPS:
    case RETRO_ENVIRONMENT_SET_CONTENT_INFO_OVERRIDE:
    case RETRO_ENVIRONMENT_SET_SUPPORT_ACHIEVEMENTS:
    case RETRO_ENVIRONMENT_SET_SUPPORT_NO_GAME:
    case RETRO_ENVIRONMENT_SET_FRAME_TIME_CALLBACK:
    case RETRO_ENVIRONMENT_SET_PROC_ADDRESS_CALLBACK:
    case RETRO_ENVIRONMENT_SET_ROTATION:
      return true;
    case RETRO_ENVIRONMENT_SET_MESSAGE:
      std::fprintf(stderr, "[core MSG] %s\n", static_cast<const retro_message *>(data)->msg);
      return true;
    case RETRO_ENVIRONMENT_SET_MESSAGE_EXT:
      std::fprintf(stderr, "[core MSG] %s\n", static_cast<const retro_message_ext *>(data)->msg);
      return true;
    case RETRO_ENVIRONMENT_GET_MESSAGE_INTERFACE_VERSION:
      *static_cast<unsigned *>(data) = 1;
      return true;
    case RETRO_ENVIRONMENT_GET_LANGUAGE:
      *static_cast<unsigned *>(data) = RETRO_LANGUAGE_ENGLISH;
      return true;
    case RETRO_ENVIRONMENT_GET_USERNAME:
      *static_cast<const char **>(data) = "melonDS";
      return true;
    case RETRO_ENVIRONMENT_GET_INPUT_BITMASKS:
      return true;
    // Deliberately unsupported: the core falls back to its software / stdio paths.
    case RETRO_ENVIRONMENT_SET_HW_RENDER:
    case RETRO_ENVIRONMENT_GET_VFS_INTERFACE:
    case RETRO_ENVIRONMENT_GET_MICROPHONE_INTERFACE:
    case RETRO_ENVIRONMENT_GET_RUMBLE_INTERFACE:
    case RETRO_ENVIRONMENT_GET_SENSOR_INTERFACE:
    case RETRO_ENVIRONMENT_GET_DEVICE_POWER:
    case RETRO_ENVIRONMENT_GET_TARGET_REFRESH_RATE:
    case RETRO_ENVIRONMENT_GET_THROTTLE_STATE:
    case RETRO_ENVIRONMENT_GET_FASTFORWARDING:
    case RETRO_ENVIRONMENT_SET_FASTFORWARDING_OVERRIDE:
    case RETRO_ENVIRONMENT_SET_NETPACKET_INTERFACE:
    case RETRO_ENVIRONMENT_SET_VARIABLES:
    case RETRO_ENVIRONMENT_SET_VARIABLE:
    case RETRO_ENVIRONMENT_SHUTDOWN:
      return false;
    default:
      noteUnhandled(cmd);
      return false;
  }
}

void videoCb(const void *data, unsigned width, unsigned height, size_t pitch) {
  if (!data) {  // libretro: NULL means "repeat the previous frame"
    ++H.duplicatedFrames;
    return;
  }
  H.width = width;
  H.height = height;
  H.stride = pitch;
  H.frame.resize(pitch * height);
  std::memcpy(H.frame.data(), data, pitch * height);
}

// TODO(phase 4): push samples into a ring buffer for mds_get_audio.
size_t audioBatchCb(const int16_t *, size_t frames) {
  H.audioFrames += frames;
  return frames;
}
void audioCb(int16_t, int16_t) { ++H.audioFrames; }

// TODO(phase 5): feed the key mask / pointer from mds_set_key_mask / mds_set_pointer.
void inputPollCb() {}
int16_t inputStateCb(unsigned, unsigned, unsigned, unsigned) { return 0; }

}  // namespace

extern "C" {

EMSCRIPTEN_KEEPALIVE int mds_create(int verbose) {
  if (H.created) return -1;
  H.verbose = verbose != 0;
  mkdir(kSystemDir, 0777);
  mkdir(kSaveDir, 0777);
  retro_set_environment(environmentCb);
  retro_init();
  retro_set_video_refresh(videoCb);
  retro_set_audio_sample(audioCb);
  retro_set_audio_sample_batch(audioBatchCb);
  retro_set_input_poll(inputPollCb);
  retro_set_input_state(inputStateCb);
  H.created = true;
  return 0;
}

EMSCRIPTEN_KEEPALIVE void mds_destroy() {
  if (!H.created) return;
  if (H.loaded) retro_unload_game();
  retro_deinit();
  H = Host{};
}

// Set options before mds_load_rom so they apply at boot; later changes are picked up through GET_VARIABLE_UPDATE.
EMSCRIPTEN_KEEPALIVE void mds_set_option(const char *key, const char *value) {
  H.options[key] = value;
  H.optionsDirty = true;
}

// Writes a file into the in-memory system directory (BIOS / firmware); the name must not contain '/'.
EMSCRIPTEN_KEEPALIVE int mds_write_system_file(const char *name, const uint8_t *data, size_t len) {
  std::string path = std::string(kSystemDir) + "/" + name;
  FILE *f = std::fopen(path.c_str(), "wb");
  if (!f) return -1;
  size_t n = std::fwrite(data, 1, len, f);
  std::fclose(f);
  return n == len ? 0 : -2;
}

// TODO(phase 5): the save buffer arguments are ignored until save support lands.
EMSCRIPTEN_KEEPALIVE int mds_load_rom(const uint8_t *rom, size_t len, const uint8_t *, size_t) {
  if (!H.created || H.loaded) return -1;
  H.romPath = "/rom.nds";
  FILE *f = std::fopen(H.romPath.c_str(), "wb");
  if (!f) return -2;
  std::fwrite(rom, 1, len, f);
  std::fclose(f);

  retro_game_info info{};
  info.path = H.romPath.c_str();
  info.data = rom;  // the caller keeps this buffer alive for the duration of the call
  info.size = len;
  if (!retro_load_game(&info)) return -3;
  H.loaded = true;
  return 0;
}

EMSCRIPTEN_KEEPALIVE void mds_run_frame() {
  if (!H.loaded) return;
  retro_run();
  ++H.frameCount;
}

// Valid until the next mds_run_frame. Returns NULL before the first frame.
EMSCRIPTEN_KEEPALIVE const void *mds_get_frame(unsigned *width, unsigned *height, size_t *stride) {
  if (H.frame.empty()) return nullptr;
  *width = H.width;
  *height = H.height;
  *stride = H.stride;
  return H.frame.data();
}

EMSCRIPTEN_KEEPALIVE uint64_t mds_get_frame_count() { return H.frameCount; }
EMSCRIPTEN_KEEPALIVE uint64_t mds_get_duplicated_frames() { return H.duplicatedFrames; }

}  // extern "C"
