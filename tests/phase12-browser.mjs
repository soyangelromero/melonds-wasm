// Phase 12 browser test: host a room from the web app on the WASM engine and join it as a guest (nds/join.html).
// Two pages in the same Chromium: real signaling over socket.io, real WebRTC, real data channel.
//
//   node tests/phase12-browser.mjs
//   HUB=http://127.0.0.1:8080 MAX_MB=200 node tests/phase12-browser.mjs
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const HUB = process.env.HUB ?? "http://127.0.0.1:8080";
const MAX_MB = Number(process.env.MAX_MB ?? 200);
const HUB_DIR = resolve(join(here, "..", ".."));

let failures = 0;
function check(name, ok, extra = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${extra ? " · " + extra : ""}`);
  if (!ok) failures++;
}

async function reachable(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(2500) });
    return r.ok;
  } catch {
    return false;
  }
}

let server = null;
if (!(await reachable(`${HUB}/nds/api/roms`))) {
  console.log("hub not running; starting it");
  server = spawn(process.execPath, [join(HUB_DIR, "server.mjs")], { cwd: HUB_DIR, stdio: "ignore" });
  for (let i = 0; i < 40 && !(await reachable(`${HUB}/nds/api/roms`)); i++) await new Promise((r) => setTimeout(r, 250));
}

let browser = null;
try {
  const roms = await (await fetch(`${HUB}/nds/api/roms`)).json();
  const rom = roms.filter((r) => r.size <= MAX_MB * 1048576).sort((a, b) => a.size - b.size)[0];
  if (!rom) {
    console.log("no ROM under MAX_MB; nothing to test (skip)");
    process.exit(0);
  }
  console.log(`ROM: ${rom.name} (id ${rom.id})`);

  browser = await chromium.launch({
    args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--autoplay-policy=no-user-gesture-required"],
  });
  const hostPage = await browser.newPage();
  const hostErrors = [];
  hostPage.on("pageerror", (e) => hostErrors.push(String(e)));

  const url = `${HUB}/nds/?engine=wasm&play=${rom.id}`;
  console.log(`host: ${url}`);
  await hostPage.goto(url, { waitUntil: "domcontentloaded" });
  await hostPage.waitForFunction(() => !!window.EJS_emulator, null, { timeout: 180000 });
  check("host emulator booted", true);

  // Spy on the host's input calls so the test can prove the guest really reached the emulator.
  await hostPage.evaluate(() => {
    const ds = window.EJS_emulator.melonDS;
    const press = ds.button.bind(ds);
    const touch = ds.touchFromCanvas.bind(ds);
    window.__guest = { buttons: [], touches: [] };
    ds.button = (name, down, player) => {
      window.__guest.buttons.push([name, !!down, Date.now()]);
      return press(name, down, player);
    };
    ds.touchFromCanvas = (x, y, state) => {
      window.__guest.touches.push([Math.round(x * 100) / 100, Math.round(y * 100) / 100, state, Date.now()]);
      return touch(x, y, state);
    };
  });

  // Open a room from the Online tab.
  await hostPage.click('.tab[data-tab="online"]');
  await hostPage.fill("#roomName", "Sala de prueba");
  await hostPage.click("#openRoom");
  await hostPage.waitForFunction(() => document.querySelector("#inviteUrl").value.includes("/nds/join.html?room="), null, { timeout: 30000 });
  const invite = await hostPage.inputValue("#inviteUrl");
  check("room opened and invite link built", /\/nds\/join\.html\?room=[0-9a-f-]{8,}/i.test(invite), invite);

  // If the page advertises a live tunnel URL, the guest is opened against the hub we are testing instead so the run
  // is deterministic; the room id (the part that matters) comes from the page.
  const guestUrl = invite.replace(new URL(invite).origin, HUB);
  const guestPage = await browser.newPage();
  const guestErrors = [];
  guestPage.on("pageerror", (e) => guestErrors.push(String(e)));
  console.log(`guest: ${guestUrl}`);
  await guestPage.goto(guestUrl, { waitUntil: "domcontentloaded" });

  const live = await guestPage
    .waitForFunction(() => document.body.classList.contains("live"), null, { timeout: 30000 })
    .then(() => true)
    .catch(() => false);
  check("guest enters the room", live);

  const video = await guestPage
    .waitForFunction(
      () => {
        const v = document.querySelector("#v");
        return !!v && v.videoWidth > 0 && v.readyState >= 2;
      },
      null,
      { timeout: 60000 },
    )
    .then(() => true)
    .catch(() => false);
  const videoInfo = await guestPage.evaluate(() => {
    const v = document.querySelector("#v");
    return v ? { w: v.videoWidth, h: v.videoHeight, paused: v.paused, t: v.currentTime } : null;
  });
  check("guest receives the video", video, JSON.stringify(videoInfo));

  // Host sees the player in the list.
  const players = await hostPage
    .waitForFunction(() => document.querySelectorAll("#players .chip").length >= 2, null, { timeout: 30000 })
    .then(() => true)
    .catch(() => false);
  const playerNames = await hostPage.evaluate(() => [...document.querySelectorAll("#players .chip")].map((c) => c.textContent.trim()));
  check("host lists both players", players, JSON.stringify(playerNames));

  // Guest input travels through the data channel into the emulator.
  const sentAt = Date.now();
  await guestPage.keyboard.press("Enter"); // START in join.html's key map
  await hostPage.waitForTimeout(600);
  const remoteButtons = await hostPage.evaluate(() => window.__guest.buttons);
  check(
    "guest button reaches the host emulator",
    remoteButtons.some((b) => b[0] === "START" && b[1] === true) && remoteButtons.some((b) => b[0] === "START" && b[1] === false),
    JSON.stringify(remoteButtons.map((b) => [b[0], b[1]])),
  );
  // Rough input latency (guest key press -> host emulator button call). It includes the Playwright dispatch and the
  // polling granularity, so it is a lower-bound-ish local measurement, not a network measurement.
  const pressed = remoteButtons.find((b) => b[0] === "START" && b[1] === true && b[2] >= sentAt - 2000);
  const inputLatencyMs = pressed ? pressed[2] - sentAt : null;
  check("guest input latency is reasonable (< 500 ms local)", inputLatencyMs != null && inputLatencyMs < 500, `${inputLatencyMs} ms`);

  // Guest touch screen travels over the socket.
  const box = await guestPage.locator("#v").boundingBox();
  await guestPage.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await hostPage.waitForTimeout(600);
  const remoteTouches = await hostPage.evaluate(() => window.__guest.touches);
  check("guest touch reaches the host emulator", remoteTouches.length > 0, JSON.stringify(remoteTouches.slice(0, 3)));

  // Closing the room gives the guest a clear message.
  await hostPage.click("#closeRoom");
  const guestNotified = await guestPage
    .waitForFunction(() => !document.body.classList.contains("live"), null, { timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  check("closing the room disconnects the guest", guestNotified);

  check("no host page errors", hostErrors.length === 0, hostErrors.slice(0, 2).join(" | "));
  check("no guest page errors", guestErrors.length === 0, guestErrors.slice(0, 2).join(" | "));
} finally {
  if (browser) await browser.close();
  if (server) server.kill();
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
