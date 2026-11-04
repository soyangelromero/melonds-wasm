// Stress test of the SharedArrayBuffer triple buffer with a real writer thread: every frame the reader gets must be
// internally consistent (no tearing), frame numbers strictly increase, and the newest frame is always reachable.
import test from "node:test";
import assert from "node:assert/strict";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { createRingBuffer, RingReader, RingWriter } from "../js/frame-ring.js";

if (!isMainThread) {
  const w = new RingWriter(workerData.sab);
  for (let n = 1; n <= workerData.frames; n++) {
    const width = 64 + (n % 5) * 32, height = 48 + (n % 3) * 16, stride = width * 4 + (n % 2 ? 16 : 0); // varying size and padded stride
    const t = w.target;
    t.fill(n & 255, 0, stride * height);
    w.publish({ width, height, stride, rotation: n & 3 });
  }
  parentPort.postMessage("done");
} else {
  test("ring: no tearing, monotonic frame numbers, last frame delivered", async () => {
    const sab = createRingBuffer();
    const frames = 20000;
    const worker = new Worker(new URL(import.meta.url), { workerData: { sab, frames } });
    const done = new Promise((r) => worker.once("message", r));
    const reader = new RingReader(sab);
    let last = 0, seen = 0, finished = false;
    done.then(() => { finished = true; });
    while (!finished || reader.stats.consumed + reader.stats.dropped < reader.stats.published) {
      const f = reader.poll();
      if (!f) { await new Promise((r) => setImmediate(r)); continue; }
      assert.ok(f.frameNo > last, "frame numbers increase");
      last = f.frameNo; seen++;
      const expect = f.frameNo & 255;
      assert.equal(f.data.length, f.stride * f.height);
      assert.equal(f.rotation, f.frameNo & 3);
      for (let i = 0; i < f.data.length; i++) if (f.data[i] !== expect) assert.fail(`torn frame ${f.frameNo} at byte ${i}`);
    }
    await worker.terminate();
    assert.equal(last, frames, "newest frame is delivered");
    assert.equal(reader.stats.published, frames);
    assert.ok(seen + reader.stats.dropped === frames, `seen ${seen} + dropped ${reader.stats.dropped} = ${frames}`);
  });
}
