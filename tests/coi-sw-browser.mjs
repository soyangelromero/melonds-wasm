// coi-sw.js check: on a static host WITHOUT COOP/COEP headers, the service worker makes the page cross-origin isolated
// after one reload, so SharedArrayBuffer (and the threaded port) works on hosts such as GitHub Pages or a plain
// `python -m http.server`. This test serves the repo with a bare Node http server (no headers at all) and checks:
//   1. the first load is not isolated and the demo registers the worker;
//   2. the automatic reload ends up with crossOriginIsolated === true and a controlling service worker;
//   3. it does not reload in a loop.
//
//   node tests/coi-sw-browser.mjs
import { chromium } from "playwright";
import http from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(join(here, ".."));
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

let failures = 0;
function check(name, ok, extra = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${extra ? " · " + extra : ""}`);
  if (!ok) failures++;
}

// Deliberately NO Cross-Origin-* headers: this is the kind of host coi-sw.js is for.
const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
  let file = resolve(join(ROOT, pathname));
  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end();
    return;
  }
  try {
    if (statSync(file).isDirectory()) file = join(file, "index.html");
    if (!existsSync(file)) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
    createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404).end("not found");
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
console.log(`bare static server (no COOP/COEP): ${base}/demo/index.html`);

const browser = await chromium.launch({ args: ["--no-sandbox"] });
try {
  const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
  const page = await context.newPage();
  let navigations = 0;
  page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) navigations++; });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  await page.goto(`${base}/demo/index.html?coi=1`, { waitUntil: "domcontentloaded", timeout: 60000 });

  // The registration script reloads once; poll across the navigation until isolated (or time out).
  let isolated = false;
  const started = Date.now();
  while (Date.now() - started < 30000) {
    try {
      isolated = await page.evaluate(() => self.crossOriginIsolated === true);
    } catch {
      /* navigation in flight: the execution context was destroyed */
    }
    if (isolated) break;
    await page.waitForTimeout(250);
  }
  const elapsed = Date.now() - started;
  const state = isolated
    ? await page.evaluate(() => ({
        isolated: self.crossOriginIsolated,
        shared: typeof SharedArrayBuffer !== "undefined",
        controlled: !!navigator.serviceWorker?.controller,
      }))
    : null;

  check("after coi-sw.js the page is crossOriginIsolated", !!state?.isolated, `${(elapsed / 1000).toFixed(1)} s`);
  check("SharedArrayBuffer is available", !!state?.shared);
  check("a service worker controls the page", !!state?.controlled);
  check("it does not reload in a loop", navigations <= 3, `${navigations} navegaciones`);
  check("no page errors (beyond the expected first load)", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));

  // With the isolation in place the threaded port can create its module: the demo only needs the wasm files to load,
  // which are also served by the bare server (no ROM needed for this check).
  const coi = await page.evaluate(async () => {
    const { default: createModule } = await import("../dist/melonds.js").catch((error) => ({ default: null, error }));
    if (!createModule) return { ok: false, why: "wasm module not importable (dist not built?)" };
    const M = await createModule();
    const heap = M.HEAPU8.length;
    M._mds_destroy?.();
    return { ok: heap > 0, heap };
  }).catch((error) => ({ ok: false, why: String(error.message ?? error) }));
  check("the wasm module boots under coi-sw (threads available)", coi.ok, coi.ok ? `heap ${(coi.heap / 1048576).toFixed(0)} MiB` : coi.why);

  // Negative case: on the same header-less server, the demo WITHOUT ?coi=1 must stay non-isolated (it explains the
  // COOP/COEP requirement) and must not register the service worker automatically.
  const plain = await browser.newContext();
  const plainPage = await plain.newPage();
  let plainNavigations = 0;
  plainPage.on("framenavigated", (frame) => { if (frame === plainPage.mainFrame()) plainNavigations++; });
  await plainPage.goto(`${base}/demo/index.html`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await plainPage.waitForTimeout(1500);
  const plainState = await plainPage.evaluate(async () => ({
    isolated: self.crossOriginIsolated,
    shared: typeof SharedArrayBuffer !== "undefined",
    registrations: "serviceWorker" in navigator ? (await navigator.serviceWorker.getRegistrations()).length : 0,
    message: document.querySelector("#msg")?.textContent ?? "",
  }));
  check("without ?coi=1 the demo stays non-isolated (no auto-registration)", !plainState.isolated && !plainState.shared && plainState.registrations === 0, `isolated=${plainState.isolated} sab=${plainState.shared} registros=${plainState.registrations}`);
  check("without ?coi=1 the demo explains the COOP/COEP requirement", /no está aislada|COOP\/COEP/i.test(plainState.message), plainState.message.slice(0, 100));
  check("without ?coi=1 there is no auto-reload", plainNavigations === 1, `${plainNavigations} navegaciones`);
  await plain.close();

  await page.screenshot({ path: join(here, "artifacts", "coi-sw-demo.png") }).catch(() => {});
} catch (error) {
  check("coi-sw flow", false, String(error?.message ?? error).slice(0, 300));
} finally {
  await browser.close().catch(() => {});
  server.close();
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
