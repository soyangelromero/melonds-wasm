// Minimal libretro frontend for the melonDS DS core, exposed as the mds_* C API (API_CONTRACT.md section 8).
// Phase 2: create / load / run / frame. Phase 3: geometry (SET_GEOMETRY / SET_SYSTEM_AV_INFO), rotation (SET_ROTATION)
// and frame serials. Phase 4: audio ring (mds_get_audio). Phase 5: input (key mask, pointer). Saves are neutral stubs (TODO phase 6).
#include <cstdarg>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <map>
#include <string>
#include <vector>

#include <emscripten.h>
#include <sys/stat.h>
#include <unistd.h>

#include "libretro.h"
#include "saves.hpp"

namespace {

constexpr const char *kSystemDir = "/system";
constexpr const char *kSaveDir = "/save";
// 8192 stereo frames = 250 ms at 32.7 kHz = ~15 DS frames of slack for an embedder that drains once per frame
// (one DS frame is ~547 frames, the core never delivers more than 2048 per retro_run: core.cpp RenderAudio).
constexpr size_t kAudioRingFrames = 8192;

// What the core last told us about its video output (retro_game_geometry + timing). The *frame* size
// that actually arrives in videoCb is authoritative; this is what the core announces it will deliver.
struct Geometry {
  unsigned baseWidth = 0, baseHeight = 0, maxWidth = 0, maxHeight = 0;
  float aspect = 0.f;
};

struct Host {
  std::map<std::string, std::string> options;
  bool optionsDirty = false;
  std::vector<uint8_t> frame;  // last composed XRGB8888 frame, rows `stride` bytes apart
  unsigned width = 0;
  unsigned height = 0;
  size_t stride = 0;
  unsigned rotation = 0;       // frontend rotation requested by the core (SET_ROTATION): 0, 1=90 CCW, 2=180, 3=270 CCW
  unsigned frameRotation = 0;  // rotation in force when `frame` was delivered
  Geometry geometry;
  double fps = 0, sampleRate = 0;
  uint32_t geometrySerial = 0;  // bumped on every SET_GEOMETRY / SET_SYSTEM_AV_INFO
  uint32_t frameSerial = 0;     // bumped on every videoCb with data != NULL (a new, different-or-equal frame)
  uint64_t frameCount = 0;
  uint64_t duplicatedFrames = 0;
  // Audio (phase 4). Stereo int16 frames (L,R pairs) in a power-of-two ring; the core writes during retro_run and the
  // embedder drains it with mds_get_audio after each mds_run_frame. Single thread (the wasm module lives in one worker),
  // so no atomics are needed here; the cross-thread ring is js/audio-ring.js.
  std::vector<int16_t> audio = std::vector<int16_t>(kAudioRingFrames * 2);
  size_t audioRead = 0, audioWrite = 0;  // monotonic frame counters; fill = write - read
  uint64_t audioFrames = 0;       // frames produced by the core
  uint64_t audioDrained = 0;      // frames handed out by mds_get_audio
  uint64_t audioOverruns = 0;     // frames DROPPED because the ring was full (nobody drained it)
  uint64_t audioUnderruns = 0;    // mds_get_audio calls that found fewer frames than requested
  uint64_t audioBatches = 0, audioSingles = 0;
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
    if (def) H.options.emplace(d->key, def);  // emplace: never overwrite a value set via mds_set_option
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
    case RETRO_ENVIRONMENT_SET_GEOMETRY: {
      // core.cpp:233 sends this whenever the screen layout / gap changes; the max size never changes with it.
      auto *g = static_cast<const retro_game_geometry *>(data);
      H.geometry = {g->base_width, g->base_height, g->max_width, g->max_height, g->aspect_ratio};
      ++H.geometrySerial;
      return true;
    }
    case RETRO_ENVIRONMENT_SET_SYSTEM_AV_INFO: {
      auto *av = static_cast<const retro_system_av_info *>(data);
      const retro_game_geometry &g = av->geometry;
      H.geometry = {g.base_width, g.base_height, g.max_width, g.max_height, g.aspect_ratio};
      H.fps = av->timing.fps;
      H.sampleRate = av->timing.sample_rate;
      ++H.geometrySerial;
      return true;
    }
    case RETRO_ENVIRONMENT_SET_ROTATION:
      // screenlayout.cpp:317: the rotated layouts hand us the Top/Bottom image and expect the FRONTEND to rotate it
      // (and rotate the pointer matrix themselves once we return true). So the renderer must apply this value.
      H.rotation = *static_cast<const unsigned *>(data) & 3u;
      return true;
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
      return true;
    case RETRO_ENVIRONMENT_SET_MESSAGE:
      std::fprintf(stderr, "[core MSG] %s\n", static_cast<const retro_message *>(data)->msg);
      return true;
    case RETRO_ENVIRONMENT_SET_MESSAGE_EXT: {
      // core/tasks.cpp (OnScreenDisplayTask) sends a STATUS message every frame ("Layout 1/2"); only show it when verbose.
      auto *m = static_cast<const retro_message_ext *>(data);
      if (m->type != RETRO_MESSAGE_TYPE_STATUS || H.verbose) std::fprintf(stderr, "[core MSG] %s\n", m->msg);
      return true;
    }
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
    case RETRO_ENVIRONMENT_SET_INPUT_DESCRIPTORS:  // core.cpp LoadGame; descriptors are for UI only
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
  H.frameRotation = H.rotation;
  ++H.frameSerial;
}

// Appends `frames` stereo frames to the audio ring. If it is full the NEWEST frames are dropped and counted
// (the oldest are already promised to the reader, and the writer must never touch the read position).
void pushAudio(const int16_t *data, size_t frames) {
  H.audioFrames += frames;
  const size_t mask = kAudioRingFrames - 1;
  size_t room = kAudioRingFrames - (H.audioWrite - H.audioRead);
  size_t n = frames < room ? frames : room;
  H.audioOverruns += frames - n;
  for (size_t i = 0; i < n; ++i) {
    const size_t slot = ((H.audioWrite + i) & mask) * 2;
    H.audio[slot] = data[i * 2];
    H.audio[slot + 1] = data[i * 2 + 1];
  }
  H.audioWrite += n;
}

// The core only uses the batch callback (environment.cpp:145, core.cpp:380 RenderAudio); retro_set_audio_sample is a
// no-op there (environment.cpp:940). The single-sample callback is implemented anyway as libretro requires it.
size_t audioBatchCb(const int16_t *data, size_t frames) {
  ++H.audioBatches;
  pushAudio(data, frames);
  return frames;
}
void audioCb(int16_t left, int16_t right) {
  ++H.audioSingles;
  const int16_t pair[2] = {left, right};
  pushAudio(pair, 1);
}

// Phase 5 input. The core (input/input.cpp, joypad.cpp, pointer.cpp) polls: RETRO_DEVICE_ID_JOYPAD_MASK (we answer true to
// GET_INPUT_BITMASKS; ids 0..15 one by one otherwise), RETRO_DEVICE_POINTER X / Y / PRESSED, and RETRO_DEVICE_ANALOG (right
// stick; the joystick-cursor mode, not fed here). Pointer coordinates are in the space of the frame as DISPLAYED, i.e. after
// the frontend rotation: the core rotates them itself (screenlayout.cpp:319, pointerMatrix = ts * rotate).
struct InputBox {
  uint32_t keyMask = 0;     // bit i = RETRO_DEVICE_ID_JOYPAD_i (B=0 Y=1 SELECT=2 START=3 UP=4 DOWN=5 LEFT=6 RIGHT=7 A=8 X=9 L=10 R=11 L2=12 R2=13 L3=14 R3=15)
  int16_t px = 0, py = 0;   // -32767..32767; (0,0) means "pointer not over the play area" to the core
  bool pressed = false;
  uint32_t queried = 0;     // MDS_INPUT_Q_* flags: what the core really asked for (diagnostics)
};
InputBox IN;
enum : uint32_t { MDS_INPUT_Q_MASK = 1, MDS_INPUT_Q_JOYPAD_ID = 2, MDS_INPUT_Q_POINTER = 4, MDS_INPUT_Q_ANALOG = 8 };

void inputPollCb() {}
int16_t inputStateCb(unsigned port, unsigned device, unsigned index, unsigned id) {
  if (port != 0) return 0;
  switch (device & RETRO_DEVICE_MASK) {
    case RETRO_DEVICE_JOYPAD:
      if (id == RETRO_DEVICE_ID_JOYPAD_MASK) {
        IN.queried |= MDS_INPUT_Q_MASK;
        return static_cast<int16_t>(IN.keyMask & 0xFFFF);
      }
      IN.queried |= MDS_INPUT_Q_JOYPAD_ID;
      return id < 16 ? static_cast<int16_t>((IN.keyMask >> id) & 1u) : 0;
    case RETRO_DEVICE_POINTER:
      if (index != 0) return 0;
      IN.queried |= MDS_INPUT_Q_POINTER;
      switch (id) {
        case RETRO_DEVICE_ID_POINTER_X: return IN.px;
        case RETRO_DEVICE_ID_POINTER_Y: return IN.py;
        case RETRO_DEVICE_ID_POINTER_PRESSED: return IN.pressed ? 1 : 0;
        default: return 0;
      }
    case RETRO_DEVICE_ANALOG:
      IN.queried |= MDS_INPUT_Q_ANALOG;
      return 0;
    default:
      return 0;
  }
}

}  // namespace

extern "C" {

// libretro-common/include/retro_timers.h declares retro_sleep as "defined in frontend" on Emscripten.
// Used by retro::task::wait (task_queue.c), config/console.cpp and platform/platform.cpp (Platform::Sleep).
void retro_sleep(unsigned msec) { usleep(static_cast<useconds_t>(msec) * 1000); }

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
  IN = InputBox{};
  mds::savesReset();
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

// save/saveLen (optional) is the cartridge save, applied before the first frame (see core/host/saves.cpp).
EMSCRIPTEN_KEEPALIVE int mds_load_rom(const uint8_t *rom, size_t len, const uint8_t *save, size_t saveLen) {
  if (!H.created || H.loaded) return -1;
  // The core is need_fullpath=false (retro_get_system_info), so it reads info.data; the path is only used for naming.
  // No copy is written to the in-memory filesystem. [VERIFICAR in phase 5 whether save-file naming needs the file to exist]
  H.romPath = "/rom.nds";

  retro_game_info info{};
  info.path = H.romPath.c_str();
  info.data = rom;  // the caller keeps this buffer alive for the duration of the call
  info.size = len;
  if (!retro_load_game(&info)) return -3;
  H.loaded = true;
  mds::savesOnLoaded(save, saveLen);
  retro_system_av_info av{};  // initial geometry and timing; later changes arrive through the environment callback
  retro_get_system_av_info(&av);
  const retro_game_geometry &g = av.geometry;
  H.geometry = {g.base_width, g.base_height, g.max_width, g.max_height, g.aspect_ratio};
  H.fps = av.timing.fps;
  H.sampleRate = av.timing.sample_rate;
  ++H.geometrySerial;
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

// Copies the last frame into dst keeping the core's pitch (rows `*stride` bytes apart). Returns the bytes copied,
// or 0 if there is no frame or dst_len is too small (then *width/*height/*stride still say how much is needed).
EMSCRIPTEN_KEEPALIVE size_t mds_copy_frame(void *dst, size_t dst_len, unsigned *width, unsigned *height, size_t *stride) {
  if (H.frame.empty()) return 0;
  *width = H.width;
  *height = H.height;
  *stride = H.stride;
  if (dst_len < H.frame.size()) return 0;
  std::memcpy(dst, H.frame.data(), H.frame.size());
  return H.frame.size();
}

// Counts frames the core really delivered (videoCb with data != NULL). If it did not change after mds_run_frame,
// the core asked to repeat the previous frame and there is nothing new to publish.
EMSCRIPTEN_KEEPALIVE uint32_t mds_get_frame_serial() { return H.frameSerial; }
// Rotation (0..3, 90 degrees CCW each) the frontend must apply to the frame returned by mds_get_frame.
EMSCRIPTEN_KEEPALIVE unsigned mds_get_frame_rotation() { return H.frameRotation; }
EMSCRIPTEN_KEEPALIVE uint32_t mds_get_geometry_serial() { return H.geometrySerial; }
// Geometry announced by the core (retro_game_geometry). aspect is width/height as the core wants it displayed.
EMSCRIPTEN_KEEPALIVE void mds_get_geometry(unsigned *baseW, unsigned *baseH, unsigned *maxW, unsigned *maxH, float *aspect) {
  *baseW = H.geometry.baseWidth;
  *baseH = H.geometry.baseHeight;
  *maxW = H.geometry.maxWidth;
  *maxH = H.geometry.maxHeight;
  *aspect = H.geometry.aspect;
}
EMSCRIPTEN_KEEPALIVE double mds_get_fps() { return H.fps; }
EMSCRIPTEN_KEEPALIVE double mds_get_sample_rate() { return H.sampleRate; }

// ---- audio (phase 4) ----
// PCM: interleaved stereo int16 (L,R). Units are STEREO FRAMES (one L,R pair), not individual int16 values.
// The rate is mds_get_sample_rate() = 33513982/1024 = 32728.498 Hz (config/constants.hpp SAMPLE_RATE), NOT 32768.
// Copies up to max_frames frames into dst and returns how many were copied.
EMSCRIPTEN_KEEPALIVE size_t mds_get_audio(int16_t *dst, size_t max_frames) {
  const size_t avail = H.audioWrite - H.audioRead;
  const size_t n = max_frames < avail ? max_frames : avail;
  if (n < max_frames) ++H.audioUnderruns;
  const size_t mask = kAudioRingFrames - 1;
  for (size_t i = 0; i < n; ++i) {
    const size_t slot = ((H.audioRead + i) & mask) * 2;
    dst[i * 2] = H.audio[slot];
    dst[i * 2 + 1] = H.audio[slot + 1];
  }
  H.audioRead += n;
  H.audioDrained += n;
  return n;
}
EMSCRIPTEN_KEEPALIVE size_t mds_get_audio_available() { return H.audioWrite - H.audioRead; }
// Drops everything pending (used when the embedder was not consuming, e.g. before the AudioContext exists).
EMSCRIPTEN_KEEPALIVE void mds_flush_audio() { H.audioRead = H.audioWrite; }
EMSCRIPTEN_KEEPALIVE uint64_t mds_get_audio_frames_total() { return H.audioFrames; }
EMSCRIPTEN_KEEPALIVE uint64_t mds_get_audio_overruns() { return H.audioOverruns; }
EMSCRIPTEN_KEEPALIVE uint64_t mds_get_audio_underruns() { return H.audioUnderruns; }
EMSCRIPTEN_KEEPALIVE uint64_t mds_get_audio_batches() { return H.audioBatches; }
EMSCRIPTEN_KEEPALIVE uint64_t mds_get_audio_singles() { return H.audioSingles; }

EMSCRIPTEN_KEEPALIVE uint64_t mds_get_frame_count() { return H.frameCount; }
EMSCRIPTEN_KEEPALIVE uint64_t mds_get_duplicated_frames() { return H.duplicatedFrames; }

// Phase 5 input (API_CONTRACT.md section 8). Takes effect at the next mds_run_frame.
// mask: bit i = RETRO_DEVICE_ID_JOYPAD_i (same numbering as the online-room indices of section 5 for bits 0..11).
EMSCRIPTEN_KEEPALIVE void mds_set_key_mask(uint32_t mask) { IN.keyMask = mask & 0xFFFFu; }
// nx, ny: -32767..32767 over the frame as displayed (after rotation). (0, 0) with pressed = 0 = pointer away from the screen.
EMSCRIPTEN_KEEPALIVE void mds_set_pointer(int nx, int ny, int pressed) {
  auto clamp = [](int v) { return static_cast<int16_t>(v < -32767 ? -32767 : v > 32767 ? 32767 : v); };
  IN.px = clamp(nx);
  IN.py = clamp(ny);
  // The core treats a raw (0, 0) as "off screen" (cursor hidden); a real touch at the exact centre is nudged by 1/32767.
  if (pressed && IN.px == 0 && IN.py == 0) IN.px = 1;
  IN.pressed = pressed != 0;
}
// Diagnostics: MDS_INPUT_Q_* flags of what the core asked the frontend for since mds_create.
EMSCRIPTEN_KEEPALIVE uint32_t mds_get_input_queries() { return IN.queried; }

}  // extern "C"
