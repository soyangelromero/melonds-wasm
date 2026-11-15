// Phase 8: pure tests for js/cheats.js (no wasm needed) + catalog parsing.
//
//   node --test tests/cheats.test.mjs                        # unit tests + reference/cheats-sample.json
//   CHEATS_DIR=/ruta/a/nds/cheats node --test tests/cheats.test.mjs   # also every *.json catalog in that folder (they must ALL parse)
//   node tests/cheats.test.mjs /ruta/a/nds/cheats            # same, directory as argument
//
// Optional, ephemeral data (never committed, see tests/PHASE8_REPORT.md): if tests/artifacts/libretro-database-src/cht/Nintendo - Nintendo DS
// exists (or CHT_DIR points to a folder of .cht files), every code in it is parsed and a summary is written to
// tests/artifacts/cht-report.json. That one only REPORTS how many parse; real-world files contain junk, so it does not fail on it.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCheat, parseCatalog, toRetroCode, payloadWords, MAX_PAD_WORDS, CheatErrorCode as E, CheatWarningCode as W } from "../js/cheats.js";
import { parseCht } from "./lib/cht.mjs";

const root = fileURLToPath(new URL("..", import.meta.url)); // not .pathname: that gives "/D:/..." on Windows
const argDir = process.argv.slice(2).find((a) => !a.startsWith("-") && existsSync(a) && statSync(a).isDirectory());
const realDir = process.env.CHEATS_DIR || argDir;

test("formato del contrato: palabras separadas por «+»", () => {
  const code = "94000130+FFFB0000+62101F2C+00000000+B2101F2C+00000000+2000E302+00000001+D2000000+00000000"; // ejemplo del contrato §4
  const r = parseCheat(code);
  assert.equal(r.ok, true);
  assert.equal(r.words.length, 10);
  assert.equal(r.code, code);
  assert.deepEqual(r.warnings, []);
});

test("líneas sueltas y pares «XXXXXXXX XXXXXXXX» dan el mismo resultado canónico", () => {
  const plus = "02210000+DEADBEEF+12210100+0000ABCD";
  for (const text of [
    "02210000 DEADBEEF\n12210100 0000ABCD",
    "02210000 DEADBEEF\r\n12210100 0000ABCD\r\n", // el núcleo rechazaría el salto final: la forma canónica no lo lleva
    "02210000\nDEADBEEF\n12210100\n0000ABCD",
    "  02210000   deadbeef  \n\n 12210100\t0000abcd ",
    "02210000-DEADBEEF-12210100-0000ABCD",
  ]) {
    const r = parseCheat(text);
    assert.equal(r.ok, true, text);
    assert.equal(r.code, plus, text);
    assert.deepEqual(r.words, [0x02210000, 0xdeadbeef, 0x12210100, 0xabcd]);
  }
});

test("palabras como uint32 sin signo (>= 0x80000000)", () => {
  assert.deepEqual(parseCheat("FFFFFFFF 80000000").words, [0xffffffff, 0x80000000]);
  assert.equal(toRetroCode([0xffffffff, 1]), "FFFFFFFF+00000001");
});

test("errores: código y línea", () => {
  let r = parseCheat("");
  assert.equal(r.error.code, E.EMPTY);
  r = parseCheat(" \n + \n");
  assert.equal(r.error.code, E.EMPTY);
  r = parseCheat(undefined);
  assert.equal(r.error.code, E.NOT_STRING);

  r = parseCheat("02210000 DEADBEEF\n12210100 0000ABCG");
  assert.equal(r.ok, false);
  assert.equal(r.error.code, E.BAD_TOKEN);
  assert.equal(r.error.line, 2);
  assert.equal(r.error.column, 10);
  assert.equal(r.error.token, "0000ABCG");
  assert.match(r.error.message, /línea 2/);

  r = parseCheat("02210000 DEADBEEF\n\n\n1221010 0000ABCD"); // 7 dígitos
  assert.equal(r.error.code, E.BAD_TOKEN);
  assert.equal(r.error.line, 4);
  assert.match(r.error.message, /7 dígitos/);

  r = parseCheat("0x02210000 DEADBEEF");
  assert.equal(r.error.code, E.BAD_TOKEN);
  assert.match(r.error.message, /0x/);

  r = parseCheat("022100000 DEADBEEF"); // 9 dígitos
  assert.equal(r.error.code, E.BAD_TOKEN);

  r = parseCheat("02210000 DEADBEEF\n12210100");
  assert.equal(r.error.code, E.ODD_WORDS);
  assert.equal(r.error.line, 2);
  assert.equal(r.error.token, "12210100");

  r = parseCheat("master+00000000");
  assert.equal(r.error.code, E.BAD_TOKEN);
});

test("instrucciones E-type: la carga útil se salta y se valida (el motor lee sin comprobar límites)", () => {
  assert.equal(payloadWords(1), 2);
  assert.equal(payloadWords(8), 2);
  assert.equal(payloadWords(9), 4);
  // E2210900 copia 8 bytes => 2 palabras de datos
  assert.equal(parseCheat("E2210900 00000008 11223344 55667788").ok, true);
  // los datos podrían parecer un opcode (0xD2...) y no deben interpretarse
  assert.equal(parseCheat("E2210900 00000008 D2000000 D2000000 02210A00 00000001").ok, true);
  // 9 bytes => 4 palabras
  assert.equal(parseCheat("E2210900 00000009 11223344 55667788 99AABBCC 00000000").ok, true);
  // 16 bytes = 4 palabras de datos pero solo hay 2: faltan 2 (<= MAX_PAD_WORDS) -> se acepta y se rellena con ceros
  let r = parseCheat("02210000 00000001\nE2210900 00000010\n11223344 55667788");
  assert.equal(r.ok, true);
  assert.equal(r.warnings[0].code, W.PAYLOAD_PADDED);
  assert.equal(r.warnings[0].line, 2);
  assert.equal(r.code, "02210000+00000001+E2210900+00000010+11223344+55667788+00000000+00000000");
  assert.equal(parseCheat(r.code).warnings.length, 0, "el resultado ya es completo");
  // faltan más de MAX_PAD_WORDS: error
  assert.equal(MAX_PAD_WORDS, 4);
  r = parseCheat("E2210900 00000020 11223344 55667788"); // 32 bytes = 8 palabras, hay 2
  assert.equal(r.ok, false);
  assert.equal(r.error.code, E.TRUNCATED_PAYLOAD);
  assert.equal(r.error.line, 1);
  // recuento absurdo (como los 3801079812 bytes de un código real mal formado) sin desbordar
  assert.equal(parseCheat("E23FF100 E28FE004 00000000 00000000").error.code, E.TRUNCATED_PAYLOAD);
});

test("avisos por opcodes que el motor no entiende (se aceptan, el motor se detiene ahí)", () => {
  let r = parseCheat("C4000000 00000000");
  assert.equal(r.ok, true);
  assert.equal(r.warnings[0].code, W.UNSUPPORTED_OPCODE);
  r = parseCheat("C1000000 00000000");
  assert.equal(r.warnings[0].code, W.UNKNOWN_OPCODE);
  for (const op of ["00", "2F", "B7", "C0", "C5", "C6", "D0", "D2", "DC", "F0", "FF"]) {
    assert.deepEqual(parseCheat(`${op}000000 00000000`).warnings, [], op);
  }
  for (const op of ["C1", "C7", "CF", "DD", "DF"]) assert.equal(parseCheat(`${op}000000 00000000`).warnings[0].code, W.UNKNOWN_OPCODE, op);
});

test("reference/cheats-sample.json: todos los códigos parsean", () => {
  const catalog = JSON.parse(readFileSync(join(root, "reference/cheats-sample.json"), "utf8"));
  const res = parseCatalog(catalog);
  assert.ok(res.total >= 6, `solo ${res.total} códigos en la muestra`);
  assert.deepEqual(res.failed, []);
  assert.equal(res.ok, res.total);
  // «Evitar la protección antipiratería» (HGSS): carga E-type 2 palabras más corta de lo anunciado -> aviso, no error
  assert.ok(res.warned.some((w) => w.warnings.some((x) => x.code === W.PAYLOAD_PADDED)));
  // el formato canónico es idempotente
  for (const e of res.entries) assert.equal(parseCheat(e.retro).code, e.retro);
  console.log(`# cheats-sample.json: ${res.ok}/${res.total} parsean`);
});

test("catálogos reales (CHEATS_DIR o argumento): todos los códigos parsean", { skip: realDir ? false : "sin CHEATS_DIR ni argumento: se omite (los catálogos reales no están en el repositorio)" }, () => {
  const files = readdirSync(realDir).filter((f) => f.endsWith(".json")).sort();
  assert.ok(files.length > 0, `no hay .json en ${realDir}`);
  const failures = [];
  for (const f of files) {
    const res = parseCatalog(JSON.parse(readFileSync(join(realDir, f), "utf8")));
    console.log(`# ${f}: ${res.ok}/${res.total} parsean, ${res.warned.length} con avisos`);
    for (const x of res.failed) failures.push(`${f} #${x.index} [${x.category}] «${x.name}»: ${x.error.code} ${x.error.message}`);
  }
  assert.deepEqual(failures, [], `${failures.length} códigos no parsean:\n${failures.join("\n")}`);
});

const chtDir = process.env.CHT_DIR || join(root, "tests/artifacts/libretro-database-src/cht/Nintendo - Nintendo DS");
test("libretro-database (.cht, datos efímeros): recuento de los que parsean", { skip: existsSync(chtDir) ? false : "sin datos en tests/artifacts (ver PHASE8_REPORT.md para descargarlos)" }, () => {
  const sum = { dir: chtDir, files: 0, codes: 0, ok: 0, entriesWithoutCode: 0, errors: {}, warnings: {}, examples: {} };
  for (const f of readdirSync(chtDir).filter((x) => x.endsWith(".cht")).sort()) {
    sum.files++;
    for (const e of parseCht(readFileSync(join(chtDir, f), "utf8"))) {
      if (e.code === undefined) { sum.entriesWithoutCode++; continue; }
      sum.codes++;
      const r = parseCheat(e.code);
      if (r.ok) {
        sum.ok++;
        for (const w of r.warnings) sum.warnings[w.code] = (sum.warnings[w.code] ?? 0) + 1;
      } else {
        sum.errors[r.error.code] = (sum.errors[r.error.code] ?? 0) + 1;
        const ex = (sum.examples[r.error.code] ??= []);
        if (ex.length < 5) ex.push({ file: f, cheat: e.index, desc: e.desc, message: r.error.message, code: e.code.slice(0, 100) });
      }
    }
  }
  sum.failed = sum.codes - sum.ok;
  writeFileSync(join(root, "tests/artifacts/cht-report.json"), JSON.stringify(sum, null, 1));
  console.log(`# libretro-database NDS: ${sum.files} archivos, ${sum.codes} códigos, ${sum.ok} parsean, ${sum.failed} no: ${JSON.stringify(sum.errors)}`);
  assert.equal(sum.ok + sum.failed, sum.codes);
  assert.ok(sum.ok / sum.codes > 0.99, "más del 1 % falla: revisar el conversor");
});
