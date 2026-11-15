// Filters (js/filters.js): every filter compiles on this GPU, changes the picture, keeps the aspect ratio and the touch mapping.
// Needs the hub on :8080 (node server.mjs) with a DS ROM in roms/nds. Saves one screenshot per filter in tests/artifacts/filters/.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
const HUB = process.env.HUB || "http://127.0.0.1:8080";
let failures = 0;
const check = (n, ok, d = "") => { console.log(`${ok ? "ok  " : "FAIL"} ${n}${d ? " · " + d : ""}`); if (!ok) failures++; };
mkdirSync("tests/artifacts/filters", { recursive: true });
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1200, height: 900 } })).newPage();
const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(`${HUB}/nds/?engine=wasm&play=0`);
await page.waitForFunction(() => !!window.EJS_emulator, null, { timeout: 180000 });
await page.waitForFunction(() => window.EJS_emulator.gameManager.getFrameNum() > 400, null, { timeout: 120000 }); // past the logos, something to look at
const list = await page.evaluate(() => window.EJS_emulator.filterList.map((f) => f.id));
check("the adapter lists the filters", list.length >= 7, list.join(","));
const opts = await page.evaluate(() => [...document.querySelector("#filter").options].map((o) => o.value));
check("the page's filter selector offers them", opts.includes("crt") && opts[0] === "disabled", opts.join(","));
const hash = () => page.evaluate(() => { const c = document.querySelector("#ejs canvas"); const t = document.createElement("canvas"); t.width = 64; t.height = 96; const x = t.getContext("2d"); x.drawImage(c, 0, 0, 64, 96); const d = x.getImageData(0, 0, 64, 96).data; let h = 0; for (let i = 0; i < d.length; i++) h = (h * 31 + d[i]) | 0; return { h, w: c.width, hh: c.height, css: c.getBoundingClientRect().width / c.getBoundingClientRect().height }; });
await page.evaluate(() => window.EJS_emulator.pause()); await page.waitForTimeout(300); // freeze one frame so every filter is judged on the same picture
const base = await hash();
for (const id of list) {
  await page.selectOption("#filter", id); await page.waitForTimeout(500);
  const r = await hash();
  const applied = await page.evaluate(() => document.querySelector("#filter").value);
  check(`filter ${id}: applied and the picture changed`, applied === id && (r.h !== base.h || r.w !== base.w), `${r.w}x${r.hh}`);
  check(`filter ${id}: aspect ratio kept (touch mapping)`, Math.abs(r.css - base.w / base.hh) < 0.02, `css ${r.css.toFixed(3)} vs ${(base.w / base.hh).toFixed(3)}`);
  await page.screenshot({ path: `tests/artifacts/filters/${id}.png`, clip: { x: 150, y: 120, width: 520, height: 420 } });
}
await page.selectOption("#filter", "disabled"); await page.waitForTimeout(400);
const back = await hash();
check("back to 'Ninguno' restores the original picture and size", back.w === base.w && back.hh === base.hh, `${back.w}x${back.hh}`);
await page.selectOption("#filter", "crt"); await page.reload(); await page.waitForFunction(() => !!window.EJS_emulator, null, { timeout: 180000 }); await page.waitForTimeout(1500);
check("the chosen filter persists across reloads", await page.evaluate(() => document.querySelector("#filter").value) === "crt");
check("no page errors", errors.length === 0, errors.slice(0, 2).join(" | "));
await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
