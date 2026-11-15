// "Third party" acceptance test (docs/GUIA_COMPLETAR_PORT.md §6): take ONLY the published release folder, copy it
// somewhere else, serve it with a plain static server (no COOP/COEP headers, no project scripts) and play a ROM.
// The demo must isolate itself with `?coi=1` (coi-sw.js) and boot; this is what a user downloading the release does.
//
//   node scripts/release.mjs               # once (creates release/, gitignored)
//   node tests/third-party-release.mjs
//
// Requires Playwright Chromium and tests/artifacts/nmap.nds (CC0). Nothing from the repo is used at runtime except the
// release folder and that homebrew ROM.
import { chromium } from "playwright";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const RELEASE = join(ROOT, "release", `melonds-wasm-${pkg.version}`);
const ROM = join(ROOT, "tests", "artifacts", "nmap.nds");
if (!existsSync(join(RELEASE, "demo", "index.html"))) {
  console.log(`SKIP: release/${`melonds-wasm-${pkg.version}`} missing (run node scripts/release.mjs)`);
  process.exit(0);
}
if (!existsSync(ROM)) {
  console.log("SKIP: tests/artifacts/nmap.nds missing (CC0 homebrew)");
  process.exit(0);
}

let failures = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${extra ? " · " + extra : ""}`);
  if (!ok) failures++;
};

const work = mkdtempSync(join(tmpdir(), "mds-thirdparty-"));
const site = join(work, `melonds-wasm-${pkg.version}`);
cpSync(RELEASE, site, { recursive: true });
console.log(`copied release to ${site}`);

// A deliberately dumb static server: no COOP/COEP headers and no project code (like `python -m http.server`).
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};
const server = createServer((req, res) => {
  try {
    const url = new URL(req.url, "http://127.0.0.1");
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith("/")) rel += "index.html";
    const file = normalize(join(site, rel));
    if (!file.startsWith(site) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    res.writeHead(200, { "content-type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream", "cache-control": "no-store" });
    res.end(readFileSync(file));
  } catch (error) {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(String(error));
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
console.log(`plain static server (no COOP/COEP): ${base}`);

try {
  // 1. Integrity of the published wasm over the plain server.
  const meta = JSON.parse(readFileSync(join(ROOT, "release", `release-${pkg.version}.json`), "utf8"));
  const wasmRes = await fetch(`${base}/dist/melonds.wasm`);
  const wasm = Buffer.from(await wasmRes.arrayBuffer());
  const wasmSha = createHash("sha256").update(wasm).digest("hex");
  check("the release serves the wasm with the right MIME type", wasmRes.status === 200 && (wasmRes.headers.get("content-type") ?? "").includes("application/wasm"), wasmRes.headers.get("content-type"));
  check("the served wasm matches the release metadata SHA-256", wasmSha === meta.dist.wasm.sha256 && wasm.length === meta.dist.wasm.bytes, `${wasm.length} B · ${wasmSha.slice(0, 12)}…`);
  check("the plain server does NOT send COOP/COEP (so the test exercises coi-sw)", !wasmRes.headers.get("cross-origin-opener-policy") && !wasmRes.headers.get("cross-origin-embedder-policy"));

  // 2. Without ?coi=1 the demo explains the isolation requirement.
  const browser = await chromium.launch({ args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--autoplay-policy=no-user-gesture-required"] });
  try {
    const plain = await browser.newPage();
    await plain.goto(`${base}/demo/index.html`, { waitUntil: "domcontentloaded" });
    const plainState = await plain.evaluate(() => ({
      isolated: self.crossOriginIsolated,
      message: document.querySelector("#msg")?.textContent ?? "",
      registrations: "serviceWorker" in navigator ? navigator.serviceWorker.getRegistrations().then((r) => r.length) : 0,
    }));
    check("without ?coi=1 the release demo asks for COOP/COEP", /no está aislada|COOP\/COEP/i.test(plainState.message), plainState.message.slice(0, 90));
    check("without ?coi=1 the release demo stays non-isolated", plainState.isolated === false);
    await plain.close();

    // 3. With ?coi=1 the service worker isolates the page and the demo boots with nmap.nds.
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    const pageErrors = [];
    const notFound = [];
    page.on("pageerror", (e) => pageErrors.push(String(e)));
    page.on("response", (r) => { if (r.status() === 404) notFound.push(r.url()); });
    await page.goto(`${base}/demo/index.html?coi=1&autoplay=1`, { waitUntil: "domcontentloaded" });
    let isolated = false;
    for (let i = 0; i < 120 && !isolated; i++) {
      try { isolated = await page.evaluate(() => self.crossOriginIsolated === true); } catch { /* the SW reloads the page */ }
      if (!isolated) await page.waitForTimeout(250);
    }
    check("?coi=1 isolates the release demo (coi-sw.js)", isolated);
    await page.waitForSelector("#rom", { state: "attached", timeout: 60000 });
    await page.setInputFiles("#rom", ROM);
    await page.waitForFunction(() => window.__demo?.player && window.__demo.player.getStats().frameCount > 30, null, { timeout: 120000 });
    const info = await page.evaluate(() => {
      const s = window.__demo.player.getStats();
      const c = document.querySelector("#screen");
      return { frames: s.frameCount, drawn: s.drawnFrames, backend: s.backend, workers: s.workers, canvas: { w: c.width, h: c.height } };
    });
    const ok = info.frames > 30 && info.drawn > 5 && info.canvas.w === 256 && info.canvas.h === 384 && pageErrors.length === 0 && notFound.length === 0;
    check("the release demo boots and plays a ROM (Plain HTTP + coi-sw)", ok, `frames=${info.frames} drawn=${info.drawn} backend=${info.backend} canvas=${info.canvas.w}x${info.canvas.h} workers=${info.workers} pageerrors=${pageErrors.length} 404s=${notFound.length}`);
    check("no 404s from the published folder", notFound.length === 0, notFound.slice(0, 3).join(" | "));
    check("no page errors from the published folder", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));
    await page.screenshot({ path: join(ROOT, "tests", "artifacts", "third-party-release-demo.png") }).catch(() => {});
  } finally {
    await browser.close().catch(() => {});
  }
} catch (error) {
  check("third-party release flow", false, String(error?.message ?? error).slice(0, 300));
} finally {
  server.close();
  rmSync(work, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed (release folder + plain static server + coi-sw + ROM)");
process.exit(failures ? 1 : 0);
