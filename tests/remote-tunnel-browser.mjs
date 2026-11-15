// Remote-access end-to-end check through a Cloudflare QUICK tunnel (no account needed): proves that the web app + the
// melonDS-WASM port work from outside the LAN over public HTTPS, with COOP/COEP preserved and ACCESS_KEY protecting
// pages, APIs and socket.io.
//
//   node tests/remote-tunnel-browser.mjs              # HTTP checks + boot a ROM through the tunnel
//   node tests/remote-tunnel-browser.mjs --http-only  # HTTP checks only (fast)
//   CLOUDFLARED="C:\path\cloudflared.exe" node tests/remote-tunnel-browser.mjs
//
// It needs `cloudflared` installed (the project's deploy/README points at C:\Program Files (x86)\cloudflared) and
// outbound internet. If the binary is missing or Cloudflare does not give a URL, the test SKIPs (not a failure of the
// port). Everything is local except the tunnel: the extra server listens on 127.0.0.1 with a random ACCESS_KEY and is
// killed at the end.
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const HUB_DIR = resolve(join(here, "..", ".."));
const PORT = Number(process.env.REMOTE_PORT ?? 8098);
const KEY = process.env.ACCESS_KEY ?? `rt-${Math.random().toString(36).slice(2, 12)}`;
const CLOUDFLARED =
  process.env.CLOUDFLARED ??
  ["C:\\Program Files (x86)\\cloudflared\\cloudflared.exe", "C:\\Program Files\\cloudflared\\cloudflared.exe", "cloudflared"].find(
    (candidate) => candidate === "cloudflared" || existsSync(candidate),
  );
const HTTP_ONLY = process.argv.includes("--http-only");
const local = `http://127.0.0.1:${PORT}`;

let failures = 0;
let skipped = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${extra ? " · " + extra : ""}`);
  if (!ok) failures++;
};
const skip = (name, extra = "") => {
  skipped++;
  console.log(`SKIP ${name}${extra ? " · " + extra : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(url, headers = {}) {
  const r = await fetch(url, { headers, redirect: "manual", signal: AbortSignal.timeout(30000) });
  return { status: r.status, coop: r.headers.get("cross-origin-opener-policy"), coep: r.headers.get("cross-origin-embedder-policy"), type: r.headers.get("content-type") ?? "", body: await r.text() };
}

if (CLOUDFLARED !== "cloudflared" && !existsSync(CLOUDFLARED)) {
  console.log(`SKIP: cloudflared not found (${CLOUDFLARED}); install it or set CLOUDFLARED=`);
  process.exit(0);
}

// Keyed server on a spare local port (the main hub on :8080 is left alone).
const server = spawn(process.execPath, [join(HUB_DIR, "server.mjs")], {
  cwd: HUB_DIR,
  env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", ACCESS_KEY: KEY },
  stdio: "ignore",
});
let tunnel = null;
try {
  let localUp = false;
  for (let i = 0; i < 40 && !localUp; i++) {
    try { localUp = (await get(`${local}/?k=${encodeURIComponent(KEY)}`)).status === 200; } catch { await sleep(250); }
  }
  if (!localUp) throw new Error(`the keyed local server did not start on :${PORT}`);

  // Cloudflare quick tunnel; the URL appears on stderr.
  tunnel = spawn(CLOUDFLARED, ["tunnel", "--url", local, "--no-autoupdate"], { stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  const urlPromise = new Promise((resolveUrl) => {
    const onData = (chunk) => {
      log += String(chunk);
      const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(log);
      if (match) resolveUrl(match[0]);
    };
    tunnel.stdout.on("data", onData);
    tunnel.stderr.on("data", onData);
    setTimeout(() => resolveUrl(null), 60000);
  });
  const base = await urlPromise;
  if (!base) {
    console.log("SKIP: Cloudflare did not provide a quick-tunnel URL (no internet / blocked). Log tail:");
    console.log(log.split("\n").slice(-6).join("\n"));
    throw { skip: true };
  }
  console.log(`tunnel: ${base} (local ${local}, key ${KEY.slice(0, 6)}…)`);
  let publicUp = false;
  for (let i = 0; i < 60 && !publicUp; i++) {
    try { publicUp = (await get(`${base}/?k=${encodeURIComponent(KEY)}`)).status === 200; } catch { await sleep(1000); }
  }
  if (!publicUp) {
    console.log("SKIP: the tunnel URL did not answer (Cloudflare edge not ready / network)");
    throw { skip: true };
  }

  const noKey = await get(`${base}/`);
  check("public URL: without the key the hub is closed (403)", noKey.status === 403, `${noKey.status}`);
  check("public URL keeps COOP/COEP", noKey.coop === "same-origin" && noKey.coep === "require-corp", `coop=${noKey.coop} coep=${noKey.coep}`);
  const withKey = await get(`${base}/?k=${encodeURIComponent(KEY)}`);
  check("public URL: ?k= opens the hub (200)", withKey.status === 200 && withKey.type.includes("text/html"), `${withKey.status} ${withKey.type}`);
  const library = await get(`${base}/nds/api/roms?k=${encodeURIComponent(KEY)}`);
  let roms = [];
  try { roms = JSON.parse(library.body); } catch {}
  check("public URL: the ROM library is reachable", library.status === 200 && Array.isArray(roms) && roms.length > 0, `${library.status} · ${roms.length} ROM(s)`);
  const adapter = await get(`${base}/nds/wasm/adapters/webapp-adapter.js?k=${encodeURIComponent(KEY)}`);
  check("public URL: the port's adapter is served", adapter.status === 200 && adapter.type.includes("javascript"), `${adapter.status} ${adapter.type}`);
  const wsWithKey = await get(`${base}/socket.io/?EIO=4&transport=polling&k=${encodeURIComponent(KEY)}`);
  check("public URL: socket.io handshake authorized with ?k=", wsWithKey.status === 200 && /^0\{/.test(wsWithKey.body), `${wsWithKey.status}`);
  const wsNoKey = await get(`${base}/socket.io/?EIO=4&transport=polling`);
  check("public URL: socket.io handshake rejected without the key", wsNoKey.status === 403, `${wsNoKey.status}`);

  if (!HTTP_ONLY) {
    const rom = roms.find((r) => r.code === "CPUS") ?? roms.slice().sort((a, b) => a.size - b.size)[0];
    const pageUrl = `${base}/nds/?engine=wasm&play=${rom.id}&k=${encodeURIComponent(KEY)}`;
    const browser = await chromium.launch({ args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--autoplay-policy=no-user-gesture-required"] });
    try {
      const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
      const errors = [];
      page.on("pageerror", (e) => errors.push(String(e)));
      const started = Date.now();
      console.log(`booting ${rom.name} remotely: ${pageUrl}`);
      await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 180000 });
      const isolated = await page.evaluate(() => self.crossOriginIsolated === true);
      check("remote page is crossOriginIsolated (SAB available)", isolated);
      await page.waitForFunction(() => !!window.EJS_emulator, null, { timeout: 360000 });
      const bootMs = Date.now() - started;
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
        canvas: (() => {
          const c = document.querySelector("#ejs canvas");
          return c ? { w: c.width, h: c.height } : null;
        })(),
      }));
      const detail = `${info.rom?.code} · boot ${(bootMs / 1000).toFixed(1)} s · ${info.fps?.toFixed(1)} fps · save ${info.saveLen} B · ${info.canvas?.w}x${info.canvas?.h} · pageerrors ${errors.length}`;
      check("the ROM boots and draws remotely through the tunnel", painted && info.rom?.code === rom.code && errors.length === 0 && info.saveLen >= 512, detail);
      await page.screenshot({ path: join(here, "artifacts", "remote-tunnel-boot.png") }).catch(() => {});
    } finally {
      await browser.close().catch(() => {});
    }
  }
} catch (error) {
  if (error?.skip) {
    skip("remote tunnel end-to-end", "Cloudflare quick tunnel unavailable in this environment");
  } else {
    check("remote tunnel end-to-end", false, String(error?.message ?? error).slice(0, 300));
  }
} finally {
  tunnel?.kill();
  server.kill();
  await sleep(300);
}

console.log(failures ? `\n${failures} check(s) failed` : `\nall checks passed${skipped ? ` · ${skipped} skipped` : ""}`);
process.exit(failures ? 1 : 0);
