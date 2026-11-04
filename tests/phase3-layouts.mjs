// Phase 3 (Node, no browser): cycle the 17 layouts + gap + hybrid small screen on a real core and report what it delivers.
// Usage: node tests/phase3-layouts.mjs <rom.nds> [--json]
import { readFileSync } from "node:fs";
import { LAYOUT_VALUES, layoutOptions, gapOptions, hybridSmallScreenOptions } from "../js/layouts.js";

const romPath = process.argv[2];
if (!romPath) { console.error("usage: node tests/phase3-layouts.mjs <rom.nds> [--json]"); process.exit(2); }
const json = process.argv.includes("--json");

const { default: createModule } = await import(new URL("../dist/melonds.js", import.meta.url));
const M = await createModule();
const cstr = (s) => { const b = Buffer.from(s + "\0"); const p = M._malloc(b.length); M.HEAPU8.set(b, p); return p; };
const set = (opts) => { for (const [k, v] of Object.entries(opts)) M._mds_set_option(cstr(k), cstr(v)); };
const [w, h, s, bw, bh, mw, mh, asp] = Array.from({ length: 8 }, () => M._malloc(4));

if (M._mds_create(0) !== 0) throw new Error("mds_create");
set({ ...layoutOptions("Top/Bottom"), ...gapOptions(0), melonds_threaded_renderer: "disabled" });
const rom = readFileSync(romPath);
const rp = M._malloc(rom.length); M.HEAPU8.set(rom, rp);
if (M._mds_load_rom(rp, rom.length, 0, 0) !== 0) throw new Error("mds_load_rom");

const rows = [];
function settle(label, frames = 6) {
  const serial0 = M._mds_get_geometry_serial();
  for (let i = 0; i < frames; i++) M._mds_run_frame();
  const p = M._mds_get_frame(w, h, s);
  M._mds_get_geometry(bw, bh, mw, mh, asp);
  const row = {
    label, frame: `${M.HEAPU32[w >> 2]}x${M.HEAPU32[h >> 2]}`, stride: M.HEAPU32[s >> 2], rotation: M._mds_get_frame_rotation(),
    geometry: `${M.HEAPU32[bw >> 2]}x${M.HEAPU32[bh >> 2]}`, max: `${M.HEAPU32[mw >> 2]}x${M.HEAPU32[mh >> 2]}`,
    aspect: +M.HEAPF32[asp >> 2].toFixed(4), geometryChanged: M._mds_get_geometry_serial() !== serial0, hasFrame: !!p,
  };
  rows.push(row);
  return row;
}

settle("boot (Top/Bottom)", 10);
for (const label of Object.keys(LAYOUT_VALUES)) { set(layoutOptions(label)); settle(label); }
set(layoutOptions("Top/Bottom"));
for (const gap of [0, 1, 40, 126]) { set(gapOptions(gap)); settle(`Top/Bottom gap=${gap}`); }
set(gapOptions(0));
set(layoutOptions("Hybrid (Focus Top)"));
for (const mode of ["one", "both"]) { set(hybridSmallScreenOptions(mode)); settle(`Hybrid (Focus Top) small=${mode}`); }
// A wrong value must be rejected by our wrapper, not silently passed to the core.
let rejected = false; try { layoutOptions("Top-Bottom"); } catch (e) { rejected = e.code === "LAYOUT_INVALID"; }
rows.push({ label: "invalid label rejected", ok: rejected });

if (json) console.log(JSON.stringify(rows, null, 1)); else console.table(rows);
M._mds_destroy();
process.exit(rejected ? 0 : 1);
