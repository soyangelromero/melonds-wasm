// Optional (needs internet + the EmulatorJS CDN): the fallback really plays the 512 MB ROM. When the WASM engine
// rejects a ROM with ROM_TOO_LARGE, nds/index.html offers the "Jugar con el motor melonDS (EmulatorJS)" button (Spanish UI text); this test opens
// that exact URL and waits for the old core to start, so the claim "the whole NDS library is playable in the web app
// today" has direct evidence (the port for 3 ROMs, EmulatorJS for the 512 MB one until the 2 GiB rebuild).
//
//   node tests/fallback-emulatorjs-browser.mjs
//   HUB=http://127.0.0.1:8080 node tests/fallback-emulatorjs-browser.mjs
//
// Slow (~30 s) and network-dependent: not part of `npm test`.
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const HUB = process.env.HUB ?? "http://127.0.0.1:8080";
const HUB_DIR = resolve(join(here, "..", ".."));
const CDN = "https://cdn.emulatorjs.org/latest/data/loader.js";

let failures = 0;
function check(name, ok, extra = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${extra ? " · " + extra : ""}`);
  if (!ok) failures++;
}
async function reachable(url, timeout = 5000) {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(timeout) })).ok;
  } catch {
    return false;
  }
}

if (!(await reachable(CDN, 8000))) {
  console.log(`SKIP: EmulatorJS CDN not reachable (${CDN}); this optional test needs internet`);
  process.exit(0);
}
let hub = null;
if (!(await reachable(`${HUB}/nds/api/roms`, 2500))) {
  console.log(`hub not running; starting ${join(HUB_DIR, "server.mjs")}`);
  hub = spawn(process.execPath, [join(HUB_DIR, "server.mjs")], { cwd: HUB_DIR, stdio: "ignore" });
  for (let i = 0; i < 40 && !(await reachable(`${HUB}/nds/api/roms`, 2500)); i++) await new Promise((r) => setTimeout(r, 250));
}

const roms = await (await fetch(`${HUB}/nds/api/roms`)).json();
const big = roms.find((r) => r.code === "IRES") ?? roms.slice().sort((a, b) => b.size - a.size)[0];
if (!big) {
  console.log("SKIP: no NDS ROM in the library");
  process.exit(0);
}

const browser = await chromium.launch({ args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--autoplay-policy=no-user-gesture-required"] });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 750 } });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  // Resource 404s from the EmulatorJS CDN / favicon are not page errors and do not prevent play.
  const url = `${HUB}/nds/?core=melonds&play=${big.id}`;
  console.log(`opening ${url} (${big.code}, ${(big.size / 1048576).toFixed(0)} MB)`);
  const started = Date.now();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(
    () => window.EJS_emulator?.started === true || document.querySelector("#statusText")?.textContent?.includes("Jugando"),
    null,
    { timeout: 240000 },
  );
  const bootMs = Date.now() - started;
  const state = await page.evaluate(() => {
    const canvas = document.querySelector("#ejs canvas");
    return {
      status: document.querySelector("#statusText")?.textContent ?? "",
      started: !!window.EJS_emulator,
      canvas: canvas ? { w: canvas.width, h: canvas.height } : null,
    };
  });
  check("the EmulatorJS fallback starts the 512 MB ROM", state.started && /Jugando/i.test(state.status), `${(bootMs / 1000).toFixed(1)} s · ${state.status}`);
  check("the old core draws on a canvas", !!state.canvas && state.canvas.w > 200 && state.canvas.h > 200, JSON.stringify(state.canvas));
  check("no page errors on the fallback path", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));
  await page.screenshot({ path: join(here, "artifacts", "fallback-emulatorjs-negra2.png") }).catch(() => {});
} catch (error) {
  check("EmulatorJS fallback", false, String(error?.message ?? error).slice(0, 300));
} finally {
  await browser.close().catch(() => {});
  if (hub) hub.kill();
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
