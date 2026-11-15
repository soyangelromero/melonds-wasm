// Integration test (phases 3, 4, 5, 6 and 8 together): ONE headless Chromium session of the ONE demo (demo/index.html) with ONE ROM
// (tests/artifacts/integration.nds, our own CC0 homebrew built by tests/homebrew/integration/mkrom.py) does at the same time:
//   load ROM -> hear audio (RMS measured inside the AudioWorklet) -> key press changes the image -> touch on the bottom screen
//   draws the core's cursor -> cheats write a RAM address (read back from the wasm heap) -> get / reload a save (.sav) and a
//   savestate -> "Continuar" (new page, same browser profile: the IndexedDB save is used) -> no console errors.
// Usage: node tests/integration-browser.mjs [rom.nds] [--gl=swiftshader]      (npm run test:integration)
// Nothing is played through a sound card (the cloud has none): the AudioContext renders against a clock and the checks read
// the worklet's own counters, as in tests/phase4-browser.mjs.
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createStaticServer } from "../scripts/serve.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flags = Object.fromEntries(args.filter((a) => a.startsWith("--")).map((a) => { const [k, v = "1"] = a.slice(2).split("="); return [k, v]; }));
const romPath = args.find((a) => !a.startsWith("--")) ?? join(root, "tests", "artifacts", "integration.nds");
if (!existsSync(romPath)) { console.log(`SKIP: ${romPath} missing (npm run build:integration-rom; needs gcc-arm-none-eabi)`); process.exit(0); }

function loadPlaywright() {
  for (const base of [join(root, "package.json"), execSync("npm root -g", { encoding: "utf8" }).trim() + "/"]) {
    try { return createRequire(base)("playwright"); } catch { /* next */ }
  }
  throw new Error("playwright not found: npm i -D playwright");
}
const { chromium } = loadPlaywright();

const out = join(root, "tests", "artifacts"); mkdirSync(out, { recursive: true });
const results = { when: new Date().toISOString(), checks: [], metrics: {}, warnings: [] };
let failures = 0;
const check = (name, ok, detail = "") => { results.checks.push({ name, ok: !!ok, detail }); if (!ok) failures++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fx = (x, d = 3) => (typeof x === "number" ? x.toFixed(d) : String(x));

const server = createStaticServer({ root });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const launchArgs = ["--autoplay-policy=no-user-gesture-required", ...(flags.gl === "swiftshader" ? ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] : [])];
const browser = await chromium.launch({ args: launchArgs });
results.browser = browser.version(); results.launchArgs = launchArgs;
console.log(`Chromium ${results.browser}, args ${launchArgs.join(" ")}, server ${base}`);

const consoleIssues = [];
const context = await browser.newContext({ viewport: { width: 1400, height: 1300 }, acceptDownloads: true });

async function openDemo(label) {
  const page = await context.newPage();
  page.on("console", (m) => {
    const t = m.text();
    if (m.type() === "error") consoleIssues.push(`[${label}] console.error: ${t}`);
    else if (m.type() === "warning" && !/GPU stall|GL Driver Message|firmware file/.test(t)) results.warnings.push(`[${label}] ${t}`);
  });
  page.on("pageerror", (e) => consoleIssues.push(`[${label}] pageerror: ${e.message}`));
  page.on("requestfailed", (r) => consoleIssues.push(`[${label}] requestfailed: ${r.url()} ${r.failure()?.errorText}`));
  await page.goto(`${base}/demo/index.html`);
  await page.mouse.click(700, 600); // a real user gesture: unlocks the AudioContext the way a person does
  return page;
}

// ---- in-page helpers (everything goes through the public VideoPlayer API except peek, a worker test hook) ----
const PAGE = {
  // snap(true) also stores the bottom half as the reference; later snaps count the bottom-half pixels that differ from it (the
  // bottom screen of this ROM is not drawn by the game, so any change there is the cursor the core composes over it).
  snap: (setRef) => {
    const c = window.__demo.canvas;
    const t = document.createElement("canvas"); t.width = c.width; t.height = c.height;
    const x = t.getContext("2d", { willReadFrequently: true }); x.drawImage(c, 0, 0);
    const d = x.getImageData(0, 0, t.width, t.height).data;
    let h = 2166136261 >>> 0;
    for (let i = 0; i < d.length; i += 4) { h ^= d[i] | (d[i + 1] << 8) | (d[i + 2] << 16); h = Math.imul(h, 16777619) >>> 0; }
    const half = d.slice((t.height / 2) * t.width * 4);
    if (setRef) window.__ref = half;
    const ref = window.__ref;
    let n = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
    for (let y = t.height / 2; y < t.height; y++) for (let xx = 0; xx < t.width; xx++) {
      const i = (y * t.width + xx) * 4, j = i - (t.height / 2) * t.width * 4;
      if (ref && (half[j] !== ref[j] || half[j + 1] !== ref[j + 1] || half[j + 2] !== ref[j + 2])) { n++; x0 = Math.min(x0, xx); y0 = Math.min(y0, y); x1 = Math.max(x1, xx); y1 = Math.max(y1, y); }
    }
    const top = (10 * t.width + 10) * 4;
    const r = c.getBoundingClientRect();
    return { W: t.width, H: t.height, hash: h, topRGB: [d[top], d[top + 1], d[top + 2]], cursor: { n, cx: (x0 + x1 + 1) / 2, cy: (y0 + y1 + 1) / 2 }, rect: { left: r.left, top: r.top, width: r.width, height: r.height } };
  },
  // Reads `len` bytes of DS main RAM from the wasm heap through the worker test hook `debugPeek`.
  peek: ([addr, len]) => new Promise((resolve, reject) => {
    const p = window.__demo.player, id = p.nextId++;
    p.pending.set(id, { resolve: (b) => resolve(Array.from(b)), reject });
    p.worker.postMessage({ type: "debugPeek", addr, len, id });
  }),
  stats: () => { const s = window.__demo.player.getStats(), a = s.audio; return { ...a, feeding: s.audioFeeding, frameCount: s.frameCount, emuFps: s.emuFps, emuMs: s.emuMs, drawFps: s.drawFps, now: performance.now() }; },
  input: () => { const i = window.__demo.player.input; return { mask: i.mask, pressed: i.pointer.pressed, x: i.pointer.x, y: i.pointer.y }; },
};
const peek = (page, addr, len = 4) => page.evaluate(PAGE.peek, [addr, len]);
const counter = async (page) => { const b = await peek(page, 0x02200000); return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0; };
const rmsBetween = (a, b) => Math.sqrt((b.sumSq - a.sumSq) / Math.max(1, b.framesOut - a.framesOut));
const text = (page, id) => page.locator(`#${id}`).innerText();
async function waitFor(page, fn, arg, timeout = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { if (await page.evaluate(fn, arg)) return true; await sleep(50); }
  return false;
}
async function measureAudio(page, ms = 1500) {
  const a = await page.evaluate(PAGE.stats); await sleep(ms); const b = await page.evaluate(PAGE.stats);
  return { rms: rmsBetween(a, b), peak: b.peak, feeding: b.feeding, underruns: b.underrunEvents - a.underrunEvents, frames: b.framesOut - a.framesOut, seconds: (b.now - a.now) / 1000 };
}
const waitBoot = (page) => waitFor(page, () => { const s = window.__demo.player?.getStats(); return s?.audio?.tick > 5 && s.audioFeeding && s.audio.mode === 1; }, null, 40000);

// ======================================================= session 1 =======================================================
const page = await openDemo("1");
check("página aislada (COOP/COEP, hace falta SharedArrayBuffer)", await page.evaluate(() => self.crossOriginIsolated));
await page.setInputFiles("#rom", romPath);
const booted = await waitBoot(page);
check("fase 3/4: ROM cargada, vídeo dibujando, audio sonando con el reloj de audio como metrónomo", booted);
if (!booted) { console.log(consoleIssues.join("\n")); process.exit(1); }
await page.evaluate(() => window.__demo.player.setCoreOption("melonds_show_cursor", "touching"));
await sleep(800);
check("fase 6: tipo de guardado detectado (EEPROM 8 KiB) y partida nueva", /EEPROM 8 KiB/.test(await text(page, "s-savetype")) && /partida nueva/.test(await text(page, "s-origin")), `${await text(page, "s-savetype")} · ${await text(page, "s-origin")}`);

// ---- 1. audio (phase 4) ----
{
  const m = await measureAudio(page, 2000);
  results.metrics.audio = m;
  check("fase 4: audio audible (RMS del worklet)", m.rms > 0.05 && m.peak > 0.1, `RMS ${fx(m.rms, 4)} pico ${fx(m.peak)} (${m.frames} fotogramas en ${fx(m.seconds, 2)} s)`);
  check("fase 4: sin cortes en 2 s", m.underruns === 0 && m.feeding, `underruns ${m.underruns}, feeding ${m.feeding}`);
}

// ---- 2. key (phase 5) ----
let base0;
{
  base0 = await page.evaluate(PAGE.snap);
  const again = await page.evaluate(PAGE.snap);
  check("fase 5: imagen estable sin pulsar nada (línea base)", base0.hash === again.hash, `hash ${base0.hash}, color arriba ${base0.topRGB}`);
  await page.keyboard.down("KeyZ"); await sleep(400);
  const during = await page.evaluate(PAGE.snap), inp = await page.evaluate(PAGE.input);
  check("fase 5: una tecla real (Z = A, bit 8 de la máscara libretro) llega al juego y la imagen cambia", during.hash !== base0.hash && inp.mask === 256, `mask ${inp.mask}, color ${base0.topRGB} -> ${during.topRGB}`);
  await page.keyboard.up("KeyZ"); await sleep(400);
  const after = await page.evaluate(PAGE.snap);
  check("fase 5: al soltar, la imagen vuelve a la base", after.hash === base0.hash && (await page.evaluate(PAGE.input)).mask === 0);
}

// ---- 3. touch on the bottom screen (phase 5) ----
{
  const s0 = await page.evaluate(PAGE.snap, true);
  const s0b = await page.evaluate(PAGE.snap);
  check("fase 5: pantalla inferior estable sin tocar (0 píxeles de cursor frente a la referencia)", s0b.cursor.n === 0, `${s0b.cursor.n} px`);
  const [fxr, fyr] = [0.3, 0.6]; // inside the bottom screen: x in [0,256), y in [192,384)
  const tx = fxr * s0.W, ty = 192 + fyr * 192;
  const cx = s0.rect.left + (tx / s0.W) * s0.rect.width, cy = s0.rect.top + (ty / s0.H) * s0.rect.height;
  const inViewport = cy < 1300 && cx < 1400;
  await page.mouse.move(cx, cy); await page.mouse.down(); await sleep(500);
  const s1 = await page.evaluate(PAGE.snap), inp = await page.evaluate(PAGE.input);
  const dist = Math.hypot(s1.cursor.cx - tx, s1.cursor.cy - ty);
  check("fase 5: tocar la pantalla inferior dibuja el cursor del núcleo bajo el puntero", inViewport && inp.pressed && s1.cursor.n > 0 && dist <= 3.5, `objetivo (${fx(tx, 1)}, ${fx(ty, 1)}) cursor (${fx(s1.cursor.cx, 1)}, ${fx(s1.cursor.cy, 1)}) dist ${fx(dist, 2)} px, ${s1.cursor.n} px`);
  await page.mouse.up(); await sleep(500);
  const s2 = await page.evaluate(PAGE.snap);
  check("fase 5: al soltar, el cursor desaparece", s2.cursor.n === 0 && !(await page.evaluate(PAGE.input)).pressed);
  await page.mouse.move(2, 2);
}

// ---- 4. cheats (phase 8): write DS main RAM, read it back from the wasm heap ----
{
  const t = async (a) => (await peek(page, a, 4)).map((x) => x.toString(16).padStart(2, "0")).join("");
  check("fase 8: RAM de destino a cero antes del truco", (await t(0x02300000)) === "00000000");
  const errCode = await page.evaluate(() => window.__demo.player.setCheat(9, true, "ZZZZ").then(() => null, (e) => e.code));
  check("fase 8: un código inválido se rechaza con CHEAT_* (sin romper nada)", /^CHEAT_/.test(errCode ?? ""), `code ${errCode}`);
  await page.evaluate(() => window.__demo.player.setCheat(1, true, "02300000 DEADBEEF"));
  await sleep(400);
  check("fase 8: el truco activado escribe 0xDEADBEEF en 0x02300000 (leído del montón de wasm)", (await t(0x02300000)) === "efbeadde", await t(0x02300000));
  await page.evaluate(() => window.__demo.player.setCheat(2, false, "02300004 11223344"));
  await sleep(400);
  const off = await t(0x02300004);
  await page.evaluate(() => window.__demo.player.setCheat(2, true, ""));
  await sleep(400);
  const on = await t(0x02300004);
  check("fase 8: desactivado no escribe; al activarlo (mismo id, sin texto) escribe 0x11223344", off === "00000000" && on === "44332211", `off ${off} on ${on}`);
  // the same through the demo's own controls
  await page.fill("#cheatId", "3"); await page.fill("#cheatCode", "02300008 CAFEBABE"); await page.click("#cheatOn"); await sleep(400);
  check("fase 8: el panel «Trucos» de la demo funciona", (await t(0x02300008)) === "bebafeca" && /#3 ON/.test(await text(page, "s-cheats")), `${await t(0x02300008)} · ${await text(page, "s-cheats")}`);
  await page.click("#cheatClear"); await sleep(200);
  check("fase 8: «Quitar todos» limpia la lista", /ninguno/.test(await text(page, "s-cheats")));
  // the cheats must not disturb video/audio
  const m = await measureAudio(page, 1000);
  check("fase 8 + 4: con trucos activos el audio sigue sonando", m.rms > 0.05 && m.feeding, `RMS ${fx(m.rms, 4)}`);
}

// ---- 5. save RAM (phase 6) ----
let savedMarker;
{
  check("fase 6: el juego ha escrito en la EEPROM (frames 30 y 60)", await waitFor(page, async () => (await window.__demo.player.saves.getSaveNow())?.[0x10] === 0xb0, null, 20000));
  const sv = await page.evaluate(async () => Array.from(await window.__demo.player.saves.getSaveNow()));
  check("fase 6: getSave devuelve 8192 bytes con lo que escribió el juego (B0..BF en 0x10)", sv.length === 8192 && sv.slice(0x10, 0x20).every((b, i) => b === 0xb0 + i), `len ${sv.length}`);
  await sleep(1200); // debounce 500 ms + IndexedDB write
  const onSaveTxt = await text(page, "s-save");
  check("fase 6: onSave se disparó (detector de cambios del worker + debounce) y se guardó en IndexedDB", /#\d+/.test(onSaveTxt), onSaveTxt);

  const before = await counter(page);
  savedMarker = sv.slice(); for (let i = 0; i < 16; i++) savedMarker[0x100 + i] = 0x5a + i;
  const r = await page.evaluate(async (bytes) => { const x = await window.__demo.player.saves.loadSave(new Uint8Array(bytes)); return { resized: x.resized, now: Array.from((await window.__demo.player.saves.getSaveNow()).subarray(0x100, 0x110)) }; }, savedMarker);
  const afterCounter = await counter(page);
  check("fase 6: loadSave aplica el guardado y reinicia el juego", !r.resized && r.now.every((b, i) => b === 0x5a + i) && afterCounter < before, `marcador ${r.now.slice(0, 4)}, contador ${before} -> ${afterCounter}`);
  await sleep(2500);
  const sv2 = await page.evaluate(async () => Array.from(await window.__demo.player.saves.getSaveNow()));
  check("fase 6: tras reiniciar el juego vuelve a escribir y el marcador persiste", sv2.slice(0x100, 0x110).every((b, i) => b === 0x5a + i) && sv2[0x10] >= 0xa0, `0x10=${sv2[0x10].toString(16)} 0x100=${sv2[0x100].toString(16)}`);
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#dlSave")]);
  const path = await dl.path(); const { statSync } = await import("node:fs");
  check("fase 6: el botón «Descargar .sav» entrega 8192 bytes", statSync(path).size === 8192, `${statSync(path).size} bytes`);
  await sleep(1200);
}

// ---- 6. savestate (phase 6) ----
{
  await sleep(500);
  const c0 = await counter(page);
  const info = await page.evaluate(async () => { const s = await window.__demo.player.saves.saveState(); window.__state = s; return { len: s.length, magic: new TextDecoder().decode(s.subarray(0, 8)) }; });
  const c1 = await counter(page);
  check("fase 6: saveState entrega el contenedor MDSSTATE (~18 MiB)", info.magic === "MDSSTATE" && info.len > 1e6, `${(info.len / 1048576).toFixed(1)} MiB, contador ${c0}..${c1}`);
  await sleep(2000);
  const cLater = await counter(page);
  await page.evaluate(() => window.__demo.player.saves.loadState(window.__state));
  const cRestored = await counter(page);
  check("fase 6: loadState devuelve el juego al momento guardado", cLater - c1 > 60 && cRestored <= c1 + 6 && cRestored >= c0 - 1, `contador al guardar ${c0}..${c1}, antes de cargar ${cLater}, tras cargar ${cRestored}`);
  const bad = await page.evaluate(async () => { const s = window.__state.slice(); s[100] ^= 0xff; return window.__demo.player.saves.loadState(s).then(() => null, (e) => e.code); });
  await sleep(300);
  const c2 = await counter(page), c3 = (await sleep(500), await counter(page));
  check("fase 6: un estado corrupto se rechaza (STATE_CORRUPT) y el juego sigue corriendo", bad === "STATE_CORRUPT" && c3 > c2, `código ${bad}, contador ${c2} -> ${c3}`);
  // UI route: quick save + quick load buttons
  await page.click("#qsave"); await sleep(1000);
  const ca = await counter(page); await sleep(1500); await page.click("#qload"); await sleep(150);
  const cb = await counter(page);
  check("fase 6: botones «Estado rápido» de la demo (guardar y cargar)", cb < ca - 10 && /cargado/i.test(await text(page, "msg")), `contador ${ca} -> (+1,5 s) -> ${cb}; «${await text(page, "msg")}»`);
  const m = await measureAudio(page, 1500);
  check("fase 6 + 4: tras cargar estados el audio sigue sonando sin cortes prolongados", m.rms > 0.05 && m.feeding, `RMS ${fx(m.rms, 4)}, underruns ${m.underruns}`);
  const base2 = await page.evaluate(PAGE.snap);
  await page.keyboard.down("KeyZ"); await sleep(400);
  check("fase 5 + 6: la entrada sigue funcionando tras cargar el estado", (await page.evaluate(PAGE.snap)).hash !== base2.hash);
  await page.keyboard.up("KeyZ");
}

// ---- performance snapshot ----
{
  const s = await page.evaluate(PAGE.stats);
  results.metrics.perf = { emuFps: s.emuFps, emuMs: s.emuMs, drawFps: s.drawFps, underrunEvents: s.underrunEvents, overrunFrames: s.overrunFrames };
  check("rendimiento: 60 fps de emulación con todo activo", s.emuFps > 55, `${fx(s.emuFps, 1)} fps, ${fx(s.emuMs, 2)} ms/fotograma, dibujo ${fx(s.drawFps, 1)} fps`);
}

// ======================================================= session 2: "Continue" =======================================================
await page.evaluate(() => window.__demo.player.saves.flush());
await sleep(800);
await page.close();
const page2 = await openDemo("2");
await page2.setInputFiles("#rom", romPath);
const booted2 = await waitBoot(page2);
check("«Continuar»: segunda sesión (misma ROM, mismo perfil) arranca", booted2);
if (booted2) {
  const origin = await text(page2, "s-origin");
  const cur = await page2.evaluate(async () => Array.from(await window.__demo.player.saves.getSaveNow()));
  check("«Continuar»: se usa el guardado de IndexedDB (marcador 0x5A.. en 0x100)", /Continuar/.test(origin) && cur.slice(0x100, 0x110).every((b, i) => b === 0x5a + i), `${origin}; 0x100=${cur[0x100].toString(16)}`);
}

// ======================================================= console =======================================================
check("sin errores de consola, de página ni peticiones fallidas (todo el recorrido)", consoleIssues.length === 0, consoleIssues.slice(0, 5).join(" | "));
if (results.warnings.length) console.log(`(${results.warnings.length} avisos de consola, ver JSON)`);

results.failures = failures;
writeFileSync(join(out, "integration-results.json"), JSON.stringify(results, null, 2));
await browser.close(); server.close();
console.log(failures ? `\n${failures} FALLO(S) de ${results.checks.length}` : `\n${results.checks.length}/${results.checks.length} comprobaciones correctas`);
process.exit(failures ? 1 : 0);
