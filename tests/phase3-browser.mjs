// Phase 3 browser test: headless Chromium (Playwright) drives demo/index.html with a homebrew ROM (never uploaded).
// Usage: node tests/phase3-browser.mjs <rom.nds> [--gl=default|swiftshader] [--seconds=6] [--keep-going]
// Needs: dist/melonds.{js,wasm} built (scripts/build-core.sh + build-host.sh) and `playwright` resolvable
// (npm i -D playwright, or a global install). Results: stdout + tests/artifacts/phase3-browser-results.json + PNGs.
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createStaticServer } from "../scripts/serve.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const args = process.argv.slice(2);
const flags = Object.fromEntries(args.filter((a) => a.startsWith("--")).map((a) => { const [k, v = "1"] = a.slice(2).split("="); return [k, v]; }));
const romPath = args.find((a) => !a.startsWith("--"));
if (!romPath) { console.error("usage: node tests/phase3-browser.mjs <rom.nds> [--gl=default|swiftshader] [--seconds=6]"); process.exit(2); }
const seconds = Number(flags.seconds ?? 6);

function loadPlaywright() {
  const req = createRequire(join(root, "package.json"));
  for (const base of [null, execSync("npm root -g", { encoding: "utf8" }).trim() + "/"]) {
    try { return (base ? createRequire(base) : req)("playwright"); } catch { /* try next */ }
  }
  throw new Error("playwright not found: run `npm i -D playwright` (Chromium: `npx playwright install chromium`) or install it globally");
}
const { chromium } = loadPlaywright();

const out = join(root, "tests", "artifacts");
mkdirSync(join(out, "layouts"), { recursive: true });
const results = { when: new Date().toISOString(), gl: flags.gl ?? "default", checks: [], metrics: {} };
let failures = 0;
function check(name, ok, detail = "") {
  results.checks.push({ name, ok: !!ok, detail });
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Display size (after frontend rotation) the core produced for each layout in tests/phase3-layouts.mjs on the real core.
const EXPECTED = {
  "Top/Bottom": [256, 384], "Bottom/Top": [256, 384], "Left/Right": [512, 192], "Right/Left": [512, 192],
  "Top Only": [256, 192], "Bottom Only": [256, 192],
  "Large Screen (Focus Top)": [768, 384], "Large Screen (Focus Bottom)": [768, 384],
  "Flipped Large Screen (Focus Top)": [768, 384], "Flipped Large Screen (Focus Bottom)": [768, 384],
  "Hybrid (Focus Top)": [768, 384], "Hybrid (Focus Bottom)": [768, 384],
  "Flipped Hybrid (Focus Top)": [768, 384], "Flipped Hybrid (Focus Bottom)": [768, 384],
  "Rotated Left": [384, 256], "Rotated Right": [384, 256], "Upside Down": [256, 384],
};

const server = createStaticServer({ root });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const launchArgs = flags.gl === "swiftshader" ? ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] : [];
const browser = await chromium.launch({ args: launchArgs });
results.browser = browser.version();
console.log(`Chromium ${results.browser}, gl=${results.gl}, server ${base}`);

// ---- in-page helpers (serialised into the page) -------------------------------------------------------------
const PAGE = {
  // Compare the visible canvas with the frame the player last drew, after applying the frontend rotation.
  compare: () => {
    const p = window.__demo.player, canvas = window.__demo.canvas;
    const f = p.getFrame();
    if (!f) return { error: "no frame" };
    const c = document.createElement("canvas"); c.width = canvas.width; c.height = canvas.height;
    const x = c.getContext("2d"); x.drawImage(canvas, 0, 0);
    const img = x.getImageData(0, 0, c.width, c.height).data;
    const W = canvas.width, H = canvas.height, k = f.rotation;
    const src = new Uint32Array(f.data.buffer, f.data.byteOffset, f.data.byteLength >> 2);
    const rowPx = f.stride >> 2;
    let bad = 0, nonBlack = 0; const colors = new Set();
    for (let Y = 0; Y < H; Y++) for (let X = 0; X < W; X++) {
      let sx = X, sy = Y;
      if (k === 1) { sx = f.width - 1 - Y; sy = X; } else if (k === 2) { sx = f.width - 1 - X; sy = f.height - 1 - Y; } else if (k === 3) { sx = Y; sy = f.height - 1 - X; }
      const px = src[sy * rowPx + sx];
      const o = (Y * W + X) * 4;
      if (img[o] !== ((px >> 16) & 255) || img[o + 1] !== ((px >> 8) & 255) || img[o + 2] !== (px & 255) || img[o + 3] !== 255) bad++;
      if (img[o] | img[o + 1] | img[o + 2]) nonBlack++;
      if (colors.size < 64) colors.add((img[o] << 16) | (img[o + 1] << 8) | img[o + 2]);
    }
    return { W, H, frameW: f.width, frameH: f.height, rotation: k, stride: f.stride, mismatches: bad, nonBlack, total: W * H, distinctColors: colors.size };
  },
  pixel: ([X, Y]) => {
    const canvas = window.__demo.canvas;
    const c = document.createElement("canvas"); c.width = canvas.width; c.height = canvas.height;
    const x = c.getContext("2d"); x.drawImage(canvas, 0, 0);
    return Array.from(x.getImageData(X, Y, 1, 1).data);
  },
  size: () => [window.__demo.canvas.width, window.__demo.canvas.height],
  stats: () => window.__demo.player.getStats(),
  cssRect: () => { const r = window.__demo.canvas.getBoundingClientRect(); return { w: r.width, h: r.height, bw: window.__demo.canvas.width, bh: window.__demo.canvas.height }; },
};

async function waitFor(page, fn, arg, timeout = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { if (await page.evaluate(fn, arg)) return true; await sleep(50); }
  return false;
}

async function openDemo({ query = "", viewport = { width: 1280, height: 900 } } = {}) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const consoleIssues = [];
  page.on("console", (m) => { if (m.type() === "error") consoleIssues.push(`console.error: ${m.text()}`); });
  page.on("pageerror", (e) => consoleIssues.push(`pageerror: ${e.message}`));
  page.on("requestfailed", (r) => consoleIssues.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));
  await page.goto(`${base}/demo/index.html${query}`);
  return { page, context, consoleIssues };
}

async function loadRomAndWait(page, minFrames = 20) {
  await page.setInputFiles("#rom", romPath); // the ROM is read by the page from the file chooser; nothing is uploaded
  const ok = await waitFor(page, (n) => window.__demo.player && window.__demo.player.getStats().drawnFrames >= n, minFrames, 60000);
  return ok;
}

// ---- Run 1: WebGL2, threaded 3D renderer --------------------------------------------------------------------
{
  const { page, context, consoleIssues } = await openDemo();
  check("crossOriginIsolated", await page.evaluate(() => crossOriginIsolated) === true);
  const gl = await page.evaluate(() => {
    const c = document.createElement("canvas"); const g = c.getContext("webgl2");
    if (!g) return null; const e = g.getExtension("WEBGL_debug_renderer_info");
    return { renderer: e ? g.getParameter(e.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER), version: g.getParameter(g.VERSION) };
  });
  results.webgl = gl;
  check("WebGL2 available in this Chromium", !!gl, gl ? `${gl.renderer} / ${gl.version}` : "no WebGL2");

  const loaded = await loadRomAndWait(page);
  check("ROM boots and frames are drawn", loaded);
  if (!loaded) { console.log(consoleIssues.join("\n")); await browser.close(); server.close(); process.exit(1); }
  check("backend is webgl2", (await page.evaluate(PAGE.stats)).backend === "webgl2");

  let cmp = await page.evaluate(PAGE.compare);
  check("canvas not empty/black", cmp.nonBlack > cmp.total * 0.2 && cmp.distinctColors > 8, `${cmp.nonBlack}/${cmp.total} non-black px, ${cmp.distinctColors}+ colours`);
  check("canvas is pixel-identical to the core frame (XRGB->RGBA, stride)", cmp.mismatches === 0, `${cmp.W}x${cmp.H}, stride ${cmp.stride}, mismatches ${cmp.mismatches}`);
  check("backing store = frame size", cmp.W === 256 && cmp.H === 384);
  await page.screenshot({ path: join(out, "layouts", "00-page.png") });

  // CSS scaling: backing store untouched, canvas rectangle == frame aspect (no bars => canvas coords == pointer space)
  const rect = await page.evaluate(PAGE.cssRect);
  check("CSS scales the canvas, aspect preserved", Math.abs(rect.w / rect.h - rect.bw / rect.bh) < 0.01 && rect.w >= rect.bw, `css ${rect.w.toFixed(1)}x${rect.h.toFixed(1)} for ${rect.bw}x${rect.bh}`);

  // All 17 layouts: size changes to the expected one and the canvas is pixel-identical to the (rotated) core frame
  for (const [label, [w, h]] of Object.entries(EXPECTED)) {
    await page.selectOption("#layout", label);
    const changed = await waitFor(page, ([W, H]) => { const [cw, ch] = window.__demo.canvas ? [window.__demo.canvas.width, window.__demo.canvas.height] : [0, 0]; return cw === W && ch === H; }, [w, h], 8000);
    await sleep(150); // let a couple of frames in the new layout land
    const c = await page.evaluate(PAGE.compare);
    check(`layout "${label}" -> ${w}x${h}`, changed && c.W === w && c.H === h && c.mismatches === 0 && c.nonBlack > c.total * 0.05,
      `canvas ${c.W}x${c.H}, frame ${c.frameW}x${c.frameH} rot=${c.rotation}, mismatches ${c.mismatches}`);
    await page.locator("#screen").screenshot({ path: join(out, "layouts", `${String(Object.keys(EXPECTED).indexOf(label) + 1).padStart(2, "0")}-${label.replace(/[^A-Za-z]+/g, "_")}.png`) });
  }

  // Gap
  await page.selectOption("#layout", "Top/Bottom");
  await waitFor(page, () => window.__demo.canvas.height === 384, null, 8000);
  for (const [gap, H] of [[40, 424], [126, 510], [0, 384]]) {
    await page.evaluate((g) => { const el = document.getElementById("gap"); el.value = g; el.dispatchEvent(new Event("input")); }, gap);
    const ok = await waitFor(page, (hh) => window.__demo.canvas.height === hh, H, 8000);
    await sleep(100);
    const c = await page.evaluate(PAGE.compare);
    check(`gap ${gap}px -> height ${H}`, ok && c.mismatches === 0, `canvas ${c.W}x${c.H}`);
  }

  // Hybrid small-screen option reaches the core (accepted, frame stays valid)
  await page.selectOption("#layout", "Hybrid (Focus Top)");
  await waitFor(page, () => window.__demo.canvas.width === 768, null, 8000);
  await page.selectOption("#hybrid", "one"); await sleep(300);
  let c = await page.evaluate(PAGE.compare);
  check("hybrid small screen 'one' keeps a valid frame", c.mismatches === 0 && c.nonBlack > 0, `${c.W}x${c.H}`);
  await page.selectOption("#hybrid", "both");
  await page.selectOption("#layout", "Top/Bottom");
  await waitFor(page, () => window.__demo.canvas.width === 256 && window.__demo.canvas.height === 384, null, 8000);

  // Post-process: scanlines darken every second displayed row by 30%; sharp restores exact pixels
  await page.selectOption("#filter", "scanlines"); await sleep(300);
  const base0 = await page.evaluate(PAGE.compare); // mismatches expected now (filter active)
  const even = await page.evaluate(PAGE.pixel, [100, 100]), odd = await page.evaluate(PAGE.pixel, [100, 101]);
  const frameRow = await page.evaluate(() => { const f = window.__demo.player.getFrame(); const w = new Uint32Array(f.data.buffer, f.data.byteOffset, f.data.byteLength >> 2); const px = (y) => { const v = w[y * (f.stride >> 2) + 100]; return [(v >> 16) & 255, (v >> 8) & 255, v & 255]; }; return { e: px(100), o: px(101) }; });
  const near = (a, b, t = 2) => a.every((v, i) => Math.abs(v - b[i]) <= t);
  check("'scanlines' filter: even row unchanged, odd row x0.7", near(even.slice(0, 3), frameRow.e) && near(odd.slice(0, 3), frameRow.o.map((v) => Math.round(v * 0.7))), `even ${even.slice(0, 3)} vs ${frameRow.e}; odd ${odd.slice(0, 3)} vs ${frameRow.o.map((v) => Math.round(v * 0.7))}`);
  check("scanlines differ from the sharp image", base0.mismatches > 0);
  await page.screenshot({ path: join(out, "layouts", "98-scanlines.png") });
  await page.selectOption("#filter", "custom");
  await page.fill("#glsl", "vec4 mds_post(vec2 uv) { return broken; }");
  await page.click("#applyGlsl"); await sleep(200);
  check("invalid custom GLSL reports an error and keeps rendering", (await page.textContent("#msg")).includes("GLSL") && (await page.evaluate(() => window.__demo.player.getStats().drawnFrames)) > 0, (await page.textContent("#msg")).slice(0, 80).replace(/\n/g, " "));
  await page.selectOption("#filter", "none"); await sleep(300);
  c = await page.evaluate(PAGE.compare);
  check("sharp filter restores exact pixels", c.mismatches === 0);

  // Integer scale, smoothing
  await page.setViewportSize({ width: 1800, height: 1400 }); await sleep(300);
  const r2 = await page.evaluate(PAGE.cssRect);
  const dpr = await page.evaluate(() => devicePixelRatio);
  check("integer scale when it fits", Number.isInteger(Math.round((r2.w / r2.bw) * dpr * 1000) / 1000) && r2.w / r2.bw >= 2, `scale ${(r2.w / r2.bw).toFixed(3)} (dpr ${dpr})`);
  await page.setViewportSize({ width: 1280, height: 900 });

  // Throughput at 1x: emulator fps and draw fps measured by the page over `seconds`
  const sA = await page.evaluate(PAGE.stats); await sleep(seconds * 1000); const sB = await page.evaluate(PAGE.stats);
  const dt = seconds;
  results.metrics.webgl2_threaded_1x = { emuFps: sB.emuFps, drawFps: (sB.drawnFrames - sA.drawnFrames) / dt, framesEmulated: sB.frameCount - sA.frameCount, ringDelta: { published: sB.ring.published - sA.ring.published, dropped: sB.ring.dropped - sA.ring.dropped, consumed: sB.ring.consumed - sA.ring.consumed }, pthreadWorkers: sB.workers };
  console.log("INFO  1x threaded:", JSON.stringify(results.metrics.webgl2_threaded_1x));
  check("3D renderer pthread workers started in the browser", sB.workers >= 1, `PThread.pthreads running = ${sB.workers}`);
  check("emulator ~60 fps at 1x with the homebrew", sB.emuFps > 50, `${sB.emuFps.toFixed(1)} fps`);

  // Unlimited
  await page.selectOption("#speed", "0"); await sleep(1000);
  const uA = await page.evaluate(PAGE.stats); await sleep(seconds * 1000); const uB = await page.evaluate(PAGE.stats);
  results.metrics.webgl2_threaded_unlimited = { emuFps: (uB.frameCount - uA.frameCount) / seconds, drawFps: (uB.drawnFrames - uA.drawnFrames) / seconds, ring: uB.ring };
  console.log("INFO  unlimited threaded:", JSON.stringify(results.metrics.webgl2_threaded_unlimited));
  check("unlimited speed: ring drops frames instead of blocking", uB.ring.dropped > uA.ring.dropped);
  await page.selectOption("#speed", "1");

  // Tearing check: the compare above already requires every pixel to match one coherent frame; repeat 30x while running.
  let torn = 0;
  for (let i = 0; i < 30; i++) { const cc = await page.evaluate(PAGE.compare); if (cc.mismatches) torn++; await sleep(20); }
  check("no torn/inconsistent frames in 30 samples while running", torn === 0, `${torn} bad`);

  // Pause: frame counter stops
  await page.click("#pause"); await sleep(400);
  const p1 = (await page.evaluate(PAGE.stats)).frameCount; await sleep(500); const p2 = (await page.evaluate(PAGE.stats)).frameCount;
  check("pause stops emulation", p1 === p2, `${p1} -> ${p2}`);
  await page.click("#pause");

  await sleep(200);
  check("no console errors / page errors / failed requests (WebGL2 run)", consoleIssues.length === 0, consoleIssues.join(" | "));
  await context.close();
}

// ---- Run 2: Canvas2D fallback, threads off -------------------------------------------------------------------
{
  const { page, context, consoleIssues } = await openDemo({ query: "?backend=canvas2d&threads=0" });
  const loaded = await loadRomAndWait(page);
  check("Canvas2D fallback boots", loaded);
  if (loaded) {
    check("backend is canvas2d", (await page.evaluate(PAGE.stats)).backend === "canvas2d");
    let ok = true, detail = [];
    for (const label of ["Top/Bottom", "Left/Right", "Rotated Left", "Rotated Right", "Upside Down", "Hybrid (Focus Top)"]) {
      await page.selectOption("#layout", label);
      await waitFor(page, ([W, H]) => window.__demo.canvas.width === W && window.__demo.canvas.height === H, EXPECTED[label], 8000);
      await sleep(150);
      const c = await page.evaluate(PAGE.compare);
      if (c.mismatches || c.W !== EXPECTED[label][0] || c.H !== EXPECTED[label][1]) ok = false;
      detail.push(`${label}:${c.mismatches}`);
    }
    check("Canvas2D pixel-identical in 6 layouts incl. all rotations", ok, detail.join(" "));
    const s1 = await page.evaluate(PAGE.stats); await sleep(seconds * 1000); const s2 = await page.evaluate(PAGE.stats);
    results.metrics.canvas2d_nothreads_1x = { emuFps: s2.emuFps, drawFps: (s2.drawnFrames - s1.drawnFrames) / seconds, pthreadWorkers: s2.workers };
    console.log("INFO  canvas2d, renderer threads off:", JSON.stringify(results.metrics.canvas2d_nothreads_1x));
    check("renderer threads OFF -> no pthread workers running", s2.workers === 0, `workers=${s2.workers}`);
    await page.selectOption("#speed", "0"); await sleep(800);
    const u1 = await page.evaluate(PAGE.stats); await sleep(seconds * 1000); const u2 = await page.evaluate(PAGE.stats);
    results.metrics.canvas2d_nothreads_unlimited = { emuFps: (u2.frameCount - u1.frameCount) / seconds };
    console.log("INFO  canvas2d unlimited:", JSON.stringify(results.metrics.canvas2d_nothreads_unlimited));
  }
  check("no console errors (Canvas2D run)", consoleIssues.length === 0, consoleIssues.join(" | "));
  await context.close();
}

// ---- Run 3: not isolated -> clear error (server without COOP/COEP is simulated by a plain page) ---------------
{
  const context = await browser.newContext(); const page = await context.newPage();
  await page.route("**/demo/index.html*", async (route) => {
    const resp = await route.fetch(); const headers = { ...resp.headers() };
    delete headers["cross-origin-opener-policy"]; delete headers["cross-origin-embedder-policy"];
    await route.fulfill({ response: resp, headers });
  });
  await page.goto(`${base}/demo/index.html`);
  const iso = await page.evaluate(() => crossOriginIsolated);
  const text = await page.textContent("#msg");
  check("without COOP/COEP the demo says why it cannot run", iso === false && /COOP|aislada/.test(text), `crossOriginIsolated=${iso}`);
  await context.close();
}

await browser.close();
server.close();
writeFileSync(join(out, "phase3-browser-results.json"), JSON.stringify(results, null, 1));
console.log(`\n${results.checks.length - failures}/${results.checks.length} checks passed`);
process.exit(failures ? 1 : 0);
