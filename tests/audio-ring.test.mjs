// Unit tests of the shared audio ring (js/audio-ring.js) with a REAL second thread (worker_threads over a SharedArrayBuffer).
import test from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { createAudioRingBuffer, AudioRingWriter, AudioRingReader, readRingStats, ringViews, CTRL } from "../js/audio-ring.js";

// Deterministic pseudo-signal so the consumer can verify every single sample.
const L = (i) => (i * 31 + 7) & 0x7fff, R = (i) => -((i * 17 + 3) & 0x7fff);

const producerSource = `
import { workerData } from "node:worker_threads";
import { AudioRingWriter } from ${JSON.stringify(new URL("../js/audio-ring.js", import.meta.url).href)};
const { sab, total, seed, respectFree } = workerData;
const w = new AudioRingWriter(sab);
const L = (i) => (i * 31 + 7) & 0x7fff, R = (i) => -((i * 17 + 3) & 0x7fff);
let s = seed; const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
const buf = new Int16Array(2048 * 2);
let i = 0;
while (i < total) {
  let n = Math.min(1 + Math.floor(rnd() * 2048), total - i);
  if (respectFree) { n = Math.min(n, w.free); if (n === 0) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 0.05); continue; } }
  for (let k = 0; k < n; k++) { buf[k * 2] = L(i + k); buf[k * 2 + 1] = R(i + k); }
  const accepted = w.write(buf, n);
  i += respectFree ? accepted : n;
}
`;
const spawnProducer = (workerData) => new Worker(producerSource, { eval: true, workerData });

test("two threads: 3 million frames arrive in order, complete and unmodified (random chunk sizes, wrap-around of the ring)", async () => {
  const sab = createAudioRingBuffer(4096); // small on purpose: the ring wraps ~700 times
  const total = 3_000_000;
  const prod = spawnProducer({ sab, total, seed: 12345, respectFree: true });
  const done = new Promise((res, rej) => { prod.on("exit", res); prod.on("error", rej); });
  const reader = new AudioRingReader(sab);
  const dst = new Int16Array(1000 * 2);
  // When the producer thread has not produced yet, yield the CPU with a short Atomics.wait instead of a tight spin:
  // under heavy parallel load the old 50M-spin budget could be consumed by the scheduler starving this thread, which
  // made the test flaky ("consumer starved") even though the ring was fine. The deadline below still fails a real hang.
  const idle = new Int32Array(new SharedArrayBuffer(4));
  const started = Date.now();
  let got = 0;
  while (got < total) {
    const n = reader.read(dst, 1000);
    if (n === 0) {
      Atomics.wait(idle, 0, 0, 2);
      if (Date.now() - started > 120000) assert.fail("consumer starved (120 s without frames)");
      continue;
    }
    for (let k = 0; k < n; k++) {
      if (dst[k * 2] !== L(got + k) || dst[k * 2 + 1] !== R(got + k)) assert.fail(`mismatch at frame ${got + k}`);
    }
    got += n;
  }
  await done;
  assert.equal(got, total);
  assert.equal(readRingStats(sab).overrunFrames, 0);
});

test("overrun: a full ring drops the NEWEST frames, counts them exactly, and keeps the oldest intact", () => {
  const sab = createAudioRingBuffer(1024);
  const w = new AudioRingWriter(sab);
  const src = new Int16Array(300 * 2);
  let sent = 0, accepted = 0;
  while (sent < 2500) { for (let k = 0; k < 300; k++) { src[k * 2] = L(sent + k); src[k * 2 + 1] = R(sent + k); } accepted += w.write(src, 300); sent += 300; }
  const st = readRingStats(sab);
  assert.equal(accepted, 1024);
  assert.equal(st.overrunFrames, sent - 1024);
  assert.ok(st.overrunEvents > 0);
  const reader = new AudioRingReader(sab), dst = new Int16Array(1024 * 2);
  assert.equal(reader.read(dst, 1024), 1024);
  for (let k = 0; k < 1024; k++) assert.equal(dst[k * 2], L(k), `frame ${k} (the oldest ones must survive)`);
});

test("overrun with a real second thread: the writer never blocks, the reader sees a consistent prefix", async () => {
  const sab = createAudioRingBuffer(2048);
  const total = 500_000;
  const prod = spawnProducer({ sab, total, seed: 9, respectFree: false });
  await new Promise((res, rej) => { prod.on("exit", res); prod.on("error", rej); }); // finishes although nobody reads
  const st = readRingStats(sab);
  assert.equal(st.fillFrames, 2048);
  assert.equal(st.overrunFrames, total - 2048);
});

test("free-running int32 indices wrap correctly past 2^31 (about 18 hours of audio)", () => {
  const sab = createAudioRingBuffer(512);
  const { ctrl } = ringViews(sab);
  const start = 2 ** 31 - 700; // W and R start just below the int32 limit
  Atomics.store(ctrl, CTRL.W, start | 0); Atomics.store(ctrl, CTRL.R, start | 0);
  const w = new AudioRingWriter(sab), reader = new AudioRingReader(sab);
  const src = new Int16Array(200 * 2), dst = new Int16Array(200 * 2);
  let pos = 0;
  for (let round = 0; round < 20; round++) {
    for (let k = 0; k < 200; k++) { src[k * 2] = L(pos + k); src[k * 2 + 1] = R(pos + k); }
    assert.equal(w.write(src, 200), 200);
    assert.equal(w.fill, 200);
    assert.equal(reader.read(dst, 200), 200);
    for (let k = 0; k < 200; k++) assert.equal(dst[k * 2], L(pos + k));
    pos += 200;
  }
  assert.ok((Atomics.load(ctrl, CTRL.W) | 0) < 0, "W did wrap to negative int32");
});

test("capacity must be a power of two", () => assert.throws(() => createAudioRingBuffer(1000), RangeError));
