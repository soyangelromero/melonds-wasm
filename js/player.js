// Main-thread side of the Phase 3 video path: spawns the emulation worker, draws the newest ring frame on every
// requestAnimationFrame into the visible canvas (so captureStream() / screenshots work), and exposes the video
// part of API_CONTRACT.md (setLayout, setScreenGap, setHybridSmallScreen, setPostProcess, getFrame).
// It is NOT the final MelonDS class (Phase 10): audio, input and saves are TODO(phase 4-6).
import { createRingBuffer, RingReader } from "./frame-ring.js";
import { FrameRenderer, fitCanvas, SCANLINES } from "./renderer.js";
import { InputState } from "./input.js";
import { layoutOptions, gapOptions, hybridSmallScreenOptions } from "./layouts.js";

export { SCANLINES } from "./renderer.js";
export { LAYOUTS as LAYOUT_LABELS } from "./layouts.js";

export class VideoPlayer {
  static async create({ canvas, container = canvas.parentElement, moduleUrl, workerUrl = new URL("./emu-worker.js", import.meta.url), backend = "auto", verbose = false, threadedRenderer = true, onStatus = () => {} }) {
    if (!self.crossOriginIsolated || typeof SharedArrayBuffer === "undefined") {
      throw Object.assign(new Error("SharedArrayBuffer unavailable: serve with COOP: same-origin and COEP: require-corp (scripts/serve.mjs)"), { code: "NO_THREADS" });
    }
    const player = new VideoPlayer(canvas, container, backend, onStatus);
    player.worker = new Worker(workerUrl, { type: "module", name: "melonds-emu" });
    player.worker.onmessage = (e) => player.#onMessage(e.data);
    player.worker.onerror = (e) => player.#fail(new Error(e.message || "worker error"));
    await player.#call({
      type: "init", ring: player.ringBuffer, input: player.input.buffer, moduleUrl: String(moduleUrl), verbose,
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
    if (m.type === "ack") { this.pending.get(m.id)?.resolve(); this.pending.delete(m.id); }
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
  async loadRom(rom) { await this.#call({ type: "loadRom", rom }); }
  start() { this.running = true; this.worker.postMessage({ type: "start" }); requestAnimationFrame(this.tick); }
  pause() { this.worker.postMessage({ type: "pause" }); }
  resume() { this.worker.postMessage({ type: "resume" }); }
  /** 1 = normal, 2/3/4... = faster, 0 = unlimited. */
  setSpeed(multiplier) { this.worker.postMessage({ type: "speed", value: multiplier }); }
  async dispose() { this.running = false; this.resizeObserver?.disconnect(); await this.#call({ type: "dispose" }).catch(() => {}); this.worker.terminate(); }

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
    return { emuFps: this.workerStats.fps, emuMs: this.workerStats.emuMs, drawFps: this.draw.fps, drawnFrames: this.draw.frames, canvasResizes: this.draw.resizes, ring: this.reader.stats, workers: this.workerStats.workers, backend: this.backend, frameCount: this.workerStats.frames, duplicated: this.workerStats.duplicated };
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
