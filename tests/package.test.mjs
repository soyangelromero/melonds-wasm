// Phase 13: the static package must work on its own, served by a plain static server, with no repo around it.
// It builds `package/`, serves it and opens the demo in Chromium to prove that every module resolves.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const PORT = Number(process.env.PACKAGE_PORT ?? 8095);

let chromium = null;
try {
  ({ chromium } = await import("playwright"));
} catch {
  chromium = null;
}

test("the static package builds and serves on its own", { skip: chromium === null && "playwright is not installed" }, async () => {
  // 1. build
  const build = spawnSync(process.execPath, [join(root, "scripts", "package.mjs")], { cwd: root, encoding: "utf8" });
  assert.equal(build.status, 0, build.stderr || build.stdout);
  const pkg = join(root, "package");
  for (const file of ["index.html", "manifest.json", "LICENSE", "THIRD_PARTY.md", "CHANGELOG.md", "coi-sw.js", "dist/melonds.js", "dist/melonds.wasm", "js/melonds.js", "adapters/webapp-adapter.js", "adapters/INTEGRATION.md", "demo/index.html", "demo/host.html", "demo/host.js"]) {
    assert.ok(existsSync(join(pkg, file)), `package is missing ${file}`);
  }

  // 2. serve it with the same static server a user would run
  const server = spawn(process.execPath, [join(root, "scripts", "serve.mjs")], {
    cwd: root,
    env: { ...process.env, ROOT: pkg, PORT: String(PORT) },
    stdio: "ignore",
  });
  const base = `http://127.0.0.1:${PORT}`;
  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      try {
        up = (await fetch(`${base}/index.html`)).ok;
      } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    assert.ok(up, "static server did not start");

    for (const [path, type] of [
      ["/index.html", "text/html"],
      ["/dist/melonds.wasm", "application/wasm"],
      ["/js/melonds.js", "text/javascript"],
      ["/adapters/netplay-host.js", "text/javascript"],
    ]) {
      const response = await fetch(base + path);
      assert.equal(response.status, 200, `${path} status`);
      assert.ok((response.headers.get("content-type") ?? "").includes(type), `${path} content-type`);
      assert.equal(response.headers.get("cross-origin-opener-policy"), "same-origin", `${path} COOP`);
    }

    // 3. the demo really loads its modules (a 404 here means the bundle is incomplete)
    const browser = await chromium.launch({ args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
    try {
      const page = await browser.newPage();
      const notFound = [];
      const errors = [];
      page.on("response", (r) => {
        if (r.status() === 404) notFound.push(r.url());
      });
      page.on("pageerror", (e) => errors.push(String(e)));
      await page.goto(`${base}/demo/index.html`, { waitUntil: "load" });
      await page.waitForTimeout(2500);
      const isolated = await page.evaluate(() => self.crossOriginIsolated === true);
      assert.equal(isolated, true, "demo is not crossOriginIsolated");
      assert.deepEqual(notFound, [], "the package has missing files");
      assert.deepEqual(errors, [], `demo page errors: ${errors.join(" | ")}`);
      const hasUi = await page.evaluate(() => !!document.querySelector("#rom"));
      assert.equal(hasUi, true, "demo did not render");
    } finally {
      await browser.close();
    }
  } finally {
    server.kill();
  }
});
