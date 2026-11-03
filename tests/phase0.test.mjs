import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("Phase 0 build produced an ES module and a wasm binary", async () => {
  const js = await readFile(join(repoRoot, "dist", "hello.js"), "utf8");
  const wasm = await readFile(join(repoRoot, "dist", "hello.wasm"));
  assert.ok(js.length > 1000, "hello.js should contain the Emscripten runtime");
  assert.match(js, /export default/);
  assert.deepEqual([...wasm.subarray(0, 4)], [0x00, 0x61, 0x73, 0x6d]);
});

test("hello page loads the build and reports crossOriginIsolated", async () => {
  const html = await readFile(join(repoRoot, "demo", "hello.html"), "utf8");
  assert.match(html, /dist\/hello\.js/);
  assert.match(html, /_mds_hello/);
  assert.match(html, /crossOriginIsolated/);
});
