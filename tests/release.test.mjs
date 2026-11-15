// Release-bundle regression test (Phase 13): scripts/release.mjs must produce a ZIP with the whole static package, a
// SHA256SUMS that matches it, a metadata JSON and release notes. It builds into a temp dir and never touches dist/release/.
//
//   node --test --test-force-exit tests/release.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const skip = !existsSync(join(root, "dist", "melonds.js")) ? "dist/melonds.js missing (build first)" : false;

/** Reads the central directory of a ZIP and returns the entry names + count. */
function zipEntries(bytes) {
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) if (bytes.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("no EOCD in zip");
  const count = bytes.readUInt16LE(eocd + 10);
  let offset = bytes.readUInt32LE(eocd + 16);
  const names = [];
  for (let i = 0; i < count; i++) {
    if (bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error(`bad central entry ${i}`);
    const nameLen = bytes.readUInt16LE(offset + 28);
    const extraLen = bytes.readUInt16LE(offset + 30);
    const commentLen = bytes.readUInt16LE(offset + 32);
    names.push(bytes.subarray(offset + 46, offset + 46 + nameLen).toString("utf8"));
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

test("scripts/release.mjs builds a complete, verifiable release bundle", { skip }, () => {
  const out = mkdtempSync(join(tmpdir(), "mds-release-"));
  try {
    const run = spawnSync(process.execPath, [join(root, "scripts", "release.mjs"), "--out", out], { cwd: root, encoding: "utf8", timeout: 180000 });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const version = pkg.version;
    const dir = join(out, `melonds-wasm-${version}`);
    for (const file of ["index.html", "manifest.json", "LICENSE", "THIRD_PARTY.md", "CHANGELOG.md", "demo/index.html", "demo/host.html", "js/melonds.js", "adapters/webapp-adapter.js", "dist/melonds.js", "dist/melonds.wasm", "coi-sw.js"]) {
      assert.ok(existsSync(join(dir, file)), `release dir missing ${file}`);
    }
    const packageFiles = readdirSync(dir, { recursive: true }).filter((f) => statSync(join(dir, f)).isFile());

    // ZIP: all package files, prefixed with the version folder, no extras.
    const zipPath = join(out, `melonds-wasm-${version}.zip`);
    assert.ok(existsSync(zipPath), "zip missing");
    const zipBytes = readFileSync(zipPath);
    const entries = zipEntries(zipBytes);
    assert.equal(entries.length, packageFiles.length, `zip entries ${entries.length} vs package files ${packageFiles.length}`);
    assert.ok(entries.every((n) => n.startsWith(`melonds-wasm-${version}/`)), "entries must be under the version folder");
    for (const file of ["LICENSE", "dist/melonds.wasm", "demo/host.html", "coi-sw.js"]) {
      assert.ok(entries.includes(`melonds-wasm-${version}/${file}`), `zip missing ${file}`);
    }

    // SHA256SUMS must match the ZIP.
    const sums = readFileSync(join(out, "SHA256SUMS"), "utf8").trim();
    const sha = createHash("sha256").update(zipBytes).digest("hex");
    assert.equal(sums, `${sha}  melonds-wasm-${version}.zip`);

    // Metadata must describe the same artifacts and the current dist.
    const meta = JSON.parse(readFileSync(join(out, `release-${version}.json`), "utf8"));
    assert.equal(meta.version, version);
    assert.equal(meta.files, packageFiles.length);
    assert.equal(meta.zip.sha256, sha);
    assert.equal(meta.packageDir, `melonds-wasm-${version}`, "metadata must use a relative packageDir");
    assert.ok(!JSON.stringify(meta).includes(root.replaceAll("\\", "\\\\")), "metadata must not leak the local absolute path");
    assert.ok(meta.totalBytes > 0);
    const distWasm = createHash("sha256").update(readFileSync(join(root, "dist", "melonds.wasm"))).digest("hex");
    assert.equal(meta.dist.wasm.sha256, distWasm, "metadata must hash the current dist");
    assert.equal(typeof meta.wasmMemory.cap2GiB, "boolean");
    assert.match(meta.gitHead ?? "", /^[0-9a-f]{7,40}$/);

    // Release notes are valid UTF-8 text with the essentials (no mojibake replacement chars).
    const notes = readFileSync(join(out, "RELEASE_NOTES.md"), "utf8");
    assert.ok(!notes.includes("\uFFFD"), "release notes contain replacement characters");
    for (const needle of [`melonds-wasm ${version}`, "GPL-3.0", "Negra 2", "SHA256SUMS", "?coi=1"]) {
      assert.ok(notes.includes(needle), `notes missing "${needle}"`);
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
