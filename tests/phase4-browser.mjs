// Phase 4 browser test: headless Chromium (Playwright) drives demo/index.html with the audio test ROM (tests/homebrew/audio-tone,
// a 440 Hz tone made by our own ARM7 code; no Nintendo content). Everything is measured INSIDE the AudioWorklet (RMS, peak,
// non-zero frames, largest sample-to-sample jump, shared counters) or in a capture ring the worklet fills, never "by ear".
//
// Usage: node tests/phase4-browser.mjs [rom.nds] [--minutes=3] [--gl=swiftshader] [--skip-long] [--only=A,C]
// Chromium needs --autoplay-policy=no-user-gesture-required (set below) AND the page gets a real mouse click before the ROM is
// chosen, which is the same gesture a user makes. There is no sound card: the AudioContext renders against a clock, nothing is played.
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createStaticServer } from "../scripts/serve.mjs";
import { peakFrequency } from "./audio-util.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flags = Object.fromEntries(args.filter((a) => a.startsWith("--")).map((a) => { const [k, v = "1"] = a.slice(2).split("="); return [k, v]; }));
const romPath = args.find((a) => !a.startsWith("--")) ?? join(root, "tests", "artifacts", "audio-tone.nds");
const minutes = Number(flags.minutes ?? 3);
const only = flags.only ? new Set(flags.only.split(",")) : null;
const run = (id) => !only || only.has(id);
if (!existsSync(romPath)) { console.log(`SKIP: ${romPath} missing (python3 tests/homebrew/audio-tone/mkrom.py tests/artifacts/audio-tone.nds)`); process.exit(0); }

function loadPlaywright() {
  for (const base of [null, execSync("npm root -g", { encoding: "utf8" }).trim() + "/"]) {
    try { return (base ? createRequire(base) : createRequire(join(root, "package.json")))("playwright"); } catch { /* next */ }
  }
  throw new Error("playwright not found (npm i -D playwright)");
}
const { chromium } = loadPlaywright();

const results = { when: new Date().toISOString(), checks: [], metrics: {}, warnings: [] };
let failures = 0;
const check = (name, ok, detail = "") => { results.checks.push({ name, ok: !!ok, detail }); if (!ok) failures++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fx = (x, d = 3) => (typeof x === "number" ? x.toFixed(d) : String(x));

const server = createStaticServer({ root });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const launchArgs = ["--autoplay-policy=no-user-gesture-required", ...(flags.gl === "swiftshader" ? ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] : [])];
const browser = await chromium.launch({ args: launchArgs });
results.browser = browser.version(); results.launchArgs = launchArgs;
console.log(`Chromium ${results.browser}, args ${launchArgs.join(" ")}, server ${base}, long run ${minutes} min`);

const consoleIssues = [];
async function boot(query = "?capture=1") {
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const page = await context.newPage();
  page.on("console", (m) => {
    const t = m.text();
    if (m.type() === "error") consoleIssues.push(`console.error: ${t}`);
    else if (m.type() === "warning" && !/GPU stall|GL Driver Message|firmware file/.test(t)) results.warnings.push(t);
  });
  page.on("pageerror", (e) => consoleIssues.push(`pageerror: ${e.message}`));
  page.on("requestfailed", (r) => consoleIssues.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));
  await page.goto(`${base}/demo/index.html${query}`);
  await page.mouse.click(600, 400); // real user gesture: unlocks the AudioContext the way a person would
  await page.setInputFiles("#rom", romPath);
  await page.waitForFunction(() => { const s = window.__demo.player?.getStats(); return s?.audio?.tick > 5 && s.audioFeeding && s.audio.mode === 1; }, null, { timeout: 30000 });
  await page.evaluate(() => {
    const p = window.__demo.player;
    window.__t = {
      p,
      st: () => { const s = p.getStats(); return { ...s.audio, frameCount: s.frameCount, emuFps: s.emuFps, drawnFrames: s.drawnFrames, drawFps: s.drawFps, feeding: s.audioFeeding, now: performance.now(), ctxTime: p.audio.ctx.currentTime }; },
      resetStats: () => Atomics.store(new Int32Array(p.audioRing, 0, 32), 12, 1),
      capture: (ms) => new Promise((resolve) => { // copy `ms` of the worklet's output (mono L, ctx rate) out of the capture ring
        const ctrl = new Int32Array(p.audioRing, 0, 32), cap = new Float32Array(p.audioCaptureRing), rate = p.audio.ctx.sampleRate;
        const n = Math.round((ms / 1000) * rate), start = Atomics.load(ctrl, 15);
        Atomics.store(ctrl, 14, 1);
        setTimeout(() => { Atomics.store(ctrl, 14, 0); const end = Atomics.load(ctrl, 15), got = Math.min(end - start, cap.length), out = new Array(got); for (let i = 0; i < got; i++) out[i] = cap[(end - got + i) & (cap.length - 1)]; resolve({ rate, samples: out }); }, ms + 80);
      }),
    };
  });
  return { page, context };
}
const T = (page) => page.evaluate(() => window.__t.st());
const rmsOf = (a, b) => Math.sqrt((b.sumSq - a.sumSq) / Math.max(1, b.framesOut - a.framesOut));
const stepLimit = (rate, peak = 0.1942) => 1.5 * ((2 * Math.PI * 440 * peak) / rate) + 1e-4; // steepest slope of the 440 Hz tone, plus 50 %
const EXPECTED_RMS = 0.1349; // measured on the raw core output in tests/phase4-core-audio.mjs

// ================================ A. basic path: non-null samples, pitch, real-time ratio ================================
let { page, context } = await boot();
let A0 = await T(page);
if (run("A")) {
  console.log("\n== A. worklet receives the core's audio ==");
  check("A1 AudioContext is running and the worklet heartbeat advances", A0.contextState === "running" && A0.tick > 5, `state ${A0.contextState}, ctx ${A0.contextRate} Hz, tick ${A0.tick}`);
  check("A2 the core announces 32728.498 Hz (not 32768) and the worker passed it on", Math.abs(A0.sourceRate - 33513982 / 1024) < 0.01, `${A0.sourceRate} Hz`);
  await page.evaluate(() => window.__t.resetStats());
  const a = await T(page); await sleep(6000); const b = await T(page);
  const rms = rmsOf(a, b), nz = (b.nonZeroFrames - a.nonZeroFrames) / (b.framesOut - a.framesOut);
  check("A3 worklet output is not null: >99 % of the frames carry signal", nz > 0.99, `${fx(nz * 100, 2)} % non-zero over ${b.framesOut - a.framesOut} frames`);
  check("A4 RMS matches the core's own output (tone ROM, 0.1349) within 5 %", Math.abs(rms / EXPECTED_RMS - 1) < 0.05, `RMS ${fx(rms, 4)}, peak ${fx(b.peak, 4)}`);
  check("A5 no underrun/overrun while idle-running 6 s", b.underrunEvents === a.underrunEvents && b.overrunFrames === 0, `underruns ${b.underrunEvents}, overrun frames ${b.overrunFrames}`);
  const wall = (b.now - a.now) / 1000, ctxT = b.ctxTime - a.ctxTime;
  results.metrics.clockRatio = ctxT / wall;
  console.log(`      AudioContext clock / wall clock = ${fx(ctxT / wall, 5)}`);
  const emuRate = (b.frameCount - a.frameCount) / ctxT;
  check("A6 audio clock is the metronome: emulated frames per AudioContext second = 59.826 ± 0.5 (±1 frame in a 6 s window is ±0.28 %; the long run I6 is the precise one)", Math.abs(emuRate - 59.8261) < 0.5, `${fx(emuRate, 3)} frames/s of audio time`);
  const cap = await page.evaluate(() => window.__t.capture(1000));
  const f = peakFrequency(Float64Array.from(cap.samples), cap.rate, 400, 480, 0.02);
  check("A7 resampled pitch is right: 440.04 Hz ± 0.3", Math.abs(f - 440.04) < 0.3, `${fx(f, 2)} Hz measured at ${cap.rate} Hz from ${cap.samples.length} captured samples`);
  const peakAbs = Math.max(...cap.samples.map(Math.abs));
  check("A8 captured peak ≈ 0.194 (no clipping, no gain error)", Math.abs(peakAbs - 0.194) < 0.01, `peak ${fx(peakAbs, 4)}`);
}

// ================================ B. no dependence on requestAnimationFrame / background tabs ================================
if (run("B")) {
  console.log("\n== B. emulation pace does not depend on requestAnimationFrame ==");
  await page.evaluate(() => { window.__realRaf = window.requestAnimationFrame; window.requestAnimationFrame = () => 0; }); // what a hidden tab does
  await sleep(500);
  const a = await T(page); await sleep(8000); const b = await T(page);
  const frames = b.frameCount - a.frameCount, secs = (b.now - a.now) / 1000;
  check("B1 with rAF dead for 8 s the draw loop stopped (precondition)", b.drawnFrames - a.drawnFrames <= 1, `drawn frames Δ ${b.drawnFrames - a.drawnFrames}`);
  check("B2 …and the emulator still ran at 1x (59.8 fps ± 1) paced by the audio clock", Math.abs(frames / secs - 59.83) < 1, `${fx(frames / secs, 2)} fps`);
  check("B3 …with no audio underrun and a stable buffer", b.underrunEvents === a.underrunEvents && Math.abs(b.bufferMs - a.bufferMs) < 25, `buffer ${fx(a.bufferMs, 1)} → ${fx(b.bufferMs, 1)} ms`);
  await page.evaluate(() => { window.requestAnimationFrame = window.__realRaf; requestAnimationFrame(window.__t.p.tick); });
  await sleep(500);
  const c = await T(page);
  check("B4 drawing resumes when rAF returns", c.drawnFrames > b.drawnFrames + 10, `drawn Δ ${c.drawnFrames - b.drawnFrames}`);
}

// ================================ C. speed 2x audible (sped up) / unlimited muted ================================
if (run("C")) {
  console.log("\n== C. 2x and unlimited speed ==");
  for (const [label, value, expectFps] of [["2x", 2, 119.65], ["unlimited", 0, null]]) {
    await page.evaluate((v) => window.__t.p.setSpeed(v), value); await sleep(1500);
    const a = await T(page); await sleep(3000); const b = await T(page);
    const fps = (b.frameCount - a.frameCount) / ((b.now - a.now) / 1000);
    if (value === 2) {
      // 2x keeps the audio: the clock stays the metronome, the tone plays an octave higher (same RMS), no underrun
      check("C 2x: the audio keeps playing (clock stays the metronome, RMS as at 1x)", b.feeding && Math.abs(rmsOf(a, b) / EXPECTED_RMS - 1) < 0.05, `feeding ${b.feeding}, RMS ${fx(rmsOf(a, b), 5)}, ${fx(fps, 1)} fps`);
      check("C 2x: speed really is ~2x", Math.abs(fps / expectFps - 1) < 0.05, `${fx(fps, 1)} fps vs ${expectFps}`);
      check("C 2x: no underrun while sped up", b.underrunEvents === a.underrunEvents, `underruns ${b.underrunEvents - a.underrunEvents}`);
    } else {
      check(`C ${label}: the audio clock stops being the metronome and the output is silent (RMS < 0.001)`, !b.feeding && rmsOf(a, b) < 0.001, `feeding ${b.feeding}, RMS ${fx(rmsOf(a, b), 5)}, ${fx(fps, 1)} fps`);
      check(`C ${label}: muting is not counted as an underrun and the ring is empty`, b.underrunEvents === a.underrunEvents && b.fillFrames === 0, `underruns ${b.underrunEvents}, fill ${b.fillFrames}`);
    }
  }
  await page.evaluate(() => { window.__t.resetStats(); window.__t.p.setSpeed(1); });
  const t0 = Date.now();
  await page.waitForFunction(() => window.__t.st().mode === 1 && window.__t.st().feeding, null, { timeout: 8000 });
  const back = Date.now() - t0; await sleep(1500);
  const a = await T(page); await sleep(3000); const b = await T(page);
  check("C back to 1x: sound returns by itself, RMS right, no click", Math.abs(rmsOf(a, b) / EXPECTED_RMS - 1) < 0.05 && b.maxJump < stepLimit(b.contextRate), `back in ${back} ms, RMS ${fx(rmsOf(a, b), 4)}, max jump ${fx(b.maxJump, 4)} (limit ${fx(stepLimit(b.contextRate), 4)})`);
}

// ================================ D. pause / resume ================================
if (run("D")) {
  console.log("\n== D. pause and resume without clicks ==");
  await page.evaluate(() => window.__t.resetStats());
  await page.evaluate(() => window.__t.p.pause()); await sleep(200);
  const a = await T(page); await sleep(1500); const b = await T(page);
  check("D1 pause: silent output (RMS < 0.0005) and no click while fading (max jump within the tone's own slope)", rmsOf(a, b) < 0.0005 && a.maxJump < stepLimit(a.contextRate), `max jump ${fx(a.maxJump, 4)} (limit ${fx(stepLimit(a.contextRate), 4)}), RMS ${fx(rmsOf(a, b), 6)}`);
  check("D2 pause: the ring was flushed and it is not counted as an underrun", b.fillFrames === 0 && b.underrunEvents === a.underrunEvents, `fill ${b.fillFrames}, underruns ${b.underrunEvents}`);
  check("D3 emulation really stopped", b.frameCount === a.frameCount, `frame ${a.frameCount} → ${b.frameCount}`);
  await page.evaluate(() => { window.__t.resetStats(); window.__t.p.resume(); }); // peak was zeroed: peak > 0.01 below means NEW sound
  const t0 = Date.now();
  await page.waitForFunction(() => { const s = window.__t.st(); return s.mode === 1 && s.peak > 0.01; }, null, { timeout: 8000 });
  const untilSound = Date.now() - t0;
  const c = await T(page); await sleep(3000); const d = await T(page);
  check("D4 resume: sound returns, RMS right, no click, no underrun", Math.abs(rmsOf(c, d) / EXPECTED_RMS - 1) < 0.05 && d.maxJump < stepLimit(d.contextRate) && d.underrunEvents === b.underrunEvents, `RMS ${fx(rmsOf(c, d), 4)}, max jump ${fx(d.maxJump, 4)}, ${untilSound} ms from resume() to first sound`);
}

// ================================ E. volume / mute (post-gain tap) ================================
if (run("E")) {
  console.log("\n== E. volume and mute, measured after the GainNode ==");
  const tap = (ms) => page.evaluate(async (ms) => {
    const an = window.__t.p.audio.tapOutput(), buf = new Float32Array(an.fftSize);
    await new Promise((r) => setTimeout(r, ms)); an.getFloatTimeDomainData(buf);
    let ss = 0, jump = 0; for (let i = 0; i < buf.length; i++) { ss += buf[i] * buf[i]; if (i) jump = Math.max(jump, Math.abs(buf[i] - buf[i - 1])); }
    return { rms: Math.sqrt(ss / buf.length), jump, rate: window.__t.p.audio.ctx.sampleRate };
  }, ms);
  await tap(100); await sleep(800);
  const full = await tap(100);
  await page.evaluate(() => window.__t.p.setVolume(0.5)); const half = await tap(800);
  check("E1 setVolume(0.5) halves the level (±5 %)", Math.abs(half.rms / full.rms - 0.5) < 0.025, `RMS ${fx(full.rms, 4)} → ${fx(half.rms, 4)}`);
  check("E2 …and the 1→0.5 change contains no click (the buffer holds the transition)", half.jump < stepLimit(half.rate), `max jump ${fx(half.jump, 4)} (limit ${fx(stepLimit(half.rate), 4)})`);
  await page.evaluate(() => window.__t.p.setMuted(true)); const mut = await tap(800);
  check("E3 setMuted(true): silence within 0.8 s, without a click", mut.rms < 0.002 * 1 + 0.005 && mut.jump < stepLimit(mut.rate), `RMS in the last 0.74 s ${fx(mut.rms, 5)} (includes the fade), max jump ${fx(mut.jump, 4)}`);
  await sleep(700); const mut2 = await tap(100);
  check("E4 …fully silent afterwards (RMS < 1e-4)", mut2.rms < 1e-4, `RMS ${fx(mut2.rms, 7)}`);
  await page.evaluate(() => window.__t.p.setMuted(false)); const un = await tap(800);
  check("E5 setMuted(false) restores volume 0.5 without a click", un.jump < stepLimit(un.rate), `max jump ${fx(un.jump, 4)}`);
  await sleep(300); const un2 = await tap(100);
  check("E6 …at the volume that was set (0.5), not at 1", Math.abs(un2.rms / full.rms - 0.5) < 0.025, `RMS ${fx(un2.rms, 4)}`);
  await page.evaluate(() => window.__t.p.setVolume(1));
  const bad = await page.evaluate(() => { try { window.__t.p.setVolume(1.5); return "no error"; } catch (e) { return e.constructor.name; } });
  check("E7 out-of-range volume is rejected", bad === "RangeError", bad);
  await sleep(500);
}

// ================================ F. buffer empty / full, measured ================================
if (run("F")) {
  console.log("\n== F. what happens when the buffer empties or fills ==");
  await sleep(1000);
  await page.evaluate(() => window.__t.resetStats());
  let a = await T(page);
  await page.evaluate(() => window.__t.p.worker.postMessage({ type: "debugStall", ms: 400 }));
  const t0 = Date.now();
  await page.waitForFunction(() => window.__t.st().mode === 2, null, { timeout: 3000 });
  const tStarve = Date.now() - t0;
  await page.waitForFunction(() => window.__t.st().mode === 1, null, { timeout: 5000 });
  const tRecover = Date.now() - t0;
  let b = await T(page);
  const dEv = b.underrunEvents - a.underrunEvents, dFr = b.underrunFrames - a.underrunFrames;
  results.metrics.underrun = { stallMs: 400, events: dEv, silenceMs: (dFr / b.contextRate) * 1000, recoveryMs: tRecover, maxJump: b.maxJump };
  check("F1 empty buffer: exactly one underrun event for a 400 ms stall", dEv === 1, `events ${dEv}`);
  check("F2 …the gap is filled with silence/decay: ≈ stall − buffered audio", dFr / b.contextRate > 0.2 && dFr / b.contextRate < 0.5, `${fx((dFr / b.contextRate) * 1000, 0)} ms of silence (stall 400 ms, buffer ~80 ms), back to sound after ${tRecover} ms`);
  check("F3 …with no click at the cut or at the recovery", b.maxJump < stepLimit(b.contextRate), `max jump ${fx(b.maxJump, 4)} (limit ${fx(stepLimit(b.contextRate), 4)})`);
  await sleep(1500);

  // Moderate excess: +10 DS frames (~167 ms) written in one go => fill ~250 ms (> 2x target). The paced worker then sleeps while
  // fill > target, so the excess drains at real-time speed; the 2 % catch-up engages while fill > 2x target (defensive: it only
  // matters for a producer that ignores the fill). Sample fast (every ~15 ms) to see the peak.
  await page.evaluate(() => window.__t.resetStats()); a = await T(page);
  await page.evaluate(() => window.__t.p.worker.postMessage({ type: "debugBurst", frames: 10 }));
  let peak = 0, drained = null; const tb = Date.now();
  for (let i = 0; i < 200; i++) { const s = await T(page); peak = Math.max(peak, s.bufferMs); if (peak > 150 && s.bufferMs < 100) { drained = Date.now() - tb; break; } await sleep(10); }
  await sleep(300); b = await T(page);
  results.metrics.overrunModerate = { peakBufferMs: peak, backUnder100msAfterMs: drained, catchupFrames: b.catchupFrames, discarded: b.trimmedFrames, underrunDelta: b.underrunEvents - a.underrunEvents, maxJump: b.maxJump };
  check("F4 moderate overrun: the buffer rises well above target (peak > 150 ms), the excess drains by itself, nothing is discarded and nothing underruns", peak > 150 && drained !== null && b.trimmedFrames === a.trimmedFrames && b.underrunEvents === a.underrunEvents, `peak ${fx(peak, 0)} ms, back under 100 ms after ${drained} ms, ${b.catchupFrames} output frames played 2 % faster, 0 discarded`);
  check("F5 …without a click", b.maxJump < stepLimit(b.contextRate), `max jump ${fx(b.maxJump, 4)}`);
  await sleep(1000);

  // Large burst: 100 DS frames (~1.7 s of audio, produced at ~5x real time) => far more than the 0.5 s ring. The reader trims the
  // oldest frames whenever fill > 5x target (13 090 < 16 384 capacity), checked every 2.7 ms render quantum, so in practice it stays
  // ahead of the writer and the writer-side "drop the newest" path is NOT reached here (it is covered by tests/audio-ring.test.mjs).
  await page.evaluate(() => window.__t.resetStats()); a = await T(page);
  await page.evaluate(() => window.__t.p.worker.postMessage({ type: "debugBurst", frames: 100 }));
  await sleep(1500); b = await T(page);
  results.metrics.overrunBurst = { writerDroppedFrames: b.overrunFrames - a.overrunFrames, readerTrimmedFrames: b.trimmedFrames - a.trimmedFrames, bufferMsAfter: b.bufferMs, underrunEventsDelta: b.underrunEvents - a.underrunEvents, maxJump: b.maxJump };
  check("F6 burst overrun: the reader trims the oldest frames and counts them (the ring never overflows)", b.trimmedFrames > a.trimmedFrames, `writer dropped ${b.overrunFrames - a.overrunFrames} frames, reader trimmed ${b.trimmedFrames - a.trimmedFrames} frames`);
  check("F7 …and afterwards the buffer is back near the target", b.bufferMs < 130, `buffer ${fx(b.bufferMs, 1)} ms, underruns Δ ${b.underrunEvents - a.underrunEvents} (a trim can leave a short gap if it lands mid-cycle)`);
  await sleep(1500);
}

// ================================ G. captureStream ================================
if (run("G")) {
  console.log("\n== G. captureStream: canvas video + MediaStreamAudioDestinationNode audio in one MediaStream ==");
  const g = await page.evaluate(async () => {
    const p = window.__t.p, ctx = p.audio.ctx;
    const stream = p.captureStream(30);
    const v = stream.getVideoTracks(), a = stream.getAudioTracks();
    const out = { videoTracks: v.length, audioTracks: a.length, vSettings: v[0]?.getSettings(), vState: v[0]?.readyState, aState: a[0]?.readyState };
    // video: count frames a <video> element really presents
    const el = document.createElement("video"); el.muted = true; el.playsInline = true; el.srcObject = stream; await el.play().catch(() => {});
    let frames = 0; const stop = performance.now() + 2500;
    await new Promise((res) => { const cb = () => { frames++; if (performance.now() < stop) el.requestVideoFrameCallback(cb); else res(); }; el.requestVideoFrameCallback(cb); setTimeout(res, 4000); });
    out.videoFrames2s = frames; out.videoSize = [el.videoWidth, el.videoHeight];
    // audio: analyser behind a MediaStreamAudioSourceNode (so what a WebRTC peer would receive)
    const src = ctx.createMediaStreamSource(new MediaStream(a)), an = ctx.createAnalyser(), z = ctx.createGain(); z.gain.value = 0;
    an.fftSize = 8192; src.connect(an); an.connect(z).connect(ctx.destination);
    const rmsNow = async () => { await new Promise((r) => setTimeout(r, 600)); const b = new Float32Array(an.fftSize); an.getFloatTimeDomainData(b); return Math.sqrt(b.reduce((s, x) => s + x * x, 0) / b.length); };
    out.audioRms = await rmsNow();
    p.setMuted(true); out.audioRmsWhileLocalMuted = await rmsNow(); p.setMuted(false);
    // record 3 s into a real container and decode it back
    const rec = new MediaRecorder(stream), chunks = []; rec.ondataavailable = (e) => chunks.push(e.data);
    const stopped = new Promise((r) => (rec.onstop = r)); rec.start(); await new Promise((r) => setTimeout(r, 3000)); rec.stop(); await stopped;
    const blob = new Blob(chunks, { type: rec.mimeType }); out.recMime = rec.mimeType; out.recBytes = blob.size;
    try { const dec = await ctx.decodeAudioData(await blob.arrayBuffer()); const ch = dec.getChannelData(0); let ss = 0; for (const x of ch) ss += x * x; out.decodedSeconds = dec.duration; out.decodedRms = Math.sqrt(ss / ch.length); out.decodedChannels = dec.numberOfChannels; } catch (e) { out.decodeError = String(e); }
    return out;
  });
  results.metrics.captureStream = g;
  check("G1 one MediaStream with 1 video + 1 audio track, both live", g.videoTracks === 1 && g.audioTracks === 1 && g.vState === "live" && g.aState === "live", JSON.stringify(g.vSettings));
  check("G2 the video track presents frames from the visible canvas (≥ 15 in 2.5 s asking for 30 fps)", g.videoFrames2s >= 15 && g.videoSize[0] > 0, `${g.videoFrames2s} frames, ${g.videoSize.join("x")}`);
  check("G3 the audio track carries the game (RMS ≈ 0.135 ± 15 %)", Math.abs(g.audioRms / EXPECTED_RMS - 1) < 0.15, `RMS ${fx(g.audioRms, 4)}`);
  check("G4 local mute does NOT silence the captured stream (a WebRTC guest keeps hearing)", Math.abs(g.audioRmsWhileLocalMuted / EXPECTED_RMS - 1) < 0.15, `RMS while muted ${fx(g.audioRmsWhileLocalMuted, 4)}`);
  check("G5 MediaRecorder: the container decodes back to 2 s+ of non-silent stereo audio", !g.decodeError && g.decodedSeconds > 2 && g.decodedRms > 0.05, g.decodeError ?? `${g.recMime}, ${g.recBytes} bytes, ${fx(g.decodedSeconds, 2)} s, ${g.decodedChannels} ch, RMS ${fx(g.decodedRms, 4)}`);
}
await context.close();

// ================================ H. other AudioContext sample rates ================================
if (run("H")) {
  console.log("\n== H. other AudioContext rates (resampling in the real worklet) ==");
  for (const rate of [22050, 48000, 96000]) {
    const r = await boot(`?capture=1&audiorate=${rate}`);
    await sleep(2500); await r.page.evaluate(() => window.__t.resetStats());
    const a = await T(r.page); const cap = await r.page.evaluate(() => window.__t.capture(1500)); const b = await T(r.page);
    const f = peakFrequency(Float64Array.from(cap.samples), cap.rate, 400, 480, 0.02);
    check(`H ${rate} Hz: context really runs at ${rate}, pitch 440.04 ± 0.3, RMS right, no underrun, no click`,
      b.contextRate === rate && Math.abs(f - 440.04) < 0.3 && Math.abs(rmsOf(a, b) / EXPECTED_RMS - 1) < 0.05 && b.underrunEvents === 0 && b.maxJump < stepLimit(rate),
      `ctx ${b.contextRate} Hz, ${fx(f, 2)} Hz, RMS ${fx(rmsOf(a, b), 4)}, underruns ${b.underrunEvents}, max jump ${fx(b.maxJump, 4)}`);
    await r.context.close();
  }
}

// ================================ I. long run at 1x ================================
if (run("I") && !flags["skip-long"]) {
  console.log(`\n== I. ${minutes} minutes at 1x: buffer stability, underruns, drift ==`);
  const r = await boot("?capture=1"); page = r.page; context = r.context;
  await sleep(3000);
  await page.evaluate(() => window.__t.resetStats());
  const first = await T(page);
  const samples = []; const t0 = Date.now(); const end = t0 + minutes * 60_000;
  while (Date.now() < end) {
    await sleep(1000);
    const s = await T(page);
    samples.push({ t: (Date.now() - t0) / 1000, ms: s.bufferMs, under: s.underrunEvents, over: s.overrunFrames, trim: s.trimmedFrames, frames: s.frameCount, ctxTime: s.ctxTime, emuFps: s.emuFps, drawn: s.drawnFrames, sumSq: s.sumSq, framesOut: s.framesOut, maxJump: s.maxJump, mode: s.mode });
    if (samples.length % 30 === 0) console.log(`      t=${fx(samples.at(-1).t, 0)} s  buffer ${fx(s.bufferMs, 1)} ms  underruns ${s.underrunEvents}  emu ${fx(s.emuFps, 1)} fps`);
  }
  const last = await T(page);
  const ms = samples.map((s) => s.ms), mean = ms.reduce((a, b) => a + b, 0) / ms.length;
  const std = Math.sqrt(ms.reduce((a, b) => a + (b - mean) ** 2, 0) / ms.length);
  const n = samples.length, tm = samples.reduce((a, s) => a + s.t, 0) / n;
  const slope = samples.reduce((a, s) => a + (s.t - tm) * (s.ms - mean), 0) / samples.reduce((a, s) => a + (s.t - tm) ** 2, 0); // ms per second
  const wall = samples.at(-1).t, avFrames = last.frameCount - first.frameCount, ctxElapsed = last.ctxTime - first.ctxTime;
  const winRms = []; for (let i = 10; i < samples.length; i += 10) winRms.push(Math.sqrt((samples[i].sumSq - samples[i - 10].sumSq) / (samples[i].framesOut - samples[i - 10].framesOut)));
  results.metrics.longRun = { minutes, wallSeconds: wall, audioContextSeconds: ctxElapsed, bufferMs: { mean, std, min: Math.min(...ms), max: Math.max(...ms), slopeMsPerMinute: slope * 60 }, underrunEvents: last.underrunEvents - first.underrunEvents, underrunFrames: last.underrunFrames - first.underrunFrames, overrunFrames: last.overrunFrames, trimmedFrames: last.trimmedFrames, catchupFrames: last.catchupFrames, emulatedFrames: avFrames, meanEmuFps: avFrames / ctxElapsed, maxJump: last.maxJump, rmsMinMax: [Math.min(...winRms), Math.max(...winRms)], drawnFrames: last.drawnFrames - first.drawnFrames };
  const L = results.metrics.longRun;
  console.log(`      buffer: mean ${fx(mean, 1)} ms, std ${fx(std, 1)}, min ${fx(L.bufferMs.min, 1)}, max ${fx(L.bufferMs.max, 1)}, slope ${fx(slope * 60, 3)} ms/min over ${fx(wall, 0)} s (${fx(ctxElapsed, 0)} s of audio-context time)`);
  check(`I1 audioBufferMs stable over ${minutes} min: all samples within [mean ± 30 ms] and 40..140 ms`, Math.abs(L.bufferMs.max - mean) < 30 && Math.abs(L.bufferMs.min - mean) < 30 && L.bufferMs.min > 40 && L.bufferMs.max < 140, `mean ${fx(mean, 1)}, std ${fx(std, 1)}, range ${fx(L.bufferMs.min, 1)}..${fx(L.bufferMs.max, 1)} ms`);
  check("I2 no drift: buffer trend under ±1 ms per minute", Math.abs(slope * 60) < 1, `${fx(slope * 60, 3)} ms/min (an audio↔emulation drift would show up here)`);
  check("I3 zero underruns, zero overrun/trim/catch-up", L.underrunEvents === 0 && last.overrunFrames === 0 && last.trimmedFrames === 0 && last.catchupFrames === 0, `underruns ${L.underrunEvents}, overrun ${last.overrunFrames}, trimmed ${last.trimmedFrames}, catch-up ${last.catchupFrames}`);
  check("I4 no click in the whole run (max sample-to-sample jump within the tone's slope)", last.maxJump < stepLimit(last.contextRate), `max jump ${fx(last.maxJump, 4)} (limit ${fx(stepLimit(last.contextRate), 4)})`);
  check("I5 level constant: RMS per 10 s window within 2 % of the core's", winRms.every((x) => Math.abs(x / EXPECTED_RMS - 1) < 0.02), `${fx(L.rmsMinMax[0], 4)}..${fx(L.rmsMinMax[1], 4)}`);
  check("I6 emulation ran at the console's 59.826 fps on average (audio-clock paced)", Math.abs(L.meanEmuFps - 59.8261) < 0.1, `${fx(L.meanEmuFps, 3)} frames per second of audio time`);
  await context.close();
}

await browser.close(); server.close();
check("Z no console errors, page errors or failed requests during the whole run", consoleIssues.length === 0, consoleIssues.slice(0, 5).join(" | "));
results.consoleIssues = consoleIssues;
mkdirSync(join(root, "tests", "artifacts"), { recursive: true });
writeFileSync(join(root, "tests", "artifacts", "phase4-browser-results.json"), JSON.stringify(results, null, 2));
console.log(`\n${results.checks.length - failures}/${results.checks.length} checks passed${results.warnings.length ? `; ${results.warnings.length} console warnings (see results json)` : ""}`);
process.exit(failures ? 1 : 0);
