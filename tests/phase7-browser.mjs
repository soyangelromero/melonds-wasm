// Phase 7 browser check: the port accepts REAL BIOS/firmware files supplied by the user (Phase 7, JS side) and still
// boots a commercial ROM. The files are never bundled: the page fetched them from the local hub (`/nds/api/bios/*`),
// which reads the user's own dumps; by default no BIOS/firmware is used at all (FreeBIOS + built-in firmware), which is
// what the library test covers.
//
//   node tests/phase7-browser.mjs                 # needs hub on :8080 and the user's BIOS/firmware folder
//   HUB=http://127.0.0.1:8080 node tests/phase7-browser.mjs
//
// If the hub has no BIOS/firmware (or the ROM library is empty) the test SKIPs with a clear message: it is not a
// requirement for the port (the default path works without any Nintendo file).
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const HUB = process.env.HUB ?? "http://127.0.0.1:8080";
const HUB_DIR = resolve(join(here, "..", ".."));

let failures = 0;
function check(name, ok, extra = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${extra ? " · " + extra : ""}`);
  if (!ok) failures++;
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

const browser = await chromium.launch({ args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--autoplay-policy=no-user-gesture-required"] });
try {
  // Are the user's own BIOS/firmware dumps reachable through the hub? If not, this check does not apply.
  const bios = await Promise.all(
    ["bios7.bin", "bios9.bin", "firmware.bin"].map(async (name) => {
      try {
        const r = await fetch(`${HUB}/nds/api/bios/${name}`, { signal: AbortSignal.timeout(5000) });
        const bytes = r.ok ? new Uint8Array(await r.arrayBuffer()) : new Uint8Array(0);
        return { name, ok: r.ok, size: bytes.length };
      } catch {
        return { name, ok: false, size: 0 };
      }
    }),
  );
  const hasFirmware = bios.find((b) => b.name === "firmware.bin")?.ok;
  const hasBios = bios.find((b) => b.name === "bios7.bin")?.ok && bios.find((b) => b.name === "bios9.bin")?.ok;
  if (!hasBios && !hasFirmware) {
    console.log("SKIP: the hub does not expose the user's BIOS/firmware (that is not needed by default; FreeBIOS + built-in firmware are used)");
    process.exit(0);
  }
  console.log(`BIOS/firmware available through the hub: ${bios.map((b) => `${b.name}${b.ok ? ` (${b.size} B)` : " (404)"}`).join(", ")}`);
  // The core validates these sizes; a 0/wrong size would make setBios/setFirmware reject and the boot would silently use
  // the built-in firmware, so the check below would not prove anything. Fail loudly instead.
  const sizeOk = (name, expected) => {
    const entry = bios.find((b) => b.name === name);
    return entry?.ok && (Array.isArray(expected) ? expected.includes(entry.size) : entry.size === expected);
  };
  const sizesOk = sizeOk("bios7.bin", 16384) && sizeOk("bios9.bin", 4096) && sizeOk("firmware.bin", [131072, 262144, 524288]);

  const roms = await (await fetch(`${HUB}/nds/api/roms`)).json();
  const rom = roms.filter((r) => r.size <= 256 * 1048576).sort((a, b) => a.size - b.size)[0];
  if (!rom) {
    console.log("SKIP: no NDS ROM in the library");
    process.exit(0);
  }
  console.log(`ROM: ${rom.code} ${rom.name} (${(rom.size / 1048576).toFixed(0)} MB)`);

  const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
  const page = await context.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  const biosRequests = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("response", (r) => { if (r.url().includes("/nds/api/bios/")) biosRequests.push({ url: r.url(), status: r.status() }); });

  // `?fw=real` makes the adapter fetch the dumps and write them into the core's /system before loadRom
  // (firmware.bin, bios7.bin, bios9.bin via mds_write_system_file) — i.e. the JS half of Phase 7.
  const started = Date.now();
  await page.goto(`${HUB}/nds/?engine=wasm&play=${rom.id}&fw=real`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => !!window.EJS_emulator, null, { timeout: 180000 });
  const bootMs = Date.now() - started;
  await page.waitForFunction(() => window.EJS_emulator.gameManager.getFrameNum() > 60, null, { timeout: 120000 });
  const info = await page.evaluate(async () => {
    const ejs = window.EJS_emulator;
    const frame = ejs.melonDS.getFrame();
    return {
      rom: ejs.romInfo,
      fps: ejs.stats.fps,
      saveLen: ejs.melonDS.getSave()?.length ?? 0,
      frame: frame ? { w: frame.width, h: frame.height } : null,
      bootError: window.__wasmLoadError?.code ?? null,
    };
  });
  const errors = [...pageErrors, ...consoleErrors].filter((e) => !/favicon\.ico/.test(e));
  check("the user's dumps have the sizes the core accepts", sizesOk, bios.map((b) => `${b.name}=${b.size}`).join(" "));
  const fetched = new Set(biosRequests.filter((r) => r.status === 200).map((r) => r.url.split("/").pop()));
  check("?fw=real actually downloads the 3 dumps", ["bios7.bin", "bios9.bin", "firmware.bin"].every((n) => fetched.has(n)), [...fetched].join(", "));
  check("boots with real firmware/BIOS (?fw=real)", !!info.rom?.code && info.bootError == null, `boot ${(bootMs / 1000).toFixed(1)} s · ${info.rom?.code}`);
  check("frames advance with real firmware/BIOS", info.fps > 20, `${info.fps?.toFixed(1)} fps`);
  check("cartridge save is readable with real firmware/BIOS", info.saveLen >= 512, `${info.saveLen} B`);
  check("no page errors with real firmware/BIOS", errors.length === 0, errors.slice(0, 2).join(" | "));

  // And the same ROM with the DEFAULT configuration (no Nintendo files at all) must still boot: that is the reason of
  // the port and the legal base for distributing it without dumps.
  const page2 = await context.newPage();
  const page2Errors = [];
  const page2Bios = [];
  page2.on("pageerror", (e) => page2Errors.push(String(e)));
  page2.on("response", (r) => { if (r.url().includes("/nds/api/bios/")) page2Bios.push(r.url()); });
  await page2.goto(`${HUB}/nds/?engine=wasm&play=${rom.id}`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page2.waitForFunction(() => !!window.EJS_emulator, null, { timeout: 180000 });
  await page2.waitForFunction(() => window.EJS_emulator.gameManager.getFrameNum() > 60, null, { timeout: 120000 });
  const noFw = await page2.evaluate(() => ({ fps: window.EJS_emulator.stats.fps, code: window.EJS_emulator.romInfo?.code }));
  check("boots with no BIOS/firmware at all (default)", !!noFw.code && page2Errors.length === 0 && noFw.fps > 20, `${noFw.code} · ${noFw.fps?.toFixed(1)} fps`);
  check("default path does not download any BIOS/firmware", page2Bios.length === 0, `${page2Bios.length} peticiones`);
  await context.close();
} catch (error) {
  check("Phase 7 firmware flow", false, String(error?.message ?? error).slice(0, 300));
} finally {
  await browser.close().catch(() => {});
  if (server) server.kill();
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
