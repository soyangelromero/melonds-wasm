// Regression test for the temporary 2 GiB artifact workaround (scripts/raise-memory-limit.mjs). It never touches the real
// dist: it copies the generated artifacts to a temp dir and exercises --out/--check/--restore/--patch there, so a future
// rebuild (which already asks for 2 GiB) keeps working and the patcher cannot silently corrupt anything.
//
// The repo's dist/ may already be patched to 2 GiB (see scripts/raise-memory-limit.mjs): in that case the original 1 GiB
// artifacts are in dist/*.1gib.bak and the test patches a copy made from those backups.
//
//   node --test --test-force-exit tests/memory-limit.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "dist");
const DIST = root;
const SCRIPT = join(resolve(here, ".."), "scripts", "raise-memory-limit.mjs");
const distWasm = join(DIST, "melonds.wasm");
const distJs = join(DIST, "melonds.js");
const bakWasm = distWasm + ".1gib.bak";
const bakJs = distJs + ".1gib.bak";
const haveDist = existsSync(distWasm) && existsSync(distJs);
const currentIs2GiB = haveDist && readFileSync(distJs, "utf8").includes("maximum:32768");
const haveBaks = existsSync(bakWasm) && existsSync(bakJs);
const skip = !haveDist
  ? "dist/melonds.{js,wasm} missing (build first)"
  : currentIs2GiB && !haveBaks
    ? "the build is already 2 GiB and there are no .1gib.bak originals to exercise the patcher on"
    : false;

/** Reads the max pages of the imported memory in a wasm binary. */
function memoryMax(bytes) {
  let o = 8;
  const rd = (buf, pos) => { let r = 0, s = 0; for (;;) { const x = buf[pos.i++]; r |= (x & 0x7f) << s; if (!(x & 0x80)) return r >>> 0; s += 7; } };
  while (o < bytes.length) {
    const id = bytes[o++];
    const state = { i: o };
    const size = rd(bytes, state);
    const payload = state.i;
    const end = payload + size;
    if (id === 2) {
      const p = { i: payload };
      const count = rd(bytes, p);
      for (let i = 0; i < count; i++) {
        p.i += 1 + bytes[p.i];
        p.i += 1 + bytes[p.i];
        const kind = bytes[p.i++];
        if (kind === 0x02) {
          const flags = bytes[p.i++];
          rd(bytes, p);
          if (!(flags & 0x01)) return null;
          return rd(bytes, p);
        }
        if (kind === 0x00) rd(bytes, p);
      }
    }
    o = end;
  }
  return null;
}
const cap = (bin) => (memoryMax(bin) * 65536) / 1073741824;
const run = (dir, extra = []) => spawnSync(process.execPath, [SCRIPT, "--out", dir, ...extra], { encoding: "utf8" });

test("raise-memory-limit patches and restores a COPY of the build (never the real dist)", { skip }, () => {
  // Source for the 1 GiB copy: the .1gib.bak originals when the live dist is already patched, otherwise the dist itself.
  const sourceWasm = currentIs2GiB ? bakWasm : distWasm;
  const sourceJs = currentIs2GiB ? bakJs : distJs;
  const dir = mkdtempSync(join(tmpdir(), "mds-memlimit-"));
  const dir2 = mkdtempSync(join(tmpdir(), "mds-memlimit-nop-"));
  try {
    copyFileSync(sourceWasm, join(dir, "melonds.wasm"));
    copyFileSync(sourceJs, join(dir, "melonds.js"));
    const originalWasm = readFileSync(join(dir, "melonds.wasm"));
    const originalJs = readFileSync(join(dir, "melonds.js"), "utf8");
    assert.ok(cap(originalWasm) < 1.1, `the backup copy should be the 1 GiB build (got ${cap(originalWasm)} GiB)`);

    // 1 GiB copy -> patched to 2 GiB, validated, reportable.
    const patch = run(dir);
    assert.equal(patch.status, 0, patch.stderr || patch.stdout);
    const patchedWasm = readFileSync(join(dir, "melonds.wasm"));
    const patchedJs = readFileSync(join(dir, "melonds.js"), "utf8");
    assert.equal(patchedWasm.length, originalWasm.length, "the wasm patch must not change the file length");
    assert.ok(cap(patchedWasm) >= 2, `patched cap ${cap(patchedWasm)} GiB`);
    assert.match(patchedJs, /maximum:32768/);
    assert.match(patchedJs, /getHeapMax=\(\)=>2147483648/);
    assert.ok(existsSync(join(dir, "melonds.wasm.1gib.bak")), "backup created");

    const check = run(dir, ["--check"]);
    assert.equal(check.status, 0, check.stdout + check.stderr);
    assert.match(check.stdout, /2 GiB/);

    // Second patch is a no-op (idempotent) and does not change the patched artifacts.
    const again = run(dir);
    assert.equal(again.status, 0, again.stderr || again.stdout);
    assert.deepEqual(readFileSync(join(dir, "melonds.wasm")), patchedWasm, "idempotent wasm");
    assert.equal(readFileSync(join(dir, "melonds.js"), "utf8"), patchedJs, "idempotent glue");

    // Restore brings back the exact original bytes and --check reports 1 GiB.
    const restore = run(dir, ["--restore"]);
    assert.equal(restore.status, 0, restore.stderr || restore.stdout);
    assert.deepEqual(readFileSync(join(dir, "melonds.wasm")), originalWasm, "restored wasm");
    assert.equal(readFileSync(join(dir, "melonds.js"), "utf8"), originalJs, "restored glue");
    const back = run(dir, ["--check"]);
    assert.notEqual(back.status, 0, "an unpatched build must not report 2 GiB");
    assert.match(back.stdout, /1 GiB/);

    // An unexpected cap (e.g. a future 3 GiB build) is refused instead of blindly patched.
    const weird = Buffer.from(originalWasm);
    for (let i = 0; i + 2 < weird.length; i++) {
      if (weird[i] === 0x80 && weird[i + 1] === 0x80 && weird[i + 2] === 0x01) { weird[i + 2] = 0x03; break; } // 49152 pages
    }
    writeFileSync(join(dir, "melonds.wasm"), weird);
    const refuse = run(dir);
    assert.notEqual(refuse.status, 0, "must refuse an unexpected cap");
    assert.match(refuse.stderr + refuse.stdout, /unexpected cap/i);

    // The live (already 2 GiB) build: a copy must be left untouched and the script reports it as already patched.
    if (currentIs2GiB) {
      for (const file of ["melonds.js", "melonds.wasm"]) copyFileSync(join(DIST, file), join(dir2, file));
      const noop = run(dir2);
      assert.equal(noop.status, 0, noop.stderr || noop.stdout);
      assert.match(noop.stdout, /already 2 GiB/i);
      assert.deepEqual(readFileSync(join(dir2, "melonds.wasm")), readFileSync(distWasm), "no-op must not rewrite the wasm");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(dir2, { recursive: true, force: true });
  }
});
