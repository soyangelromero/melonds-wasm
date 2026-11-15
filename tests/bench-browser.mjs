// Phase 9 benchmark harness: drives the demo's own "Medir rendimiento" button in Chromium against a real ROM served
// locally, and writes the raw measurements to tests/artifacts/ (JSON) plus a compact table on stdout.
//
// The ROM is never uploaded or copied anywhere: the page is served by this repo's scripts/serve.mjs on its own port
// (default 8090; the hub owns 8080 and is not touched), and the file is handed to the demo's <input id="rom"> with
// Playwright's file chooser. Everything stays on 127.0.0.1.
//
// What it measures (the demo already implements the protocol: one worker/audio window average every ~500 ms, then a
// summary; see the "benchmark" block of demo/demo.js):
//   * speed 1x / 1.5x / 2x / unlimited, with the threaded 3D renderer on (?threads=1, the default) and off (?threads=0);
//   * audioDynamicRate "always" (the default) vs "off" at 1x under a CPU shortage, so the DRC validation of the plan
//     (decision 0.0 #4) has real numbers: no underruns with "always" vs underruns with "off";
//   * the CPU shortage is produced with the DevTools Protocol (Emulation.setCPUThrottlingRate, 4x by default). If that
//     does not slow the emulation WORKER down (it is a separate thread; Chrome may only throttle the main thread), the
//     harness says so and falls back to a synthetic shortage: the test-only "debugStall" worker hook (the same one
//     tests/phase4-browser.mjs uses) is posted on a timer so the producer delivers ~86 % of real time — exactly the
//     "CPU justa" case the DRC is for. Nothing in the demo or the emulator is modified.
//
// Usage (both `BENCH_*` and the short names are accepted; the short ones are handy for a quick re-run):
//   node tests/bench-browser.mjs                     # full matrix, 20 s per run, 3 repeats (median), ~13 min
//   node tests/bench-browser.mjs --quick             # 6 s per run, speeds 1 and unlimited, no CPU-shortage runs
//   SPEEDS=1,2 THREADS=1 SECS=10 REPS=1 node tests/bench-browser.mjs
//   DRC=always,off THREADS=0 node tests/bench-browser.mjs
//   BENCH_ROM="roms/nds/otra.nds" node tests/bench-browser.mjs
//   HEADED=1 node tests/bench-browser.mjs            # real GPU, visible window (draw() numbers closer to the user's)
//   SWIFTSHADER=1 node tests/bench-browser.mjs       # force software WebGL (what the other browser tests use)
//   SKIP_THROTTLE=1 node tests/bench-browser.mjs
//   SKIP_MATRIX=1 CPU_SHORTAGE=none|synthetic|throttle node tests/bench-browser.mjs   # only boot + DRC 1x comparison
//   SYNTH_DUTY=50 SYNTH_STALL=7 node tests/bench-browser.mjs                        # tunable synthetic shortage
//
// Phase 9b (loop optimizations A/B + profiler):
//   SKIP_MATRIX=1 SKIP_DRC=1 OPT_VARIANTS=off,all SPEEDS=2,0 REPS=3 PROF=1 node tests/bench-browser.mjs
//     -> before/after of the three JS optimizations (off = old behaviour forced with the test-only debugOpt switch,
//        all = new behaviour) plus one 20 s unlimited run with the worker loop profiler on.
//   SKIP_MATRIX=1 SKIP_DRC=1 OPT_VARIANTS=a,b,c SPEEDS=2,0 REPS=1 node tests/bench-browser.mjs   # per-optimization gain
//   SKIP_MATRIX=1 SKIP_DRC=1 PROF=1 PROFILE_VARIANTS=a,ac,ab,all PROFILE_SPEED=0 node tests/bench-browser.mjs
//     -> only the loop profiler, once per variant: compares the per-section ms/frame (the robust "gain" measurement).
//
// Environment: ROM, PORT (8090), SECS, REPS/REPEATS, SPEEDS (1,1.5,2,0; 0 = unlimited), THREADS (1 = threaded 3D
// renderer, 0 = without; both by default), DRC ("always" by default, can be a list: always,off), THROTTLE (4),
// SKIP_THROTTLE, CPU_SHORTAGE (auto|synthetic|throttle|none), SKIP_MATRIX, SKIP_DRC, SKIP_IDENT, SYNTH_DUTY/SYNTH_STALL,
// HEADED, SWIFTSHADER, OPT_VARIANTS (off,all,a,b,c,ab,ac), PROF (1 = profile runs), PROFILE_VARIANTS, PROFILE_SPEED (0),
// PROFILE_SECS (SECS). Every run writes the raw JSON with date and machine info to tests/artifacts/.
//
// Serialize it with the other heavy browser tests (the 4-ROM library test): CPU-contended numbers are worthless.
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(join(here, ".."));
const ARTIFACTS = join(here, "artifacts");
const envStr = (name, def) => process.env[`BENCH_${name}`] ?? process.env[name] ?? def;
const envNum = (name, def) => Number(envStr(name, def));
const QUICK = process.argv.includes("--quick");
const ROM = envStr("ROM", "roms/nds/4833 - Pokemon - Edicion Plata SoulSilver (Spain).nds");
const PORT = envNum("PORT", 8090);
const BASE = `http://127.0.0.1:${PORT}`;
const SECS = envNum("SECS", QUICK ? 6 : 20);
const REPEATS = envNum("REPEATS", envNum("REPS", QUICK ? 1 : 3));
const SPEEDS = envStr("SPEEDS", QUICK ? "1,0" : "1,1.5,2,0")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n));
const THREADS = (() => {
  const list = envStr("THREADS", "1,0")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s === "0" || s === "1")
    .map(Number);
  return list.length ? [...new Set(list)] : [1, 0];
})();
const DRC_MODES = (() => {
  const valid = ["off", "ff", "always"];
  const list = envStr("DRC", "always")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => valid.includes(s));
  return list.length ? [...new Set(list)] : ["always"];
})();
const SKIP_THROTTLE = QUICK || envStr("SKIP_THROTTLE", "0") === "1" || !THREADS.includes(1);
const CPU_SHORTAGE = envStr("CPU_SHORTAGE", "auto"); // auto | synthetic | throttle | none (real machine, no artificial load)
const SYNTH_DUTY_MS = envNum("SYNTH_DUTY", 50);
const SYNTH_STALL_MS = envNum("SYNTH_STALL", 7);
const SKIP_MATRIX = envStr("SKIP_MATRIX", "0") === "1"; // only the boot + DRC comparison (quick re-run of the 1x validation)
const SKIP_DRC = envStr("SKIP_DRC", "0") === "1"; // do not run the audioDynamicRate 1x comparison
// Phase 9b: A/B variants of the three loop optimizations. off = all three forced OFF (pre-Phase-9b behaviour), all = all
// three ON (default), a/b/c = only one ON. The switch is the test-only `debugOpt` worker message.
const OPT_VARIANTS = (() => {
  const list = envStr("OPT_VARIANTS", "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => ["off", "all", "a", "b", "c", "ab", "ac"].includes(s));
  return [...new Set(list)];
})();
const OPT_SETS = {
  off: { publishDecimation: false, savesCadence: false, yieldEvery2: false },
  all: { publishDecimation: true, savesCadence: true, yieldEvery2: true },
  a: { publishDecimation: true, savesCadence: false, yieldEvery2: false }, // (a) decimate frame publication in FF
  b: { publishDecimation: false, savesCadence: true, yieldEvery2: false }, // (b) SRAM detector every 30 frames in FF
  c: { publishDecimation: false, savesCadence: false, yieldEvery2: true }, // (c) yield to events every 2 frames in FF
  ab: { publishDecimation: true, savesCadence: true, yieldEvery2: false }, // (a)+(b): isolates (b) against (a)
  ac: { publishDecimation: true, savesCadence: false, yieldEvery2: true }, // (a)+(c): isolates (c) against (a)
};
const PROFILE = envStr("PROF", "0") === "1"; // profile run(s) of the worker loop
const PROFILE_SPEED = envNum("PROFILE_SPEED", 0);
const PROFILE_SECS = envNum("PROFILE_SECS", SECS);
// Variants to profile (each one is a profileRun with that debugOpt set); default: the current default behaviour.
const PROFILE_VARIANTS = (() => {
  const list = envStr("PROFILE_VARIANTS", "all")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s in { off: 1, all: 1, a: 1, b: 1, c: 1, ab: 1, ac: 1 });
  return list.length ? [...new Set(list)] : ["all"];
})();
const SKIP_IDENT = envStr("SKIP_IDENT", "0") === "1"; // skip the 1x off/all identity runs (e.g. nmap at 1000s of fps)
const THROTTLE_RATE = envNum("THROTTLE", 4);
const HEADED = envStr("HEADED", "0") === "1";
const FORCE_SWIFTSHADER = envStr("SWIFTSHADER", "0") === "1";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fx = (v, d = 1) => (v == null || Number.isNaN(v) ? "—" : Number(v).toFixed(d));
const toNum = (s) => (s == null ? null : Number(String(s).replace(",", ".")));

function die(message) {
  console.error(`bench-browser: ${message}`);
  process.exit(2);
}

// ---------- static server (scripts/serve.mjs on its own port; never the hub's 8080) ----------
let server = null;
let serverLog = "";
async function reachable(url) {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(1500) })).ok;
  } catch {
    return false;
  }
}

// ---------- demo page helpers ----------
const BENCH_DONE = `(() => {
  const b = document.getElementById("bench"), o = document.getElementById("benchOut");
  return !!b && !!o && o.textContent.length > 0 && !b.textContent.includes("Midiendo");
})()`;

/** Parses the human-readable summary the demo prints in #benchOut (demo/demo.js "benchmark" block). */
function parseBenchText(text) {
  const grab = (re) => {
    const m = text.match(re);
    return m ? toNum(m[1]) : null;
  };
  const gpu = text.match(/GPU: (.+)/);
  return {
    emuFpsMin: grab(/Emulador \(fps\):\s*mín ([\d.,]+)/),
    emuFpsP5: grab(/Emulador \(fps\):.*?p5 ([\d.,]+)/),
    emuFpsAvg: grab(/Emulador \(fps\):.*?media ([\d.,]+)/),
    emuFpsMax: grab(/Emulador \(fps\):.*?máx ([\d.,]+)/),
    emuMsAvg: grab(/ms por fotograma:\s*media ([\d.,]+)/),
    emuMsMax: grab(/peor ventana ([\d.,]+)/),
    slowWindows: grab(/ventanas lentas (\d+)/),
    drawFpsAvg: grab(/Dibujado \(fps\):\s*mín [\d.,]+ · media ([\d.,]+)/),
    bufMinMs: grab(/búfer mín (\d+)/),
    bufAvgMs: grab(/búfer mín \d+ · media (\d+)/),
    bufMaxMs: grab(/búfer mín \d+ · media \d+ · máx (\d+)/),
    underruns: grab(/underruns \+(\d+)/),
    underrunFrames: grab(/silencio (\d+) muestras/),
    overruns: grab(/overruns \+(\d+)/),
    catchupFrames: grab(/acelerado \+(\d+)/),
    rafHz: grab(/≈([\d.,]+) Hz/),
    rafP95: grab(/p95 ([\d.,]+)/),
    queueDrops: grab(/descartes en cola: (\d+)/),
    drawMsAvg: grab(/draw\(\) en CPU: media ([\d.,]+)/),
    workers: grab(/hilos 3D: (-?\d+)/),
    cpuThreads: grab(/CPU: (\d+) hilos lógicos/),
    backend: (text.match(/dibujo: (\w+)/) ?? [])[1] ?? null,
    gpu: gpu ? gpu[1].trim() : null,
    speedLabel: (text.match(/Velocidad ([^\n·]+)/) ?? [])[1]?.trim() ?? null,
    verdict: (text.match(/Veredicto: ([^\n]+)/) ?? [])[1]?.trim() ?? null,
  };
}

/** Adds an option to #benchSecs if the fixed list has no such value (the demo offers 20/30/60 s). */
async function setBenchSecs(page, secs) {
  await page.evaluate((s) => {
    const sel = document.getElementById("benchSecs");
    if (![...sel.options].some((o) => Number(o.value) === s)) sel.add(new Option(String(s), String(s)));
    sel.value = String(s);
  }, secs);
}

/** Boots the demo with the given ROM, waits for the player and the benchmark button, and checks the audio clock. */
async function openPlayer(browser, { threads }) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  const url = `${BASE}/demo/index.html?autoplay=1&threads=${threads ? 1 : 0}`;
  console.log(`  opening ${url}`);
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.setInputFiles("#rom", ROM);
  await page.waitForFunction(() => !!window.__demo?.player && !document.getElementById("bench").disabled, null, { timeout: 300000 });
  await setBenchSecs(page, SECS);
  const feeding = await page
    .waitForFunction(() => window.__demo.player.getStats().audioFeeding === true, null, { timeout: 30000 })
    .then(() => true)
    .catch(() => false);
  const info = await page.evaluate(() => {
    const gl = (() => {
      try {
        const c = document.createElement("canvas");
        const g = c.getContext("webgl2");
        if (!g) return null;
        const e = g.getExtension("WEBGL_debug_renderer_info");
        return e ? g.getParameter(e.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER);
      } catch {
        return null;
      }
    })();
    const s = window.__demo.player.getStats();
    return { hardwareConcurrency: navigator.hardwareConcurrency, userAgent: navigator.userAgent, gl, backend: s.backend, workers: s.workers, frameCount: s.frameCount };
  });
  return { context, page, errors, feeding, info };
}

/**
 * Walks the boot sequence for `frames` of GAME time (not wall time, so every config measures the same part of the game
 * regardless of speed): logos -> press START -> title/attract. The demo's own input path is used (VideoPlayer.button),
 * no DOM editing.
 */
async function driveScene(page) {
  const atLeast = (n) => page.waitForFunction((k) => window.__demo.player.getStats().frameCount >= k, n, { timeout: 240000 });
  const tap = (button) =>
    page.evaluate((b) => {
      const p = window.__demo.player;
      p.button(b, true);
      setTimeout(() => p.button(b, false), 150);
    }, button);
  await atLeast(240);
  await tap("START");
  await atLeast(300);
  await tap("START");
  await atLeast(360);
  await tap("A");
  await atLeast(420);
  await sleep(800);
  return page.evaluate(() => window.__demo.player.getStats().frameCount);
}

/** One measurement: set speed + DRC mode, wait for the ring/speed to settle, click the demo's bench button, parse. */
async function runBench(page, { config, speed, drcMode, throttleRate = 1, synthetic = null, secs = SECS, opt = null, ping = false }) {
  if (secs !== SECS) await setBenchSecs(page, secs);
  if (opt) {
    // Phase 9b A/B: the same worker code, with the three loop optimizations forced on/off through the test-only hook.
    await page.evaluate((set) => window.__demo.player.worker.postMessage({ type: "debugOpt", set }), opt);
    await sleep(150);
  }
  await page.evaluate(
    ({ speed, drcMode }) => {
      const p = window.__demo.player;
      p.setAudioDynamicRate(drcMode);
      const sel = document.getElementById("speed");
      if (sel.value !== String(speed)) {
        sel.value = String(speed);
        sel.dispatchEvent(new Event("change", { bubbles: true }));
      }
    },
    { speed, drcMode },
  );
  await sleep(1500); // the worker applies the speed and re-targets the audio cushion; not part of the measurement
  const before = await page.evaluate(() => {
    const s = window.__demo.player.getStats();
    return { frameCount: s.frameCount, underrunEvents: s.audio?.underrunEvents ?? 0, t: performance.now() };
  });
  const t0 = Date.now();
  await page.evaluate(() => document.getElementById("bench").click());
  try {
    await page.waitForFunction(() => document.getElementById("bench").textContent.includes("Midiendo"), null, { timeout: 20000 });
    await page.waitForFunction(BENCH_DONE, null, { timeout: (secs + 180) * 1000 });
  } catch (error) {
    // A saturated main thread (e.g. a tiny homebrew at thousands of fps with publication decimation OFF) can starve the
    // demo's own measurement interval; leave a trace of what the page was doing instead of a bare TimeoutError.
    const diag = await page
      .evaluate(() => {
        const s = window.__demo.player.getStats();
        return {
          bench: document.getElementById("bench").textContent,
          disabled: document.getElementById("bench").disabled,
          msg: document.getElementById("msg").textContent,
          out: (document.getElementById("benchOut").textContent || "").slice(0, 200),
          stats: { fps: s.emuFps, emuMs: s.emuMs, drawFps: s.drawFps, frameCount: s.frameCount, feeding: s.audioFeeding },
        };
      })
      .catch(() => null);
    console.error(`  runBench failed (${config}): ${JSON.stringify(diag)}`);
    throw Object.assign(error, { benchDiag: diag });
  }
  const wallMs = Date.now() - t0;
  if (secs !== SECS) await setBenchSecs(page, SECS);
  const { text, snap } = await page.evaluate(() => {
    const s = window.__demo.player.getStats();
    const a = s.audio;
    return {
      text: document.getElementById("benchOut").textContent,
      snap: {
        frameCount: s.frameCount,
        emuFps: s.emuFps,
        emuMs: s.emuMs,
        drawFps: s.drawFps,
        drawnFrames: s.drawnFrames,
        workers: s.workers,
        backend: s.backend,
        audioFeeding: s.audioFeeding,
        prof: window.__demo.player.workerStats?.prof ?? null,
        audio: a
          ? {
              contextState: a.contextState,
              contextRate: a.contextRate,
              sourceRate: a.sourceRate,
              bufferMs: a.bufferMs,
              targetFrames: a.targetFrames,
              mode: a.mode,
              drc: a.drc,
              drcMode: a.drcMode,
              playRate: a.playRate,
              underrunEvents: a.underrunEvents,
              underrunFrames: a.underrunFrames,
              overrunEvents: a.overrunEvents,
              trimmedFrames: a.trimmedFrames,
              catchupFrames: a.catchupFrames,
              peak: a.peak,
              maxJump: a.maxJump,
            }
          : null,
      },
    };
  });
  const parsed = parseBenchText(text);
  const emulatedFrames = snap.frameCount - before.frameCount;
  const actualEmuFps = wallMs > 0 ? (emulatedFrames * 1000) / wallMs : null;
  const result = {
    config,
    speed,
    drcMode,
    throttleRate,
    synthetic,
    secs,
    wallMs,
    sceneFrameStart: before.frameCount,
    sceneFrameEnd: snap.frameCount,
    actualEmuFps,
    opt: opt ? { ...opt } : null,
    parsed,
    snapshot: snap,
    benchText: text,
    timestamp: new Date().toISOString(),
  };
  if (ping) result.ping = await pingWorker(page);
  console.log(
    `    ${config.padEnd(26)} ${fx(parsed.emuFpsAvg)} fps · ${fx(parsed.emuMsAvg, 2)} ms · dib ${fx(parsed.drawFpsAvg)} fps · underruns +${parsed.underruns ?? "?"} · búfer ${fx(parsed.bufMinMs, 0)}-${fx(parsed.bufMaxMs, 0)} ms · drc ${fx(snap.audio?.drc, 3)}${result.ping ? ` · ping ${fx(result.ping.median, 1)} ms` : ""}`,
  );
  return result;
}

/** Synthetic CPU shortage: post the test-only debugStall hook on a timer (nothing in the emulator changes). */
async function startSyntheticLoad(page, { dutyMs = 50, stallMs = 7 } = {}) {
  await page.evaluate(
    ({ dutyMs, stallMs }) => {
      clearInterval(window.__benchSynthetic);
      window.__benchSynthetic = setInterval(() => window.__demo.player.worker.postMessage({ type: "debugStall", ms: stallMs }), dutyMs);
    },
    { dutyMs, stallMs },
  );
}
async function stopSyntheticLoad(page) {
  await page.evaluate(() => {
    clearInterval(window.__benchSynthetic);
    window.__benchSynthetic = null;
  });
}

/**
 * Samples the audio ring for a few seconds (main-thread read only): used to measure the DRC factor ON A CPU THAT KEEPS UP,
 * which the plan assumed would be exactly 1. No benchmark button involved.
 */
async function sampleAudio(page, { ms = 3000, every = 100 } = {}) {
  const samples = [];
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    samples.push(
      await page.evaluate(() => {
        const a = window.__demo.player.getStats().audio;
        return a ? { drc: a.drc, bufferMs: a.bufferMs, fillFrames: a.fillFrames, targetFrames: a.targetFrames, underruns: a.underrunEvents } : null;
      }),
    );
    await sleep(every);
  }
  const ok = samples.filter(Boolean);
  const pick = (f) => ok.map(f).filter((v) => typeof v === "number");
  const stats = (arr) => (arr.length ? { min: Math.min(...arr), avg: arr.reduce((a, b) => a + b, 0) / arr.length, max: Math.max(...arr) } : null);
  return {
    samples: ok.length,
    drc: stats(pick((s) => s.drc)),
    bufferMs: stats(pick((s) => s.bufferMs)),
    fillFrames: stats(pick((s) => s.fillFrames)),
    targetFrames: ok[0]?.targetFrames ?? null,
  };
}

function median(values) {
  const a = values.filter((v) => typeof v === "number" && Number.isFinite(v)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/**
 * Round-trip latency of a control message (test-only `debugPing`): postMessage -> worker handles it -> ack back.
 * With `yieldEvery2` the worker only drains messages every other frame in FF, so this is the cost side of optimization
 * (c). 25 samples; returns min/median/max in ms.
 */
async function pingWorker(page, samples = 25) {
  return page.evaluate(async (n) => {
    const worker = window.__demo.player.worker;
    const times = [];
    await new Promise((resolve) => {
      let t0 = 0;
      const send = () => { t0 = performance.now(); worker.postMessage({ type: "debugPing", id: "bench-ping" }); };
      const done = () => { worker.removeEventListener("message", handler); resolve(); };
      const handler = (e) => {
        if (e.data?.type === "ack" && e.data.id === "bench-ping") {
          times.push(performance.now() - t0);
          if (times.length < n) send();
          else done();
        }
      };
      worker.addEventListener("message", handler);
      send();
      setTimeout(done, 5000);
    });
    const sorted = [...times].sort((a, b) => a - b);
    return { n: sorted.length, min: sorted[0] ?? null, median: sorted[Math.floor(sorted.length / 2)] ?? null, max: sorted[sorted.length - 1] ?? null };
  }, samples);
}

/**
 * Phase 9b: one measurement with the worker loop profiler on (`debugProfile`). Instead of the demo button it samples the
 * `prof` field of the worker `stats` message every 500 ms and adds up the sections; returns ms per emulated frame.
 */
async function profileRun(page, { speed = 0, secs = SECS } = {}) {
  await page.evaluate(({ speed }) => {
    const sel = document.getElementById("speed");
    if (sel.value !== String(speed)) { sel.value = String(speed); sel.dispatchEvent(new Event("change", { bubbles: true })); }
    window.__profSamples = [];
    window.__demo.player.worker.postMessage({ type: "debugProfile", on: true });
    clearInterval(window.__profTimer);
    window.__profTimer = setInterval(() => {
      const prof = window.__demo.player.workerStats?.prof;
      if (prof) window.__profSamples.push(prof);
    }, 500);
  }, { speed });
  await sleep(2000); // settle with the profiler on (first windows include speed-change noise)
  await page.evaluate(() => { window.__profSamples.length = 0; });
  const t0 = Date.now();
  await sleep(secs * 1000);
  const out = await page.evaluate(() => {
    clearInterval(window.__profTimer);
    window.__demo.player.worker.postMessage({ type: "debugProfile", on: false });
    const s = window.__demo.player.getStats();
    return { samples: window.__profSamples, frameCount: s.frameCount, emuFps: s.emuFps, emuMs: s.emuMs, workers: s.workers };
  });
  const wallMs = Date.now() - t0;
  const sl = out.samples;
  const sum = (k) => sl.reduce((a, s) => a + (s[k] ?? 0), 0);
  const frames = sum("frames");
  const windowMs = sum("windowMs");
  const per = (k) => (frames ? sum(k) / frames : 0);
  const sections = { core: per("core"), publish: per("publish"), audio: per("audio"), saves: per("saves"), yield: per("yield"), wait: per("wait") };
  const measured = Object.values(sections).reduce((a, b) => a + b, 0);
  const cadence = frames ? windowMs / frames : 0;
  const result = {
    speed,
    secs,
    wallMs,
    samples: sl.length,
    frames,
    iterations: sum("iterations"),
    msPerFrame: sections,
    msPerFrameMeasured: measured,
    msPerFrameCadence: cadence,
    msPerFrameUnaccounted: cadence - measured,
    emuMs: out.emuMs,
    emuFps: out.emuFps,
    workers: out.workers,
    opt: sl.at(-1)?.opt ?? null,
    raw: sl,
  };
  console.log(
    `    profile ${speed === 0 ? "sin límite" : speed + "x"}: ${fx(cadence, 2)} ms/fotograma real · core ${fx(sections.core, 2)} · publish ${fx(sections.publish, 2)} · audio ${fx(sections.audio, 2)} · saves ${fx(sections.saves, 3)} · yield ${fx(sections.yield, 2)} · wait ${fx(sections.wait, 2)} · resto ${fx(result.msPerFrameUnaccounted, 2)} (${frames} fotogramas)`,
  );
  return result;
}

const MEDIAN_FIELDS = [
  "actualEmuFps",
  "emuFpsAvg",
  "emuFpsMin",
  "emuFpsMax",
  "emuFpsP5",
  "emuMsAvg",
  "emuMsMax",
  "drawFpsAvg",
  "drawMsAvg",
  "bufMinMs",
  "bufAvgMs",
  "bufMaxMs",
  "underruns",
  "underrunFrames",
  "overruns",
  "catchupFrames",
  "rafHz",
  "rafP95",
];

function groupKey(run) {
  return [run.config, run.throttleRate > 1 ? "cpu4x" : "cpu1x", run.synthetic ? "synthetic" : "real"].join("|");
}

function summarize(runs) {
  const groups = new Map();
  for (const run of runs) {
    if (run.config.startsWith("probe-")) continue; // throttle probes: kept in the raw JSON, not in the comparison table
    const key = groupKey(run);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(run);
  }
  const out = [];
  for (const [key, list] of groups) {
    const first = list[0];
    const med = {};
    for (const f of MEDIAN_FIELDS) med[f] = median(list.map((r) => r.parsed[f]));
    med.actualEmuFps = median(list.map((r) => r.actualEmuFps));
    med.audioDrc = median(list.map((r) => r.snapshot?.audio?.drc));
    med.audioBufferMs = median(list.map((r) => r.snapshot?.audio?.bufferMs));
    med.pingMs = median(list.map((r) => r.ping?.median));
    med.workers = first.snapshot?.workers ?? null;
    out.push({
      key,
      config: first.config,
      speed: first.speed,
      drcMode: first.drcMode,
      throttleRate: first.throttleRate,
      synthetic: first.synthetic,
      runs: list.length,
      threads: first.config.startsWith("t0") || first.config.includes("sin-hilos") ? 0 : 1,
      backend: first.snapshot?.backend ?? null,
      workers: med.workers,
      ...med,
    });
  }
  return out.sort((a, b) => (a.config === b.config ? a.throttleRate - b.throttleRate || (a.drcMode ?? "").localeCompare(b.drcMode ?? "") : a.config.localeCompare(b.config)));
}

function printTable(medians) {
  const showPing = medians.some((m) => m.pingMs != null);
  const head = ["config", "hilos", "cpu", "fps", "min", "emuMs", "draw", "underr", "bufMin", "bufAvg", "drc", ...(showPing ? ["ping"] : []), "runs"];
  const rows = medians.map((m) => [
    m.config,
    m.workers >= 0 ? String(m.workers) : "—",
    m.throttleRate > 1 ? `${m.throttleRate}x` : m.synthetic ? "sint" : "1x",
    fx(m.emuFpsAvg),
    fx(m.emuFpsMin),
    fx(m.emuMsAvg, 2),
    fx(m.drawFpsAvg),
    m.underruns == null ? "—" : String(m.underruns),
    fx(m.bufMinMs, 0),
    fx(m.bufAvgMs, 0),
    fx(m.audioDrc, 3),
    ...(showPing ? [fx(m.pingMs, 1)] : []),
    String(m.runs),
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join("  ");
  console.log("");
  console.log(line(head));
  console.log(line(widths.map((w) => "-".repeat(w))));
  for (const r of rows) console.log(line(r));
}

// ---------- main ----------
if (!existsSync(ROM)) die(`ROM not found: ${ROM} (set BENCH_ROM)`);
const romInfo = { name: ROM.split(/[\\/]/).pop(), bytes: statSync(ROM).size, note: "local file, handed to the page's <input type=file>; never uploaded" };

console.log(`Phase 9 benchmark: ${SECS} s/run · ${REPEATS} repeat(s) · speeds [${SPEEDS.join(", ")}] · hilos 3D [${THREADS.join(", ")}] · audioDynamicRate [${DRC_MODES.join(", ")}] · ROM ${romInfo.name} (${(romInfo.bytes / 1048576).toFixed(0)} MB)`);
await mkdir(ARTIFACTS, { recursive: true });

const envInfo = {
  date: new Date().toISOString(),
  os: `${os.platform()} ${os.release()}`,
  node: process.version,
  cpu: os.cpus()[0]?.model ?? "unknown",
  cores: os.cpus().length,
  totalMemGiB: Math.round(os.totalmem() / 1073741824),
  rom: romInfo,
  secsPerRun: SECS,
  repeats: REPEATS,
  speeds: SPEEDS,
  threads: THREADS,
  drcModes: DRC_MODES,
  headed: HEADED,
  forceSwiftshader: FORCE_SWIFTSHADER,
  throttleRate: THROTTLE_RATE,
  cpuShortageMode: CPU_SHORTAGE,
  skipMatrix: SKIP_MATRIX,
  skipDrc: SKIP_DRC,
  optVariants: OPT_VARIANTS,
  profiles: null,
};

const runs = [];
let browser = null;
try {
  server = spawn(process.execPath, [join(ROOT, "scripts", "serve.mjs")], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (d) => (serverLog += d));
  server.stderr.on("data", (d) => (serverLog += d));
  for (let i = 0; i < 40 && !(await reachable(`${BASE}/demo/index.html`)); i++) await sleep(250);
  if (!(await reachable(`${BASE}/demo/index.html`))) die(`static server did not come up on ${BASE}\n${serverLog}`);
  console.log(`static server: ${BASE} (port ${PORT}; the hub on 8080 is untouched)`);

  const args = [
    "--autoplay-policy=no-user-gesture-required",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--no-sandbox",
  ];
  if (FORCE_SWIFTSHADER) args.push("--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist");
  browser = await chromium.launch({ headless: !HEADED, args });

  const speedKey = (speed) => (speed === 0 ? "sinlimite" : speed + "x");
  const configName = (threads, speed, drcMode) => `t${threads}-${speedKey(speed)}${DRC_MODES.length > 1 ? "-" + drcMode : ""}`;
  async function runSpeedMatrix(player, threads) {
    if (SKIP_MATRIX) return;
    for (let r = 1; r <= REPEATS; r++) {
      const order = r % 2 ? SPEEDS : [...SPEEDS].reverse();
      for (const speed of order) {
        for (const drcMode of DRC_MODES) {
          runs.push(await runBench(player.page, { config: configName(threads, speed, drcMode), speed, drcMode }));
        }
      }
    }
  }

  // Pages run one after the other (never two emulators at once: a background page would steal CPU and contaminate the
  // numbers). Each page is closed as soon as its matrix is done.
  const scenes = {};
  if (THREADS.includes(1)) {
    console.log("\n[1] threaded 3D renderer ON (?threads=1)");
    const on = await openPlayer(browser, { threads: true });
    envInfo.page = { ...on.info, audioFeeding: on.feeding };
    if (!on.feeding) console.warn("  warning: the audio clock is not feeding (AudioContext not running); audio numbers will be empty");
    scenes.threads1 = await driveScene(on.page);
    await on.page.screenshot({ path: join(ARTIFACTS, "bench-threads-on.png") });
    await runSpeedMatrix(on, 1);

    // ---------- Phase 9b: A/B of the three loop optimizations (same worker code, test-only debugOpt switch) ----------
    if (OPT_VARIANTS.length) {
      console.log(`\n[1a] optimizaciones del bucle: variantes [${OPT_VARIANTS.join(", ")}], velocidades [${SPEEDS.join(", ")}]`);
      for (const speed of SPEEDS) {
        for (let r = 1; r <= REPEATS; r++) {
          const order = r % 2 ? OPT_VARIANTS : [...OPT_VARIANTS].reverse();
          for (const variant of order) {
            runs.push(await runBench(on.page, { config: `opt-${variant}-${speedKey(speed)}`, speed, drcMode: "always", opt: OPT_SETS[variant], ping: true }));
          }
        }
      }
      // Identity at 1x: the three optimizations must be exact no-ops at 1x, so "off" and "all" should match within noise.
      if (!SPEEDS.includes(1) && !SKIP_IDENT && OPT_VARIANTS.includes("off") && OPT_VARIANTS.includes("all")) {
        for (let r = 1; r <= Math.min(2, REPEATS); r++) {
          for (const variant of r % 2 ? ["off", "all"] : ["all", "off"]) {
            runs.push(await runBench(on.page, { config: `opt-${variant}-1x-ident`, speed: 1, drcMode: "always", opt: OPT_SETS[variant], ping: true }));
          }
        }
      }
      // Leave the worker in the default (all optimizations on) state for whatever runs next.
      await on.page.evaluate(() => window.__demo.player.worker.postMessage({ type: "debugOpt", set: { publishDecimation: true, savesCadence: true, yieldEvery2: true } }));
      envInfo.optVariants = OPT_VARIANTS;
      envInfo.optSets = OPT_SETS;
    }

    // ---------- Phase 9b: loop profiler (1+ runs with the test-only debugProfile on) ----------
    if (PROFILE) {
      envInfo.profiles = {};
      for (const variant of PROFILE_VARIANTS) {
        console.log(`\n[1c] perfil del bucle (velocidad ${PROFILE_SPEED === 0 ? "sin límite" : PROFILE_SPEED + "x"}, variante ${variant})`);
        await on.page.evaluate((set) => window.__demo.player.worker.postMessage({ type: "debugOpt", set }), OPT_SETS[variant]);
        envInfo.profiles[variant] = await profileRun(on.page, { speed: PROFILE_SPEED, secs: PROFILE_SECS });
      }
      await on.page.evaluate(() => window.__demo.player.worker.postMessage({ type: "debugOpt", set: { publishDecimation: true, savesCadence: true, yieldEvery2: true } }));
    }

    // DRC at 1x on a CPU that keeps up: measure the factor instead of assuming it. "always" must stay near 1 and "ff"
    // must be exactly 1; this is the "no change when the CPU is on time" half of decision 0.0 #4.
    if (!SKIP_DRC) {
      envInfo.drcIdle1x = {};
      for (const mode of ["always", "ff", "off"]) {
        if (!DRC_MODES.includes(mode) && mode !== "always") continue;
        await on.page.evaluate((m) => {
          window.__demo.player.setAudioDynamicRate(m);
          const sel = document.getElementById("speed");
          sel.value = "1";
          sel.dispatchEvent(new Event("change", { bubbles: true }));
        }, mode);
        await sleep(1500);
        envInfo.drcIdle1x[mode] = await sampleAudio(on.page, { ms: 3000, every: 100 });
        console.log(`    DRC 1x CPU a tiempo (${mode}): factor medio ${fx(envInfo.drcIdle1x[mode].drc?.avg, 3)} · búfer ${fx(envInfo.drcIdle1x[mode].bufferMs?.min, 0)}-${fx(envInfo.drcIdle1x[mode].bufferMs?.max, 0)} ms`);
      }
    }

    // ---------- audioDynamicRate "always" vs "off" under a CPU shortage ----------
    if (!SKIP_DRC && !SKIP_THROTTLE) {
      console.log(`\n[1b] audioDynamicRate at 1x under a CPU shortage (always vs off)`);
      const cdp = await on.context.newCDPSession(on.page);
      // The useful "CPU justa" is ~85-94 % of real time: above the 0.8 floor of the DRC, so "always" can keep the audio
      // alive whereas "off" cuts. A 4x throttle is usually FAR too harsh (~25 % of real time), so probe with decreasing
      // rates and keep the one that lands in that window. If the worker is not throttled at all (Chrome may only
      // throttle the main thread) or no rate lands in the window, fall back to the synthetic debugStall shortage.
      const unthrottled1x = median(runs.filter((r) => r.speed === 1 && r.throttleRate === 1 && !r.synthetic).map((r) => r.parsed.emuFpsAvg));
      const target = unthrottled1x; // emulated fps at 1x with no shortage
      const probes = [];
      let chosenRate = null;
      if (target && CPU_SHORTAGE !== "synthetic") {
        for (const rate of [THROTTLE_RATE, 2, 1.5, 1.25, 1.15]) {
          await cdp.send("Emulation.setCPUThrottlingRate", { rate });
          const probe = await runBench(on.page, { config: `probe-cpu${rate}x`, speed: 1, drcMode: "always", throttleRate: rate, secs: 5 });
          probes.push({ rate, emuFps: probe.parsed.emuFpsAvg, ratio: target ? probe.parsed.emuFpsAvg / target : null });
          runs.push(probe);
          console.log(`    probe CPU ${rate}x: ${fx(probe.parsed.emuFpsAvg)} fps (${((probe.parsed.emuFpsAvg / target) * 100).toFixed(0)} % de sin límite)`);
          if (probe.parsed.emuFpsAvg >= target * 0.85 && probe.parsed.emuFpsAvg <= target * 0.94) {
            chosenRate = rate;
            break;
          }
        }
      }
      const throttleReachedWorker = probes.length > 0 && probes[0].ratio != null && probes[0].ratio < 0.95;
      // Only trust a lower throttle rate if the STRONGEST one actually slowed the emulation worker: otherwise the
      // "window" was scene drift, not CPU throttling (probes run at different points of the game's intro).
      if (!throttleReachedWorker) chosenRate = null;
      let cpuShortage;
      if (CPU_SHORTAGE === "none") {
        // No artificial load: compare "always" vs "off" in the real, naturally marginal 1x case of this machine.
        cpuShortage = { method: "real-1x", reason: "sin carga artificial (la máquina es marginalmente corta a 1x en esta escena)", unthrottledFps: target };
        console.log(`  sin carga artificial: comparando always vs off a 1x (la máquina da ${fx(target)} fps de 59,83)`);
        for (let r = 1; r <= REPEATS; r++) {
          const order = r % 2 ? ["always", "off"] : ["off", "always"];
          for (const mode of order) runs.push(await runBench(on.page, { config: `t1-1x-real-${mode}`, speed: 1, drcMode: mode }));
        }
      } else if (chosenRate != null && CPU_SHORTAGE !== "synthetic") {
        cpuShortage = { method: "cdp-cpu-throttle", rate: chosenRate, unthrottledFps: target, probes };
        await cdp.send("Emulation.setCPUThrottlingRate", { rate: chosenRate });
        for (let r = 1; r <= REPEATS; r++) {
          const order = r % 2 ? ["always", "off"] : ["off", "always"];
          for (const mode of order) runs.push(await runBench(on.page, { config: `t1-1x-cpu${chosenRate}x-${mode}`, speed: 1, drcMode: mode, throttleRate: chosenRate }));
        }
        await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
      } else {
        await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
        cpuShortage = {
          method: "synthetic-debugStall",
          reason:
            CPU_SHORTAGE === "synthetic"
              ? "forzado con CPU_SHORTAGE=synthetic"
              : throttleReachedWorker
                ? "ningún rate de throttle cae en la ventana 85-94 %"
                : "el CPU throttling no frena al worker de emulación (solo al hilo principal)",
          probes,
          dutyMs: SYNTH_DUTY_MS,
          stallMs: SYNTH_STALL_MS,
        };
        console.log(`  CPU throttling: ${cpuShortage.reason}`);
        console.log(`  usando escasez sintética: debugStall cada ${SYNTH_DUTY_MS} ms (${SYNTH_STALL_MS} ms bloqueado) -> productor por debajo del tiempo real`);
        await startSyntheticLoad(on.page, { dutyMs: SYNTH_DUTY_MS, stallMs: SYNTH_STALL_MS });
        for (let r = 1; r <= REPEATS; r++) {
          const order = r % 2 ? ["always", "off"] : ["off", "always"];
          for (const mode of order) runs.push(await runBench(on.page, { config: `t1-1x-sint-${mode}`, speed: 1, drcMode: mode, synthetic: { dutyMs: SYNTH_DUTY_MS, stallMs: SYNTH_STALL_MS } }));
        }
        await stopSyntheticLoad(on.page);
        runs.push(await runBench(on.page, { config: "t1-1x-recovered", speed: 1, drcMode: "always", synthetic: null }));
      }
      envInfo.cpuShortage = cpuShortage;
    }
    if (on.errors.length) envInfo.threadedOnErrors = on.errors.slice(0, 10);
    await on.context.close();
  }

  if (THREADS.includes(0) && !SKIP_MATRIX) {
    console.log("\n[2] threaded 3D renderer OFF (?threads=0)");
    const off = await openPlayer(browser, { threads: false });
    envInfo.threadedOff = { ...off.info, audioFeeding: off.feeding };
    if (!off.feeding) console.warn("  warning: the audio clock is not feeding (AudioContext not running); audio numbers will be empty");
    scenes.threads0 = await driveScene(off.page);
    await off.page.screenshot({ path: join(ARTIFACTS, "bench-threads-off.png") });
    await runSpeedMatrix(off, 0);
    if (off.errors.length) envInfo.threadedOffErrors = off.errors.slice(0, 10);
    await off.context.close();
  }
  envInfo.scene = { frames: scenes, shots: Object.keys(scenes).map((k) => `bench-${k === "threads1" ? "threads-on" : "threads-off"}.png`) };
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) server.kill();
}

// ---------- results ----------
const medians = summarize(runs);
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const kind = OPT_VARIANTS.length ? "opt" : PROFILE ? "prof" : SKIP_MATRIX ? "drc" : "matrix";
const outFile = join(ARTIFACTS, `bench-${kind}-${stamp}.json`);
const payload = { env: envInfo, medians, runs };
await writeFile(outFile, JSON.stringify(payload, null, 2));
await writeFile(join(ARTIFACTS, `bench-${kind}-latest.json`), JSON.stringify(payload, null, 2));
console.log(`\nRaw JSON: tests/artifacts/bench-${kind}-${stamp}.json (and bench-${kind}-latest.json)`);
printTable(medians);

// Headline numbers for the report (only if the full matrix ran).
const find = (config) => medians.find((m) => m.config === config);
const fmt = (m) =>
  m ? `${fx(m.emuFpsAvg)} fps, ${fx(m.emuMsAvg, 2)} ms, dibujo ${fx(m.drawFpsAvg)} fps, underruns ${m.underruns ?? "?"}` : "no data";
for (const s of ["t1-1x", "t1-1.5x", "t1-2x", "t1-sinlimite", "t0-1x", "t0-sinlimite"]) {
  const m = find(s);
  if (m) console.log(`${s.padEnd(14)} ${fmt(m)}`);
}
if (envInfo.cpuShortage) {
  const short = envInfo.cpuShortage;
  const suffix = short.method === "cdp-cpu-throttle" ? `cpu${short.rate}x` : short.method === "real-1x" ? "real" : "sint";
  console.log(`\nDRC 1x (${short.method}${short.rate ? ` ${short.rate}x` : ""}): ${fmt(find(`t1-1x-${suffix}-always`))} con "always" vs ${fmt(find(`t1-1x-${suffix}-off`))} con "off"`);
  const rec = find("t1-1x-recovered");
  if (rec) console.log(`DRC 1x recuperado (CPU a tiempo, always): ${fmt(rec)}`);
}

// Phase 9b summary: before/after per variant, and the 1x identity check.
const speedKeyLabel = (speed) => (speed === 0 ? "sinlimite" : `${speed}x`);
if (OPT_VARIANTS.length) {
  const pct = (a, b) => (a && b ? `${(((b / a) - 1) * 100).toFixed(1)} %` : "—");
  for (const speed of SPEEDS) {
    const label = speedKeyLabel(speed);
    const off = find(`opt-off-${label}`);
    const all = find(`opt-all-${label}`);
    if (off && all) {
      console.log(`${label.padEnd(9)} off ${fx(off.emuFpsAvg)} fps / ${fx(off.emuMsAvg, 2)} ms / ping ${fx(off.pingMs, 1)} ms  ->  all ${fx(all.emuFpsAvg)} fps / ${fx(all.emuMsAvg, 2)} ms / ping ${fx(all.pingMs, 1)} ms  =  ${pct(off.emuFpsAvg, all.emuFpsAvg)} fps`);
      for (const v of ["a", "b", "c"]) {
        const m = find(`opt-${v}-${label}`);
        if (m) console.log(`    solo ${v}: ${fx(m.emuFpsAvg)} fps / ${fx(m.emuMsAvg, 2)} ms / ping ${fx(m.pingMs, 1)} ms  =  ${pct(off.emuFpsAvg, m.emuFpsAvg)}`);
      }
    }
  }
  const identOff = find("opt-off-1x-ident");
  const identAll = find("opt-all-1x-ident");
  if (identOff && identAll) console.log(`identidad 1x: off ${fx(identOff.emuFpsAvg)} fps / ${fx(identOff.emuMsAvg, 2)} ms vs all ${fx(identAll.emuFpsAvg)} fps / ${fx(identAll.emuMsAvg, 2)} ms (deben coincidir)`);
}
if (envInfo.profiles) {
  const pct = (a, b) => (a > 0 ? `${(((b / a) - 1) * 100).toFixed(1)} %` : "—");
  const off = envInfo.profiles.off;
  for (const [variant, p] of Object.entries(envInfo.profiles)) {
    console.log(`\nperfil del bucle (${variant}, ${p.speed === 0 ? "sin límite" : p.speed + "x"}, ${p.frames} fotogramas): core ${fx(p.msPerFrame.core, 3)} · publish ${fx(p.msPerFrame.publish, 3)} · audio ${fx(p.msPerFrame.audio, 3)} · saves ${fx(p.msPerFrame.saves, 4)} · yield ${fx(p.msPerFrame.yield, 3)} · wait ${fx(p.msPerFrame.wait, 3)} · sin medir ${fx(p.msPerFrameUnaccounted, 3)} ms/fotograma (cadencia real ${fx(p.msPerFrameCadence, 3)})`);
    if (off && variant !== "off") {
      console.log(`  overhead (publish+audio+saves+yield) off ${fx(off.msPerFrame.publish + off.msPerFrame.audio + off.msPerFrame.saves + off.msPerFrame.yield, 3)} -> ${variant} ${fx(p.msPerFrame.publish + p.msPerFrame.audio + p.msPerFrame.saves + p.msPerFrame.yield, 3)} ms/fotograma (${pct(off.msPerFrame.publish + off.msPerFrame.audio + off.msPerFrame.saves + off.msPerFrame.yield, p.msPerFrame.publish + p.msPerFrame.audio + p.msPerFrame.saves + p.msPerFrame.yield)})`);
      console.log(`  cadencia real: off ${fx(off.msPerFrameCadence, 3)} -> ${variant} ${fx(p.msPerFrameCadence, 3)} ms/fotograma (${pct(off.msPerFrameCadence, p.msPerFrameCadence)})`);
    }
  }
}
