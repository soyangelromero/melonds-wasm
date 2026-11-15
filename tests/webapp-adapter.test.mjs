// Phase 11: unit tests for the web-app adapter that do not need a browser, a worker or a ROM.
import { test } from "node:test";
import assert from "node:assert/strict";
import { LAYOUT_MAP, HYBRID_MAP, applyCoreVariable, openStateStore, createWebappEmulator } from "../adapters/webapp-adapter.js";

test("LAYOUT_MAP translates every layout value the web app sends", () => {
  // nds/index.html LAYOUT tables for the melonDS and DeSmuME engines.
  const fromWebApp = ["Top/Bottom", "Left/Right", "Hybrid Top", "Top Only", "top/bottom", "left/right", "hybrid/top"];
  for (const value of fromWebApp) assert.ok(LAYOUT_MAP[value], `no mapping for ${value}`);
  assert.equal(LAYOUT_MAP["Hybrid Top"], "Hybrid (Focus Top)");
  assert.equal(LAYOUT_MAP["left/right"], "Left/Right");
  assert.equal(LAYOUT_MAP["Top Only"], "Top Only");
});

test("HYBRID_MAP turns the old values into the contract ones", () => {
  assert.equal(HYBRID_MAP.Duplicate, "both");
  assert.equal(HYBRID_MAP.Top, "one");
  assert.equal(HYBRID_MAP.Bottom, "one");
});

test("applyCoreVariable drives setLayout / setScreenGap / setHybridSmallScreen", () => {
  const calls = [];
  const ds = {
    setLayout: (label) => calls.push(["layout", label]),
    setScreenGap: (px) => calls.push(["gap", px]),
    setHybridSmallScreen: (mode) => calls.push(["hybrid", mode]),
  };
  assert.equal(applyCoreVariable(ds, "melonds_screen_layout", "Top/Bottom"), true);
  assert.equal(applyCoreVariable(ds, "melonds_screen_gap", "12"), true);
  assert.equal(applyCoreVariable(ds, "melonds_hybrid_small_screen", "Duplicate"), true);
  assert.equal(applyCoreVariable(ds, "melonds_threaded_renderer", "enabled"), false, "threads are fixed at boot");
  assert.equal(applyCoreVariable(ds, "something_else", "1"), false);
  assert.deepEqual(calls, [
    ["layout", "Top/Bottom"],
    ["gap", 12],
    ["hybrid", "both"],
  ]);
});

test("the adapter module loads without a DOM and exposes the factory", () => {
  assert.equal(typeof createWebappEmulator, "function");
});

test("createWebappEmulator rejects without a canvas instead of throwing a TypeError", async () => {
  await assert.rejects(() => createWebappEmulator({ romUrl: "/x.nds" }), (error) => error.code === "NO_CANVAS");
});

test("openStateStore resolves to null when IndexedDB is not available", async () => {
  assert.equal(await openStateStore(), null);
});
