// Phase 5 browser test: headless Chromium (Playwright) drives demo/index.html with REAL mouse, keyboard and touch events
// (Playwright / CDP) through the whole path: DOM -> js/input.js -> SharedArrayBuffer -> worker -> mds_set_* -> core -> frame -> canvas.
// Usage: node tests/phase5-browser.mjs <rom.nds> [--gl=default|swiftshader]
// The ROM is the CC0 homebrew nmap.nds by default (npm run test:input). It ignores the touch screen, so the observable effect of
// a touch is the cursor the CORE draws on the composed frame (melonds_show_cursor=touching): it must appear under the pointer.
// A gamepad is simulated by replacing navigator.getGamepads (real pads cannot be attached to headless Chromium).
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createStaticServer } from "../scripts/serve.mjs";
import { LAYOUT_RECTS, LAYOUT_LABEL } from "./support/layout-rects.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flags = Object.fromEntries(args.filter((a) => a.startsWith("--")).map((a) => { const [k, v = "1"] = a.slice(2).split("="); return [k, v]; }));
const romPath = args.find((a) => !a.startsWith("--"));
if (!romPath) { console.error("usage: node tests/phase5-browser.mjs <rom.nds> [--gl=default|swiftshader]"); process.exit(2); }

function loadPlaywright() {
  for (const base of [join(root, "package.json"), execSync("npm root -g", { encoding: "utf8" }).trim() + "/"]) {
    try { return createRequire(base)("playwright"); } catch { /* next */ }
  }
  throw new Error("playwright not found: npm i -D playwright (or install it globally)");
}
const { chromium } = loadPlaywright();

const out = join(root, "tests", "artifacts");
mkdirSync(out, { recursive: true });
const results = { when: new Date().toISOString(), checks: [] };
let failures = 0;
function check(name, ok, detail = "") {
  results.checks.push({ name, ok: !!ok, detail });
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = createStaticServer({ root });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const launchArgs = flags.gl === "swiftshader" ? ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] : [];
const browser = await chromium.launch({ args: launchArgs });
results.browser = browser.version();
console.log(`Chromium ${results.browser}, server ${base}`);

// ---- in-page helpers -------------------------------------------------------------------------------------------------
const PAGE = {
  // Canvas pixels as a flat RGBA array plus canvas / CSS geometry. Hashing is done in Node.
  snap: () => {
    const canvas = window.__demo.canvas;
    const c = document.createElement("canvas"); c.width = canvas.width; c.height = canvas.height;
    const x = c.getContext("2d"); x.drawImage(canvas, 0, 0);
    const r = canvas.getBoundingClientRect();
    return { W: canvas.width, H: canvas.height, rect: { left: r.left, top: r.top, width: r.width, height: r.height }, data: Array.from(x.getImageData(0, 0, c.width, c.height).data), drawn: window.__demo.player.getStats().drawnFrames };
  },
  state: () => { const i = window.__demo.player.input, p = i.pointer; return { mask: i.mask, pointer: p, scrollY: window.scrollY, sw: document.documentElement.scrollHeight, ch: document.documentElement.clientHeight }; },
  geometry: () => { const c = window.__demo.canvas, r = c.getBoundingClientRect(); return { W: c.width, H: c.height, left: r.left, top: r.top, width: r.width, height: r.height, drawn: window.__demo.player.getStats().drawnFrames }; },
};
const sameFrame = (a, b) => { for (let i = 0; i < a.data.length; i += 4) if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2]) return false; return true; };
function diffBox(a, b) {
  let n = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
  for (let i = 0; i < a.data.length; i += 4) {
    if (a.data[i] === b.data[i] && a.data[i + 1] === b.data[i + 1] && a.data[i + 2] === b.data[i + 2]) continue;
    const p = i >> 2, x = p % a.W, y = (p / a.W) | 0;
    n++; x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  return { n, cx: (x0 + x1 + 1) / 2, cy: (y0 + y1 + 1) / 2 };
}
async function waitFor(page, fn, arg, timeout = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { if (await page.evaluate(fn, arg)) return true; await sleep(50); }
  return false;
}
// Wait until N more frames were drawn so an input sent now has gone through the worker and onto the canvas.
async function settle(page, frames = 6) {
  const n = (await page.evaluate(PAGE.geometry)).drawn;
  await waitFor(page, (t) => window.__demo.player.getStats().drawnFrames >= t, n + frames, 10000);
}

async function openDemo(contextOptions = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, ...contextOptions });
  const page = await context.newPage();
  const issues = [];
  page.on("console", (m) => { if (m.type() === "error") issues.push(`console.error: ${m.text()}`); });
  page.on("pageerror", (e) => issues.push(`pageerror: ${e.message}`));
  page.on("requestfailed", (r) => issues.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));
  await page.addInitScript(() => { // fake pad slot: tests set window.__pads; real navigator.getGamepads() is replaced
    window.__pads = [];
    navigator.getGamepads = () => window.__pads;
    window.__prevented = [];
    // window bubbles after the demo's document listener, so defaultPrevented is final here
    window.addEventListener("keydown", (e) => window.__prevented.push([e.code, e.defaultPrevented]), false);
  });
  await page.goto(`${base}/demo/index.html`);
  await page.setInputFiles("#rom", romPath);
  const ok = await waitFor(page, () => window.__demo.player && window.__demo.player.getStats().drawnFrames >= 40, null, 60000);
  if (!ok) throw new Error("ROM did not boot: " + issues.join("; "));
  await page.evaluate(() => window.__demo.player.setCoreOption("melonds_show_cursor", "touching"));
  await settle(page, 10);
  return { page, context, issues };
}
const hold = async (page, ms = 350) => { await sleep(ms); await settle(page, 4); };

// ===== 1. keyboard ======================================================================================================
{
  const { page, context, issues } = await openDemo();
  await page.evaluate(() => document.activeElement?.blur());
  await page.mouse.move(5, 5);
  await settle(page, 4);
  const idle = await page.evaluate(PAGE.snap);
  await settle(page, 4);
  check("escena estática sin entrada (base de comparación)", sameFrame(idle, await page.evaluate(PAGE.snap)));

  await page.keyboard.down("ArrowUp"); await hold(page);
  const st = await page.evaluate(PAGE.state);
  check("flecha arriba = bit UP en la máscara compartida", (st.mask & (1 << 4)) !== 0, `máscara ${st.mask.toString(2)}`);
  const up = await page.evaluate(PAGE.snap);
  check("flecha arriba mantenida cambia la imagen en el núcleo (llegó hasta el emulador)", !sameFrame(idle, up));
  await page.keyboard.up("ArrowUp"); await hold(page, 150);
  check("al soltar, la máscara vuelve a 0", (await page.evaluate(PAGE.state)).mask === 0);

  await page.keyboard.down("KeyZ"); await page.keyboard.down("Enter");
  const both = (await page.evaluate(PAGE.state)).mask;
  check("Z=A y Enter=START a la vez", both === ((1 << 8) | (1 << 3)), `máscara ${both.toString(2)}`);
  await page.keyboard.up("KeyZ"); await page.keyboard.up("Enter");

  for (const [code, expected] of [["ArrowUp", true], ["ArrowDown", true], ["ArrowLeft", true], ["ArrowRight", true], ["Space", true], ["KeyP", false]]) {
    await page.evaluate(() => { window.__prevented.length = 0; });
    await page.keyboard.down(code); await page.keyboard.up(code);
    const seen = await page.evaluate(() => window.__prevented.slice());
    check(`preventDefault en ${code}: ${expected}`, seen.length > 0 && seen.every(([, p]) => p === expected), JSON.stringify(seen));
  }
  const sc = await page.evaluate(PAGE.state);
  check("la página no se desplazó con flechas/Espacio", sc.scrollY === 0, `scrollY=${sc.scrollY}`);

  // Focus in a <select> must not be hijacked: typing there does not press buttons.
  await page.focus("#layout"); await page.keyboard.down("KeyZ");
  check("con foco en un <select> las teclas no pulsan botones", (await page.evaluate(PAGE.state)).mask === 0);
  await page.keyboard.up("KeyZ");
  await page.evaluate(() => document.activeElement?.blur());

  // Held key + window blur: nothing stays stuck.
  await page.keyboard.down("KeyS");
  check("S=Y pulsada", (await page.evaluate(PAGE.state)).mask === (1 << 1));
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  check("blur de la ventana suelta las teclas (nada se queda pegado)", (await page.evaluate(PAGE.state)).mask === 0);
  await page.keyboard.up("KeyS");

  // ===== 2. gamepad (simulated standard pad) ==================================================================================
  const pad = (pressed, axes = [0, 0, 0, 0]) => ({ connected: true, mapping: "standard", id: "Simulated standard pad", index: 0, axes, buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: pressed.includes(i), value: +pressed.includes(i) })) });
  await page.evaluate((p) => { window.__pads = [p]; }, pad([12]));
  await hold(page);
  const gp = await page.evaluate(PAGE.state);
  check("mando: cruceta arriba (botón 12) = UP", gp.mask === (1 << 4), `máscara ${gp.mask.toString(2)}`);
  check("mando: la imagen cambia como con el teclado", !sameFrame(idle, await page.evaluate(PAGE.snap)));
  await page.evaluate((p) => { window.__pads = [p]; }, pad([], [0.9, 0, 0, 0]));
  await hold(page, 100);
  check("mando: palanca izquierda a la derecha = RIGHT", (await page.evaluate(PAGE.state)).mask === (1 << 7));
  await page.evaluate((p) => { window.__pads = [p]; }, pad([1, 3]));
  await hold(page, 100);
  check("mando: botón derecho = A y superior = X", (await page.evaluate(PAGE.state)).mask === ((1 << 8) | (1 << 9)));
  await page.evaluate(() => { window.__pads = []; });
  await hold(page, 100);
  check("mando desconectado: se sueltan todos los botones", (await page.evaluate(PAGE.state)).mask === 0);

  check("sin errores de consola/página (teclado y mando)", issues.length === 0, issues.join(" | "));
  await context.close();
}

// ===== 3. mouse and touch over the canvas, several layouts ==========================================================================
const LAYOUTS_UNDER_TEST = ["top-bottom", "left-right", "rotate-left", "rotate-right", "rotate-180", "bottom"];
const targetFor = (layout, g, fx, fy) => {
  const L = LAYOUT_RECTS[layout], [rx, ry, rw, rh] = L.rect;
  const px = rx + fx * rw, py = ry + fy * rh;                      // displayed (canvas backing store) pixels
  return { px, py, clientX: g.left + (px / g.W) * g.width, clientY: g.top + (py / g.H) * g.height };
};
async function setLayoutAndWait(page, layout) {
  const L = LAYOUT_RECTS[layout];
  await page.evaluate((l) => window.__demo.player.setLayout(l), LAYOUT_LABEL[layout]);
  const ok = await waitFor(page, ([w, h]) => window.__demo.canvas.width === w && window.__demo.canvas.height === h, [L.w, L.h], 8000);
  await settle(page, 8);
  return ok;
}

{
  const { page, context, issues } = await openDemo();
  await page.evaluate(() => document.activeElement?.blur());
  for (const layout of LAYOUTS_UNDER_TEST) {
    check(`[${LAYOUT_LABEL[layout]}] el canvas tiene el tamaño mostrado ${LAYOUT_RECTS[layout].w}x${LAYOUT_RECTS[layout].h}`, await setLayoutAndWait(page, layout));
    await page.mouse.move(2, 2); await settle(page, 4);
    const g = await page.evaluate(PAGE.geometry);
    check(`[${LAYOUT_LABEL[layout]}] el canvas visible = rectángulo del fotograma (sin barras)`, Math.abs(g.width / g.height - g.W / g.H) < 0.01, `CSS ${g.width.toFixed(1)}x${g.height.toFixed(1)} vs ${g.W}x${g.H}`);

    for (const [fx, fy] of [[0.5, 0.5], [0.15, 0.8]]) {
      const t = targetFor(layout, g, fx, fy);
      const before = await page.evaluate(PAGE.snap);
      await page.mouse.move(t.clientX, t.clientY);
      await page.mouse.down();
      await hold(page, 250);
      const pressed = await page.evaluate(PAGE.state);
      const during = await page.evaluate(PAGE.snap);
      const d = diffBox(before, during);
      // tolerance: the CSS-to-canvas scale can be > 1 so one DS pixel is several mouse pixels; 3.5 canvas px as in the core test
      const dist = Math.hypot(d.cx - t.px, d.cy - t.py);
      check(`[${LAYOUT_LABEL[layout]}] ratón pulsado en (${fx},${fy}): el cursor del núcleo aparece bajo el puntero`, pressed.pointer.pressed && d.n > 0 && dist <= 3.5, `objetivo (${t.px.toFixed(1)}, ${t.py.toFixed(1)}) cursor (${d.cx.toFixed(1)}, ${d.cy.toFixed(1)}) dist ${dist.toFixed(2)}, ${d.n} px`);
      if (layout === "rotate-left" && fx === 0.5) writeFileSync(join(out, "phase5-rotate-left-touch.png"), await page.locator("#screen").screenshot());
      await page.mouse.up();
      await hold(page, 150);
      const after = await page.evaluate(PAGE.snap);
      check(`[${LAYOUT_LABEL[layout]}] al soltar el cursor desaparece y el puntero queda libre`, diffBox(before, after).n === 0 && !(await page.evaluate(PAGE.state)).pointer.pressed);
    }
  }

  // Drag across the canvas and release OUTSIDE it (pointer capture): the touch must end, nothing stays pressed.
  await setLayoutAndWait(page, "top-bottom");
  {
    const g = await page.evaluate(PAGE.geometry), a = targetFor("top-bottom", g, 0.5, 0.5);
    await page.mouse.move(a.clientX, a.clientY); await page.mouse.down(); await hold(page, 120);
    await page.mouse.move(g.left + g.width + 200, g.top + g.height / 2, { steps: 5 }); await hold(page, 120);
    const mid = await page.evaluate(PAGE.state);
    check("arrastrar fuera del canvas mantiene el toque pegado al borde (captura de puntero)", mid.pointer.pressed && mid.pointer.x === 32767, `x=${mid.pointer.x}`);
    await page.mouse.up(); await hold(page, 120);
    const end = await page.evaluate(PAGE.state);
    check("soltar fuera del canvas termina el toque", !end.pointer.pressed);
    await page.mouse.move(2, 2); await hold(page, 100);
    check("el ratón fuera del canvas deja el puntero en (0,0) 'ausente'", (await page.evaluate(PAGE.state)).pointer.x === 0);
  }

  // Right button must not touch.
  {
    const g = await page.evaluate(PAGE.geometry), a = targetFor("top-bottom", g, 0.5, 0.5);
    await page.mouse.move(a.clientX, a.clientY); await page.mouse.down({ button: "right" }); await hold(page, 100);
    check("botón derecho del ratón no toca la pantalla", !(await page.evaluate(PAGE.state)).pointer.pressed);
    await page.mouse.up({ button: "right" });
  }
  check("sin errores de consola/página (ratón)", issues.length === 0, issues.join(" | "));
  await context.close();
}

// ----- real touch events (CDP): single and multi-touch, in a rotated layout ------------------------------------------------------
{
  const { page, context, issues } = await openDemo({ hasTouch: true });
  await page.evaluate(() => document.activeElement?.blur());
  const cdp = await context.newCDPSession(page);
  for (const layout of ["rotate-left", "left-right", "top-bottom"]) {
    await setLayoutAndWait(page, layout);
    const g = await page.evaluate(PAGE.geometry);
    const t = targetFor(layout, g, 0.3, 0.6), other = targetFor(layout, g, 0.9, 0.1);
    const before = await page.evaluate(PAGE.snap);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: t.clientX, y: t.clientY, id: 1 }] });
    await hold(page, 250);
    const d1 = diffBox(before, await page.evaluate(PAGE.snap)), dist1 = Math.hypot(d1.cx - t.px, d1.cy - t.py);
    check(`[${LAYOUT_LABEL[layout]}] toque real: el cursor aparece bajo el dedo`, d1.n > 0 && dist1 <= 3.5, `dist ${dist1.toFixed(2)} px`);
    // second finger: ignored, the first keeps the DS touch
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: t.clientX, y: t.clientY, id: 1 }, { x: other.clientX, y: other.clientY, id: 2 }] });
    await hold(page, 250);
    const d2 = diffBox(before, await page.evaluate(PAGE.snap)), dist2 = Math.hypot(d2.cx - t.px, d2.cy - t.py);
    check(`[${LAYOUT_LABEL[layout]}] segundo dedo ignorado: el cursor sigue bajo el primero`, d2.n > 0 && dist2 <= 3.5, `dist ${dist2.toFixed(2)} px`);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await hold(page, 200);
    const end = await page.evaluate(PAGE.state);
    check(`[${LAYOUT_LABEL[layout]}] al levantar los dedos el toque termina y el cursor desaparece`, !end.pointer.pressed && diffBox(before, await page.evaluate(PAGE.snap)).n === 0);
  }
  check("sin errores de consola/página (táctil)", issues.length === 0, issues.join(" | "));
  await context.close();
}

await browser.close();
server.close();
const passed = results.checks.filter((c) => c.ok).length;
console.log(`\n${passed}/${results.checks.length} comprobaciones correctas`);
writeFileSync(join(out, "phase5-browser-results.json"), JSON.stringify(results, null, 2));
process.exit(failures ? 1 : 0);
