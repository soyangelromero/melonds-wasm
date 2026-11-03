import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createStaticServer } from "../scripts/serve.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

test("static server sends COOP and COEP on every response", async () => {
  const server = createStaticServer({ root: repoRoot });
  const base = await listen(server);
  try {
    const response = await fetch(`${base}/README.md`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cross-origin-opener-policy"), "same-origin");
    assert.equal(response.headers.get("cross-origin-embedder-policy"), "require-corp");
    assert.match(await response.text(), /melonds-wasm/);
  } finally {
    await close(server);
  }
});

test("static server serves wasm with application/wasm", async () => {
  const dir = await mkdtemp(join(tmpdir(), "melonds-serve-"));
  const wasm = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
  await writeFile(join(dir, "sample.wasm"), wasm);
  const server = createStaticServer({ root: dir });
  const base = await listen(server);
  try {
    const response = await fetch(`${base}/sample.wasm`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/wasm");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), wasm);
  } finally {
    await close(server);
    await rm(dir, { recursive: true, force: true });
  }
});

test("static server refuses path traversal", async () => {
  const server = createStaticServer({ root: repoRoot });
  const base = await listen(server);
  try {
    const status = await new Promise((resolve, reject) => {
      // fetch() normalizes %2f and dot segments before sending, so use a raw request.
      const request = http.get(`${base}/..%2f..%2fpackage.json`, (response) => {
        response.resume();
        resolve(response.statusCode);
      });
      request.once("error", reject);
    });
    assert.equal(status, 404);
  } finally {
    await close(server);
  }
});

test("static server maps / to demo/index.html", async () => {
  const dir = await mkdtemp(join(tmpdir(), "melonds-index-"));
  await writeFile(join(dir, "index.html"), "<!doctype html><title>demo</title>");
  const server = createStaticServer({ root: dir });
  const base = await listen(server);
  try {
    const response = await fetch(`${base}/`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /<title>demo<\/title>/);
  } finally {
    await close(server);
    await rm(dir, { recursive: true, force: true });
  }
});
