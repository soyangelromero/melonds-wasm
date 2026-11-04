// Phase 2 smoke test (no ROM needed): dist/melonds.js loads, mds_create works, mds_load_rom fails cleanly on garbage.
// Usage: node tests/phase2-smoke.mjs
import assert from "node:assert/strict";

const { default: createModule } = await import(new URL("../dist/melonds.js", import.meta.url));
const M = await createModule();

for (const fn of ["_mds_create", "_mds_destroy", "_mds_set_option", "_mds_write_system_file", "_mds_load_rom",
  "_mds_run_frame", "_mds_get_frame", "_mds_get_frame_count", "_mds_get_duplicated_frames"]) {
  assert.equal(typeof M[fn], "function", `${fn} is not exported`);
}

assert.equal(M._mds_create(0), 0, "mds_create");
assert.equal(M._mds_create(0), -1, "second mds_create must be rejected");

// 1) Garbage data (4 KiB of 0xAA) must be rejected, not hang or abort.
const bad = new Uint8Array(4096).fill(0xaa);
const ptr = M._malloc(bad.length);
M.HEAPU8.set(bad, ptr);
const rc = M._mds_load_rom(ptr, bad.length, 0, 0);
assert.notEqual(rc, 0, "garbage ROM must not load");
console.log(`load_rom(garbage 4 KiB) -> ${rc} (expected non-zero)`);

// 2) Empty data.
const rc2 = M._mds_load_rom(ptr, 0, 0, 0);
assert.notEqual(rc2, 0, "empty ROM must not load");
console.log(`load_rom(empty) -> ${rc2} (expected non-zero)`);

// 3) After a failed load: no frame, run_frame is a no-op, process still alive.
M._mds_run_frame();
assert.equal(M._mds_get_frame_count(), 0n, "no frames counted after failed load");
assert.equal(M._mds_get_frame(M._malloc(4), M._malloc(4), M._malloc(4)), 0, "no frame before a successful load");

M._mds_destroy();
console.log("phase2-smoke: OK");
process.exit(0);
