// Repository hygiene check (Phase 13): fail if the repository would ship Nintendo binaries, secrets or author-machine
// paths. Intended for CI or a local hook:
//
//   node scripts/check-clean.mjs            # errors fail, warnings are printed
//   node scripts/check-clean.mjs --strict   # warnings also fail (release gate)
//
// What is an ERROR: ROM/BIOS/firmware/save extensions anywhere outside the ignored/generated directories, private keys,
// hard-coded credentials, and the author's home directory (`C:\Users\...`).
// What is a WARNING: other absolute Windows paths. Some test commands document the local ROM library (for example
// `roms/nds` in tests/bench-browser.mjs) and are not needed to build or serve the package; `--strict` lists them.
import { readdir, stat, readFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STRICT = process.argv.includes("--strict");

// Generated/ignored trees: never part of the published source.
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "build",
  "dist",
  "package",
  "release",
  "third_party",
  "tests/artifacts",
  ".playwright-mcp",
  ".superpowers",
]);

// Nintendo telemetry: these extensions must never be tracked or left unignored.
const FORBIDDEN_EXT = new Map([
  [".nds", "ROM de Nintendo DS"],
  [".dsi", "ROM de DSi"],
  [".srl", "ROM de Nintendo DS"],
  [".gba", "ROM de Game Boy Advance"],
  [".sav", "partida guardada"],
  [".bin", "posible BIOS/firmware"],
  [".rom", "posible BIOS/firmware"],
  [".firmware", "firmware"],
  [".fw", "firmware"],
  [".cia", "contenido de Nintendo 3DS"],
]);

const TEXT_EXT = new Set([
  ".md", ".txt", ".js", ".mjs", ".json", ".html", ".css", ".sh", ".ps1", ".yml", ".yaml", ".c", ".cpp", ".h",
  ".hpp", ".ini", ".toml", ".patch", ".gitignore", ".gitmodules", ".example", "",
]);

const SECRET_PATTERNS = [
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, "clave privada"],
  [/C:\\Users\\[^\\\s]+/i, "ruta del perfil del autor (C:\\Users\\...)"],
  [/(?:api[_-]?key|secret|access[_-]?token|password)\s*[:=]\s*["'][^"'\s]{10,}["']/i, "credencial hardcodeada"],
];
const ABSOLUTE_PATH = /\b[A-Za-z]:[\\/][^\s"'`)]*/;

const errors = [];
const warnings = [];
let scanned = 0;

function walk(dir, out = []) {
  return readdir(dir, { withFileTypes: true }).then(async (entries) => {
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const rel = relative(ROOT, full).replaceAll("\\", "/");
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(rel) || [...SKIP_DIRS].some((d) => rel === d || rel.startsWith(d + "/"))) continue;
        if (entry.name === ".git") continue;
        await walk(full, out);
      } else if (entry.isFile()) {
        out.push(rel);
      }
    }
    return out;
  });
}

const files = await walk(ROOT);
for (const rel of files) {
  scanned++;
  // This script contains the patterns themselves (e.g. the author-home regex): never scan it.
  if (rel === "scripts/check-clean.mjs") continue;
  const ext = extname(rel).toLowerCase();
  if (FORBIDDEN_EXT.has(ext)) {
    errors.push(`${rel}: ${FORBIDDEN_EXT.get(ext)} (contenido de Nintendo o partida: no debe estar en el repo)`);
    continue;
  }
  if (!TEXT_EXT.has(ext)) continue;
  const full = join(ROOT, rel);
  const info = await stat(full);
  if (info.size > 2 * 1024 * 1024) continue; // generated/large: not source
  let text;
  try {
    text = await readFile(full, "utf8");
  } catch {
    continue;
  }
  for (const [pattern, why] of SECRET_PATTERNS) {
    const m = pattern.exec(text);
    if (m) errors.push(`${rel}: ${why} (${m[0].slice(0, 80)})`);
  }
  const abs = ABSOLUTE_PATH.exec(text);
  if (abs) warnings.push(`${rel}: ruta absoluta "${abs[0]}"`);
}

const report = (list, label) => {
  if (!list.length) return;
  console.log(`\n${label} (${list.length}):`);
  for (const line of list) console.log(`  - ${line}`);
};
report(errors, "ERRORES");
if (warnings.length) {
  report(warnings, STRICT ? "RUTAS ABSOLUTAS (--strict: también fallan)" : "avisos: rutas absolutas (no bloquean)");
}
console.log(`\ncheck-clean: ${scanned} archivos revisados · ${errors.length} errores · ${warnings.length} avisos`);
if (errors.length || (STRICT && warnings.length)) {
  console.log("RESULTADO: FALLA");
  process.exit(1);
}
console.log("RESULTADO: OK (sin ROM/BIOS/firmware/partidas ni credenciales)");
