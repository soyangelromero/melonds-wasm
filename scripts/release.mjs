#!/usr/bin/env node
// Phase 13: build a ready-to-upload release bundle WITHOUT any dependency: it reuses scripts/package.mjs, writes a ZIP
// (pure Node, deflate), SHA256SUMS, a release metadata JSON and RELEASE_NOTES.md. The upload to GitHub (tag + release)
// still needs the user's account; this only prepares and verifies the artifacts locally.
//
//   node scripts/release.mjs                 # -> release/melonds-wasm-1.0.0(.zip) + SHA256SUMS + notes + json
//   node scripts/release.mjs --out /tmp/rel
//   node scripts/release.mjs --no-zip        # only the directory + notes/sums
//
// It never commits anything: release/ is gitignored and dist/ remains a build artifact.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { deflateRawSync, crc32 } from "node:zlib";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..");
const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const OUT = outIndex > -1 ? resolve(args[outIndex + 1]) : join(root, "release");
const NO_ZIP = args.includes("--no-zip");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = pkg.version;

if (!existsSync(join(root, "dist", "melonds.js")) || !existsSync(join(root, "dist", "melonds.wasm"))) {
  console.error("dist/melonds.{js,wasm} missing: build first (scripts/build.ps1 / build.sh) or restore the release artifacts");
  process.exit(1);
}

const dir = join(OUT, `melonds-wasm-${version}`);
console.log(`release ${version} -> ${dir}`);
rmSync(dir, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const build = spawnSync(process.execPath, [join(root, "scripts", "package.mjs"), "--out", dir], { cwd: root, encoding: "utf8" });
if (build.status !== 0) {
  console.error("package.mjs failed:", build.stderr || build.stdout);
  process.exit(1);
}
process.stdout.write(build.stdout.split("\n").slice(-3).join("\n") + "\n");

function walk(dirPath, base = dirPath, out = []) {
  for (const entry of readdirSync(dirPath, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dirPath, entry.name);
    if (entry.isDirectory()) walk(full, base, out);
    else out.push({ full, rel: relative(base, full).replaceAll("\\", "/") });
  }
  return out;
}
const files = walk(dir);
const totalBytes = files.reduce((sum, f) => sum + statSync(f.full).size, 0);
console.log(`package: ${files.length} files, ${(totalBytes / 1048576).toFixed(2)} MiB`);

/** Minimal ZIP writer (deflate + CRC32), folder prefix so unzip yields melonds-wasm-<version>/. */
function writeZip(zipPath) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const folder = `melonds-wasm-${version}`;
  for (const file of files) {
    const name = Buffer.from(`${folder}/${file.rel}`, "utf8");
    const data = readFileSync(file.full);
    const compressed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0x21, 12); // 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, compressed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4); // version made by
    entry.writeUInt16LE(20, 6); // version needed
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(0, 12);
    entry.writeUInt16LE(0x21, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(compressed.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt16LE(0, 30); // extra
    entry.writeUInt16LE(0, 32); // comment
    entry.writeUInt16LE(0, 34); // disk
    entry.writeUInt16LE(0, 36); // attrs
    entry.writeUInt32LE(0, 38); // external attrs
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += local.length + name.length + compressed.length;
  }
  const centralSize = central.reduce((sum, c) => sum + c.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  writeFileSync(zipPath, Buffer.concat([...chunks, ...central, eocd]));
  return statSync(zipPath).size;
}

let zipPath = null, zipBytes = 0;
if (!NO_ZIP) {
  zipPath = join(OUT, `melonds-wasm-${version}.zip`);
  rmSync(zipPath, { force: true });
  zipBytes = writeZip(zipPath);
  console.log(`zip: ${zipPath} (${(zipBytes / 1048576).toFixed(2)} MiB)`);
}

const sha256 = (file) => {
  const hash = createHash("sha256");
  hash.update(readFileSync(file));
  return hash.digest("hex");
};
const distWasm = join(root, "dist", "melonds.wasm");
const distJs = join(root, "dist", "melonds.js");
const memory = (() => {
  try {
    const result = spawnSync(process.execPath, [join(root, "scripts", "raise-memory-limit.mjs"), "--check"], { encoding: "utf8" });
    return { cap2GiB: result.status === 0, detail: (result.stdout || "").split("\n").filter((l) => /CHECK|max .*pages/.test(l)).join(" · ") };
  } catch { return { cap2GiB: null, detail: "raise-memory-limit --check failed" }; }
})();
const gitHead = (() => {
  try { return spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim(); } catch { return null; }
})();
const metadata = {
  name: pkg.name,
  version,
  builtAt: new Date().toISOString(),
  packageDir: `melonds-wasm-${version}`, // relative: the metadata must not leak the local absolute path if it is published
  files: files.length,
  totalBytes,
  zip: zipPath ? { file: relative(OUT, zipPath), bytes: zipBytes, sha256: sha256(zipPath) } : null,
  dist: { wasm: { bytes: statSync(distWasm).size, sha256: sha256(distWasm) }, js: { bytes: statSync(distJs).size, sha256: sha256(distJs) } },
  wasmMemory: memory,
  gitHead,
  excludes: ["tests/", "third_party/", "build/", "release/", "node_modules/"],
};
writeFileSync(join(OUT, `release-${version}.json`), JSON.stringify(metadata, null, 2) + "\n");
if (zipPath) writeFileSync(join(OUT, "SHA256SUMS"), `${metadata.zip.sha256}  ${relative(OUT, zipPath)}\n`);

const notes = `# melonds-wasm ${version} — release

A port of **melonDS DS v1.4.0** (libretro core) to WebAssembly with a minimal libretro host and a JavaScript library with no
runtime dependencies. **GPL-3.0** license (see \`LICENSE\` and \`THIRD_PARTY.md\` inside the package). It does not include any
ROM, BIOS or firmware: use only your own copies.

## Contents

- \`melonds-wasm-${version}/\` (inside the ZIP): \`index.html\`, \`demo/\` (standalone demo and \`demo/host.html\`), \`js/\`,
  \`adapters/\`, \`dist/melonds.js\` + \`dist/melonds.wasm\`, \`coi-sw.js\`, \`LICENSE\`, \`THIRD_PARTY.md\`, \`CHANGELOG.md\`,
  \`README.md\`, \`manifest.json\`.
- **${files.length} files, ${(totalBytes / 1048576).toFixed(2)} MiB**. The ZIP's SHA-256 is in \`SHA256SUMS\`. The ZIP is not
  bit-reproducible between runs (it carries timestamps and \`builtAt\`): verify it with \`SHA256SUMS\`.

## Quick start

1. Unzip the archive and publish the folder with **any static server** (Node, nginx, Caddy, GitHub Pages…).
2. That host must send \`Cross-Origin-Opener-Policy: same-origin\` and \`Cross-Origin-Embedder-Policy: require-corp\`
   (SharedArrayBuffer). Without those headers, open the demo with **\`?coi=1\`** so \`coi-sw.js\` isolates the page.
3. Open \`/demo/index.html\`, pick your ROM and play. The demo's local multiplayer needs the web app's signaling server
   (see \`deploy/\` in the web app repository).

## Verified in this release

- The full library with the port in Chromium: **NDS 4/4 + GBA 4/4** (the 512 MB game, Pokémon Black 2 ("Negra 2"), needs the
  2 GiB memory cap: this build includes it; with another build, rebuild with \`scripts/build-host.sh\` or apply
  \`scripts/raise-memory-limit.mjs\`).
- **Chromium, Firefox and WebKit** (demo and web app): crossOriginIsolated, SharedArrayBuffer, WebGL2, canvas and saving.
- Remote access over HTTPS with \`ACCESS_KEY\` (Cloudflare quick tunnel) and WebRTC multiplayer.
- Suite: 138 tests (134 pass, 3 skipped, 1 pre-existing flaky one) plus browser tests.

## Known limits

- **Pokémon Black 2 / "Negra 2" (512 MB)**: needs the 2 GiB memory cap (included here). Without it, the web app falls back to
  EmulatorJS.
- **Microphone**, Phase 7 in C++ and a cheap \`retro_reset\`: pending a wasm rebuild.
- **Real Safari** is untested (the WebKit engine is); Playwright's WebKit does not expose \`AudioWorkletNode\`.
- **No emulated Wi-Fi** (Nintendo's servers are shut down) and **no DSi states**.
- Multiplayer without TURN: networks with symmetric NAT may fail to connect.

## How to publish it (done by the maintainer)

1. Create the tag \`v${version}\` and a GitHub release with this ZIP and \`SHA256SUMS\`.
2. **Do not** push \`dist/\` to git (it is already ignored); the binary ships as a release artifact.
3. Check the downloaded hash: \`sha256sum -c SHA256SUMS\`.
`;
writeFileSync(join(OUT, "RELEASE_NOTES.md"), notes);

console.log(`\nrelease ready:
  dir      ${dir}
  notes    ${join(OUT, "RELEASE_NOTES.md")}
  metadata ${join(OUT, `release-${version}.json`)}
${zipPath ? `  zip      ${zipPath}\n  sha256   ${metadata.zip.sha256}\n` : ""}next: upload the ZIP + SHA256SUMS to a GitHub release tagged v${version} (needs your account).`);
