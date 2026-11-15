// Phase 13: builds the static, dependency-free bundle that can be copied to any web server.
//
//   node scripts/package.mjs            -> package/
//   node scripts/package.mjs --out dir  -> custom output directory
//
// The bundle contains only browser-facing files: no tests, no third_party (thousands of files), no build flags.
// Dist is not versioned, so this script fails loudly if the wasm has not been built.
import { cp, mkdir, readdir, rm, stat, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const argIndex = process.argv.indexOf("--out");
const out = resolve(root, argIndex > -1 ? process.argv[argIndex + 1] : "package");

const REQUIRED = ["dist/melonds.js", "dist/melonds.wasm"];
const COPY = [
  ["dist/melonds.js", "dist/melonds.js"],
  ["dist/melonds.wasm", "dist/melonds.wasm"],
  ["js", "js"],
  ["adapters", "adapters"],
  ["demo/index.html", "demo/index.html"],
  ["demo/demo.js", "demo/demo.js"],
  ["demo/host.html", "demo/host.html"],
  ["demo/host.js", "demo/host.js"],
  ["coi-sw.js", "coi-sw.js"],
  ["LICENSE", "LICENSE"],
  ["THIRD_PARTY.md", "THIRD_PARTY.md"],
  ["CHANGELOG.md", "CHANGELOG.md"],
  ["README.md", "README.md"],
  ["package.json", "package.json"],
];

async function walk(dir, base = dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === ".gitkeep" || entry.name === ".DS_Store") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full, base)));
    else out.push({ path: full.slice(base.length + 1), size: (await stat(full)).size });
  }
  return out;
}

const missing = REQUIRED.filter((file) => !existsSync(join(root, file)));
if (missing.length) {
  console.error(`missing build output: ${missing.join(", ")}`);
  console.error("run: MSYS_NO_PATHCONV=1 docker run --rm -v \"$PWD:/src\" -w /src emscripten/emsdk:6.0.13 bash -lc \"bash scripts/build-core.sh && bash scripts/build-host.sh\"");
  process.exit(1);
}

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
for (const [from, to] of COPY) {
  const source = join(root, from);
  if (!existsSync(source)) {
    console.warn(`skip (missing): ${from}`);
    continue;
  }
  await cp(source, join(out, to), { recursive: true });
}

// A tiny entry point so the bundle can be opened at /index.html and links to the demo.
const indexHtml = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><title>melonDS-WASM</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:44rem;margin:3rem auto;padding:0 1rem;background:#0b1020;color:#e8eeff}
a{color:#8fb4ff}code{background:#1b2450;padding:.1rem .35rem;border-radius:.3rem}</style></head>
<body><h1>melonDS DS v1.4.0 en WebAssembly</h1>
<p>Paquete estático listo para copiar a cualquier servidor. Necesita <code>Cross-Origin-Opener-Policy: same-origin</code>
y <code>Cross-Origin-Embedder-Policy: require-corp</code> (las manda <code>scripts/serve.mjs</code>).</p>
<p><a href="demo/index.html">Abrir la demo</a></p>
<p>API: <code>import { MelonDS } from "./js/melonds.js"</code> — ver <code>API_CONTRACT.md</code> y <code>README.md</code>.</p>
</body></html>
`;
await writeFile(join(out, "index.html"), indexHtml);

const files = await walk(out);
const total = files.reduce((sum, file) => sum + file.size, 0);
const manifest = {
  name: "melonds-wasm",
  version: (JSON.parse(await readFile(join(root, "package.json"), "utf8"))).version,
  builtAt: new Date().toISOString(),
  files: files.map((file) => ({ path: file.path, bytes: file.size })),
  totalBytes: total,
};
await writeFile(join(out, "manifest.json"), JSON.stringify(manifest, null, 2));

console.log(`package -> ${out}`);
console.log(`files: ${files.length} · ${(total / 1048576).toFixed(2)} MiB`);
for (const file of files.sort((a, b) => b.size - a.size).slice(0, 6)) console.log(`  ${(file.size / 1024).toFixed(0).padStart(6)} KiB  ${file.path}`);
