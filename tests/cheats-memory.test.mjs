// Phase 8: cheats against the REAL core (dist/melonds.js) with the CC0 homebrew nmap.nds, reading DS main RAM before/after.
//
//   bash scripts/build-core.sh && bash scripts/build-host.sh      # dist/melonds.{js,wasm}
//   node --test tests/cheats-memory.test.mjs                      # ROM: tests/artifacts/nmap.nds (or ROM=/ruta/juego.nds)
//
// Skipped (not failed) when dist/ or the ROM is missing. Every test works on its own addresses inside 0x02200000..0x0223FFFF,
// a region nmap.nds never touches (measured in tests/PHASE8_REPORT.md), because disabling a cheat does not undo what it wrote.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { bootCore, haveCore } from "./lib/core-harness.mjs";
import { parseCheat, parseCatalog, CheatErrorCode as E } from "../js/cheats.js";
import { parseCht } from "./lib/cht.mjs";
import { setCheat, clearCheats, cheatHandlers } from "../js/cheats-worker.js";

const root = fileURLToPath(new URL("..", import.meta.url)); // not .pathname: that gives "/D:/..." (URI-encoded) on Windows
const romPath = process.env.ROM || join(root, "tests/artifacts/nmap.nds");
const skip = !haveCore ? "falta dist/melonds.js (compila con scripts/build-core.sh y scripts/build-host.sh)" : !existsSync(romPath) ? `falta la ROM ${romPath}` : false;

let preLoad = null;
let c = null;
if (!skip) {
  c = await bootCore(romPath, {
    beforeLoad: (M) => {
      // Before mds_load_rom there is no console: the core would silently ignore the cheat, so the glue must refuse it
      // (and must not consume a slot).
      const t = Buffer.from("02200000+DEADBEEF"), p = M._malloc(t.length);
      M.HEAPU8.set(t, p);
      preLoad = { set: M._mds_cheat_set(1, 1, p, t.length), count: M._mds_cheat_count(), ram: M._mds_ram_data(), ramSize: Number(M._mds_ram_size()) };
      M._mds_cheat_clear(); // must be harmless
      M._free(p);
    },
  });
  c.frames(60); // let the homebrew settle
}
after(() => { if (c) { try { c.destroy(); } catch {} } setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref(); });

const T = (name, fn) => test(name, { skip }, fn);
// Runs frames until `pred()` is true (max `max`); returns the frames used, or -1.
const until = (pred, max = 5) => { for (let i = 1; i <= max; i++) { c.frames(1); if (pred()) return i; } return -1; };

T("sin juego cargado: mds_cheat_set devuelve -1, no consume ranura y mds_cheat_clear es inofensivo", () => {
  assert.equal(preLoad.set, -1);
  assert.equal(preLoad.count, 0);
  assert.equal(preLoad.ram, 0);
  assert.equal(preLoad.ramSize, 0);
});

T("RAM principal accesible: retro_get_memory_data(SYSTEM_RAM) = 4 MiB (sin mds_peek ni parches)", () => {
  assert.equal(Number(c.M._mds_ram_size()), 4 * 1024 * 1024);
  assert.notEqual(c.M._mds_ram_data(), 0);
  assert.equal(c.r32(0x02200000), 0, "la dirección de prueba debería estar a cero en nmap.nds");
});

T("efecto: un código AR fija un valor en RAM; se reaplica cada fotograma; desactivar NO lo revierte", () => {
  const A = 0x02200000, code = "02200000+DEADBEEF";
  assert.equal(c.r32(A), 0);
  c.frames(10);
  assert.equal(c.r32(A), 0, "sin truco no cambia");

  assert.equal(c.cheat(1, true, code), 0);
  const used = until(() => c.r32(A) === 0xdeadbeef);
  assert.ok(used > 0, "el código no tuvo efecto en 5 fotogramas");
  console.log(`# valor aplicado tras ${used} fotograma(s) desde que se activa`);
  assert.equal(c.r32(A), 0xdeadbeef);

  // se reaplica: lo borramos a mano y vuelve
  c.w32(A, 0);
  assert.ok(until(() => c.r32(A) === 0xdeadbeef, 3) > 0, "no se reaplicó");

  // desactivar (sin reenviar el texto: se reutiliza el guardado): el valor se queda (no se revierte) ...
  assert.equal(c.cheat(1, false, ""), 0);
  assert.equal(c.enabled(1), 0);
  c.frames(5);
  assert.equal(c.r32(A), 0xdeadbeef, "desactivar no debe revertir (ver DEVIATIONS.md)");
  // ... y el motor deja de escribir
  c.w32(A, 0xfeedf00d);
  c.frames(10);
  assert.equal(c.r32(A), 0xfeedf00d, "el código desactivado siguió escribiendo");

  // reactivar con el texto guardado
  assert.equal(c.cheat(1, true, ""), 0);
  assert.equal(c.enabled(1), 1);
  assert.ok(until(() => c.r32(A) === 0xdeadbeef, 3) > 0);
  c.cheat(1, false, "");
});

// Ten synthetic codes covering the AR instruction families. Each runs alone (clear -> seed -> set -> frames -> check).
const B = 0x02210000;
const SYNTH = [
  { name: "00 escritura 32 bits", code: "02210000+11223344", expect: [[B + 0x000, 32, 0x11223344]] },
  { name: "10 escritura 16 bits", code: "12210100+0000ABCD", seed: [[B + 0x100, 32, 0xffffffff]], expect: [[B + 0x100, 16, 0xabcd], [B + 0x102, 16, 0xffff]] },
  { name: "20 escritura 8 bits", code: "22210200+000000A5", seed: [[B + 0x200, 32, 0xffffffff]], expect: [[B + 0x200, 8, 0xa5], [B + 0x201, 8, 0xff]] },
  { name: "50 IF == (32 bits) verdadero + D0 ENDIF", code: "52210300+12345678+02210304+AAAAAAAA+D0000000+00000000+02210308+CCCCCCCC", seed: [[B + 0x300, 32, 0x12345678]], expect: [[B + 0x304, 32, 0xaaaaaaaa], [B + 0x308, 32, 0xcccccccc]] },
  { name: "50 IF == falso: no escribe, y tras ENDIF sí", code: "52210400+00000001+02210404+BBBBBBBB+D0000000+00000000+02210408+CCCCCCCC", seed: [[B + 0x400, 32, 0]], expect: [[B + 0x404, 32, 0], [B + 0x408, 32, 0xcccccccc]] },
  { name: "90 IF == (16 bits con máscara) verdadero", code: "92210500+00001234+02210504+0000BEEF", seed: [[B + 0x500, 16, 0x1234]], expect: [[B + 0x504, 32, 0xbeef]] },
  { name: "30 IF b > u32[a] verdadero", code: "32210600+00000010+02210604+00000001", seed: [[B + 0x600, 32, 5]], expect: [[B + 0x604, 32, 1]] },
  { name: "C0/D2 bucle FOR + D5/D6 (4 palabras consecutivas)", code: "D3000000+02210800+C0000000+00000003+D5000000+CAFEBABE+D6000000+00000000+D2000000+00000000",
    expect: [[B + 0x800, 32, 0xcafebabe], [B + 0x804, 32, 0xcafebabe], [B + 0x808, 32, 0xcafebabe], [B + 0x80c, 32, 0xcafebabe], [B + 0x810, 32, 0]] },
  { name: "E0 copia de bloque (8 bytes)", code: "E2210900+00000008+11223344+55667788", expect: [[B + 0x900, 32, 0x11223344], [B + 0x904, 32, 0x55667788]] },
  { name: "B0 puntero + D5/D6 (escribe en [puntero+8])", code: "B2210C00+00000000+D5000000+600DCAFE+D6000000+00000008", seed: [[B + 0xc00, 32, B + 0xd00]], expect: [[B + 0xd08, 32, 0x600dcafe]] },
  { name: "D4 operaciones de datos (+5, |F0 => F5)", code: "D3000000+00000000+D5000000+00000010+D4000000+00000005+D4000001+000000F0+D6000000+02210E00", expect: [[B + 0xe00, 32, 0xf5]] },
];
const rd = (a, bits) => (bits === 8 ? c.r8(a) : bits === 16 ? c.r16(a) : c.r32(a));
const wr = (a, bits, v) => (bits === 8 ? c.w8(a, v) : bits === 16 ? c.w16(a, v) : c.w32(a, v));
for (const t of SYNTH) {
  T(`código sintético: ${t.name}`, () => {
    c.clear();
    for (const [a, bits, v] of t.seed ?? []) wr(a, bits, v);
    const parsed = parseCheat(t.code);
    assert.equal(parsed.ok, true, JSON.stringify(parsed.error));
    assert.equal(c.cheat(77, true, parsed.code), 0);
    c.frames(4);
    for (const [a, bits, v] of t.expect) assert.equal(rd(a, bits), v, `${t.name}: @${a.toString(16)} (${bits} bits)`);
    c.clear();
  });
}

T("estrés: activar/desactivar el MISMO código 20 veces (una sola ranura, sin fugas ni cuelgues)", () => {
  const A = 0x02220000, code = "02220000+0BADF00D";
  c.clear();
  c.w32(A, 0);
  c.cheat(9, true, code);
  c.frames(3);
  const heap0 = c.heapUsed();
  for (let i = 1; i <= 20; i++) {
    const on = i % 2 === 0; // 1 = off, 2 = on, ...
    assert.equal(c.cheat(9, on, code), 0, `iteración ${i}`);
    assert.equal(c.count(), 1, "no debe crecer el vector de trucos del núcleo");
    assert.equal(c.slot(9), 0);
    assert.equal(c.enabled(9), on ? 1 : 0);
    c.w32(A, 0);
    c.frames(3);
    assert.equal(c.r32(A), on ? 0x0badf00d : 0, `iteración ${i}: ${on ? "activado debe escribir" : "desactivado no debe escribir"}`);
  }
  const grown = c.heapUsed() - heap0;
  console.log(`# heap tras 20 ciclos con 60 fotogramas: ${grown >= 0 ? "+" : ""}${grown} bytes`);
  assert.ok(grown < 512 * 1024, `crecimiento sospechoso del heap: ${grown}`);

  // fugas puras del glue: muchas llamadas sin emular
  const h1 = c.heapUsed();
  for (let i = 0; i < 20000; i++) c.cheat(9, i & 1, code);
  const leak = c.heapUsed() - h1;
  console.log(`# heap tras 20000 llamadas a mds_cheat_set sin emular: ${leak >= 0 ? "+" : ""}${leak} bytes`);
  assert.ok(Math.abs(leak) < 64 * 1024, `fuga: ${leak} bytes`);
  assert.equal(c.count(), 1);
  c.clear();
});

T("ids dispersos (5, 1000, 3): ranuras por orden de aparición, reutilización al repetir, reemplazo real en el núcleo", () => {
  const A5 = 0x02230000, A1000 = 0x02230010, A3 = 0x02230020, A1000b = 0x02230030, A7 = 0x02230040;
  c.clear();
  for (const a of [A5, A1000, A3, A1000b, A7]) c.w32(a, 0);
  assert.equal(c.cheat(5, true, `0223${"0000"}+00000005`.replace("02230000", "02230000")), 0);
  assert.equal(c.cheat(1000, true, "02230010+000003E8"), 1);
  assert.equal(c.cheat(3, true, "02230020+00000003"), 2);
  assert.deepEqual([c.slot(5), c.slot(1000), c.slot(3), c.slot(42)], [0, 1, 2, -1]);
  assert.equal(c.count(), 3);
  c.frames(4);
  assert.deepEqual([c.r32(A5), c.r32(A1000), c.r32(A3)], [5, 1000, 3]);

  // repetir un id reutiliza su ranura (no crece) y REEMPLAZA el código en el núcleo: la dirección vieja deja de escribirse
  assert.equal(c.cheat(1000, true, "02230030+000003E9"), 1);
  assert.equal(c.count(), 3);
  c.w32(A1000, 0);
  c.frames(4);
  assert.equal(c.r32(A1000), 0, "el código antiguo del id 1000 sigue activo: la ranura no se reemplazó");
  assert.equal(c.r32(A1000b), 1001);
  assert.deepEqual([c.r32(A5), c.r32(A3)], [5, 3]);

  // repetir 5 y 3 tampoco crecen; un id nuevo toma la siguiente ranura libre (3)
  assert.equal(c.cheat(5, true, "02230000+00000005"), 0);
  assert.equal(c.cheat(3, true, "02230020+00000003"), 2);
  assert.equal(c.cheat(7, true, "02230040+00000007"), 3);
  assert.equal(c.count(), 4);
  c.frames(4);
  assert.equal(c.r32(A7), 7);

  // desactivar uno no afecta al resto
  c.cheat(3, false, "");
  c.w32(A3, 0); c.w32(A5, 0);
  c.frames(4);
  assert.deepEqual([c.r32(A3), c.r32(A5)], [0, 5]);

  // clear: olvida los ids y las ranuras empiezan otra vez desde 0
  c.clear();
  assert.equal(c.count(), 0);
  assert.deepEqual([c.slot(5), c.slot(1000), c.slot(3)], [-1, -1, -1]);
  c.w32(A5, 0); c.w32(A7, 0);
  c.frames(4);
  assert.deepEqual([c.r32(A5), c.r32(A7)], [0, 0], "tras clear nada debe seguir escribiendo");
  assert.equal(c.cheat(3, true, "02230020+00000003"), 0);
  assert.equal(c.cheat(5, true, "02230000+00000005"), 1);
  c.frames(4);
  assert.deepEqual([c.r32(A3), c.r32(A5)], [3, 5]);
  c.clear();
});

T("un código no válido NO consume ranura (si no, las ranuras se desplazarían respecto al vector del núcleo)", () => {
  const A = 0x02230100;
  c.clear();
  c.w32(A, 0);
  assert.equal(c.cheat(1, true, "ZZZZZZZZ+00000000"), -3);
  assert.equal(c.cheat(2, true, "0223010+0000000"), -3);
  assert.equal(c.cheat(3, true, "02230100"), -4);
  assert.equal(c.cheat(4, true, "E2230100+00000040+11223344+55667788"), -5);
  assert.equal(c.cheat(5, true, "  \n+ "), -2);
  assert.equal(c.cheat(6, true, ""), -2, "id desconocido sin texto");
  assert.equal(c.count(), 0);
  assert.equal(c.slot(1) + c.slot(2) + c.slot(3) + c.slot(4) + c.slot(5) + c.slot(6), -6);
  assert.equal(c.cheat(8, true, "02230100+0000A11D"), 0, "el primer código válido debe usar la ranura 0");
  c.frames(4);
  assert.equal(c.r32(A), 0xa11d);
  // un id que ya existe con texto inválido no pierde su código anterior
  assert.equal(c.cheat(8, true, "nope"), -3);
  c.w32(A, 0);
  c.frames(4);
  assert.equal(c.r32(A), 0xa11d);
  c.clear();
});

T("paridad JS ↔ C++: el conversor y mds_cheat_set aceptan y rechazan lo mismo", () => {
  const MAP = { [E.EMPTY]: -2, [E.BAD_TOKEN]: -3, [E.ODD_WORDS]: -4, [E.TRUNCATED_PAYLOAD]: -5 };
  const inputs = [
    "02230200+00000001", "02230200 00000001", "02230200\n00000001", "02230200-00000001", "", "   ", "0x02230200+00000001", "02230200+0000000",
    "022302000+00000001", "02230200", "02230200+00000001+12230204", "E2230208+00000010+11223344+55667788", "E2230208+00000008+11223344+55667788",
    "E2230208+00000020+11223344+55667788", "E2230208+00000018+11223344+55667788", "C4000000+00000000", "master+00000000", "folder",
  ];
  for (const text of inputs) {
    c.clear();
    const j = parseCheat(text);
    const rc = c.cheat(1, false, j.ok ? j.code : text);
    if (j.ok) assert.ok(rc >= 0, `JS acepta «${text}» pero C++ devolvió ${rc}`);
    else assert.equal(rc, MAP[j.error.code], `«${text}»: JS ${j.error.code}, C++ ${rc}`);
  }
  c.clear();
});

T("js/cheats-worker.js (lo que usa emu-worker): texto en varias líneas, relleno E-type, errores con código y línea", () => {
  const A = 0x02230300;
  clearCheats(c.M);
  c.w32(A, 0);
  // pares por línea, mayúsculas/minúsculas mezcladas, salto final (el núcleo lo rechazaría tal cual)
  const r = setCheat(c.M, 4000000000, true, "02230300 0000c0de\r\n");
  assert.equal(r.slot, 0);
  c.frames(4);
  assert.equal(c.r32(A), 0xc0de);
  // carga E-type 2 palabras corta (como el código HGSS): aviso y se carga
  const p = setCheat(c.M, 1, false, "E2230310+00000010+11223344+55667788");
  assert.equal(p.warnings[0].code, "PAYLOAD_PADDED");
  // errores
  assert.throws(() => setCheat(c.M, 2, true, "02230300+0000ZZZZ"), (e) => e.code === "CHEAT_BAD_TOKEN" && e.line === 1 && e.column === 10);
  assert.throws(() => setCheat(c.M, 2, true, "02230300+00000001\n12230304"), (e) => e.code === "CHEAT_ODD_WORDS" && e.line === 2);
  assert.throws(() => setCheat(c.M, 99, true, ""), (e) => e.code === "CHEAT_EMPTY");
  assert.throws(() => setCheat(c.M, -1, true, "02230300+00000001"), (e) => e.code === "CHEAT_ID");
  assert.equal(c.count(), 2, "los errores no consumen ranura");
  // handlers del worker
  const h = cheatHandlers(() => c.M);
  h.cheat({ id: 4000000000, enabled: false, code: "" });
  assert.equal(c.enabled(4000000000), 0);
  h.cheatClear();
  assert.equal(c.count(), 0);
});

T("reference/cheats-sample.json: los 6 códigos cargan en el núcleo y se puede emular sin cuelgues", () => {
  const cat = JSON.parse(readFileSync(join(root, "reference/cheats-sample.json"), "utf8"));
  const res = parseCatalog(cat);
  assert.equal(res.failed.length, 0);
  c.clear();
  let id = 100;
  for (const e of res.entries) assert.ok(c.cheat(id++, true, e.retro) >= 0, e.name);
  assert.equal(c.count(), res.entries.length);
  const before = Number(c.M._mds_get_frame_count());
  c.frames(120);
  assert.equal(Number(c.M._mds_get_frame_count()) - before, 120);
  c.clear();
});

// Optional: every code in libretro-database that the JS converter accepts is also accepted by C++ (loaded disabled, in batches).
const chtDir = process.env.CHT_DIR || join(root, "tests/artifacts/libretro-database-src/cht/Nintendo - Nintendo DS");
test("libretro-database (datos efímeros): todo lo que acepta JS lo acepta C++ y el núcleo", { skip: skip || (existsSync(chtDir) ? false : "sin datos en tests/artifacts") }, () => {
  const step = process.env.CHT_FULL ? 1 : 10; // 1 de cada 10 por defecto
  let n = 0, tried = 0, bad = [];
  c.clear();
  let id = 0;
  for (const f of readdirSync(chtDir).filter((x) => x.endsWith(".cht")).sort()) {
    for (const e of parseCht(readFileSync(join(chtDir, f), "utf8"))) {
      if (e.code === undefined || (n++ % step) !== 0) continue;
      const j = parseCheat(e.code);
      if (!j.ok) continue;
      tried++;
      const rc = c.cheat(id++, false, j.code);
      if (rc < 0) bad.push(`${f} #${e.index}: rc ${rc}`);
      if (id >= 1000) { c.clear(); id = 0; }
    }
  }
  c.clear();
  console.log(`# ${tried} códigos reales cargados (desactivados) en el núcleo, ${bad.length} rechazados`);
  assert.deepEqual(bad.slice(0, 10), []);
});
