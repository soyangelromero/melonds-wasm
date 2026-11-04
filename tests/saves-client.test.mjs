// Unit tests of the main-thread SaveClient (js/saves.js) with a fake worker: debounce, cache and flush. No wasm needed.
import test from "node:test";
import assert from "node:assert/strict";
import { SaveClient } from "../js/saves.js";

function fake() {
  const handlers = new Map(); let bytes = Uint8Array.of(1, 2, 3); const calls = [];
  const client = new SaveClient({
    call: async (msg) => { calls.push(msg.type); if (msg.type === "getSave") return bytes.slice(); if (msg.type === "setSave") { bytes = msg.data; return { resized: false }; } },
    on: (type, cb) => { handlers.set(type, cb); return () => handlers.delete(type); },
  });
  return { client, calls, emit: (type, m = {}) => handlers.get(type)?.(m), setBytes: (b) => { bytes = b; } };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("onSave: a burst of changes produces one callback after the debounce, with the latest bytes", async () => {
  const { client, emit, setBytes } = fake();
  const got = [];
  client.onSave((b) => got.push(Array.from(b)), 80);
  for (let i = 0; i < 5; i++) { setBytes(Uint8Array.of(9, i)); emit("saveChanged"); await sleep(20); }
  assert.equal(got.length, 0, "nothing while the game keeps writing");
  await sleep(200);
  assert.deepEqual(got, [[9, 4]], "one call, latest content");
  setBytes(Uint8Array.of(7)); emit("saveChanged"); await sleep(200);
  assert.deepEqual(got, [[9, 4], [7]], "a later change fires again");
});

test("getSave() is the synchronous cache; null until something is known; returns copies", async () => {
  const { client, emit } = fake();
  assert.equal(client.getSave(), null);
  emit("loaded", { saveLen: 3, saveType: "x", saveStatus: 0 });
  await sleep(10);
  const a = client.getSave(); assert.deepEqual(Array.from(a), [1, 2, 3]);
  a[0] = 99; assert.deepEqual(Array.from(client.getSave()), [1, 2, 3], "mutating the result does not corrupt the cache");
  emit("loaded", { saveLen: 0, saveType: "none", saveStatus: 0 });
  assert.equal(client.getSave(), null, "a game without save memory gives null");
});

test("unsubscribe cancels a pending callback; flush() delivers it immediately", async () => {
  const { client, emit } = fake();
  const a = [], b = [];
  const off = client.onSave((x) => a.push(x), 100);
  client.onSave((x) => b.push(x), 100);
  emit("saveChanged");
  off();
  await client.flush();
  assert.equal(a.length, 0);
  assert.equal(b.length, 1, "flush delivered without waiting for the timer");
  await sleep(250);
  assert.equal(b.length, 1, "and the timer does not fire a second time");
});

test("loadSave() forwards the bytes and refreshes the cache", async () => {
  const { client, calls } = fake();
  const r = await client.loadSave(Uint8Array.of(5, 5));
  assert.deepEqual(r, { resized: false });
  assert.deepEqual(Array.from(client.getSave()), [5, 5]);
  assert.deepEqual(calls, ["setSave", "getSave"]);
});
