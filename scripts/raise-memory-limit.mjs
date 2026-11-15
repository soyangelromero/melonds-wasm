#!/usr/bin/env node
// TEMPORARY WORKAROUND (until the wasm is rebuilt with -sMAXIMUM_MEMORY=2147483648, which scripts/build-host.sh already
// requests): raise the memory cap of an EXISTING build by patching the generated artifacts, without recompiling.
//
// The wasm module imports its memory (env.memory, shared, min 4096 pages, max 16384 pages = 1 GiB) and the Emscripten
// glue creates it plus defines getHeapMax() = 1 GiB. Three values control the cap:
//   1. dist/melonds.wasm  -> the imported memory's max (LEB128 16384 -> 32768 pages)
//   2. dist/melonds.js    -> `maximum:16384`
//   3. dist/melonds.js    -> `getHeapMax=()=>1073741824`
// Patching those three (same byte length for the LEB) makes the same C++/wasm run with up to 2 GiB, which is enough for
// the 512 MB ROM (measured heap after load: ~1636 MiB, see tests/artifacts/probe-2g-load.log).
//
//   node scripts/raise-memory-limit.mjs            # patch dist/ in place (keeps .bak backups, validates the wasm)
//   node scripts/raise-memory-limit.mjs --check    # only report the current cap (exit 0 = 2 GiB or more)
//   node scripts/raise-memory-limit.mjs --restore  # restore the .bak backups (back to the unpatched build)
//   node scripts/raise-memory-limit.mjs --out DIR  # patch a copy in DIR (default dist/)
//
// A rebuild with the current build-host.sh produces 2 GiB directly and this script becomes a no-op (it detects the
// current cap). It only touches generated files under dist/, never source.
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const restore = args.includes("--restore");
const outIndex = args.indexOf("--out");
const dir = outIndex > -1 ? resolve(args[outIndex + 1]) : join(root, "dist");
const wasmPath = join(dir, "melonds.wasm");
const jsPath = join(dir, "melonds.js");
const WASM_BAK = wasmPath + ".1gib.bak";
const JS_BAK = jsPath + ".1gib.bak";
const ONE_GIB_PAGES = 16384;
const TWO_GIB_PAGES = 32768;

if (restore) {
  let restored = 0;
  for (const [bak, target] of [[WASM_BAK, wasmPath], [JS_BAK, jsPath]]) {
    if (existsSync(bak)) { copyFileSync(bak, target); restored++; console.log("restored", target); }
  }
  console.log(restored ? `done (${restored} file(s) restored)` : "no .1gib.bak backups found; nothing to restore");
  process.exit(0);
}

if (!existsSync(wasmPath) || !existsSync(jsPath)) {
  console.error(`missing ${wasmPath} or ${jsPath}: build first (scripts/build.ps1 / build.sh)`);
  process.exit(1);
}

/** Reads the imported memory type from the wasm binary and returns { min, max, maxAt }. */
function readMemoryImport(bytes) {
  let o = 8;
  const uleb = () => { let r = 0, s = 0; for (;;) { const x = bytes[o++]; r |= (x & 0x7f) << s; if (!(x & 0x80)) return r >>> 0; s += 7; } };
  while (o < bytes.length) {
    const id = bytes[o++];
    const size = uleb();
    const payload = o;
    const end = payload + size;
    if (id === 2) {
      let p = payload;
      const rd = () => { let r = 0, s = 0; for (;;) { const x = bytes[p++]; r |= (x & 0x7f) << s; if (!(x & 0x80)) return r >>> 0; s += 7; } };
      const count = rd();
      for (let i = 0; i < count; i++) {
        p += 1 + bytes[p]; // module name
        p += 1 + bytes[p]; // field name
        const kind = bytes[p++];
        if (kind === 0x02) {
          const flags = bytes[p++];
          const min = rd();
          if (!(flags & 0x01)) return { min, max: null, maxAt: -1 };
          const maxAt = p;
          const max = rd();
          return { min, max, maxAt };
        }
        if (kind === 0x00) rd();
        else if (kind === 0x01) p += 1 + 0; // vtable: elem type + limits; not produced by Emscripten here
        else if (kind === 0x03) p += 2;
        else throw new Error(`unexpected import kind ${kind} in the wasm import section`);
      }
    }
    o = end;
  }
  throw new Error("no memory import found in the wasm binary");
}

const wasm = readFileSync(wasmPath);
const memory = readMemoryImport(wasm);
const js = readFileSync(jsPath, "utf8");
const glueMax = js.includes("maximum:" + ONE_GIB_PAGES) ? ONE_GIB_PAGES : js.includes("maximum:" + TWO_GIB_PAGES) ? TWO_GIB_PAGES : null;
const heapMax = js.includes("getHeapMax=()=>1073741824") ? 1073741824 : js.includes("getHeapMax=()=>2147483648") ? 2147483648 : null;
const currentGiB = memory.max ? (memory.max * 65536) / 1073741824 : 0;
console.log(`dist: ${dir}`);
console.log(`wasm imported memory: min ${memory.min} pages (${(memory.min * 65536) / 1048576} MiB), max ${memory.max} pages (${currentGiB} GiB)`);
console.log(`glue: maximum:${glueMax ?? "?"}, getHeapMax=${heapMax ?? "?"}`);

if (memory.max == null) { console.error("the memory import has no max; not supported by this workaround"); process.exit(1); }

if (checkOnly) {
  const ok = currentGiB >= 2 && heapMax === 2147483648 && glueMax === TWO_GIB_PAGES;
  console.log(ok ? "CHECK: cap is 2 GiB (patched or rebuilt with the 2 GiB flags)" : `CHECK: cap is ${currentGiB} GiB — run without --check to patch`);
  process.exit(ok ? 0 : 1);
}

if (currentGiB >= 2 && heapMax === 2147483648 && glueMax === TWO_GIB_PAGES) {
  console.log("already 2 GiB; nothing to do");
  process.exit(0);
}
if (currentGiB !== 1) {
  console.error(`this build has an unexpected cap (${currentGiB} GiB); expected 1 GiB from the 2026-11-04 build. Refusing to patch blindly.`);
  process.exit(1);
}

// 1. wasm: the LEB128 of 16384 and 32768 both take 3 bytes (0x80 0x80 0x01 vs 0x80 0x80 0x02), so the binary length and
// every other offset stay identical.
const patchedWasm = Buffer.from(wasm);
patchedWasm.set([0x80, 0x80, 0x02], memory.maxAt);
writeFileSync(WASM_BAK, wasm);
writeFileSync(wasmPath, patchedWasm);
if (!WebAssembly.validate(patchedWasm)) {
  copyFileSync(WASM_BAK, wasmPath);
  console.error("patched wasm does not validate; restored the original");
  process.exit(1);
}

// 2. glue: the WebAssembly.Memory maximum and the heap-growth limit.
let patchedJs = js
  .replaceAll("maximum:" + ONE_GIB_PAGES, "maximum:" + TWO_GIB_PAGES)
  .replaceAll("getHeapMax=()=>1073741824", "getHeapMax=()=>2147483648");
writeFileSync(JS_BAK, js);
writeFileSync(jsPath, patchedJs);

console.log(`patched ${wasmPath} and ${jsPath} (backups: *.1gib.bak) · wasm validates: ${WebAssembly.validate(patchedWasm)}`);
console.log(`new cap: ${(TWO_GIB_PAGES * 65536) / 1073741824} GiB · run \`node tests/library-browser.mjs\` to verify the whole library (Negra 2 needs ~1.7 GiB of heap)`);
console.log("TEMPORARY: re-run scripts/build.ps1/build.sh (which already requests 2 GiB) when Docker/emsdk is available, or use --restore");
