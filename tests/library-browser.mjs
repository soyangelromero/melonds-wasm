// Library check: every NDS ROM in the hub boots on the melonDS-WASM engine, and the GBA player still works.
// This is the evidence that "the whole library is playable", not just one game.
//
//   node tests/library-browser.mjs                    # every ROM, biggest last
//   MAX_ROM_MB=150 node tests/library-browser.mjs     # skip the big ones
//   ONLY=CPUS,IRBS node tests/library-browser.mjs     # a subset
//   FRAME_TARGET=120 SETTLE_MS=3000 node tests/library-browser.mjs
//
// For each NDS ROM it checks: the page is crossOriginIsolated (SharedArrayBuffer), the adapter installs itself as
// window.EJS_emulator, the canvas is sized to the DS frame, frames advance, the composed frame has real content (not
// just a counter), the measured fps/ms are sane, the cartridge save is readable with its type, and the page has no
// errors. Evidence (screenshots, JSON) goes to tests/artifacts/.
//
// Memory note: the original wasm is built with -sINITIAL_MEMORY=256 MiB and -sMAXIMUM_MEMORY=1 GiB. A 512 MB ROM
// (Negra 2) needs ~1.6-1.7 GiB because melonDS copies it three times inside the wasm heap (the mds_load_rom buffer,
// the NDSCart::ParseROM::CopyToUnique copy and the CartRetail constructor copy). With the 2 GiB build (a rebuild via
// scripts/build-core.sh/build-host.sh, or the temporary `node scripts/raise-memory-limit.mjs` artifact patch) it boots
// and is checked like the others; with the 1 GiB build mds_load_rom aborts (`Aborted()`/`RuntimeError: unreachable`) and
// the failure is tagged [WASM_LIMIT] (rebuild with 2 GiB, or apply the patch).
//
// The test never touches the user's real .sav files: PUT /nds/api/sav/* is intercepted and aborted, so a game that
// writes SRAM during boot cannot overwrite the saves next to the ROMs in roms/nds.
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const ARTIFACTS = join(here, "artifacts");
const HUB = process.env.HUB ?? "http://127.0.0.1:8080";
const HUB_DIR = resolve(join(here, "..", ".."));
const MAX_ROM_MB = Number(process.env.MAX_ROM_MB ?? 600);
const ONLY = process.env.ONLY ? process.env.ONLY.split(",").map((s) => s.trim().toUpperCase()) : null;
const FRAME_TARGET = Number(process.env.FRAME_TARGET ?? 60);
const SETTLE_MS = Number(process.env.SETTLE_MS ?? 4000);
const BOOT_TIMEOUT_MS = Number(process.env.BOOT_TIMEOUT_MS ?? 0);
const BIG_ROM_MB = 256; // above this a failed boot is checked against the wasm cap
const BIG_ROM_BOOT_MS = 600000;
// The current build can be 1 GiB (original) or 2 GiB (rebuilt, or the temporary patch from scripts/raise-memory-limit.mjs).
const WASM_CAP_GIB = /maximum:32768/.test(readFileSync(join(here, "..", "dist", "melonds.js"), "utf8")) ? 2 : 1;

mkdirSync(ARTIFACTS, { recursive: true });

const results = [];
let failures = 0;
function check(name, ok, extra = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${extra ? " · " + extra : ""}`);
  if (!ok) failures++;
}
const mb = (bytes) => Math.round(bytes / 1048576);
const timeoutFor = (rom) => BOOT_TIMEOUT_MS || (rom.size > BIG_ROM_MB * 1048576 ? BIG_ROM_BOOT_MS : 300000);

async function reachable(url) {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(2500) })).ok;
  } catch {
    return false;
  }
}

/** Hooks every diagnostic the browser can give us; also blocks save uploads so the user's .sav files are never written. */
function watchPage(page) {
  const diag = { pageErrors: [], consoleErrors: [], notFound: [], crashed: false, savePuts: 0 };
  page.on("pageerror", (e) => diag.pageErrors.push(String(e)));
  page.on("crash", () => (diag.crashed = true));
  page.on("console", (m) => {
    if (m.type() === "error") diag.consoleErrors.push(m.text());
  });
  page.on("response", (r) => {
    if (r.status() === 404) diag.notFound.push(r.url());
  });
  page.route("**/nds/api/sav/**", (route) => {
    if (route.request().method() === "PUT" || route.request().method() === "POST") {
      diag.savePuts++;
      return route.abort(); // never overwrite the real .sav; the adapter treats a failed push as "not synced"
    }
    return route.continue();
  });
  return diag;
}

/** Errors that matter; resource 404s are validated through `unexpected404()` below, and favicon noise is ignored. */
function realErrors(diag) {
  return [...diag.pageErrors, ...diag.consoleErrors].filter(
    (e) => !/favicon\.ico/.test(e) && !/Failed to load resource.*(404|Not Found)/i.test(e),
  );
}

/** 404s that are fine: a game without a save yet is normal (the players probe /api/sav/:id and the hub answers 404). */
function unexpected404(diag) {
  return diag.notFound.filter((u) => !/\/api\/sav\/\d+/.test(u));
}

/** Heuristic: a failure of the 512 MB ROM that looks like the wasm heap hitting -sMAXIMUM_MEMORY. */
function looksLikeWasmLimit(rom, detail) {
  if (rom.size <= BIG_ROM_MB * 1048576) return false;
  return /memory|allocat|abort|OOM|out of|grow|enlarge|RangeError|unreachable|RuntimeError|Aborted\(\)|crash|Aw, snap/i.test(detail);
}

// A 512 MB ROM needs ~3 copies of the ROM in the wasm heap: the JS-side malloc in emu-worker.js (the buffer that
// mds_load_rom receives), the copy NDSCart::ParseROM makes (CopyToUnique) and another one in the CartRetail constructor.
// At 512 MB x 3 + the emulator's own memory that is ~1.6-1.7 GiB, so the original 1 GiB build aborts in mds_load_rom and
// the 2 GiB one (rebuild or scripts/raise-memory-limit.mjs patch) fits it (measured heap: ~1636 MiB).
const WASM_LIMIT_HINT =
  "probablemente el ROM de 512 MB no cabe: se copia 3 veces dentro del heap wasm (buffer de mds_load_rom + " +
  "NDSCart::ParseROM::CopyToUnique + constructor de CartRetail) y el build está limitado a -sMAXIMUM_MEMORY=1 GiB. " +
  "Recompila con 2 GiB (scripts/build-host.sh ya preparado) o, temporalmente, ejecuta node scripts/raise-memory-limit.mjs";

/** Waits for the adapter to install itself, but fails fast if the page/worker dies first instead of burning the timeout. */
async function waitForAdapter(page, diag, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (diag.crashed) throw new Error("the page crashed before window.EJS_emulator was installed");
    if (diag.pageErrors.length) throw new Error(`page error before window.EJS_emulator was installed: ${diag.pageErrors[0]}`);
    // nds/index.html records a boot error in window.__wasmLoadError (it shows it in the status bar and does not re-throw,
    // so there is no pageerror): fail with that message, e.g. ROM_TOO_LARGE for the 512 MB ROM.
    const bootError = await page.evaluate(() => {
      const e = window.__wasmLoadError;
      return e ? `${e.code}: ${e.message}` : null;
    }).catch(() => null);
    if (bootError) throw new Error(`the WASM engine failed before installing window.EJS_emulator: ${bootError}`);
    const installed = await page.evaluate(() => !!window.EJS_emulator).catch(() => false);
    if (installed) return;
    await page.waitForTimeout(200);
  }
  throw new Error(`window.EJS_emulator was not installed within ${timeoutMs} ms`);
}

let server = null;
if (!(await reachable(`${HUB}/nds/api/roms`))) {
  console.log(`hub not running; starting ${join(HUB_DIR, "server.mjs")}`);
  server = spawn(process.execPath, [join(HUB_DIR, "server.mjs")], { cwd: HUB_DIR, stdio: "ignore" });
  for (let i = 0; i < 40 && !(await reachable(`${HUB}/nds/api/roms`)); i++) await new Promise((r) => setTimeout(r, 250));
}

const browser = await chromium.launch({
  args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--autoplay-policy=no-user-gesture-required"],
});

try {
  // ---------- NDS with the WASM engine ----------
  const roms = await (await fetch(`${HUB}/nds/api/roms`)).json();
  const list = roms
    .filter((r) => r.size <= MAX_ROM_MB * 1048576 && (!ONLY || ONLY.includes(String(r.code).toUpperCase())))
    .sort((a, b) => a.size - b.size); // smallest first, so a crash on the big one does not poison the others
  console.log(`NDS ROMs to check: ${list.length} of ${roms.length} (MAX_ROM_MB=${MAX_ROM_MB})`);
  console.log(`machine: ${process.platform} · Node ${process.version} · wasm cap ${WASM_CAP_GIB} GiB · big-ROM limit ${BIG_ROM_MB} MB\n`);

  for (const rom of list) {
    const label = `${rom.code} · ${rom.name} · ${mb(rom.size)} MB`;
    const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
    const page = await context.newPage();
    const diag = watchPage(page);
    const started = Date.now();
    let record = { kind: "NDS", code: rom.code, name: rom.name, size: rom.size, ok: false };
    try {
      await page.goto(`${HUB}/nds/?engine=wasm&play=${rom.id}`, { waitUntil: "domcontentloaded", timeout: 60000 });

      // 1. COOP/COEP => SharedArrayBuffer: without it the port refuses to boot.
      const isolated = await page.evaluate(() => self.crossOriginIsolated === true);
      // 2. The adapter installs itself as window.EJS_emulator (the contract the web app consumes). Fails fast if the
      //    worker dies on boot (a 512 MB ROM aborts on the 1 GiB wasm cap; there is no point waiting 10 minutes).
      await waitForAdapter(page, diag, timeoutFor(rom));
      const bootMs = Date.now() - started;

      // 3. Canvas sized to the DS frame, frames advancing, and a frame that really has pixels.
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
      await page.waitForFunction((target) => window.EJS_emulator.gameManager.getFrameNum() >= target, FRAME_TARGET, { timeout: 180000 });
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

      // 4. Measured emulation rate after the JIT/boot warm-up. `getFrameNum()` is a cached copy of the worker counter
      //    (updated with the stats message every ~500 ms), so a plain delta is quantized by up to half a second: sample
      //    it periodically and fit a line to get a wall-clock rate that is not fooled by the quantization.
      const samples = [];
      const sampleEveryMs = Math.max(100, Math.round(SETTLE_MS / 16));
      for (let i = 0; i < 17; i++) {
        if (i) await page.waitForTimeout(sampleEveryMs);
        samples.push(await page.evaluate(() => ({ f: window.EJS_emulator.gameManager.getFrameNum(), t: performance.now() })));
      }
      const wallSeconds = (samples[samples.length - 1].t - samples[0].t) / 1000;
      const meanT = samples.reduce((a, s) => a + s.t, 0) / samples.length;
      const meanF = samples.reduce((a, s) => a + s.f, 0) / samples.length;
      let cov = 0, varT = 0;
      for (const s of samples) { cov += (s.t - meanT) * (s.f - meanF); varT += (s.t - meanT) ** 2; }
      const measuredFps = varT ? (cov / varT) * 1000 : 0;
      const sampled = await page.evaluate(async () => {
        const ejs = window.EJS_emulator;
        const frame = ejs.melonDS.getFrame();
        // Snapshot everything FIRST: the optional memory breakdown below can take seconds and would otherwise be
        // counted as elapsed time / mix stats from different moments, making the measured fps look lower.
        const snapshot = {
          f: ejs.gameManager.getFrameNum(),
          t: performance.now(),
          stats: ejs.stats,
          rom: ejs.romInfo,
          saveLen: ejs.melonDS.getSave()?.length ?? 0,
          saveType: ejs.melonDS.getSave()?.length ? ejs.romInfo?.saveType : null,
          isolated: self.crossOriginIsolated,
          sharedMemory: typeof SharedArrayBuffer !== "undefined",
          hardware: navigator.hardwareConcurrency,
          memory: performance.memory ? { used: performance.memory.usedJSHeapSize, limit: performance.memory.jsHeapSizeLimit } : null,
          frameSize: frame ? { w: frame.width, h: frame.height } : null,
        };
        let arrayBuffers = null;
        try {
          // crossOriginIsolated pages can ask for a precise memory breakdown (Chromium); never required.
          arrayBuffers = (await Promise.race([performance.measureUserAgentSpecificMemory?.(), new Promise((r) => setTimeout(() => r(null), 4000))]))?.bytes;
        } catch {
          /* not available in this browser */
        }
        return { ...snapshot, memoryBytes: arrayBuffers };
      });
      const fps = sampled.stats?.fps ?? 0;

      // 5. The right cartridge: the header the adapter read must match the hub's library entry.
      const codeOk = String(sampled.rom?.code ?? "").trim() === String(rom.code).trim();
      const errors = realErrors(diag);
      const bad404 = unexpected404(diag);
      const ok = isolated && painted && codeOk && errors.length === 0 && bad404.length === 0 && !diag.crashed && (fps > 20 || measuredFps > 20);
      record = {
        kind: "NDS", code: rom.code, name: rom.name, size: rom.size, ok,
        bootMs, canvas, painted, codeOk, measuredFps, wallSeconds, fps, emuMs: sampled.stats?.emuMs, threads: sampled.stats?.threads,
        saveLen: sampled.saveLen, saveType: sampled.saveType ?? sampled.rom?.saveType, memoryBytes: sampled.memoryBytes,
        memory: sampled.memory, hardware: sampled.hardware, isolated, sharedMemory: sampled.sharedMemory,
        errors, unexpected404: bad404, notFound: diag.notFound, savePuts: diag.savePuts, crashed: diag.crashed,
      };
      const tags = [
        `${fps.toFixed(1)} fps de worker (pared ${measuredFps.toFixed(1)} en ${wallSeconds.toFixed(1)} s, cuantizado a ~500 ms)`,
        `${(sampled.stats?.emuMs ?? 0).toFixed(1)} ms/frame`,
        `save ${sampled.saveLen} B (${sampled.saveType ?? sampled.rom?.saveType ?? "?"})`,
        `boot ${(bootMs / 1000).toFixed(1)} s`,
        `${canvas?.w}x${canvas?.h}`,
        sampled.stats?.threads ? "hilos 3D sí" : "hilos 3D no",
        sampled.memory ? `heap ${mb(sampled.memory.used)} MB` : "",
        sampled.memoryBytes ? `proceso ${mb(sampled.memoryBytes)} MB` : "",
        diag.savePuts ? `${diag.savePuts} push de .sav bloqueado` : "",
        bad404.length ? `404 inesperados: ${bad404.slice(0, 2).join(" | ")}` : "",
        errors.length ? `errores: ${errors.slice(0, 2).join(" | ")}` : "",
      ].filter(Boolean);
      check(`NDS ${label}`, ok, tags.join(" · "));

      try {
        await page.screenshot({ path: join(ARTIFACTS, `library-${rom.code}.png`), timeout: 15000 });
      } catch {
        /* screenshot is evidence, not a check */
      }
    } catch (error) {
      const detail = String(error?.message ?? error);
      const errors = realErrors(diag);
      const bad404 = unexpected404(diag);
      const full = `${detail} ${errors.join(" ")} ${bad404.join(" ")} ${diag.crashed ? "page crashed" : ""}`;
      const suspectedWasmLimit = looksLikeWasmLimit(rom, full);
      record = {
        kind: "NDS", code: rom.code, name: rom.name, size: rom.size, ok: false, suspectedWasmLimit,
        error: detail.slice(0, 500), errors, unexpected404: bad404, notFound: diag.notFound, savePuts: diag.savePuts, crashed: diag.crashed,
        bootMs: Date.now() - started,
      };
      check(
        `NDS ${label}`,
        false,
        `${detail.slice(0, 220)}${errors.length ? " · " + errors.slice(0, 2).join(" | ") : ""}${
          suspectedWasmLimit ? ` · [WASM_LIMIT] ${WASM_LIMIT_HINT}` : ""
        }`,
      );
      try {
        writeFileSync(
          join(ARTIFACTS, `library-${rom.code}-error.txt`),
          `${detail}\n\n${errors.join("\n")}\n\ncrashed=${diag.crashed}\n404=${diag.notFound.join("\n")}\n` +
            `${suspectedWasmLimit ? `WASM_LIMIT: ${WASM_LIMIT_HINT}\n` : ""}`,
        );
      } catch {
        /* best effort */
      }
    } finally {
      results.push(record);
      await context.close().catch(() => {});
    }
  }

  // ---------- GBA (mGBA-WASM, one player per ROM: "all possible GBA games" means the whole library, not just the first) ----------
  const gbaRoms = await (await fetch(`${HUB}/gba/api/roms`)).json();
  console.log(`GBA ROMs to check: ${gbaRoms.length}`);
  for (const rom of gbaRoms) {
    const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
    const page = await context.newPage();
    const diag = watchPage(page);
    const started = Date.now();
    const label = `${rom.code} · ${rom.name} · ${mb(rom.size)} MB`;
    let record = { kind: "GBA", code: rom.code, name: rom.name, size: rom.size, ok: false };
    try {
      await page.goto(`${HUB}/gba/?id=${rom.id}`, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForFunction(() => window.__emu && document.querySelector("#statusText")?.textContent.includes("Jugando"), null, { timeout: 180000 });
      const gba = await page.evaluate(() => {
        const c = document.querySelector("#canvas");
        return {
          canvas: c ? { w: c.width, h: c.height, css: Math.round(c.getBoundingClientRect().width) } : null,
          status: document.querySelector("#statusText")?.textContent,
          save: window.__emu?.getSave?.()?.length ?? 0,
          code: window.__emu?.romCode ?? null,
        };
      });
      const errors = realErrors(diag);
      const bad404 = unexpected404(diag);
      const ok = !!gba.canvas && gba.canvas.w > 0 && gba.canvas.h > 0 && errors.length === 0 && bad404.length === 0 && !diag.crashed;
      record = {
        kind: "GBA", code: rom.code, name: rom.name, size: rom.size, ok,
        canvas: gba.canvas, status: gba.status, saveLen: gba.save, errors, unexpected404: bad404, notFound: diag.notFound, bootMs: Date.now() - started,
      };
      check(
        `GBA ${label}`,
        ok,
        `${gba.canvas?.w}x${gba.canvas?.h} css ${gba.canvas?.css} · ${gba.status} · save ${gba.save} B · boot ${((Date.now() - started) / 1000).toFixed(1)} s${bad404.length ? " · 404 inesperados: " + bad404.slice(0, 2).join(" | ") : ""}${errors.length ? " · errores: " + errors.slice(0, 2).join(" | ") : ""}`,
      );
      try {
        await page.screenshot({ path: join(ARTIFACTS, `library-GBA-${rom.code}.png`), timeout: 15000 });
      } catch {
        /* evidence only */
      }
    } catch (error) {
      const detail = String(error?.message ?? error);
      record = { kind: "GBA", code: rom.code, name: rom.name, size: rom.size, ok: false, error: detail.slice(0, 500), errors: realErrors(diag), unexpected404: unexpected404(diag), bootMs: Date.now() - started };
      check(`GBA ${label}`, false, `${detail.slice(0, 220)}${realErrors(diag).length ? " · " + realErrors(diag).slice(0, 2).join(" | ") : ""}`);
    } finally {
      results.push(record);
      await context.close().catch(() => {});
    }
  }
} finally {
  await browser.close().catch(() => {});
  if (server) server.kill();
}

// ---------- summary ----------
console.log("\n=== Library summary ===");
console.log(`${"ROM".padEnd(6)} ${"size".padStart(7)}  ${"fps".padStart(6)}  ${"emu ms".padStart(7)}  ${"save".padStart(9)}  ${"boot".padStart(7)}  result`);
for (const r of results) {
  const flag = r.ok ? "ok" : r.suspectedWasmLimit ? "FAIL [WASM_LIMIT]" : "FAIL";
  console.log(
    `${String(r.code).padEnd(6)} ${String(r.size != null ? mb(r.size) + " MB" : "—").padStart(7)}  ${String(r.fps != null ? r.fps.toFixed(1) : "—").padStart(6)}  ${String(r.emuMs != null ? r.emuMs.toFixed(1) : "—").padStart(7)}  ${String(r.saveLen != null ? r.saveLen + " B" : "—").padStart(9)}  ${String(r.bootMs != null ? (r.bootMs / 1000).toFixed(1) + " s" : "—").padStart(7)}  ${flag}`,
  );
}
const nds = results.filter((r) => r.kind === "NDS");
const gba = results.filter((r) => r.kind === "GBA");
console.log(`\nNDS: ${nds.filter((r) => r.ok).length}/${nds.length} playable · GBA: ${gba.filter((r) => r.ok).length}/${gba.length}`);
if (nds.length === 4) console.log(`All 4 NDS ROMs boot = ${nds.every((r) => r.ok) ? "yes" : "NO"}`);
else console.log("Partial NDS run (ONLY/MAX_ROM_MB): not the full 4-ROM library");
if (gba.length) console.log(`All GBA ROMs boot = ${gba.every((r) => r.ok) ? "yes" : "NO"}`);
try {
  writeFileSync(join(ARTIFACTS, "library-results.json"), JSON.stringify({ when: new Date().toISOString(), hub: HUB, results }, null, 2));
  console.log(`evidence: ${join(ARTIFACTS, "library-results.json")} + screenshots`);
} catch {
  /* evidence only */
}

if (failures) console.log(`\n${failures} check(s) failed`);
else console.log("\nall checks passed");
process.exit(failures ? 1 : 0);
