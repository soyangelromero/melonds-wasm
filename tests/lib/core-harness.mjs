// Node test harnesses around dist/melonds.js, shared by two phases (merged during the integration):
//  - createCore / sha256: Phase 6 (saves and states), driven through the same js/saves-core.js functions the worker uses.
//  - bootCore / RAM_BASE / haveCore: Phase 8 (cheats), with word/byte access to the DS main RAM via mds_ram_data().
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import * as saves from "../../js/saves-core.js";

// ===== Phase 6 =====

// fixedClock: the emulated RTC starts at a fixed date instead of the wall clock. Without it two instances booted in different
// seconds differ in a few RTC bytes of the state (found while writing the determinism test); everything else is identical.
export async function createCore({ threads = false, fixedClock = true } = {}) {
  const { default: createModule } = await import(new URL("../../dist/melonds.js", import.meta.url));
  const log = process.env.MDS_VERBOSE ? (t) => console.error(t) : () => {};
  const M = await createModule({ print: log, printErr: log });
  const heap = (bytes) => { const p = M._malloc(Math.max(1, bytes.length)); M.HEAPU8.set(bytes, p); return p; };
  const cstr = (s) => heap(Buffer.from(s + "\0"));
  if (M._mds_create(process.env.MDS_VERBOSE ? 1 : 0) !== 0) throw new Error("mds_create failed");
  M._mds_set_option(cstr("melonds_threaded_renderer"), cstr(threads ? "enabled" : "disabled"));
  if (fixedClock) {
    for (const [k, v] of Object.entries({ mode: "absolute", absolute_year: "2020", absolute_month: "6", absolute_day: "15", absolute_hour: "12", absolute_minute: "0", absolute_second: "0" })) {
      M._mds_set_option(cstr(`melonds_start_time_${k}`), cstr(v));
    }
  }
  const [wp, hp, sp] = [M._malloc(4), M._malloc(4), M._malloc(4)];

  const core = {
    M, saves,
    loadRom(rom, save = null) {
      const rp = heap(rom), vp = save?.length ? heap(save) : 0;
      const rc = M._mds_load_rom(rp, rom.length, vp, vp ? save.length : 0);
      M._free(rp); if (vp) M._free(vp);
      if (rc !== 0) throw new Error(`mds_load_rom failed (${rc})`);
    },
    run(n = 1) { for (let i = 0; i < n; i++) M._mds_run_frame(); },
    frameCount: () => Number(M._mds_get_frame_count()),
    /** SHA-256 of the composed XRGB8888 frame (visible bytes only, as tests/headless.mjs does). */
    frameHash() {
      const p = M._mds_get_frame(wp, hp, sp);
      if (!p) return null;
      const w = M.HEAPU32[wp >> 2], h = M.HEAPU32[hp >> 2], stride = M.HEAPU32[sp >> 2];
      const hash = createHash("sha256");
      for (let y = 0; y < h; y++) hash.update(M.HEAPU8.subarray(p + y * stride, p + y * stride + w * 4));
      return hash.digest("hex");
    },
    getSave: () => saves.getSave(M),
    setSave: (b) => saves.setSave(M, b),
    saveState: () => saves.saveState(M),
    loadState: (b) => saves.loadState(M, b),
    destroy() { M._mds_destroy(); },
  };
  return core;
}

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// ===== Phase 8 =====

export const RAM_BASE = 0x02000000;

export async function bootCore(romPath, { beforeLoad } = {}) {
  const { default: createModule } = await import(new URL("../../dist/melonds.js", import.meta.url));
  const M = await createModule({ print: () => {}, printErr: () => {} });
  const cstr = (s) => { const b = Buffer.from(s + "\0"); const p = M._malloc(b.length); M.HEAPU8.set(b, p); return p; };
  if (M._mds_create(0) !== 0) throw new Error("mds_create failed");
  const opt = (k, v) => { const a = cstr(k), b = cstr(v); M._mds_set_option(a, b); M._free(a); M._free(b); };
  opt("melonds_threaded_renderer", "disabled"); // fewer moving parts; cheats do not depend on it
  beforeLoad?.(M);
  const rom = readFileSync(romPath);
  const rp = M._malloc(rom.length);
  M.HEAPU8.set(rom, rp);
  const rc = M._mds_load_rom(rp, rom.length, 0, 0);
  M._free(rp);
  if (rc !== 0) throw new Error(`mds_load_rom failed (${rc})`);

  const ramBase = () => { const p = M._mds_ram_data(); if (!p) throw new Error("no RAM pointer"); return p; };
  const off = (addr, n) => {
    const o = (addr >>> 0) - RAM_BASE;
    if (o < 0 || o + n > M._mds_ram_size()) throw new RangeError(`address ${addr.toString(16)} outside main RAM`);
    return ramBase() + o;
  };
  const api = {
    M,
    cstr,
    frames: (n = 1) => { for (let i = 0; i < n; i++) M._mds_run_frame(); },
    r8: (a) => M.HEAPU8[off(a, 1)],
    r16: (a) => { const p = off(a, 2); return M.HEAPU8[p] | (M.HEAPU8[p + 1] << 8); },
    r32: (a) => { const p = off(a, 4); return (M.HEAPU8[p] | (M.HEAPU8[p + 1] << 8) | (M.HEAPU8[p + 2] << 16) | (M.HEAPU8[p + 3] << 24)) >>> 0; }, // byte reads: the RAM pointer is not 4-aligned in the wasm heap
    w8: (a, v) => { M.HEAPU8[off(a, 1)] = v & 0xff; },
    w16: (a, v) => { const p = off(a, 2); M.HEAPU8[p] = v & 0xff; M.HEAPU8[p + 1] = (v >> 8) & 0xff; },
    w32: (a, v) => { const p = off(a, 4); for (let i = 0; i < 4; i++) M.HEAPU8[p + i] = (v >>> (8 * i)) & 0xff; },
    // Writes/reads a whole text to mds_cheat_set. Returns the C return code.
    cheat: (id, enabled, text) => {
      if (text == null || text === "") return M._mds_cheat_set(id, enabled ? 1 : 0, 0, 0);
      const b = Buffer.from(text);
      const p = M._malloc(b.length + 1);
      M.HEAPU8.set(b, p);
      const rc = M._mds_cheat_set(id, enabled ? 1 : 0, p, b.length);
      M._free(p);
      return rc;
    },
    clear: () => M._mds_cheat_clear(),
    count: () => M._mds_cheat_count(),
    slot: (id) => M._mds_cheat_slot(id),
    enabled: (id) => M._mds_cheat_enabled(id),
    heapUsed: () => Number(M._mds_heap_used()),
    destroy: () => M._mds_destroy(),
  };
  return api;
}

export const haveCore = existsSync(new URL("../../dist/melonds.js", import.meta.url));
