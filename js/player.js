// Main-thread side of the Phase 3 video path: spawns the emulation worker, draws the newest ring frame on every
// requestAnimationFrame into the visible canvas (so captureStream() / screenshots work), and exposes the video
// part of API_CONTRACT.md (setLayout, setScreenGap, setHybridSmallScreen, setPostProcess, getFrame).
// Phase 4 adds audio (js/audio-output.js, js/audio-ring.js), setVolume/setMuted and captureStream().
// It is NOT the final MelonDS class (Phase 10): input and saves are TODO(phase 5-6).
import { createRingBuffer, RingReader } from "./frame-ring.js";
import { FrameRenderer, fitCanvas, SCANLINES } from "./renderer.js";
import { createAudioRingBuffer, DEFAULT_CAPACITY_FRAMES, createCaptureBuffer } from "./audio-ring.js";
import { AudioOutput } from "./audio-output.js";
import { InputState } from "./input.js";
import { SaveClient } from "./saves.js"; // phase 6
import { layoutOptions, gapOptions, hybridSmallScreenOptions } from "./layouts.js";

export { SCANLINES } from "./renderer.js";
export { LAYOUTS as LAYOUT_LABELS } from "./layouts.js";

export class VideoPlayer {
  static async create({ canvas, container = canvas.parentElement, moduleUrl, workerUrl = new URL("./emu-worker.js", import.meta.url), backend = "auto", verbose = false, threadedRenderer = true, onStatus = () => {}, audio = true, audioLatencyMs = 80, audioSampleRate, audioCapture = false, audioIgnoreActivation = false }) {
    if (!self.crossOriginIsolated || typeof SharedArrayBuffer === "undefined") {
      throw Object.assign(new Error("SharedArrayBuffer unavailable: serve with COOP: same-origin and COEP: require-corp (scripts/serve.mjs)"), { code: "NO_THREADS" });
    }
    const player = new VideoPlayer(canvas, container, backend, onStatus);
    if (audio) {
      player.audioRing = createAudioRingBuffer(DEFAULT_CAPACITY_FRAMES);
      player.audioCaptureRing = audioCapture ? createCaptureBuffer() : null; // tests only
      player.audio = new AudioOutput({ ring: player.audioRing, sampleRate: audioSampleRate, capture: player.audioCaptureRing, ignoreActivation: audioIgnoreActivation, onError: (e) => player.#fail(e) });
    }
    player.worker = new Worker(workerUrl, { type: "module", name: "melonds-emu" });
    player.worker.onmessage = (e) => player.#onMessage(e.data);
    player.worker.onerror = (e) => player.#fail(new Error(e.message || "worker error"));
    await player.#call({
      type: "init", ring: player.ringBuffer, input: player.input.buffer, moduleUrl: String(moduleUrl), verbose, audioRing: player.audioRing, audioLatencyMs,
      options: { ...layoutOptions(player.layout), ...gapOptions(0), melonds_threaded_renderer: threadedRenderer ? "enabled" : "disabled" },
    });
    return player;
  }

  constructor(canvas, container, backend, onStatus) {
    this.canvas = canvas; this.container = container; this.onStatus = onStatus;
    this.renderer = new FrameRenderer(canvas, { backend });
    this.ringBuffer = createRingBuffer();
    this.input = new InputState(); // Phase 5: read by the worker before each frame
    this.reader = new RingReader(this.ringBuffer);
    this.layout = "Top/Bottom";
    this.fit = { integer: true, smooth: false };
    this.pending = new Map(); this.nextId = 1; this.listeners = new Map();
    this.workerStats = { fps: 0, emuMs: 0, frames: 0, duplicated: 0, workers: -1 };
    this.draw = { frames: 0, fps: 0, windowStart: performance.now(), windowFrames: 0, lastGeometrySerial: -1, resizes: 0 };
    this.lastFrame = null;
    this.running = false;
    this.audio = null; this.audioRing = null; this.audioCaptureRing = null;
    this.saves = new SaveClient({ call: (msg) => this.#call(msg), on: (event, cb) => this.on(event, cb) }); // getSave/loadSave/onSave/saveState/loadState
    this.tick = (now) => this.#raf(now);
    this.resizeObserver = typeof ResizeObserver === "function" && container ? new ResizeObserver(() => this.refit()) : null;
    this.resizeObserver?.observe(container);
  }

  // ---- worker plumbing ----
  #call(msg) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.worker.postMessage({ ...msg, id }); });
  }
  #onMessage(m) {
    if (m.type === "ack") { this.pending.get(m.id)?.resolve(m.result); this.pending.delete(m.id); }
    else if (m.type === "error") {
      const err = Object.assign(new Error(m.message), { code: m.code });
      const p = this.pending.get(m.id);
      if (p) { p.reject(err); this.pending.delete(m.id); } else this.#fail(err);
    } else if (m.type === "stats") { this.workerStats = m; this.#emit("stats", m); }
    else if (m.type === "log") this.onStatus(m);
    else this.#emit(m.type, m);
  }
  #fail(error) { this.#emit("error", error); }
  on(event, cb) { (this.listeners.get(event) ?? this.listeners.set(event, new Set()).get(event)).add(cb); return () => this.listeners.get(event).delete(cb); }
  #emit(event, payload) { for (const cb of this.listeners.get(event) ?? []) cb(payload); }

  // ---- lifecycle ----
  async loadRom(rom, { save = null } = {}) { await this.#call({ type: "loadRom", rom, save }); }
  start() {
    this.running = true; this.paused = false;
    this.audio?.start().catch(() => {}); // no-op if the context is not allowed yet: autoUnlock retries on the first gesture
    this.worker.postMessage({ type: "start" }); requestAnimationFrame(this.tick);
  }
  pause() { this.paused = true; this.audio?.setPaused(true); this.worker.postMessage({ type: "pause" }); } // the worklet starts its 6 ms fade right away
  resume() { this.paused = false; this.audio?.start().catch(() => {}); this.worker.postMessage({ type: "resume" }); }
  /** 1 = normal, 2/3/4... = faster, 0 = unlimited. */
  setSpeed(multiplier) { this.worker.postMessage({ type: "speed", value: multiplier }); }
  async dispose() { this.running = false; await this.audio?.dispose(); this.resizeObserver?.disconnect(); await this.#call({ type: "dispose" }).catch(() => {}); this.worker.terminate(); }

  // ---- audio API (API_CONTRACT.md section 2) ----
  setVolume(v) { this.volumeValue = v; this.audio?.setVolume(v); }
  setMuted(m) { this.mutedValue = !!m; this.audio?.setMuted(m); }
  /** Resumes the AudioContext; call it from a click/key handler if the page wants to be explicit (autoUnlock does it on the first gesture). */
  unlockAudio() { return this.audio?.start() ?? Promise.resolve(); }
  /**
   * Video (canvas.captureStream) + audio (MediaStreamAudioDestinationNode) in a single MediaStream, for WebRTC (phase 12).
   * Needs the visible canvas of the main thread, and the audio started (after the first gesture). Local volume/mute do not affect it.
   */
  captureStream(fps = 60) {
    const stream = new MediaStream(this.canvas.captureStream(fps).getVideoTracks());
    if (this.audio) for (const t of this.audio.getCaptureTracks()) stream.addTrack(t);
    return stream;
  }

  // ---- input API (API_CONTRACT.md section 2; js/input.js) ----
  button(name, down) { this.input.button(name, down); }
  touchFromCanvas(nx, ny, state) { this.input.touchFromCanvas(nx, ny, state); }
  attachKeyboard(el, map) { return this.input.attachKeyboard(el, map); }
  attachGamepad(opts) { return this.input.attachGamepad(opts); }
  /** Mouse / touch / pen on the canvas (Pointer Events); the contract has no name for it, `touchFromCanvas` is the primitive. */
  attachPointer(el = this.canvas, opts) { return this.input.attachPointer(el, opts); }

  // ---- video API (API_CONTRACT.md section 2) ----
  #setOptions(set) { this.worker.postMessage({ type: "options", set }); }
  setLayout(label) { this.#setOptions(layoutOptions(label)); this.layout = label; }
  setScreenGap(px) { this.#setOptions(gapOptions(px)); }
  setHybridSmallScreen(mode) { this.#setOptions(hybridSmallScreenOptions(mode)); }
  setCoreOption(key, value) { this.#setOptions({ [key]: String(value) }); }
  setPostProcess(shader) { return this.renderer.setPostProcess(shader); }
  setScaling({ integer = this.fit.integer, smooth = this.fit.smooth } = {}) { this.fit = { integer, smooth }; this.refit(); }
  get backend() { return this.renderer.backend; }

  /** Copy of the last frame the renderer drew (stride preserved, unrotated, as the core delivered it). */
  getFrame() {
    const f = this.lastFrame;
    if (!f) return null;
    return { width: f.width, height: f.height, stride: f.stride, rotation: f.rotation, format: "XRGB8888", data: f.data.slice() };
  }

  refit() {
    if (!this.container || !this.canvas.width) return;
    const r = this.container.getBoundingClientRect();
    this.fitState = fitCanvas(this.canvas, { width: r.width, height: r.height }, this.fit);
  }

  getStats() {
    const a = this.audio?.getStats();
    return {
      audioBufferMs: a?.bufferMs ?? 0, audio: a ?? null, audioFeeding: this.workerStats.feeding ?? false, emuFps: this.workerStats.fps, emuMs: this.workerStats.emuMs, drawFps: this.draw.fps, drawnFrames: this.draw.frames, canvasResizes: this.draw.resizes, ring: this.reader.stats, workers: this.workerStats.workers, backend: this.backend, frameCount: this.workerStats.frames, duplicated: this.workerStats.duplicated,
    };
  }

  #raf(now) {
    if (!this.running) return;
    const frame = this.reader.poll();
    if (frame) {
      const prevW = this.canvas.width, prevH = this.canvas.height;
      this.renderer.draw(frame);
      this.lastFrame = frame; // valid until the next poll(); getFrame() copies it
      if (this.canvas.width !== prevW || this.canvas.height !== prevH) { this.draw.resizes++; this.refit(); }
      this.draw.frames++; this.draw.windowFrames++;
      this.#emit("frame", { width: frame.width, height: frame.height, rotation: frame.rotation, frameNo: frame.frameNo });
    }
    if (now - this.draw.windowStart >= 500) {
      this.draw.fps = (this.draw.windowFrames * 1000) / (now - this.draw.windowStart);
      this.draw.windowFrames = 0; this.draw.windowStart = now;
    }
    requestAnimationFrame(this.tick);
  }
}
