// Test harness around dist/melonds.js for Phase 8: boots a ROM and gives word/byte access to the DS main RAM via mds_ram_data().
// Main RAM is mapped at 0x02000000 (4 MiB on a DS; the mirrors are not exposed, use addresses 0x02000000..0x023FFFFF).
import { existsSync, readFileSync } from "node:fs";

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
