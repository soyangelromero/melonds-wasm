// Phase 4, core level (Node, no browser): mds_get_audio against the real core.
// Usage: node tests/phase4-core-audio.mjs [tests/artifacts/audio-tone.nds]
// Checks the announced rate (32728.498, not 32768), samples per frame, counters, that the tone ROM produces non-silent PCM
// at the expected pitch, and the host ring's overrun/underrun accounting.
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { goertzel } from "./audio-util.mjs";

const romPath = process.argv[2] ?? fileURLToPath(new URL("./artifacts/audio-tone.nds", import.meta.url));
if (!existsSync(romPath)) { console.log(`SKIP: ${romPath} missing (python3 tests/homebrew/audio-tone/mkrom.py tests/artifacts/audio-tone.nds)`); process.exit(0); }

const { default: createModule } = await import(new URL("../dist/melonds.js", import.meta.url));
const M = await createModule();
assert.equal(typeof M._mds_get_audio, "function", "mds_get_audio not exported: rebuild the host");
assert.equal(M._mds_create(0), 0);
M._mds_set_option(...["melonds_threaded_renderer", "disabled"].map((s) => { const b = Buffer.from(s + "\0"); const p = M._malloc(b.length); M.HEAPU8.set(b, p); return p; }));
const rom = readFileSync(romPath);
const rp = M._malloc(rom.length); M.HEAPU8.set(rom, rp);
assert.equal(M._mds_load_rom(rp, rom.length, 0, 0), 0, "ROM must load");

const rate = M._mds_get_sample_rate(), fps = M._mds_get_fps();
console.log(`announced: ${rate} Hz, ${fps} fps -> ${(rate / fps).toFixed(3)} audio frames per video frame`);
assert.ok(Math.abs(rate - 33513982 / 1024) < 1e-6, "rate must be 33513982/1024");

const MAXF = 2048, buf = M._malloc(MAXF * 4);
const pcm = [];
let perFrame = [];
for (let i = 0; i < 360; i++) { // 6 s of emulated time
  M._mds_run_frame();
  const n = M._mds_get_audio(buf, MAXF);
  perFrame.push(n);
  pcm.push(new Int16Array(M.HEAP16.buffer.slice(buf, buf + n * 4)));
}
const total = pcm.reduce((a, b) => a + b.length / 2, 0);
const L = new Float64Array(total), R = new Float64Array(total);
let o = 0; for (const c of pcm) for (let i = 0; i < c.length; i += 2) { L[o] = c[i] / 32768; R[o] = c[i + 1] / 32768; o++; }

const stats = { min: Math.min(...perFrame), max: Math.max(...perFrame), mean: total / perFrame.length };
console.log(`frames per run: min ${stats.min} max ${stats.max} mean ${stats.mean.toFixed(3)} (expected ~${(rate / fps).toFixed(3)})`);
assert.ok(Math.abs(stats.mean - rate / fps) < 0.5, "mean frames/run must match rate/fps");
assert.equal(M._mds_get_audio_frames_total(), BigInt(total));
assert.equal(M._mds_get_audio_overruns(), 0n);
console.log(`counters: batches=${M._mds_get_audio_batches()} singles=${M._mds_get_audio_singles()} total=${M._mds_get_audio_frames_total()}`);
assert.equal(M._mds_get_audio_singles(), 0n, "core must not use the per-sample callback");

// Skip the first 0.5 s (the ARM7 needs a moment to program the SPU) and measure RMS / peak / pitch.
const skip = Math.floor(rate * 0.5);
let sumsq = 0, peak = 0; for (let i = skip; i < total; i++) { sumsq += L[i] * L[i]; peak = Math.max(peak, Math.abs(L[i])); }
const rms = Math.sqrt(sumsq / (total - skip));
console.log(`RMS ${rms.toFixed(4)} peak ${peak.toFixed(4)}`);
assert.ok(rms > 0.05, "tone ROM must produce a non-silent signal");
const seg = L.subarray(skip, skip + 32768);
let best = { f: 0, p: 0 };
for (let f = 400; f <= 480; f += 0.25) { const p = goertzel(seg, f, rate); if (p > best.p) best = { f, p }; }
console.log(`dominant frequency ~${best.f} Hz (ROM programs 440.04 Hz)`);
assert.ok(Math.abs(best.f - 440.04) < 1, "pitch must match the ROM's timer setting");
assert.ok(Math.abs(L.subarray(skip).reduce((a, v, i) => a + Math.abs(v - R[skip + i]), 0)) < 1e-6 * total, "pan centre => L == R");

// Host ring accounting: do not drain for 40 frames (~21900 frames > 8192 capacity) -> overruns, newest dropped.
const before = M._mds_get_audio_overruns();
for (let i = 0; i < 40; i++) M._mds_run_frame();
const avail = M._mds_get_audio_available(), over = M._mds_get_audio_overruns() - before;
console.log(`undrained 40 frames: available ${avail}, overrun frames ${over}`);
assert.equal(avail, 8192); assert.ok(over > 0n);
assert.equal(BigInt(avail) + over + 0n, BigInt(M._mds_get_audio_frames_total()) - BigInt(total) - 0n + 0n);
// Underrun accounting: ask for more than there is.
M._mds_flush_audio(); const u0 = M._mds_get_audio_underruns();
assert.equal(M._mds_get_audio(buf, 100), 0); assert.equal(M._mds_get_audio_underruns(), u0 + 1n);
M._mds_destroy();
console.log("phase4-core-audio: OK");
process.exit(0);
