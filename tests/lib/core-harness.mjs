// Node harness around dist/melonds.js for the Phase 6 tests: one wasm instance per Core, driven through the same
// js/saves-core.js functions the emulation worker uses.
import { createHash } from "node:crypto";
import * as saves from "../../js/saves-core.js";

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
