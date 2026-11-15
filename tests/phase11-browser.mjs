// Phase 11 browser test: the web app's NDS page running on the melonDS-WASM engine instead of EmulatorJS.
//
// It needs the hub server (<web-app>\server.mjs) and at least one NDS ROM in the library. The ROM is never
// uploaded or copied: the browser fetches it from the local server, exactly like the real page does.
//
//   node tests/phase11-browser.mjs
//   HUB=http://127.0.0.1:8080 node tests/phase11-browser.mjs
//   MAX_MB=64 node tests/phase11-browser.mjs     (skip ROMs bigger than this; default 200)
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const HUB = process.env.HUB ?? "http://127.0.0.1:8080";
const MAX_MB = Number(process.env.MAX_MB ?? 200);
const HUB_DIR = resolve(join(here, "..", ".."));

let failures = 0;
function check(name, ok, extra = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${extra ? " · " + extra : ""}`);
  if (!ok) failures++;
}

async function reachable(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(2500) });
    return r.ok;
  } catch {
    return false;
  }
}

let server = null;
if (!(await reachable(`${HUB}/nds/api/roms`))) {
  console.log(`hub not running; starting ${join(HUB_DIR, "server.mjs")}`);
  server = spawn(process.execPath, [join(HUB_DIR, "server.mjs")], { cwd: HUB_DIR, stdio: "ignore" });
  for (let i = 0; i < 40 && !(await reachable(`${HUB}/nds/api/roms`)); i++) await new Promise((r) => setTimeout(r, 250));
}

try {
  const roms = await (await fetch(`${HUB}/nds/api/roms`)).json();
  check("library is readable", Array.isArray(roms), `${roms.length} ROM(s)`);
  const candidate = roms.filter((r) => r.size <= MAX_MB * 1048576).sort((a, b) => a.size - b.size)[0];
  if (!candidate) {
    console.log("no ROM under MAX_MB; nothing to test (skip)");
    process.exit(0);
  }
  console.log(`ROM: ${candidate.name} (${(candidate.size / 1048576).toFixed(1)} MB, id ${candidate.id})`);

  const browser = await chromium.launch({ args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
  const page = await browser.newPage();
  const errors = [];
  const notFound = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("response", (r) => {
    if (r.status() === 404) notFound.push(r.url());
  });
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });

  const url = `${HUB}/nds/?engine=wasm&play=${candidate.id}`;
  console.log(`opening ${url}`);
  await page.goto(url, { waitUntil: "domcontentloaded" });

  // 1. crossOriginIsolated (COOP/COEP) - without it there is no SharedArrayBuffer and the port refuses to boot.
  const isolated = await page.evaluate(() => self.crossOriginIsolated === true);
  check("page is crossOriginIsolated", isolated);

  // 2. the adapter installs itself as window.EJS_emulator (the page's contract).
  await page.waitForFunction(() => !!window.EJS_emulator, null, { timeout: 180000 });
  check("adapter installed as window.EJS_emulator", true);

  // 3. a canvas exists inside #ejs; its backing size is set from the frame once drawing starts.
  await page.waitForFunction(
    () => {
      const c = document.querySelector("#ejs canvas");
      return !!c && c.width >= 256 && c.height >= 192;
    },
    null,
    { timeout: 120000 },
  );
  const canvas = await page.evaluate(() => {
    const c = document.querySelector("#ejs canvas");
    return c ? { w: c.width, h: c.height } : null;
  });
  check("canvas sized to the frame", !!canvas && canvas.w > 200 && canvas.h > 200, canvas ? `${canvas.w}x${canvas.h}` : "none");

  // 4. the emulator is actually running frames.
  const start = await page.evaluate(() => window.EJS_emulator.gameManager.getFrameNum());
  await page.waitForTimeout(3000);
  const later = await page.evaluate(() => window.EJS_emulator.gameManager.getFrameNum());
  check("frames advance", later > start + 60, `${start} -> ${later} frames`);

  // 5. the composed frame has real content (the emulator is drawing, not just counting frames).
  const painted = await page
    .waitForFunction(
      () => {
        const frame = window.EJS_emulator.melonDS.getFrame();
        if (!frame) return false;
        const d = frame.data;
        for (let i = 0; i + 2 < d.length; i += 4096) if (d[i] > 10 || d[i + 1] > 10 || d[i + 2] > 10) return true;
        return false;
      },
      null,
      { timeout: 90000 },
    )
    .then(() => true)
    .catch(() => false);
  check("frame has visible content", painted);

  // 6. the stats of the contract are reachable through the adapter.
  const stats = await page.evaluate(() => window.EJS_emulator.stats);
  check("getStats() reports fps", typeof stats.fps === "number" && stats.fps > 20, JSON.stringify(stats));

  // 6. the save is readable (a fresh cartridge must have SRAM bytes, e.g. Flash/EEPROM).
  const save = await page.evaluate(async () => {
    const bytes = await window.EJS_emulator.getSave();
    return bytes ? bytes.length : 0;
  });
  check("cartridge save readable", save >= 512, `${save} bytes`);

  // 6b. the picture fills the stage (integer scaling when >= 2x, smooth fill otherwise).
  const fill = await page.evaluate(() => {
    const c = document.querySelector("#ejs canvas");
    const box = document.querySelector(".screen").getBoundingClientRect();
    const rect = c.getBoundingClientRect();
    return { frameW: c.width, cssW: Math.round(rect.width), cssH: Math.round(rect.height), boxW: Math.round(box.width), boxH: Math.round(box.height) };
  });
  check("canvas fills the stage", fill.cssH >= fill.boxH * 0.85 || fill.cssW >= fill.boxW * 0.85, JSON.stringify(fill));
  await page.screenshot({ path: "tests/artifacts/phase11-desktop.png" });

  // 7. pause and resume go through to the emulator without breaking the loop.
  await page.evaluate(() => {
    window.EJS_emulator.pause();
  });
  await page.waitForTimeout(150);
  await page.evaluate(() => {
    window.EJS_emulator.play();
  });
  check("pause/play accepted", true);

  // 8. the page's own UI works: the screen layout lives in the Aspecto tab and drives the port.
  const layout = await page.evaluate(() => {
    const select = document.querySelector("#aspectLayout");
    select.value = "side"; select.dispatchEvent(new Event("change"));
    return !!window.EJS_emulator.melonDS?.getStats && select.value === "side";
  });
  check("UI layout selector clickable", layout);

  // 8b. no duplicated UI: one FPS readout, one action bar, one loading indicator, no legacy bars.
  const dup = await page.evaluate(() => {
    const vis = (el) => !!el && getComputedStyle(el).display !== "none" && !el.hidden && el.getClientRects().length > 0;
    const fpsTexts = [...document.querySelectorAll("body *")].filter((e) => e.children.length === 0 && vis(e) && /\bfps\b/i.test(e.textContent) && !e.closest("#pane-aspect,#pane-game,#pane-controls"));
    return {
      fpsReadouts: fpsTexts.length,
      legacy: ["#hud", "#hudFps", "#mbar", "#fsBar", "#loadbar", "#fsExit", "#layout"].filter((s) => document.querySelector(s)),
      actionBars: document.querySelectorAll('[role="toolbar"]').length,
      loaders: [...document.querySelectorAll("#boot, .boot-spin")].filter(vis).length,
      pauseButtons: document.querySelectorAll('button[id$="ause" i]').length,
    };
  });
  check("single FPS readout", dup.fpsReadouts === 1, JSON.stringify(dup));
  check("no legacy duplicate bars (hud, mbar, fsBar, loadbar, layout seg)", dup.legacy.length === 0, JSON.stringify(dup));
  check("exactly one action bar and one pause button", dup.actionBars === 1 && dup.pauseButtons === 1, JSON.stringify(dup));
  check("loading overlay is gone while playing", dup.loaders === 0, JSON.stringify(dup));

  // 9. speed control: ONE indicator (the speed button) shows speed and audio state; muted above 2x.
  for (let i = 0; i < 2; i++) await page.evaluate(() => document.querySelector("#ff").click());
  const speed3 = await page.evaluate(() => ({ tag: document.querySelector("#spdTag")?.textContent.trim(), muted: document.querySelector("#spdTag")?.classList.contains("muted"), title: document.querySelector("#ff")?.title }));
  check("speed x3 is shown once, on the speed button", speed3.tag === "x3", JSON.stringify(speed3));
  check("speed x3 marks audio as muted (and explains it)", speed3.muted === true && /sin audio/.test(speed3.title), JSON.stringify(speed3));
  await page.screenshot({ path: "tests/artifacts/phase11-desktop-speed.png" });
  for (let i = 0; i < 2; i++) await page.evaluate(() => document.querySelector("#ff").click());
  const speed1 = await page.evaluate(() => ({ tag: document.querySelector("#spdTag")?.textContent.trim(), muted: document.querySelector("#spdTag")?.classList.contains("muted") }));
  check("back to 1x with audio active", speed1.tag === "1x" && speed1.muted === false, JSON.stringify(speed1));

  check("no 404s", notFound.length === 0, notFound.slice(0, 5).join(" | "));
  check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));

  // ---- mobile: the on-screen controls (added in Phase 11 for the WASM engine) ----
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const mpage = await mobile.newPage();
  const mobileErrors = [];
  mpage.on("pageerror", (e) => mobileErrors.push(String(e)));
  // Slow the ROM download a bit so the loading overlay is observable (the user must never see a black screen).
  await mpage.route("**/nds/api/rom/0**", async (route) => { await new Promise((r) => setTimeout(r, 1400)); await route.continue().catch(() => {}); });
  await mpage.goto(url, { waitUntil: "domcontentloaded" });
  await mpage.waitForTimeout(500);
  const boot = await mpage.evaluate(() => ({ hidden: document.querySelector("#boot")?.hidden, text: document.querySelector("#bootText")?.textContent ?? "", sub: document.querySelector("#bootSub")?.textContent ?? "" }));
  check("mobile: loading overlay is visible while the ROM loads", boot.hidden === false && /Cargando/i.test(boot.text), JSON.stringify(boot));
  await mpage.screenshot({ path: "tests/artifacts/phase11-mobile-loading.png" });
  await mpage.waitForFunction(() => !!window.EJS_emulator, null, { timeout: 180000 });
  const bootGone = await mpage.evaluate(() => ({ hidden: document.querySelector("#boot")?.hidden, fps: !document.querySelector("#fpsBadge")?.hidden }));
  check("mobile: loading overlay hides and the FPS badge appears when playing", bootGone.hidden === true && bootGone.fps === true, JSON.stringify(bootGone));

  const padVisible = await mpage.evaluate(() => document.querySelector("#touchpad").classList.contains("show"));
  check("mobile: on-screen controls visible", padVisible);

  // The mobile layout must show the screen and the controls in the same viewport (no scrolling down to the buttons), and
  // the menu/fullscreen must keep them reachable.
  const mobileLayout = await mpage.evaluate(() => {
    const rect = (sel) => { const el = document.querySelector(sel); if (!el) return null; const b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), bottom: Math.round(b.bottom) }; };
    const inViewport = (r) => !!r && r.x >= 0 && r.y >= 0 && r.x + r.w <= innerWidth + 1 && r.y + r.h <= innerHeight + 1;
    const apart = (a, b) => !!a && !!b && (a.bottom <= b.y + 2 || b.bottom <= a.y + 2 || a.x + a.w <= b.x + 2 || b.x + b.w <= a.x + 2);
    return {
      screen: rect(".screen"), pad: rect("#touchpad"), mbar: rect("#actions"),
      vw: innerWidth, vh: innerHeight, inScreen: inViewport(rect(".screen")), inPad: inViewport(rect("#touchpad")),
      apart: apart(rect(".screen"), rect("#touchpad")), mbarShown: getComputedStyle(document.querySelector("#actions")).display !== "none",
      toolbarHidden: [...document.querySelectorAll("#actions .iconbtn")].every((b) => { const r = b.getBoundingClientRect(); return b.hidden || (r.width >= 44 && r.height >= 44); }),
      iconOnly: [...document.querySelectorAll("#actions .lbl")].every((l) => getComputedStyle(l).display === "none"),
      fpsBadge: getComputedStyle(document.querySelector("#fpsBadge")).display !== "none" && /FPS: \d+/.test(document.querySelector("#fpsBadge")?.textContent ?? ""),
      sides: getComputedStyle(document.querySelector("#startBtn")).display !== "none" && getComputedStyle(document.querySelector("#selBtn")).display !== "none",
    };
  });
  check("mobile: screen and controls are visible in the same viewport", mobileLayout.inScreen && mobileLayout.inPad && mobileLayout.apart && mobileLayout.screen.h >= 300, JSON.stringify(mobileLayout));
  check("mobile: the single action bar is icon-only and every button is at least 44 px", mobileLayout.mbarShown && mobileLayout.toolbarHidden && mobileLayout.iconOnly, JSON.stringify(mobileLayout));
  await mpage.screenshot({ path: "tests/artifacts/mobile-portrait-final.png" });
  check("mobile: FPS badge and SELECT/START side pills are visible", mobileLayout.fpsBadge && mobileLayout.sides, JSON.stringify({ fps: mobileLayout.fpsBadge, sides: mobileLayout.sides }));
  check("mobile: controls stay inside the viewport (no page scroll needed)", mobileLayout.pad.bottom <= mobileLayout.vh + 1 && mobileLayout.mbar.bottom <= mobileLayout.vh + 1);

  // Menu opens the panel sheet and closes it (mobile users still need saves/cheats).
  await mpage.tap("#panelBtn");
  await mpage.waitForTimeout(400);
  const panelOpen = await mpage.evaluate(() => document.querySelector("aside.panel")?.classList.contains("open"));
  check("mobile: menu button opens the panel sheet", panelOpen);
  await mpage.tap("#panelClose");
  await mpage.waitForTimeout(300);
  const panelClosed = await mpage.evaluate(() => document.querySelector("aside.panel")?.classList.contains("open"));
  check("mobile: panel closes again", panelClosed === false);

  // Appearance tab: themes/layout/gap are customizable and applied immediately.
  await mpage.tap("#panelBtn");
  await mpage.waitForTimeout(400);
  await mpage.tap('[data-tab="aspect"]');
  const aspectTab = await mpage.evaluate(() => ({ show: document.querySelector("#pane-aspect")?.classList.contains("show"), preset: document.querySelector("#padPreset")?.value }));
  await mpage.selectOption("#padPreset", "neon");
  const themed = await mpage.evaluate(() => ({ bg: getComputedStyle(document.documentElement).getPropertyValue("--pad-bg").trim(), label: document.querySelector("#padOpacityLabel")?.textContent }));
  check("mobile: appearance tab opens and themes the controls", aspectTab.show && aspectTab.preset === "classic" && themed.bg.includes("0,230,176"), JSON.stringify({ aspectTab, themed }));
  await mpage.selectOption("#aspectLayout", "side");
  const layoutFromAspect = await mpage.evaluate(() => document.querySelector("#aspectLayout").value);
  check("mobile: screen layout can be changed from the appearance tab", layoutFromAspect === "side", `layout=${layoutFromAspect}`);
  await mpage.screenshot({ path: "tests/artifacts/mobile-aspect.png" });
  await mpage.tap("#aspectReset");
  await mpage.tap("#panelClose");
  await mpage.waitForTimeout(300);

  // Fullscreen must target the console (screen + controls), not only the canvas.
  await mpage.tap("#full");
  await mpage.waitForTimeout(600);
  const fullState = await mpage.evaluate(() => {
    const b = document.querySelector("#touchpad")?.getBoundingClientRect();
    return { element: document.fullscreenElement?.id ?? null, pad: document.querySelector("#touchpad")?.classList.contains("show"), padRect: b ? { y: Math.round(b.y), h: Math.round(b.height) } : null, vh: innerHeight };
  });
  check("mobile: fullscreen includes the controls", fullState.element === "consoleBox" && fullState.pad === true && !!fullState.padRect && fullState.padRect.h > 80 && fullState.padRect.y + fullState.padRect.h <= fullState.vh + 1, JSON.stringify(fullState));
  const fsBar = await mpage.evaluate(() => { const b = document.querySelector("#actions"); const cs = getComputedStyle(b); return { position: cs.position, shown: b.classList.contains("show"), opacity: cs.opacity, pause: !!document.querySelector("#pause"), count: document.querySelectorAll('[role="toolbar"]').length }; });
  check("mobile: fullscreen floats the same action bar over the game", fsBar.position === "fixed" && fsBar.shown && fsBar.pause && fsBar.count === 1, JSON.stringify(fsBar));
  await mpage.evaluate(() => document.querySelector("#pause").click());
  check("mobile: fullscreen pause button works", await mpage.evaluate(() => window.EJS_emulator?.paused === true));
  await mpage.evaluate(() => document.querySelector("#pause").click());
  await mpage.screenshot({ path: "tests/artifacts/mobile-fullscreen-final.png" });
  await mpage.screenshot({ path: "tests/artifacts/phase11-mobile-fullscreen.png" });
  await mpage.waitForTimeout(3600);
  check("mobile: the floating bar hides itself in fullscreen", await mpage.evaluate(() => !document.querySelector("#actions").classList.contains("show")));
  await mpage.evaluate(() => document.exitFullscreen?.().catch(() => {}));
  await mpage.waitForTimeout(300);

  // Spy on MelonDS.button to prove the pad reaches the emulator with the right button.
  await mpage.evaluate(() => {
    const ds = window.EJS_emulator.melonDS;
    const original = ds.button.bind(ds);
    window.__buttons = [];
    ds.button = (name, down) => {
      window.__buttons.push([name, !!down]);
      return original(name, down);
    };
  });
  await mpage.tap("#startBtn");
  await mpage.waitForTimeout(250);
  const seen = await mpage.evaluate(() => window.__buttons);
  check(
    "mobile: touch START reaches the emulator",
    seen.some((b) => b[0] === "START" && b[1] === true) && seen.some((b) => b[0] === "START" && b[1] === false),
    JSON.stringify(seen),
  );

  const fit = await mpage.evaluate(() => {
    const c = document.querySelector("#ejs canvas");
    const r = c.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), vw: innerWidth };
  });
  check("mobile: canvas fits the viewport", fit.w <= fit.vw && fit.w > 100, JSON.stringify(fit));
  await mpage.screenshot({ path: "tests/artifacts/phase11-mobile.png" });
  check("mobile: no page errors", mobileErrors.length === 0, mobileErrors.slice(0, 2).join(" | "));
  await mobile.close();

  // Landscape phones: screen on the left, controls on the right, both in the viewport.
  const land = await browser.newContext({ viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const lpage = await land.newPage();
  const landErrors = [];
  lpage.on("pageerror", (e) => landErrors.push(String(e)));
  await lpage.goto(url, { waitUntil: "domcontentloaded" });
  await lpage.waitForFunction(() => !!window.EJS_emulator, null, { timeout: 180000 });
  await lpage.waitForTimeout(600);
  const landLayout = await lpage.evaluate(() => {
    const rect = (sel) => { const el = document.querySelector(sel); if (!el) return null; const b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), bottom: Math.round(b.bottom) }; };
    const inViewport = (r) => !!r && r.x >= 0 && r.y >= 0 && r.x + r.w <= innerWidth + 1 && r.y + r.h <= innerHeight + 1;
    return { screen: rect(".screen"), pad: rect("#touchpad"), vw: innerWidth, vh: innerHeight, inScreen: inViewport(rect(".screen")), inPad: inViewport(rect("#touchpad")), sideBySide: rect(".screen").x + rect(".screen").w <= rect("#touchpad").x + 2 };
  });
  check("mobile landscape: screen and controls share the viewport (side by side)", landLayout.inScreen && landLayout.inPad && landLayout.sideBySide && landLayout.screen.h >= 200, JSON.stringify(landLayout));
  await lpage.screenshot({ path: "tests/artifacts/phase11-mobile-landscape.png" });
  await lpage.screenshot({ path: "tests/artifacts/mobile-landscape-final.png" });
  const landBar = await lpage.evaluate(() => { const r = document.querySelector("#actions").getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), r: Math.round(r.right), b: Math.round(r.bottom), vw: innerWidth, vh: innerHeight }; });
  check("mobile landscape: the action bar stays inside the viewport", landBar.r <= landBar.vw + 1 && landBar.b <= landBar.vh + 1 && landBar.y >= 0, JSON.stringify(landBar));
  check("mobile landscape: no page errors", landErrors.length === 0, landErrors.slice(0, 2).join(" | "));
  await land.close();
  await browser.close();
} finally {
  if (server) server.kill();
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
