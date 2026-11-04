// Phase 2 headless test: boot a ROM, run N frames, print SHA-256 of the composed XRGB8888 frame every 60 frames.
// Usage: node tests/headless.mjs <rom.nds> [frames=300] [--threads=0|1] [--verbose]
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

const args = process.argv.slice(2);
const flags = Object.fromEntries(
  args.filter((a) => a.startsWith("--")).map((a) => { const [k, v = "1"] = a.slice(2).split("="); return [k, v]; }),
);
const pos = args.filter((a) => !a.startsWith("--"));
if (!pos[0]) {
  console.error("usage: node tests/headless.mjs <rom.nds> [frames=300] [--threads=0|1] [--verbose] [--bios7= --bios9= --firmware=]");
  process.exit(2);
}
const frames = Number(pos[1] ?? 300);

const { default: createModule } = await import(new URL("../dist/melonds.js", import.meta.url));
const M = await createModule();

function writeToHeap(bytes) {
  const ptr = M._malloc(bytes.length);
  M.HEAPU8.set(bytes, ptr);
  return ptr;
}
function cstr(s) {
  return writeToHeap(Buffer.from(s + "\0"));
}
function setOption(k, v) { M._mds_set_option(cstr(k), cstr(v)); }

// Optional real BIOS/firmware supplied by the caller (never bundled). Names follow the core's expectations.
for (const [flag, name] of [["bios7", "bios7.bin"], ["bios9", "bios9.bin"], ["firmware", "firmware.bin"]]) {
  if (flags[flag]) {
    const b = readFileSync(flags[flag]);
    const rc = M._mds_write_system_file(cstr(name), writeToHeap(b), b.length);
    if (rc !== 0) { console.error(`failed to write ${name}: ${rc}`); process.exit(1); }
  }
}

if (M._mds_create(flags.verbose ? 1 : 0) !== 0) { console.error("mds_create failed"); process.exit(1); }
const threaded = flags.threads === "0" ? "disabled" : "enabled";
setOption("melonds_threaded_renderer", threaded);

const rom = readFileSync(pos[0]);
const rc = M._mds_load_rom(writeToHeap(rom), rom.length, 0, 0);
if (rc !== 0) { console.error(`mds_load_rom failed: ${rc}`); process.exit(1); }

const wPtr = M._malloc(4), hPtr = M._malloc(4), sPtr = M._malloc(4);
function frameHash() {
  const p = M._mds_get_frame(wPtr, hPtr, sPtr);
  if (!p) return null;
  const w = M.HEAPU32[wPtr >> 2], h = M.HEAPU32[hPtr >> 2], stride = M.HEAPU32[sPtr >> 2];
  const hash = createHash("sha256");
  for (let y = 0; y < h; y++) hash.update(M.HEAPU8.subarray(p + y * stride, p + y * stride + w * 4));
  return { w, h, stride, hex: hash.digest("hex") };
}

const t0 = performance.now();
for (let i = 1; i <= frames; i++) {
  M._mds_run_frame();
  if (i % 60 === 0) {
    const f = frameHash();
    console.log(`frame ${String(i).padStart(4)}  ${f ? `${f.w}x${f.h} stride=${f.stride}  ${f.hex}` : "(no frame yet)"}`);
  }
}
const secs = (performance.now() - t0) / 1000;
console.log(`frames=${M._mds_get_frame_count()} duplicated=${M._mds_get_duplicated_frames()} fps=${(frames / secs).toFixed(1)} renderer=${threaded} threaded_build=${typeof SharedArrayBuffer !== "undefined"}`);
M._mds_destroy();
process.exit(0);
