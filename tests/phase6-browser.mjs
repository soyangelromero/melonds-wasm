// Phase 6 browser test: the real worker + SaveClient (js/player.js -> js/emu-worker.js -> wasm) in headless Chromium, with the
// synthetic cartridge of tests/lib/synth-rom.mjs. Nothing is downloaded or uploaded.
//   node tests/phase6-browser.mjs          (needs dist/ built and `playwright` resolvable, like tests/phase3-browser.mjs)
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createStaticServer } from "../scripts/serve.mjs";
import { buildSynthRom, SYNTH_SAVE_SIZE, SYNTH_WRITE_OFFSET } from "./lib/synth-rom.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function loadPlaywright() {
  for (const base of [null, execSync("npm root -g", { encoding: "utf8" }).trim() + "/"]) {
    try { return (base ? createRequire(base) : createRequire(join(root, "package.json")))("playwright"); } catch { /* next */ }
  }
  throw new Error("playwright not found (npm i -D playwright, or a global install)");
}
const { chromium } = loadPlaywright();
const out = join(root, "tests", "artifacts");
mkdirSync(out, { recursive: true });
const romPath = join(out, "synth.nds");
writeFileSync(romPath, buildSynthRom());

let failures = 0;
const check = (name, ok, detail = "") => { if (!ok) failures++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = createStaticServer({ root });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
console.log(`Chromium ${browser.version()}, server ${base}`);
const context = await browser.newContext({ viewport: { width: 1000, height: 800 } });
const page = await context.newPage();
const issues = [];
page.on("console", (m) => { if (m.type() === "error") issues.push(`console.error: ${m.text()}`); });
page.on("pageerror", (e) => issues.push(`pageerror: ${e.message}`));

await page.goto(`${base}/demo/saves.html`);
check("crossOriginIsolated", await page.evaluate(() => crossOriginIsolated));

// 1) Drive the demo UI: ROM without .sav -> save type reported, onSave fires after the game's EEPROM writes (frames 30 and 60).
await page.setInputFiles("#rom", romPath);
const waitFor = async (fn, arg, timeout = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < timeout) { if (await page.evaluate(fn, arg)) return true; await sleep(50); } return false; };
check("player created and ROM loaded", await waitFor(() => window.__saves?.player?.saves.info.length > 0));
const info = await page.evaluate(() => window.__saves.player.saves.info);
check("save type reported by loadRom", info.length === SYNTH_SAVE_SIZE && info.type === "EEPROM 8 KiB" && info.status === 0, JSON.stringify(info));

const O = SYNTH_WRITE_OFFSET;
await page.evaluate((O) => {
  window.__events = [];
  window.__saves.player.saves.onSave((b) => window.__events.push({ at: performance.now(), len: b.length, win: Array.from(b.subarray(O, O + 16)), first: b[0], rest: b.subarray(32).every((x) => x === 0xff) }), 300);
}, O);
check("onSave fires after the first game write (debounced)", await waitFor(() => window.__events.length >= 1, null, 20000));
const first = (await page.evaluate(() => window.__events[0]));
check("first onSave carries the exact EEPROM bytes (8192, 0xA0..0xAF at 0x10, rest 0xFF)", first.len === SYNTH_SAVE_SIZE && first.win.every((v, i) => v === 0xa0 + i) && first.rest);
check("second onSave after the second write (0xB0..0xBF)", await waitFor(() => window.__events.length >= 2, null, 20000));
await sleep(1500);
const evs = await page.evaluate(() => window.__events);
check("exactly one onSave per burst of writes (2 total), no spurious events", evs.length === 2, `events=${evs.length}`);
check("second event bytes", evs[1].win.every((v, i) => v === 0xb0 + i));

// 2) getSave (sync cache) and getSaveNow (live) agree with the last event.
const g = await page.evaluate((O) => ({ cached: Array.from(window.__saves.player.saves.getSave().subarray(O, O + 16)) }), O);
check("getSave() (cached) = latest bytes", g.cached.every((v, i) => v === 0xb0 + i));
const live = await page.evaluate(async () => (await window.__saves.player.saves.getSaveNow()).length);
check("getSaveNow() length", live === SYNTH_SAVE_SIZE);

// 3) savestate through the worker; a state file survives a modify + restart; tampering is rejected with the right code.
const st = await page.evaluate(async () => {
  const p = window.__saves.player; p.pause(); await new Promise((r) => setTimeout(r, 100));
  const s = await p.saves.saveState();
  window.__state = s;
  return { len: s.length, magic: new TextDecoder().decode(s.subarray(0, 8)) };
});
check("saveState() returns the MDSSTATE container", st.magic === "MDSSTATE" && st.len > 1_000_000, `${st.len} bytes`);
const restored = await page.evaluate(async (size) => {
  const p = window.__saves.player;
  const before = Array.from(await p.saves.getSaveNow());
  const r = await p.saves.loadSave(new Uint8Array(size).fill(0x11));
  const mid = Array.from(await p.saves.getSaveNow());
  await p.saves.loadState(window.__state);
  const after = Array.from(await p.saves.getSaveNow());
  return { before, mid, after, resized: r.resized };
}, SYNTH_SAVE_SIZE);
check("loadSave() replaces the SRAM (all 0x11) and restarts", restored.mid.every((v) => v === 0x11) && restored.resized === false);
check("loadState() brings back the SRAM of the saved moment", restored.after.length === SYNTH_SAVE_SIZE && restored.after.every((v, i) => v === restored.before[i]));

const errors = await page.evaluate(async () => {
  const p = window.__saves.player, good = window.__state, res = {};
  const dv = (b) => new DataView(b.buffer);
  const tries = {
    STATE_VERSION: () => { const b = good.slice(); dv(b).setUint32(8, 7, true); return b; },
    STATE_INCOMPATIBLE: () => { const b = good.slice(); dv(b).setUint32(16, dv(b).getUint32(16, true) ^ 1, true); return b; },
    STATE_CORRUPT: () => { const b = good.slice(); b[40000] ^= 1; return b; },
  };
  for (const [want, make] of Object.entries(tries)) {
    try { await p.saves.loadState(make()); res[want] = "no error"; } catch (e) { res[want] = e.code; }
  }
  return res;
});
for (const [want, got] of Object.entries(errors)) check(`loadState error crosses the worker boundary: ${want}`, got === want, `got ${got}`);

// 4) "Close and reopen" analogue of the key regression test: getSave() -> dispose -> new player -> loadRom({save}).
const reopen = await page.evaluate(async (O) => {
  const { VideoPlayer } = await import("/js/player.js");
  const old = window.__saves.player;
  await old.saves.loadState(window.__state);
  const saved = await old.saves.getSaveNow();          // what the host app would persist
  await old.dispose();
  const canvas = document.createElement("canvas");
  const p = await VideoPlayer.create({ canvas, container: document.body, moduleUrl: new URL("/dist/melonds.js", location.href) });
  const rom = new Uint8Array(await (await fetch("/tests/artifacts/synth.nds")).arrayBuffer());
  let loaded = null; p.on("loaded", (m) => { loaded = m; });
  await p.loadRom(rom, { save: saved });                // before start(): the game has not run a single frame
  const atLoad = await p.saves.getSaveNow();
  window.__saves.player = p;
  return { same: atLoad.length === saved.length && atLoad.every((v, i) => v === saved[i]), status: loaded.saveStatus, len: loaded.saveLen, nonFF: saved.some((v) => v !== 0xff) };
}, O);
check("reopen: loadRom(rom, {save: getSave()}) returns exactly the same bytes before the first frame", reopen.same && reopen.nonFF && reopen.status === 0 && reopen.len === SYNTH_SAVE_SIZE);

// 5) Persistence across a page reload through the demo (IndexedDB, demo-only convenience).
await page.reload();
await page.setInputFiles("#rom", romPath);
check("demo reuses the autosaved .sav after a reload", await waitFor(() => /IndexedDB/.test(document.getElementById("s-origin").textContent)), await page.evaluate(() => document.getElementById("s-origin").textContent));

check("no console or page errors", issues.length === 0, issues.join(" | "));
await browser.close();
server.close();
console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
