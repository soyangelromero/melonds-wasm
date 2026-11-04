// Emulation worker: owns the wasm module, runs mds_run_frame at the console's pace and publishes each new composed
// frame into the shared ring (js/frame-ring.js). Module worker; the main thread only draws.
import { RingWriter } from "./frame-ring.js";
import { AudioRingWriter } from "./audio-ring.js";

const DS_FPS = 59.8261; // fallback; the real value comes from retro_get_system_av_info (mds_get_fps)
let M = null, ring = null, running = false, speed = 1, loopToken = 0;
let wPtr = 0, hPtr = 0, sPtr = 0, strPtr = 0;
let lastSerial = -1, lastGeomSerial = -1;
// Audio (phase 4). `feeding` = the audio clock is the metronome: the AudioWorklet is alive (its heartbeat advances), speed is 1x
// and we are not paused. Otherwise the timer paces the emulator and the audio produced is discarded.
const AUDIO_MAX_FRAMES = 2048; // the core never delivers more than this per retro_run (core.cpp RenderAudio)
const ALIVE_MS = 150;          // heartbeat older than this => AudioContext suspended/absent => fall back to the timer
let aw = null, audioPtr = 0, audioLatencyMs = 80, feeding = false, lastTick = -1, lastTickAt = 0, srcRate = 32728.498;
const stats = { frames: 0, published: 0, emuMs: 0, windowFrames: 0, windowStart: 0 };

const post = (msg) => self.postMessage(msg);
const cstr = (s) => { const b = new TextEncoder().encode(s + "\0"); const p = M._malloc(b.length); M.HEAPU8.set(b, p); return p; };
function setOption(key, value) {
  const k = cstr(key), v = cstr(value);
  M._mds_set_option(k, v);
  M._free(k); M._free(v);
}
const workerCount = () => (M?.PThread ? Object.keys(M.PThread.pthreads).length : -1);

async function init({ ring: sab, audioRing, audioLatencyMs: lat, moduleUrl, verbose, options }) {
  ring = new RingWriter(sab);
  if (audioRing) { aw = new AudioRingWriter(audioRing); aw.setPaused(true); }
  if (lat) audioLatencyMs = lat;
  const { default: createModule } = await import(moduleUrl);
  M = await createModule({
    print: (t) => post({ type: "log", level: "info", text: String(t) }),
    printErr: (t) => post({ type: "log", level: "err", text: String(t) }),
  });
  [wPtr, hPtr, sPtr, strPtr] = [M._malloc(4), M._malloc(4), M._malloc(4), M._malloc(4)];
  audioPtr = M._malloc(AUDIO_MAX_FRAMES * 4);
  if (M._mds_create(verbose ? 1 : 0) !== 0) throw new Error("mds_create failed");
  for (const [k, v] of Object.entries(options ?? {})) setOption(k, v);
  post({ type: "ready", sharedMemory: M.HEAPU8.buffer instanceof SharedArrayBuffer });
}

function loadRom(bytes) {
  const p = M._malloc(bytes.length);
  M.HEAPU8.set(bytes, p);
  const rc = M._mds_load_rom(p, bytes.length, 0, 0);
  M._free(p); // the core copied what it needs
  if (rc !== 0) throw Object.assign(new Error(`mds_load_rom failed (${rc})`), { code: "ROM_INVALID" });
  srcRate = M._mds_get_sample_rate() || srcRate;
  if (aw) { aw.setSourceRate(srcRate); aw.setTargetFrames(Math.round((audioLatencyMs / 1000) * srcRate)); }
  post({ type: "loaded", fps: M._mds_get_fps(), sampleRate: srcRate, workers: workerCount() });
}

function publishFrame() {
  const serial = M._mds_get_frame_serial();
  if (serial === lastSerial) return; // data == NULL: the core asked to repeat the previous frame, nothing new to show
  lastSerial = serial;
  const p = M._mds_get_frame(wPtr, hPtr, sPtr);
  if (!p) return;
  const width = M.HEAPU32[wPtr >> 2], height = M.HEAPU32[hPtr >> 2], stride = M.HEAPU32[sPtr >> 2];
  ring.target.set(M.HEAPU8.subarray(p, p + stride * height)); // the single copy: wasm heap -> ring slot, stride preserved
  ring.publish({ width, height, stride, rotation: M._mds_get_frame_rotation(), geometrySerial: M._mds_get_geometry_serial() });
}

// Moves the audio the core produced during the last mds_run_frame into the shared ring, or drops it when not feeding.
function drainAudio() {
  if (!feeding) { M._mds_flush_audio(); return; }
  const n = M._mds_get_audio(audioPtr, AUDIO_MAX_FRAMES);
  if (n) aw.write(M.HEAP16.subarray(audioPtr >> 1, (audioPtr >> 1) + n * 2), n);
}

// Decides who is the metronome. Called once per loop iteration.
function refreshAudioMode(now) {
  if (!aw) return;
  const tick = aw.tick;
  if (tick !== lastTick) { lastTick = tick; lastTickAt = now; }
  const should = speed === 1 && now - lastTickAt < ALIVE_MS;
  if (should !== feeding) {
    feeding = should;
    aw.setPaused(!feeding);            // false: the worklet (re)primes and fades in; true: it fades out and drops what is left
    M._mds_flush_audio();
    post({ type: "audio-mode", feeding, speed });
  }
}

const channel = new MessageChannel();
const yieldToEvents = () => new Promise((resolve) => { channel.port1.onmessage = resolve; channel.port2.postMessage(0); });
const sleepSab = new Int32Array(new SharedArrayBuffer(4));

async function loop(token) {
  const frameMs = () => 1000 / (M._mds_get_fps() || DS_FPS) / (speed || 1);
  let next = performance.now();
  stats.windowStart = next;
  let lastStats = next;
  while (running && token === loopToken) {
    const now = performance.now();
    refreshAudioMode(now);
    if (feeding) {
      // The audio clock is the metronome: the worklet drains the ring in real time, we emulate a frame whenever the fill
      // is below target. Steady state: fill oscillates between target and target + one DS frame (~547 audio frames).
      const fill = aw.fill, target = aw.targetFrames;
      if (fill < target) stepFrame();
      else Atomics.wait(sleepSab, 0, 0, Math.min(8, Math.max(0.5, ((fill - target) / srcRate) * 1000)));
      next = performance.now(); // keep the timer base fresh in case we fall back to it
    } else {
      stepFrame();
      if (speed !== 0) { // timer-paced: sleep (Atomics.wait is precise in workers) until the next frame is due
        next += frameMs();
        const wait = next - performance.now();
        if (wait > 0) Atomics.wait(sleepSab, 0, 0, wait);
        else if (wait < -100) next = performance.now(); // fell far behind: do not try to catch up in a burst
      }
    }
    const t1 = performance.now();
    if (t1 - lastStats >= 500) {
      post({ type: "stats", fps: (stats.windowFrames * 1000) / (t1 - stats.windowStart), emuMs: stats.windowFrames ? stats.emuMs / stats.windowFrames : 0, frames: Number(M._mds_get_frame_count()), duplicated: Number(M._mds_get_duplicated_frames()), workers: workerCount(), feeding, hostAudio: { total: Number(M._mds_get_audio_frames_total()), overruns: Number(M._mds_get_audio_overruns()), underruns: Number(M._mds_get_audio_underruns()) } });
      stats.windowFrames = 0; stats.emuMs = 0; stats.windowStart = t1; lastStats = t1;
    }
    await yieldToEvents(); // let setOption / pause messages in between frames
  }
}

function stepFrame() {
  const t0 = performance.now();
  M._mds_run_frame();
  publishFrame();
  drainAudio();
  stats.emuMs += performance.now() - t0; stats.frames++; stats.windowFrames++;
}

function start() { if (running) return; running = true; loop(++loopToken); }
function stop() {
  running = false; loopToken++;
  if (aw) { aw.setPaused(true); feeding = false; if (M) M._mds_flush_audio(); }
}

const handlers = {
  init, loadRom: ({ rom }) => loadRom(rom),
  options: ({ set }) => { for (const [k, v] of Object.entries(set)) setOption(k, v); },
  start, pause: stop, resume: start,
  speed: ({ value }) => { speed = value; },
  // Test hooks for the stress measurements in tests/phase4-browser.mjs (not part of the public API).
  debugStall: ({ ms }) => { Atomics.wait(sleepSab, 0, 0, ms); },   // block the producer: provokes an underrun
  debugBurst: ({ frames }) => { if (!feeding) return; for (let i = 0; i < frames; i++) stepFrame(); }, // run ahead: provokes an overrun / trim
  dispose: () => { stop(); if (M) M._mds_destroy(); post({ type: "disposed" }); },
};

self.onmessage = async ({ data }) => {
  try { await handlers[data.type]?.(data); if (data.id != null) post({ type: "ack", id: data.id }); }
  catch (error) { post({ type: "error", id: data.id, code: error.code ?? "WORKER", message: String(error.message ?? error), stack: error.stack }); }
};
