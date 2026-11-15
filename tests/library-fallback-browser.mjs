// Fallback check: a library ROM that does not fit in the wasm heap (Negra 2, 512 MB on the original 1 GiB build) must
// not be a dead end in the web app. The WASM engine rejects it with ROM_TOO_LARGE, the page explains it and offers a
// button that reloads the same game with the EmulatorJS engine (the default one), which is slower but playable.
//
// With a build that has enough memory (rebuild with 2 GiB, or the temporary artifact patch from
// scripts/raise-memory-limit.mjs) the same ROM boots directly on the port: then this test reports SKIP instead of
// failing, because the fallback is simply not needed.
//
//   node tests/library-fallback-browser.mjs                 # needs the hub on :8080
//   HUB=http://127.0.0.1:8080 node tests/library-fallback-browser.mjs
//
// The CDN requests are blocked so the test does not depend on the internet: it only asserts the navigation and the
// state of this page up to the click (the EmulatorJS core boot is out of scope here).
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const HUB = process.env.HUB ?? "http://127.0.0.1:8080";
const HUB_DIR = resolve(join(here, "..", ".."));

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
async function reachable(url) {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(2500) })).ok;
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

const browser = await chromium.launch({ args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
try {
  const roms = await (await fetch(`${HUB}/nds/api/roms`)).json();
  const big = roms.find((r) => r.code === "IRES") ?? roms.slice().sort((a, b) => b.size - a.size)[0];
  if (!big) {
    console.log("no ROM in the library; nothing to test (skip)");
    process.exit(0);
  }
  console.log(`ROM: ${big.code} ${big.name} (${(big.size / 1048576).toFixed(0)} MB, id ${big.id})`);

  const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  // Do not depend on the EmulatorJS CDN (the test asserts the navigation, not the old core booting).
  await page.route("https://cdn.emulatorjs.org/**", (route) => route.abort());

  const started = Date.now();
  await page.goto(`${HUB}/nds/?engine=wasm&play=${big.id}`, { waitUntil: "domcontentloaded", timeout: 60000 });

  // Wait for either outcome: the fallback button (1 GiB build) or an installed adapter (enough memory: the port boots).
  let outcome = null;
  while (Date.now() - started < 240000) {
    const state = await page.evaluate(() => ({
      fallback: !!document.querySelector("#wasmFallback"),
      installed: !!window.EJS_emulator,
      bootError: window.__wasmLoadError?.code ?? null,
    })).catch(() => null);
    if (state?.fallback) { outcome = "fallback"; break; }
    if (state?.installed) { outcome = "booted"; break; }
    if (state?.bootError && state.bootError !== "ROM_TOO_LARGE") { outcome = "error"; break; }
    await page.waitForTimeout(250);
  }
  const elapsedMs = Date.now() - started;

  if (outcome === "booted") {
    await page.waitForFunction(() => window.EJS_emulator.gameManager.getFrameNum() > 60, null, { timeout: 240000 });
    const booted = await page.evaluate(async () => ({
      code: window.EJS_emulator.romInfo?.code,
      fps: window.EJS_emulator.stats?.fps,
      saveLen: (await window.EJS_emulator.getSave())?.length ?? 0,
    }));
    skip(
      "the 512 MB ROM boots on the current wasm build; the EmulatorJS fallback is not needed",
      `${big.code} · boot ${(elapsedMs / 1000).toFixed(1)} s · ${booted.fps?.toFixed(1)} fps · save ${booted.saveLen} B · pageerrors ${pageErrors.length}`,
    );
    check("no page errors on the direct boot", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));
  } else if (outcome === "fallback") {
    const state = await page.evaluate(() => ({
      status: document.querySelector("#statusText")?.textContent ?? "",
      code: window.__wasmLoadError?.code ?? null,
      message: window.__wasmLoadError?.message ?? "",
      button: document.querySelector("#wasmFallback")?.textContent ?? "",
      url: location.href,
    }));
    check("WASM engine reports ROM_TOO_LARGE", state.code === "ROM_TOO_LARGE", `code ${state.code}`);
    check("the status bar explains it in Spanish", /no cabe en el motor WASM/i.test(state.status), state.status.slice(0, 120));
    check("a fallback button is offered", !!state.button && /EmulatorJS/i.test(state.button), state.button);
    check("the failure is fast (not an infinite spinner)", elapsedMs < 30000, `${(elapsedMs / 1000).toFixed(1)} s`);
    check("no page errors on the wasm failure path", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));
    await page.screenshot({ path: join(here, "artifacts", "library-fallback-negra2.png") }).catch(() => {});

    // Click it: it must reload the same game with the EmulatorJS melonDS engine (not wasm, not desmume).
    await Promise.all([page.waitForURL(/[?&]core=melonds\b/, { timeout: 60000 }), page.click("#wasmFallback")]);
    const next = new URL(page.url());
    check("fallback navigates to the EmulatorJS engine", next.searchParams.get("core") === "melonds", page.url());
    check("fallback keeps the same game", next.searchParams.get("play") === String(big.id), page.url());
    check("fallback drops ?engine=wasm", !next.searchParams.has("engine"), page.url());
    check("fallback keeps the access key when used", !process.env.ACCESS_KEY || next.searchParams.get("k") === process.env.ACCESS_KEY, page.url());
  } else {
    check("fallback flow", false, `unexpected outcome after ${(elapsedMs / 1000).toFixed(1)} s: ${outcome ?? "timeout"}${pageErrors.length ? " · " + pageErrors.slice(0, 2).join(" | ") : ""}`);
  }
} catch (error) {
  check("fallback flow", false, String(error?.message ?? error).slice(0, 300));
} finally {
  await browser.close().catch(() => {});
  if (server) server.kill();
}

console.log(failures ? `\n${failures} check(s) failed` : `\nall checks passed${skipped ? ` · ${skipped} skipped` : ""}`);
process.exit(failures ? 1 : 0);
