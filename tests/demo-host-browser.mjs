// Phase 12 step 7: standalone multiplayer demo (`demo/host.html`). It loads a ROM from disk, boots the port, creates a
// room on the hub's signaling server (cross-origin, socket.io script from /socket.io/socket.io.js) and shows the
// invitation link for `nds/join.html`.
//
//   node tests/demo-host-browser.mjs                    # needs the hub on :8080
//   BENCH_ROM="roms/nds/otra.nds" node tests/demo-host-browser.mjs
//
// The guest side is covered by tests/phase12-browser.mjs (host + guest in two pages); this smoke test proves the
// standalone demo page can create a room by itself.
import { chromium } from "playwright";
import { createStaticServer } from "../scripts/serve.mjs";
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(join(here, ".."));
const HUB = process.env.HUB ?? "http://127.0.0.1:8080";
const HUB_DIR = resolve(join(here, "..", ".."));
const ROM = process.env.BENCH_ROM ?? findRom();

function findRom() {
  const dir = process.env.ROM_DIR ?? "roms/nds";
  try {
    const found = readdirSync(dir).filter((n) => n.toLowerCase().endsWith(".nds")).sort()[0];
    return found ? join(dir, found) : null;
  } catch {
    return null;
  }
}

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

if (!ROM || !existsSync(ROM)) {
  console.log("SKIP: no local NDS ROM found (set BENCH_ROM) — this demo needs a ROM from the user's disk");
  process.exit(0);
}

let hub = null;
if (!(await reachable(`${HUB}/nds/api/roms`))) {
  console.log(`hub not running; starting ${join(HUB_DIR, "server.mjs")}`);
  hub = spawn(process.execPath, [join(HUB_DIR, "server.mjs")], { cwd: HUB_DIR, stdio: "ignore" });
  for (let i = 0; i < 40 && !(await reachable(`${HUB}/nds/api/roms`)); i++) await new Promise((r) => setTimeout(r, 250));
}

// The demo page needs COOP/COEP (scripts/serve.mjs) like the real port; the hub serves it at /nds/wasm/demo/host.html
// so socket.io is same-origin (COEP blocks a cross-origin socket.io script otherwise).
const server = createStaticServer({ root: ROOT });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const standaloneBase = `http://127.0.0.1:${server.address().port}`;
const base = HUB;
const pageUrl = `${base}/nds/wasm/demo/host.html`;
console.log(`demo host (standalone server also available at ${standaloneBase}/demo/host.html): ${pageUrl} · hub: ${HUB} · ROM: ${ROM.split(/[\\/]/).pop()}`);

const browser = await chromium.launch({ args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--autoplay-policy=no-user-gesture-required"] });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.fill("#hub", HUB);
  await page.setInputFiles("#rom", ROM);
  await page.waitForFunction(() => document.querySelector("#create")?.disabled === false, null, { timeout: 120000 });
  check("host page boots the port and enables creating a room", true);

  await page.click("#create");
  await page.waitForFunction(() => document.querySelector("#invite")?.value?.includes("/nds/join.html?room="), null, { timeout: 30000 });
  const invite = await page.inputValue("#invite");
  check("room created and invitation link built", /\/nds\/join\.html\?room=[0-9a-f-]{8,}/i.test(invite), invite);
  const players = await page.evaluate(() => [...document.querySelectorAll("#players .chip")].map((c) => c.textContent.trim()));
  check("host lists itself as a player", players.includes("Anfitrión"), JSON.stringify(players));
  const status = await page.textContent("#status");
  check("status reflects the room", /sala creada/i.test(status ?? ""), status);
  check("no page errors in the standalone host demo", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));
  await page.screenshot({ path: join(here, "artifacts", "demo-host.png") }).catch(() => {});

  await page.click("#leave");
  await page.waitForFunction(() => document.querySelector("#invite")?.value === "", null, { timeout: 15000 });
  check("leaving the room clears the invitation", true);
} catch (error) {
  check("standalone host demo", false, String(error?.message ?? error).slice(0, 300));
} finally {
  await browser.close().catch(() => {});
  server.close();
  if (hub) hub.kill();
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
