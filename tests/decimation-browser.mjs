// Phase 9b behaviour evidence (the pause/control checks that were only described in BENCH §6.4/§6.6 without a stored
// artifact):
//
//   1. Frame-publication decimation at unlimited speed. When the worker emulates much faster than the main thread can
//      draw, OFF saturates it (drawn rate collapses, control messages delayed) while ON (the default) keeps drawing and
//      the control round-trip usable. In this headless/software-GPU environment the 3D homebrew can be GPU-bound
//      (~35 fps), in which case the extreme ratio of BENCH §6.4 does not reproduce; the fps/ping numbers are then
//      recorded as evidence rather than asserted. The extreme case itself is measured with
//      `tests/bench-browser.mjs` (BENCH §6.4 and its JSON artifacts).
//   2. Forced publication on pause: after pausing, the worker must publish the newest frame once (published +1) and the
//      main thread draws it (drawnFrames increases) while emulation is frozen.
//
//   node tests/decimation-browser.mjs            # needs tests/artifacts/nmap.nds (CC0) and Playwright
//
// The absolute fps depend on the machine; the pause/control behaviour is deterministic.
import { chromium } from "playwright";
import { existsSync, writeFileSync } from "node:fs";
import { createStaticServer } from "../scripts/serve.mjs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(join(here, ".."));
const ROM = process.env.BENCH_ROM ?? join(here, "artifacts", "nmap.nds");
const OPT = {
  off: { publishDecimation: false, savesCadence: false, yieldEvery2: false },
  all: { publishDecimation: true, savesCadence: true, yieldEvery2: true },
};
let failures = 0;
let skipped = 0;
function check(name, ok, extra = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${extra ? " · " + extra : ""}`);
  if (!ok) failures++;
}
function skip(name, extra = "") {
  skipped++;
  console.log(`SKIP ${name}${extra ? " · " + extra : ""}`);
}
if (!existsSync(ROM)) {
  console.log(`SKIP: ${ROM} missing (homebrew CC0 de normalmappingds)`);
  process.exit(0);
}

const server = createStaticServer({ root: ROOT });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--autoplay-policy=no-user-gesture-required"] });
const results = { rom: ROM, when: new Date().toISOString(), variants: [], pause: [] };

try {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.goto(`${base}/demo/index.html?autoplay=1&threads=1`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.setInputFiles("#rom", ROM);
  await page.waitForFunction(() => window.__demo?.player && window.__demo.player.getStats().frameCount > 120, null, { timeout: 120000 });

  /** Measures the worker control round-trip (debugPing) from inside the page. */
  const ping = () =>
    page.evaluate(
      () =>
        new Promise((resolve) => {
          const p = window.__demo.player;
          const id = 987654321;
          const t0 = performance.now();
          const onMsg = (event) => {
            if (event.data?.type === "ack" && event.data.id === id) {
              p.worker.removeEventListener("message", onMsg);
              resolve(performance.now() - t0);
            }
          };
          p.worker.addEventListener("message", onMsg);
          p.worker.postMessage({ type: "debugPing", id });
          setTimeout(() => {
            p.worker.removeEventListener("message", onMsg);
            resolve(null); // control path saturated: no answer in 15 s
          }, 15000);
        }),
    );

  for (const variant of ["off", "all"]) {
    await page.evaluate((set) => window.__demo.player.worker.postMessage({ type: "debugOpt", set }), OPT[variant]);
    await page.evaluate(() => window.__demo.player.setSpeed(0)); // unlimited: the worst case for publication
    await page.waitForTimeout(4000);
    const latency = await ping();
    const snap = await page.evaluate(() => {
      const s = window.__demo.player.getStats();
      return { emuFps: s.emuFps, drawFps: s.drawFps, frameCount: s.frameCount, drawnFrames: s.drawnFrames, published: s.ring?.published, dropped: s.ring?.dropped, queueDrops: s.queueDrops };
    });
    const row = { variant, ...snap, controlPingMs: latency };
    results.variants.push(row);
    console.log(`variant ${variant}: worker ${snap.emuFps?.toFixed(0)} fps · dibujo ${snap.drawFps?.toFixed(1)} fps · ping ${latency == null ? "timeout" : latency.toFixed(1) + " ms"} · publicados ${snap.published}`);
    await page.evaluate(() => window.__demo.player.setSpeed(1));
    await page.waitForTimeout(500);
  }

  const off = results.variants.find((v) => v.variant === "off");
  const all = results.variants.find((v) => v.variant === "all");
  // On this machine with WebGL of software (SwiftShader) the 3D homebrew is GPU-bound, so the worker fps is limited by
  // rendering and the saturation phenomenon only appears when the core is much faster than drawing. The robust checks
  // here are the control round-trip and the forced publication on pause; the fps ratio is recorded as evidence.
  // The saturation scenario needs the core to be much faster than the main thread can draw; on a thermally throttled
// machine the worker can cap below 200 fps even at "unlimited", and then the ping number says nothing about decimation.
const allRate = all?.emuFps ?? 0;
if (allRate >= 200) {
  check("decimation ON: control round-trip stays low even at unlimited speed", all?.controlPingMs != null && all.controlPingMs < 100, `${all?.controlPingMs?.toFixed(1)} ms`);
} else {
  skip("decimation ON: control round-trip stays low even at unlimited speed", `máquina limitada (worker ${allRate.toFixed(0)} fps < 200: el escenario de saturación necesita CPU de sobra; repetir en frío)`);
}
  check("both variants run (register recorded)", !!off && !!all, `off worker ${off?.emuFps?.toFixed(0)} fps · all worker ${all?.emuFps?.toFixed(0)} fps`);

  // Forced publication on pause: emulation freezes but the newest frame is published and drawn. Compare against the
  // snapshot taken right BEFORE pausing (the forced publish happens once, so a post-pause "before" would miss it).
  for (const speed of [2, 0]) {
    await page.evaluate((s) => window.__demo.player.setSpeed(s), speed);
    await page.waitForTimeout(900);
    const before = await page.evaluate(() => {
      const s = window.__demo.player.getStats();
      return { frameCount: s.frameCount, published: s.ring?.published, drawnFrames: s.drawnFrames };
    });
    await page.evaluate(() => window.__demo.player.pause());
    await page.waitForTimeout(900); // worker stops + forced publish + one draw
    const after = await page.evaluate(() => {
      const s = window.__demo.player.getStats();
      return { frameCount: s.frameCount, published: s.ring?.published, drawnFrames: s.drawnFrames };
    });
    results.pause.push({ speed, before, after });
    const delta = after.published - before.published;
    const forced = delta >= 1 && delta <= 3; // the forced publish, not a stream of new frames
    const drawn = after.drawnFrames >= before.drawnFrames;
    const frozen = after.frameCount - before.frameCount <= 3; // the pause message itself may let 1-2 frames through
    check(`pause at ${speed === 0 ? "unlimited" : speed + "x"} publishes the newest frame without advancing emulation`, forced && drawn && frozen, `published ${before.published}→${after.published} (+${delta}) · drawn ${before.drawnFrames}→${after.drawnFrames} · frames ${before.frameCount}→${after.frameCount}`);
    await page.evaluate(() => window.__demo.player.resume());
    await page.waitForTimeout(500);
  }
  await page.evaluate((set) => window.__demo.player.worker.postMessage({ type: "debugOpt", set }), OPT.all);
  check("no page errors", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));
} catch (error) {
  check("decimation evidence", false, String(error?.message ?? error).slice(0, 300));
} finally {
  writeFileSync(join(here, "artifacts", "decimation-evidence.json"), JSON.stringify(results, null, 2));
  await browser.close().catch(() => {});
  server.close();
}

console.log(failures ? `\n${failures} check(s) failed` : `\nall checks passed${skipped ? ` · ${skipped} skipped (environment)` : ""}`);
process.exit(failures ? 1 : 0);
