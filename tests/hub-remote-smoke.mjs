// Remote-access software smoke test (objective: "reachable remotely" without depending on a tunnel account).
// Spawns the web app server (<web-app>\server.mjs) on a spare port with ACCESS_KEY and HOST set, then checks with
// real HTTP requests that:
//   - without the key everything is 403 (library, pages), and with `?k=`/cookie it is 200;
//   - the port's browser files are served under /nds/wasm/ while third_party stays 404 (whitelist);
//   - the hub demo pages (including the standalone host) are reachable;
//   - socket.io's handshake is gated by the same key (remote multiplayer would not work otherwise);
//   - the server actually listens on the requested HOST/PORT (LAN/remote binding).
//
//   node tests/hub-remote-smoke.mjs
//   PORT=8097 ACCESS_KEY=... node tests/hub-remote-smoke.mjs
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const HUB_DIR = resolve(join(here, "..", ".."));
const PORT = Number(process.env.PORT ?? 8097);
const KEY = process.env.ACCESS_KEY ?? `smoke-${Math.random().toString(36).slice(2, 10)}`;
const HOST = process.env.HOST ?? "0.0.0.0";
const base = `http://127.0.0.1:${PORT}`;

let failures = 0;
function check(name, ok, extra = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${extra ? " · " + extra : ""}`);
  if (!ok) failures++;
}
const cookie = `k=${KEY}`;
async function get(path, headers = {}) {
  try {
    const response = await fetch(base + path, { headers, signal: AbortSignal.timeout(8000), redirect: "manual" });
    return { status: response.status, type: response.headers.get("content-type") ?? "", setCookie: response.headers.get("set-cookie") ?? "", body: await response.text() };
  } catch (error) {
    return { status: 0, error: String(error.message ?? error) };
  }
}

console.log(`web app server: HOST=${HOST} PORT=${PORT} ACCESS_KEY=${KEY.slice(0, 6)}…`);
const server = spawn(process.execPath, [join(HUB_DIR, "server.mjs")], {
  cwd: HUB_DIR,
  env: { ...process.env, PORT: String(PORT), HOST, ACCESS_KEY: KEY },
  stdio: "ignore",
});

try {
  // Wait until it answers (with the key).
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    const r = await get(`/?k=${encodeURIComponent(KEY)}`);
    if (r.status === 200) up = true;
    else await new Promise((resolve) => setTimeout(resolve, 250));
  }
  check("server listens on the requested HOST/PORT with ACCESS_KEY", up, `${base}`);
  if (!up) throw new Error("server did not start");

  const noKey = await get("/");
  check("without the key the hub is closed (403)", noKey.status === 403, `${noKey.status}`);
  const withKey = await get(`/?k=${encodeURIComponent(KEY)}`);
  check("?k= opens the hub (200) and sets the cookie", withKey.status === 200 && withKey.setCookie.includes("k="), `${withKey.status} · ${withKey.setCookie.slice(0, 60)}`);
  const libraryCookie = await get("/nds/api/roms", { cookie });
  check("library API works with the cookie", libraryCookie.status === 200 && Array.isArray(JSON.parse(libraryCookie.body || "null")), `${libraryCookie.status} · ${JSON.parse(libraryCookie.body || "[]").length} ROM(s)`);
  const libraryQuery = await get(`/nds/api/roms?k=${encodeURIComponent(KEY)}`);
  check("library API works with ?k=", libraryQuery.status === 200, `${libraryQuery.status}`);
  const wrong = await get("/nds/api/roms?k=not-the-key");
  check("a wrong key is rejected (403)", wrong.status === 403, `${wrong.status}`);
  const demo = await get("/nds/wasm/demo/host.html", { cookie });
  check("the standalone demo/host page is served by the hub", demo.status === 200 && demo.type.includes("text/html"), `${demo.status} · ${demo.type}`);
  const thirdParty = await get("/nds/wasm/third_party/melonds-ds/README.md", { cookie });
  check("third_party is not exposed (404, whitelist)", thirdParty.status === 404, `${thirdParty.status}`);
  const wsWithKey = await get(`/socket.io/?EIO=4&transport=polling&k=${encodeURIComponent(KEY)}`);
  check("socket.io handshake is authorized with ?k=", wsWithKey.status === 200 && /^0\{/.test(wsWithKey.body), `${wsWithKey.status} · ${wsWithKey.body.slice(0, 40)}`);
  const wsNoKey = await get("/socket.io/?EIO=4&transport=polling");
  check("socket.io handshake is rejected without the key", wsNoKey.status === 403, `${wsNoKey.status}`);
  const audioWorklet = await get("/nds/wasm/js/audio-worklet.js", { cookie });
  check("the port's JS files are served (audio worklet)", audioWorklet.status === 200 && audioWorklet.type.includes("javascript"), `${audioWorklet.status} · ${audioWorklet.type}`);
} catch (error) {
  check("remote-access smoke test", false, String(error?.message ?? error).slice(0, 300));
} finally {
  server.kill();
  // On Windows the child may linger if it was killed before listening; make sure the port is free for the next run.
  await new Promise((resolve) => setTimeout(resolve, 300));
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
