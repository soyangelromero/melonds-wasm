// Cross-browser smoke test: the same port/demo must boot in Chromium, Firefox and WebKit (the Safari engine) with
// cross-origin isolation (SharedArrayBuffer + wasm threads), load a ROM from the file picker and run frames.
//
//   node tests/cross-browser-smoke.mjs
//   ENGINES=chromium,firefox node tests/cross-browser-smoke.mjs
//   SKIP_WEBAPP=1 node tests/cross-browser-smoke.mjs      # demo only
//
// Missing Playwright browser builds are SKIPPED (install with `npx playwright install firefox webkit`). This machine has
// Chromium; Firefox/WebKit are optional but the result is saved as evidence for the "Firefox/Safari untested" limit.
// After the demo, it also opens the real web app (`nds/?engine=wasm&play=<first ROM>`) in each engine if the hub on :8080
// is running, which is the definitive "playable in a web app" cross-browser check.
import { chromium, firefox, webkit } from "playwright";
import { createStaticServer } from "../scripts/serve.mjs";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(join(here, ".."));
const ROM = process.env.BENCH_ROM ?? join(here, "artifacts", "nmap.nds");
const WANTED = (process.env.ENGINES ?? "chromium,firefox,webkit").split(",").map((s) => s.trim().toLowerCase());
const ENGINES = { chromium, firefox, webkit };
const HUB = process.env.HUB ?? "http://127.0.0.1:8080";
const SKIP_WEBAPP = process.env.SKIP_WEBAPP === "1";
const ARGS = {
  chromium: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--autoplay-policy=no-user-gesture-required"],
  firefox: [],
  webkit: [],
};
// Firefox headless throttles timers of background-looking pages; disable the budget throttling for a fair measurement.
const PREFS = {
  firefox: {
    "dom.timeout.enable_budget_timer_throttling": false,
    "dom.timeout.background_throttling_max_budget": -1,
    "dom.min_background_timeout_value": 4,
    "widget.non-native-theme.enabled": false,
  },
};

if (!existsSync(ROM)) {
  console.log(`SKIP: ${ROM} missing (CC0 homebrew; tests/artifacts/nmap.nds)`);
  process.exit(0);
}
const hubUp = await (async () => {
  try { return (await fetch(`${HUB}/nds/api/roms`, { signal: AbortSignal.timeout(2500) })).ok; } catch { return false; }
})();
const webappRom = hubUp && !SKIP_WEBAPP ? (await (await fetch(`${HUB}/nds/api/roms`)).json()).sort((a, b) => a.size - b.size)[0] : null;
const server = createStaticServer({ root: ROOT });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
console.log(`serving ${ROOT} at ${base}/demo/index.html · ROM ${ROM.split(/[\\/]/).pop()}${webappRom ? ` · web app ROM ${webappRom.code} (${(webappRom.size / 1048576).toFixed(0)} MB)` : ""}`);

const results = [];
for (const name of WANTED) {
  const engine = ENGINES[name];
  if (!engine) { results.push({ name, status: "SKIP", why: "unknown engine" }); continue; }
  let browser = null;
  try {
    browser = await engine.launch({ headless: true, args: ARGS[name] ?? [], ...(PREFS[name] ? { firefoxUserPrefs: PREFS[name] } : {}) });
  } catch (error) {
    results.push({ name, status: "SKIP", why: `browser not installed: ${String(error.message ?? error).split("\n")[0]}` });
    console.log(`SKIP ${name}: ${results.at(-1).why}`);
    continue;
  }
  const result = { name, demo: null, webapp: null };
  // 1. Demo (VideoPlayer + file picker).
  {
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    const pageErrors = [];
    const consoleErrors = [];
    page.on("pageerror", (e) => pageErrors.push(String(e)));
    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
    try {
      await page.goto(`${base}/demo/index.html?autoplay=1`, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.bringToFront();
      await page.mouse.click(400, 300).catch(() => {}); // unlock the AudioContext (a real user gesture)
      const caps = await page.evaluate(() => ({
        isolated: self.crossOriginIsolated === true,
        sab: typeof SharedArrayBuffer !== "undefined",
        audioWorklet: typeof AudioWorkletNode !== "undefined",
        webgl2: (() => { try { return !!document.createElement("canvas").getContext("webgl2"); } catch { return false; } })(),
        ua: navigator.userAgent,
      }));
      await page.setInputFiles("#rom", ROM);
      await page.waitForFunction(() => window.__demo?.player && window.__demo.player.getStats().frameCount > 30, null, { timeout: 120000 });
      const info = await page.evaluate(() => {
        const s = window.__demo.player.getStats();
        const c = document.querySelector("#screen");
        return { backend: s.backend, frames: s.frameCount, drawn: s.drawnFrames, workers: s.workers, canvas: { w: c.width, h: c.height }, save: window.__demo.player.saves.getSave()?.length ?? 0 };
      });
      const ok = caps.isolated && caps.sab && info.frames > 30 && info.drawn > 5 && info.canvas.w >= 256 && pageErrors.length === 0;
      result.demo = { status: ok ? "PASS" : "FAIL", caps, info, pageErrors: pageErrors.slice(0, 3), consoleErrors: consoleErrors.slice(0, 3) };
      console.log(`${ok ? "PASS" : "FAIL"} ${name} demo: isolated=${caps.isolated} sab=${caps.sab} worklet=${caps.audioWorklet} webgl2=${caps.webgl2} backend=${info.backend} frames=${info.frames} drawn=${info.drawn} canvas=${info.canvas.w}x${info.canvas.h} save=${info.save} pageerrors=${pageErrors.length}`);
    } catch (error) {
      result.demo = { status: "FAIL", why: String(error?.message ?? error).slice(0, 300), pageErrors: pageErrors.slice(0, 3), consoleErrors: consoleErrors.slice(0, 3) };
      console.log(`FAIL ${name} demo: ${result.demo.why}`);
    } finally {
      await page.close().catch(() => {});
    }
  }
  // 2. The real web app with the WASM engine (the definitive "playable in a web app" check).
  if (webappRom) {
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(String(e)));
    try {
      const started = Date.now();
      await page.goto(`${HUB}/nds/?engine=wasm&play=${webappRom.id}`, { waitUntil: "domcontentloaded", timeout: 90000 });
      await page.bringToFront();
      await page.mouse.click(400, 300).catch(() => {}); // unlock audio: the audio clock is the 1x metronome
      const isolated = await page.evaluate(() => self.crossOriginIsolated === true);
      await page.waitForFunction(() => !!window.EJS_emulator, null, { timeout: 240000 });
      await page.waitForFunction(() => window.EJS_emulator.gameManager.getFrameNum() > 60, null, { timeout: 180000 });
      const painted = await page
        .waitForFunction(
          () => {
            const frame = window.EJS_emulator.melonDS.getFrame();
            if (!frame) return false;
            for (let i = 0; i + 2 < frame.data.length; i += 4096) if (frame.data[i] > 10 || frame.data[i + 1] > 10 || frame.data[i + 2] > 10) return true;
            return false;
          },
          null,
          { timeout: 120000 },
        )
        .then(() => true)
        .catch(() => false);
      const info = await page.evaluate(async () => ({
        rom: window.EJS_emulator.romInfo,
        fps: window.EJS_emulator.stats.fps,
        saveLen: (await window.EJS_emulator.getSave())?.length ?? 0,
      }));
      const ok = isolated && painted && info.rom?.code === webappRom.code && info.saveLen >= 512 && pageErrors.length === 0;
      result.webapp = { status: ok ? "PASS" : "FAIL", isolated, painted, info, bootMs: Date.now() - started, pageErrors: pageErrors.slice(0, 3) };
      console.log(`${ok ? "PASS" : "FAIL"} ${name} webapp: isolated=${isolated} painted=${painted} rom=${info.rom?.code} ${info.fps?.toFixed(1)} fps save=${info.saveLen} boot=${((Date.now() - started) / 1000).toFixed(1)} s pageerrors=${pageErrors.length}`);
      await page.screenshot({ path: join(here, "artifacts", `cross-browser-${name}.png`) }).catch(() => {});
    } catch (error) {
      result.webapp = { status: "FAIL", why: String(error?.message ?? error).slice(0, 300), pageErrors: pageErrors.slice(0, 3) };
      console.log(`FAIL ${name} webapp: ${result.webapp.why}`);
    } finally {
      await page.close().catch(() => {});
    }
  }
  // Overall status: PASS only if demo and (when applicable) webapp pass.
  const statuses = [result.demo?.status, result.webapp?.status].filter(Boolean);
  result.status = statuses.includes("FAIL") ? "FAIL" : statuses.length ? "PASS" : "SKIP";
  results.push(result);
  await browser.close().catch(() => {});
}
server.close();

const { writeFileSync } = await import("node:fs");
writeFileSync(join(here, "artifacts", "cross-browser-results.json"), JSON.stringify({ when: new Date().toISOString(), base, rom: ROM, results }, null, 2));
const failed = results.filter((r) => r.status === "FAIL").length;
console.log(`\nsummary: ${results.map((r) => `${r.name}=${r.status}`).join(" ")}`);
process.exit(failed ? 1 : 0);
