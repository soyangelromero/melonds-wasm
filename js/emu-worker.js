// Emulation worker: owns the wasm module, runs mds_run_frame at the console's pace and publishes each new composed
// frame into the shared ring (js/frame-ring.js). Module worker; the main thread only draws.
import { RingWriter } from "./frame-ring.js";
import { createWorkerSaves, describeSaveType, getSave as readCartSave, saveStatus } from "./saves-core.js"; // phase 6

const DS_FPS = 59.8261; // fallback; the real value comes from retro_get_system_av_info (mds_get_fps)
let M = null, ring = null, running = false, speed = 1, loopToken = 0;
let wPtr = 0, hPtr = 0, sPtr = 0, strPtr = 0;
let lastSerial = -1, lastGeomSerial = -1;
let saves = null; // phase 6: save RAM / savestate handlers + change detector (js/saves-core.js)
const stats = { frames: 0, published: 0, emuMs: 0, windowFrames: 0, windowStart: 0 };

const post = (msg) => self.postMessage(msg);
const cstr = (s) => { const b = new TextEncoder().encode(s + "\0"); const p = M._malloc(b.length); M.HEAPU8.set(b, p); return p; };
function setOption(key, value) {
  const k = cstr(key), v = cstr(value);
  M._mds_set_option(k, v);
  M._free(k); M._free(v);
}
const workerCount = () => (M?.PThread ? Object.keys(M.PThread.pthreads).length : -1);

async function init({ ring: sab, moduleUrl, verbose, options }) {
  ring = new RingWriter(sab);
  const { default: createModule } = await import(moduleUrl);
  M = await createModule({
    print: (t) => post({ type: "log", level: "info", text: String(t) }),
    printErr: (t) => post({ type: "log", level: "err", text: String(t) }),
  });
  [wPtr, hPtr, sPtr, strPtr] = [M._malloc(4), M._malloc(4), M._malloc(4), M._malloc(4)];
  if (M._mds_create(verbose ? 1 : 0) !== 0) throw new Error("mds_create failed");
  for (const [k, v] of Object.entries(options ?? {})) setOption(k, v);
  saves = createWorkerSaves(M, post);
  post({ type: "ready", sharedMemory: M.HEAPU8.buffer instanceof SharedArrayBuffer });
}

function loadRom(bytes, save) {
  const p = M._malloc(bytes.length);
  M.HEAPU8.set(bytes, p);
  const sp = save?.length ? M._malloc(save.length) : 0; // optional .sav, applied before the first frame
  if (sp) M.HEAPU8.set(save, sp);
  const rc = M._mds_load_rom(p, bytes.length, sp, sp ? save.length : 0);
  M._free(p); // the core copied what it needs
  if (sp) M._free(sp);
  if (rc !== 0) throw Object.assign(new Error(`mds_load_rom failed (${rc})`), { code: "ROM_INVALID" });
  saves.reset();
  const saveLen = readCartSave(M)?.length ?? 0;
  post({ type: "loaded", fps: M._mds_get_fps(), workers: workerCount(), saveLen, saveType: describeSaveType(saveLen), saveStatus: saveStatus(M) });
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

const channel = new MessageChannel();
const yieldToEvents = () => new Promise((resolve) => { channel.port1.onmessage = resolve; channel.port2.postMessage(0); });
const sleepSab = new Int32Array(new SharedArrayBuffer(4));

async function loop(token) {
  const frameMs = () => 1000 / (M._mds_get_fps() || DS_FPS) / (speed || 1);
  let next = performance.now();
  stats.windowStart = next;
  let lastStats = next;
  while (running && token === loopToken) {
    const t0 = performance.now();
    M._mds_run_frame();
    publishFrame();
    saves.tick();
    const t1 = performance.now();
    stats.emuMs += t1 - t0; stats.frames++; stats.windowFrames++;

    if (speed !== 0) { // paced: sleep (Atomics.wait is precise in workers) until the next frame is due
      next += frameMs();
      const wait = next - performance.now();
      if (wait > 0) Atomics.wait(sleepSab, 0, 0, wait);
      else if (wait < -100) next = performance.now(); // fell far behind: do not try to catch up in a burst
    }
    if (t1 - lastStats >= 500) {
      post({ type: "stats", fps: (stats.windowFrames * 1000) / (t1 - stats.windowStart), emuMs: stats.emuMs / stats.windowFrames, frames: Number(M._mds_get_frame_count()), duplicated: Number(M._mds_get_duplicated_frames()), workers: workerCount() });
      stats.windowFrames = 0; stats.emuMs = 0; stats.windowStart = t1; lastStats = t1;
    }
    await yieldToEvents(); // let setOption / pause messages in between frames
  }
}

function start() { if (running) return; running = true; loop(++loopToken); }
function stop() { running = false; loopToken++; }

const handlers = {
  init, loadRom: ({ rom, save }) => loadRom(rom, save),
  options: ({ set }) => { for (const [k, v] of Object.entries(set)) setOption(k, v); },
  start, pause: () => { stop(); saves.tick(true); }, resume: start,
  speed: ({ value }) => { speed = value; },
  dispose: () => { stop(); if (M) M._mds_destroy(); post({ type: "disposed" }); },
};

self.onmessage = async ({ data }) => {
  try {
    const out = (await (handlers[data.type] ?? saves?.handlers[data.type])?.(data)) ?? {};
    if (data.id != null) self.postMessage({ type: "ack", id: data.id, result: out.result }, out.transfer ?? []);
  }
  catch (error) { post({ type: "error", id: data.id, code: error.code ?? "WORKER", message: String(error.message ?? error), stack: error.stack }); }
};
