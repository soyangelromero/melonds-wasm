// Third save layer (decision 0.0 #2): a real `.sav` file on the PC via the File System Access API. Playwright cannot
// drive the native file pickers, so this test injects small stand-ins for showOpenFilePicker/showSaveFilePicker through
// page.addInitScript and then drives the demo's buttons exactly like a user would:
//
//   1. link a PC .sav -> it becomes the starting save when the ROM loads;
//   2. the "Guardar ahora en el .sav del PC" button (Spanish UI text) writes the current cartridge save into the linked file (createWritable);
//   3. if the IndexedDB "Continuar" save and the PC file differ, a confirm() asks which one to use and nothing is
//      overwritten silently;
//   4. without the API (Firefox/Safari) the demo explains it and falls back to Download/Import.
//
//   node tests/fsa-saves-browser.mjs                 # needs Playwright + a ROM (BENCH_ROM or roms/nds)
import { chromium } from "playwright";
import { createStaticServer } from "../scripts/serve.mjs";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(join(here, ".."));
const SAVE_LEN = 524288; // Flash 512 KiB (the games in the library)
const PC_SAVE = new Uint8Array(SAVE_LEN).fill(0xaa); // linked PC file
const BROWSER_SAVE = new Uint8Array(SAVE_LEN).fill(0xbb); // IndexedDB "Continuar" save (different on purpose)

function findRom() {
  if (process.env.BENCH_ROM && existsSync(process.env.BENCH_ROM)) return process.env.BENCH_ROM;
  const dir = process.env.ROM_DIR ?? "roms/nds";
  try {
    const found = readdirSync(dir).filter((n) => n.toLowerCase().endsWith(".nds")).sort()[0];
    if (found) return join(dir, found);
  } catch {
    /* no library */
  }
  return join(here, "artifacts", "nmap.nds");
}
const ROM = findRom();
let failures = 0;
function check(name, ok, extra = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${extra ? " · " + extra : ""}`);
  if (!ok) failures++;
}
if (!existsSync(ROM)) {
  console.log(`SKIP: no ROM found (${ROM})`);
  process.exit(0);
}

/** Stand-in for the native File System Access API (one file, in memory). */
async function addFakeFsa(context, initialBytes, name = "pokemon.sav") {
  await context.addInitScript(
    ({ bytes, fileName }) => {
      let current = new Uint8Array(bytes);
      const handle = {
        kind: "file",
        name: fileName,
        async getFile() {
          return new File([current], fileName, { type: "application/octet-stream" });
        },
        async createWritable() {
          return {
            async write(data) {
              const view = data instanceof Uint8Array ? data : new Uint8Array(data);
              current = view.slice();
              window.__fsa.written = current;
              window.__fsa.writes++;
            },
            async close() {},
          };
        },
        async queryPermission() { return "granted"; },
        async requestPermission() { return "granted"; },
      };
      window.__fsa = { current, written: null, writes: 0, name: fileName };
      window.showOpenFilePicker = async () => [handle];
      window.showSaveFilePicker = async () => handle;
    },
    { bytes: [...initialBytes], fileName: name },
  );
}

const server = createStaticServer({ root: ROOT });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--autoplay-policy=no-user-gesture-required"] });
try {
  const context = await browser.newContext({ viewport: { width: 1100, height: 760 } });
  await addFakeFsa(context, PC_SAVE);
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  const bootAndLoad = async (p) => {
    await p.waitForFunction(() => !document.querySelector("#fsaLink").disabled, null, { timeout: 30000 });
    await p.click("#fsaLink");
    await p.waitForFunction(() => document.querySelector("#fsaState")?.textContent?.includes("vinculado"), null, { timeout: 10000 });
    await p.setInputFiles("#rom", ROM);
    await p.waitForFunction(() => window.__demo?.player && !document.querySelector("#pause").disabled, null, { timeout: 120000 });
  };

  await page.goto(`${base}/demo/index.html?autoplay=1`, { waitUntil: "domcontentloaded" });
  await bootAndLoad(page);
  const origin1 = await page.textContent("#s-origin");
  check("linked PC .sav is used as the starting save", /archivo vinculado/i.test(origin1 ?? ""), origin1);
  const saveLen = await page.evaluate(() => window.__demo.player.saves.getSave()?.length ?? 0);
  check("the cartridge save has the linked size", saveLen === SAVE_LEN, `${saveLen} B`);

  // Write the current save into the linked PC file.
  await page.click("#fsaSave");
  await page.waitForFunction(() => (window.__fsa?.writes ?? 0) > 0, null, { timeout: 15000 });
  const written = await page.evaluate(() => ({ writes: window.__fsa.writes, len: window.__fsa.written?.length ?? 0, fsa: window.__demo.fsa }));
  check("the PC file receives the current .sav", written.writes > 0 && written.len === SAVE_LEN, `${written.writes} escritura(s) · ${written.len} B`);
  check("the demo reports the linked file", written.fsa.linked && written.fsa.name === "pokemon.sav", JSON.stringify(written.fsa));
  const romKey = await page.evaluate(() => window.__demo.romKey);
  await page.close();

  // Conflict: seed IndexedDB with a DIFFERENT "Continuar" save, reload, link the PC file again and load the ROM.
  const context2 = await browser.newContext({ viewport: { width: 1100, height: 760 } });
  await addFakeFsa(context2, PC_SAVE);
  const page2 = await context2.newPage();
  const page2Errors = [];
  page2.on("pageerror", (e) => page2Errors.push(String(e)));
  await page2.goto(`${base}/demo/index.html?autoplay=1`, { waitUntil: "domcontentloaded" });
  await page2.evaluate(
    async ({ key, bytes }) => {
      const db = await new Promise((res, rej) => {
        const req = indexedDB.open("melonds-wasm-demo", 1);
        req.onupgradeneeded = () => req.result.createObjectStore("saves");
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
      });
      await new Promise((res, rej) => {
        const tx = db.transaction("saves", "readwrite");
        tx.objectStore("saves").put(new Uint8Array(bytes), key);
        tx.oncomplete = res;
        tx.onerror = () => rej(tx.error);
      });
    },
    { key: romKey, bytes: [...BROWSER_SAVE] },
  );
  let dialogText = null;
  page2.once("dialog", async (dialog) => {
    dialogText = dialog.message();
    await dialog.accept(); // the "use the PC one" choice
  });
  await bootAndLoad(page2);
  const origin2 = await page2.textContent("#s-origin");
  check("a conflicting browser save asks which one to use", !!dialogText && /dos guardados distintos/i.test(dialogText), (dialogText ?? "").slice(0, 120));
  check("choosing the PC file loads the PC save", /archivo vinculado/i.test(origin2 ?? ""), origin2);
  check("no page errors (link + write + conflict)", pageErrors.length === 0 && page2Errors.length === 0, [...pageErrors, ...page2Errors].slice(0, 2).join(" | "));
  await context2.close();
  await context.close();

  // Graceful fallback when the API is not available (Firefox/Safari).
  const context3 = await browser.newContext();
  await context3.addInitScript(() => {
    Object.defineProperty(window, "showOpenFilePicker", { value: undefined, configurable: true });
    Object.defineProperty(window, "showSaveFilePicker", { value: undefined, configurable: true });
  });
  const page3 = await context3.newPage();
  await page3.goto(`${base}/demo/index.html`, { waitUntil: "domcontentloaded" });
  const fallback = await page3.evaluate(() => ({
    hint: document.querySelector("#fsaHint")?.textContent ?? "",
    linkDisabled: document.querySelector("#fsaLink")?.disabled,
    fsa: window.__demo.fsa,
  }));
  check("without the API the demo explains it and disables the button", !fallback.fsa.supported && fallback.linkDisabled === true && /no soporta/i.test(fallback.hint), fallback.hint.slice(0, 120));
  await context3.close();
} catch (error) {
  check("File System Access save layer", false, String(error?.message ?? error).slice(0, 300));
} finally {
  await browser.close().catch(() => {});
  server.close();
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
