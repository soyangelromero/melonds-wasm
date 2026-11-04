// Phase 5 core test (Node, no browser): drives mds_set_key_mask / mds_set_pointer against the REAL core and checks effects.
// Usage: node tests/phase5-core.mjs <rom.nds>      (dist/melonds.{js,wasm} must be built; the ROM is never uploaded)
//  1. diagnostics: which input the core really asks the frontend for (mds_get_input_queries)
//  2. key mask: holding UP / SELECT changes the picture of the CC0 homebrew nmap.nds (lights move / normal mapping toggles)
//  3. pointer: with melonds_show_cursor=touching the core draws an inverted square at the console touch position; its centre,
//     mapped to DISPLAYED coordinates (after the frontend rotation), must sit under the normalised point we sent, in several
//     layouts including the rotated ones. Nothing here re-implements the layout transform: only "cursor under the pointer".
//  4. release: pressed=false removes the cursor; (0,0) hover is ignored by "touching".
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const romPath = process.argv[2];
if (!romPath) { console.error("usage: node tests/phase5-core.mjs <rom.nds>"); process.exit(2); }
const rom = readFileSync(romPath);
const { default: createModule } = await import(new URL("../dist/melonds.js", import.meta.url));

let failures = 0, total = 0;
function check(name, ok, detail = "") { total++; if (!ok) failures++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); }

async function boot(options = {}) {
  const M = await createModule({ print: () => {}, printErr: () => {} });
  const put = (b) => { const p = M._malloc(b.length); M.HEAPU8.set(b, p); return p; };
  const cstr = (s) => put(Buffer.from(s + "\0"));
  const setOption = (k, v) => M._mds_set_option(cstr(k), cstr(v));
  if (M._mds_create(0) !== 0) throw new Error("mds_create failed");
  setOption("melonds_threaded_renderer", "disabled"); // deterministic
  for (const [k, v] of Object.entries(options)) setOption(k, v);
  if (M._mds_load_rom(put(rom), rom.length, 0, 0) !== 0) throw new Error("mds_load_rom failed");
  const [wP, hP, sP] = [M._malloc(4), M._malloc(4), M._malloc(4)];
  const api = {
    M, setOption,
    run: (n = 1) => { for (let i = 0; i < n; i++) M._mds_run_frame(); },
    frame() {
      const p = M._mds_get_frame(wP, hP, sP);
      const w = M.HEAPU32[wP >> 2], h = M.HEAPU32[hP >> 2], stride = M.HEAPU32[sP >> 2];
      const px = new Uint32Array(w * h);
      for (let y = 0; y < h; y++) px.set(new Uint32Array(M.HEAPU8.buffer.slice(p + y * stride, p + y * stride + w * 4)), y * w);
      return { w, h, px, rotation: M._mds_get_frame_rotation() };
    },
    key: (mask) => M._mds_set_key_mask(mask),
    pointer: (x, y, pressed) => M._mds_set_pointer(x, y, pressed ? 1 : 0),
    queries: () => M._mds_get_input_queries(),
    destroy: () => M._mds_destroy(),
  };
  return api;
}
const hash = (f) => createHash("sha256").update(Buffer.from(f.px.buffer)).digest("hex").slice(0, 12);
const BIT = { B: 0, Y: 1, SELECT: 2, START: 3, UP: 4, DOWN: 5, LEFT: 6, RIGHT: 7, A: 8, X: 9, L: 10, R: 11 };

// ---- 1 + 2: keys ----------------------------------------------------------------------------------------------------
{
  const e = await boot();
  e.run(120);
  const idle1 = e.frame(); e.run(3); const idle2 = e.frame();
  const q = e.queries();
  check("el núcleo pide JOYPAD_MASK (bit 1) y el puntero (bit 4)", (q & 1) === 1 && (q & 4) === 4, `flags=${q} (1=MASK 2=ids sueltos 4=puntero 8=analógico)`);
  check("el núcleo NO pide ids de botón sueltos (usa la máscara)", (q & 2) === 0);
  console.log(`      analógico pedido: ${(q & 8) !== 0} (palanca derecha = modo cursor con joystick, no alimentado en la Fase 5)`);
  check("escena estática sin entrada (referencia para comparar)", hash(idle1) === hash(idle2), hash(idle1));

  e.key(1 << BIT.UP); e.run(20); const up = e.frame();
  check("máscara UP cambia la imagen (la luz 1 se mueve)", hash(up) !== hash(idle2), `${hash(idle2)} -> ${hash(up)}`);
  e.key(0); e.run(2);
  const afterUp = e.frame();
  e.key(1 << BIT.SELECT); e.run(2); e.key(0); e.run(3); const sel = e.frame();
  check("SELECT (flanco) alterna normal mapping: la imagen cambia", hash(sel) !== hash(afterUp), `${hash(afterUp)} -> ${hash(sel)}`);
  e.destroy();

  // The same input must give the same picture twice (determinism of the harness itself).
  const run = async (mask) => { const x = await boot(); x.run(100); x.key(mask); x.run(15); const h = hash(x.frame()); x.destroy(); return h; };
  const [a, b, c] = [await run(1 << BIT.LEFT), await run(1 << BIT.LEFT), await run(1 << BIT.A)];
  check("misma máscara ⇒ mismo fotograma (determinista)", a === b, a);
  check("LEFT y A producen imágenes distintas (cada bit llega a su botón)", a !== c, `${a} vs ${c}`);
}

// ---- 3 + 4: pointer ---------------------------------------------------------------------------------------------------
import { LAYOUT_RECTS as LAYOUTS } from "./support/layout-rects.mjs";
// Unrotated frame pixel -> displayed pixel for rotation k (90 degrees CCW each), W x H = unrotated size.
function toDisplayed(x, y, W, H, k) {
  switch (k & 3) { case 0: return [x, y]; case 1: return [y, W - 1 - x]; case 2: return [W - 1 - x, H - 1 - y]; default: return [H - 1 - y, x]; }
}
function diffBox(a, b) {
  let n = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
  for (let i = 0; i < a.px.length; i++) if (a.px[i] !== b.px[i]) {
    const [dx, dy] = toDisplayed(i % a.w, (i / a.w) | 0, a.w, a.h, b.rotation);
    n++; x0 = Math.min(x0, dx); y0 = Math.min(y0, dy); x1 = Math.max(x1, dx); y1 = Math.max(y1, dy);
  }
  return { n, x0, y0, x1, y1, cx: (x0 + x1 + 1) / 2, cy: (y0 + y1 + 1) / 2 };
}
const toPtr = (n) => Math.round((n * 2 - 1) * 32767);

for (const [layout, g] of Object.entries(LAYOUTS)) {
  const e = await boot({ melonds_number_of_screen_layouts: "1", melonds_screen_layout1: layout, melonds_show_cursor: "touching" });
  e.run(120);
  const f0 = e.frame();
  const dims = f0.rotation & 1 ? [f0.h, f0.w] : [f0.w, f0.h]; // displayed size
  check(`[${layout}] tamaño mostrado ${g.w}x${g.h}`, dims[0] === g.w && dims[1] === g.h, `${dims[0]}x${dims[1]} rotación ${f0.rotation}`);

  const [rx, ry, rw, rh] = g.rect;
  for (const [fx, fy] of [[0.5, 0.5], [0.2, 0.75], [0.9, 0.15]]) {
    const px = rx + fx * rw, py = ry + fy * rh;           // target in displayed pixels
    e.pointer(0, 0, false); e.run(3); const before = e.frame();
    e.pointer(toPtr(px / g.w), toPtr(py / g.h), true); e.run(3); const during = e.frame();
    const d = diffBox(before, during);
    const dist = Math.hypot(d.cx - px, d.cy - py);
    check(`[${layout}] el cursor aparece bajo el toque (${fx},${fy}) de la pantalla inferior`, d.n > 0 && dist <= 3.5, `objetivo (${px.toFixed(1)}, ${py.toFixed(1)}) cursor (${d.cx.toFixed(1)}, ${d.cy.toFixed(1)}) dist ${dist.toFixed(2)} px, ${d.n} px cambiados`);
    e.pointer(toPtr(px / g.w), toPtr(py / g.h), false); e.run(3); const after = e.frame();
    check(`[${layout}] al soltar el cursor desaparece`, diffBox(before, after).n === 0);
  }
  e.destroy();
}

{ // pointer reaches the core even when nothing else is configured: default cursor mode (timeout) shows it on hover too
  const e = await boot({ melonds_number_of_screen_layouts: "1", melonds_screen_layout1: "top-bottom", melonds_show_cursor: "touching" });
  e.run(120); const base = e.frame();
  e.pointer(toPtr(0.5), toPtr(0.75), false); e.run(3);
  check("hover sin pulsar no dibuja cursor con 'touching'", diffBox(base, e.frame()).n === 0);
  e.pointer(0, 0, true); e.run(3);   // exact centre while pressed: the host nudges it, the core must still register the touch
  check("toque exacto en el centro (0,0 pulsado) se registra", diffBox(base, e.frame()).n > 0);
  e.destroy();
}

console.log(`\n${total - failures}/${total} comprobaciones correctas`);
process.exit(failures ? 1 : 0);
