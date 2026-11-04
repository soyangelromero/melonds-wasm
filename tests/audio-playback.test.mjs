// Unit tests of the real-time consumer logic (js/audio-playback.js): resampling, priming, underrun, pause fade, catch-up, trim.
// The same code runs inside the AudioWorklet; here it is driven in Node with explicit 128-frame render quanta.
import test from "node:test";
import assert from "node:assert/strict";
import { createAudioRingBuffer, AudioRingWriter, readRingStats, ringViews, CTRL, MODE } from "../js/audio-ring.js";
import { AudioPlayback } from "../js/audio-playback.js";
import { peakFrequency } from "./audio-util.mjs";

const SRC = 33513982 / 1024; // 32728.498 Hz, what the core announces
const Q = 128;
// Steepest sample-to-sample step of the 1 kHz / 0.5-amplitude test tone at 48 kHz. A click (hard cut) would be ~0.5.
const NATURAL_STEP = (2 * Math.PI * 1000 * 0.5) / 48000, CLICK_LIMIT = NATURAL_STEP * 1.15;

function rig({ ctxRate = 48000, targetMs = 80, capacity = 16384 } = {}) {
  const sab = createAudioRingBuffer(capacity);
  const writer = new AudioRingWriter(sab);
  writer.setSourceRate(SRC); writer.setTargetFrames(Math.round((targetMs / 1000) * SRC));
  const pb = new AudioPlayback(sab, ctxRate);
  const outL = new Float32Array(Q), outR = new Float32Array(Q);
  let srcPos = 0; const tmp = new Int16Array(4096 * 2);
  return {
    sab, writer, pb, outL, outR, ctrl: ringViews(sab).ctrl, target: writer.targetFrames,
    /** Feed `n` frames of a sine (Hz, amplitude 0..1) at the source rate, phase-continuous. */
    feed(n, hz = 1000, amp = 0.5) {
      let left = n;
      while (left > 0) {
        const m = Math.min(left, 4096);
        for (let i = 0; i < m; i++) { const v = Math.round(amp * 32767 * Math.sin((2 * Math.PI * hz * (srcPos + i)) / SRC)); tmp[i * 2] = v; tmp[i * 2 + 1] = v; }
        writer.write(tmp, m); srcPos += m; left -= m;
      }
    },
    /** Renders `quanta` quanta, topping the ring up to the target before each one (what the paced worker does). */
    run(quanta, { top = true, hz = 1000, amp = 0.5 } = {}) {
      const out = new Float32Array(quanta * Q);
      for (let q = 0; q < quanta; q++) {
        if (top && writer.fill < this.target) this.feed(this.target - writer.fill + 600, hz, amp);
        pb.process(outL, outR, Q); out.set(outL, q * Q);
      }
      return out;
    },
  };
}
const sinFit = (x, fs, f) => { // least-squares amplitude/phase of a known frequency, returns SNR in dB of the residual
  let sc = 0, ss = 0, cc = 0, ssn = 0, scn = 0, xx = 0;
  for (let i = 0; i < x.length; i++) { const c = Math.cos((2 * Math.PI * f * i) / fs), s = Math.sin((2 * Math.PI * f * i) / fs); cc += c * c; ss += s * s; sc += s * c; scn += x[i] * c; ssn += x[i] * s; xx += x[i] * x[i]; }
  const det = cc * ss - sc * sc, a = (scn * ss - ssn * sc) / det, b = (ssn * cc - scn * sc) / det;
  const fitE = a * a * cc + b * b * ss + 2 * a * b * sc, resid = xx - fitE;
  return { amp: Math.hypot(a, b), snr: 10 * Math.log10(fitE / Math.max(resid, 1e-30)) };
};

for (const ctxRate of [22050, 44100, 48000, 96000]) {
  test(`resampler @${ctxRate} Hz: pitch within 0.05 Hz, amplitude within 1 %, SNR of a 1 kHz tone`, () => {
    const t = rig({ ctxRate });
    t.run(200); // prime and settle
    const x = t.run(ctxRate > 50000 ? 400 : 300);
    const seg = x.subarray(2000);
    const f = peakFrequency(seg.subarray(0, 16384), ctxRate, 950, 1050, 0.05);
    assert.ok(Math.abs(f - 1000) < 0.05, `peak at ${f}`);
    const { amp, snr } = sinFit(seg, ctxRate, f);
    assert.ok(Math.abs(amp - 0.5) < 0.005, `amplitude ${amp}`);
    // 22.05 kHz is DOWN-sampling (32.7 k -> 22 k) with no anti-alias filter; a 1 kHz tone has nothing to alias, so it still passes.
    assert.ok(snr > 45, `SNR ${snr.toFixed(1)} dB`);
  });
}

test("cubic (Catmull-Rom) is better than linear interpolation for a high tone (6 kHz @48 kHz)", () => {
  const t = rig({ ctxRate: 48000 });
  t.run(200, { hz: 6000 });
  const x = t.run(300, { hz: 6000 }).subarray(2000);
  const cubic = sinFit(x, 48000, peakFrequency(x.subarray(0, 16384), 48000, 5950, 6050, 0.05)).snr;
  // Reference: linear interpolation of the same input.
  const n = 40000, src = new Float64Array(n); for (let i = 0; i < n; i++) src[i] = 0.5 * Math.sin((2 * Math.PI * 6000 * i) / SRC);
  const lin = new Float64Array(Math.floor((n - 2) * 48000 / SRC)); for (let i = 0; i < lin.length; i++) { const p = (i * SRC) / 48000, k = Math.floor(p), fr = p - k; lin[i] = src[k] * (1 - fr) + src[k + 1] * fr; }
  const linear = sinFit(lin.subarray(2000, 18384), 48000, 6000 * 48000 / 48000).snr;
  assert.ok(cubic > linear + 6, `cubic ${cubic.toFixed(1)} dB vs linear ${linear.toFixed(1)} dB`);
  console.log(`      6 kHz tone: cubic SNR ${cubic.toFixed(1)} dB, linear ${linear.toFixed(1)} dB`);
});

test("rate: exactly srcRate/ctxRate source frames are consumed per output frame (no drift): 60 s @48 kHz", () => {
  const t = rig();
  t.run(100);
  const r0 = Atomics.load(t.ctrl, CTRL.R);
  const quanta = Math.round((60 * 48000) / Q);
  t.run(quanta);
  const consumed = (Atomics.load(t.ctrl, CTRL.R) - r0) | 0;
  const expected = (quanta * Q * SRC) / 48000;
  assert.ok(Math.abs(consumed - expected) < 2, `consumed ${consumed}, expected ${expected.toFixed(2)}`);
});

test("priming: silence until the fill reaches the target, then a 6 ms fade-in (no click)", () => {
  const t = rig();
  t.feed(t.target - 100);
  let x = new Float32Array(Q * 5); for (let q = 0; q < 5; q++) { t.pb.process(t.outL, t.outR, Q); x.set(t.outL, q * Q); }
  assert.equal(Math.max(...x.map(Math.abs)), 0, "below the target the output stays silent");
  assert.equal(readRingStats(t.sab).underrunEvents, 0, "priming is not an underrun");
  t.feed(200);
  const y = t.run(12, { top: false });
  const first = y.findIndex((v) => Math.abs(v) > 1e-6), ramp = Math.ceil(0.006 * 48000);
  assert.ok(first >= 0);
  const peakInRamp = Math.max(...y.subarray(first, first + ramp / 2).map(Math.abs));
  assert.ok(peakInRamp < 0.3, `fade-in is gradual (peak in first half of the ramp ${peakInRamp.toFixed(3)} < full 0.5)`);
  const jump = Math.max(...Array.from(y.subarray(first + 1), (v, i) => Math.abs(v - y[first + i])));
  assert.ok(jump < CLICK_LIMIT, `max sample-to-sample step ${jump} (natural ${NATURAL_STEP.toFixed(4)})`);
});

test("underrun: silence/decay (no hard cut), exactly one event per episode, recovery only after re-priming, with a fade-in", () => {
  const t = rig();
  t.run(150);
  const before = readRingStats(t.sab);
  const feedStop = t.writer.fill; // let the ring run dry
  const y = t.run(Math.ceil((feedStop / SRC) * 48000 / Q) + 30, { top: false }); // keep rendering without feeding
  const st = readRingStats(t.sab);
  assert.equal(st.underrunEvents - before.underrunEvents, 1, "one episode = one event, not one per quantum");
  assert.ok(st.underrunFrames > 0);
  assert.equal(st.mode, MODE.STARVED);
  const jump = Math.max(...Array.from(y.subarray(1), (v, i) => Math.abs(v - y[i])));
  assert.ok(jump < CLICK_LIMIT, `no click at the cut (max step ${jump.toFixed(4)}, natural ${NATURAL_STEP.toFixed(4)})`);
  assert.ok(Math.abs(y[y.length - 1]) < 1e-3, "tail decayed to silence");
  // Refill a little (below the target): still silent; refill to the target: plays again.
  t.feed(500); t.pb.process(t.outL, t.outR, Q);
  assert.equal(readRingStats(t.sab).mode, MODE.STARVED, "re-priming waits for the full target");
  t.feed(t.target); const z = t.run(10, { top: false });
  assert.equal(readRingStats(t.sab).mode, MODE.PLAYING);
  const j2 = Math.max(...Array.from(z.subarray(1), (v, i) => Math.abs(v - z[i])));
  assert.ok(j2 < CLICK_LIMIT, `no click on recovery (${j2.toFixed(4)})`);
});

test("pause: ramps the real audio to zero within ~6 ms, then flushes the ring and stays silent; resume re-primes with a fade-in", () => {
  const t = rig();
  t.run(150);
  Atomics.store(t.ctrl, CTRL.PAUSED, 1);
  const y = new Float32Array(Q * 6); for (let q = 0; q < 6; q++) { t.pb.process(t.outL, t.outR, Q); y.set(t.outL, q * Q); }
  const jump = Math.max(...Array.from(y.subarray(1), (v, i) => Math.abs(v - y[i])));
  assert.ok(jump < CLICK_LIMIT, `no click on pause (${jump.toFixed(4)})`);
  const rampSamples = Math.ceil(0.006 * 48000) + 2 * Q;
  assert.equal(Math.max(...y.subarray(rampSamples).map(Math.abs)), 0, "silent after the ramp");
  const st = readRingStats(t.sab);
  assert.equal(st.fillFrames, 0, "leftover audio was discarded");
  assert.equal(st.underrunEvents, 0, "pausing is not an underrun");
  t.pb.process(t.outL, t.outR, Q); // still paused: nothing written, still silent
  Atomics.store(t.ctrl, CTRL.PAUSED, 0);
  const z = t.run(15);
  assert.ok(Math.max(...z.map(Math.abs)) > 0.4, "plays again after resume");
  assert.equal(readRingStats(t.sab).underrunEvents, 0);
});

test("overrun (moderate): while the fill is above 2x target the consumer plays 2 % faster, and stops below 1.25x", () => {
  const t = rig();
  t.run(150);
  t.feed(t.target * 2 + 800); // fill ~ 3x target
  const r0 = Atomics.load(t.ctrl, CTRL.R);
  t.run(1, { top: false });
  const consumed = (Atomics.load(t.ctrl, CTRL.R) - r0) | 0;
  assert.ok(Math.abs(consumed - (Q * SRC * 1.02) / 48000) < 2.5, `consumed ${consumed} vs ${(Q * SRC * 1.02 / 48000).toFixed(2)}`);
  t.run(Math.ceil(((t.writer.fill - t.target) / (SRC * 0.02)) * 48000 / Q) + 400, { top: false, });
  const st = readRingStats(t.sab);
  assert.ok(st.catchupFrames > 0);
  assert.equal(st.trimmedFrames, 0, "no frames were thrown away");
});

test("overrun (burst): beyond 5x target the oldest frames are skipped and the fill returns to the target", () => {
  const t = rig();
  t.run(150);
  t.feed(t.target * 6);
  t.pb.process(t.outL, t.outR, Q);
  const st = readRingStats(t.sab);
  assert.ok(st.trimmedFrames > t.target * 4, `trimmed ${st.trimmedFrames}`);
  const oneQuantum = (Q * SRC) / 48000; // the trim happens at the start of the quantum, which then consumes ~87 frames
  assert.ok(Math.abs(st.fillFrames - (t.target - oneQuantum)) < 4, `fill after trim ${st.fillFrames} vs ${(t.target - oneQuantum).toFixed(0)}`);
  const y = t.run(5, { top: false });
  assert.ok(Math.max(...y.map(Math.abs)) > 0.4);
});

test("stats: output RMS, peak and non-zero count are exposed in the shared buffer", () => {
  const t = rig();
  t.run(300);
  const st = readRingStats(t.sab);
  const rms = Math.sqrt(st.sumSq / st.framesOut);
  assert.ok(st.framesOut >= 300 * Q);
  assert.ok(st.nonZeroFrames > st.framesOut * 0.7);
  assert.ok(st.peak > 0.49 && st.peak < 0.51);
  assert.ok(rms > 0.25 && rms < 0.4, `rms ${rms}`); // a pure 0.5-amplitude tone is 0.354 RMS (minus priming)
});

test("process() does not allocate in steady state (heap growth over 200 000 quanta)", () => {
  const t = rig();
  t.run(100);
  const sab = t.sab; void sab;
  global.gc?.();
  const h0 = process.memoryUsage().heapUsed;
  for (let q = 0; q < 200_000; q++) {
    if (t.writer.fill < t.target) t.feed(1200);
    t.pb.process(t.outL, t.outR, Q);
  }
  const grown = process.memoryUsage().heapUsed - h0;
  // feed() allocates nothing either (typed arrays are reused); allow noise from the test harness itself.
  assert.ok(grown < 4 * 1024 * 1024, `heap grew ${(grown / 1024).toFixed(0)} KiB`);
});
