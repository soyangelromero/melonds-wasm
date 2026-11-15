// Unit tests for the public API facade (js/melonds.js) that can run without a browser, a worker or a ROM.
// The engine itself is covered by the phase tests; here we pin the contract surface, the header parsing and the
// argument validation that must reject before touching the wasm module.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MelonDS, readRomInfo, FIRMWARE_SIZES, BIOS_SIZES, LAYOUT_LABELS } from "../js/melonds.js";

/** Builds a fake DS ROM header: title (12 bytes) + game code (4 bytes) + padding. */
function fakeRom(title, code, size = 0x2000) {
  const rom = new Uint8Array(size);
  for (let i = 0; i < title.length && i < 12; i++) rom[i] = title.charCodeAt(i);
  for (let i = 0; i < code.length && i < 4; i++) rom[12 + i] = code.charCodeAt(i);
  return rom;
}

test("readRomInfo parses the DS header (title 0..0B, game code 0C..0F)", () => {
  const rom = fakeRom("POKEMON N", "IPGS", 4096);
  const info = readRomInfo(rom);
  assert.equal(info.title, "POKEMON N");
  assert.equal(info.code, "IPGS");
  assert.equal(info.size, 4096);
});

test("readRomInfo trims NUL padding and trailing spaces", () => {
  const rom = fakeRom("AB", "CPUS");
  assert.equal(readRomInfo(rom).title, "AB");
  assert.equal(readRomInfo(fakeRom("", "IRES")).title, "");
});

test("the exported constants match the core (firmware sizes and BIOS lengths)", () => {
  assert.deepEqual([...FIRMWARE_SIZES], [131072, 262144, 524288]);
  assert.deepEqual(BIOS_SIZES, { arm7: 16384, arm9: 4096 });
});

test("the 17 layouts of API_CONTRACT table 2.1 are exported", () => {
  assert.equal(LAYOUT_LABELS.length, 17);
  assert.ok(LAYOUT_LABELS.includes("Top/Bottom"));
  assert.ok(LAYOUT_LABELS.includes("Rotated Left"));
});

test("the contract surface exists on the class (nothing silently missing)", () => {
  const required = [
    "loadRom", "start", "pause", "resume", "reset", "dispose",
    "setFirmware", "setBios", "setSpeed", "getFrameCount",
    "setLayout", "setScreenGap", "setHybridSmallScreen", "setPostProcess", "screenshot", "getFrame", "captureStream",
    "setVolume", "setMuted", "button", "touchFromCanvas", "attachKeyboard", "attachGamepad", "setMicInput",
    "getSave", "loadSave", "onSave", "saveState", "loadState", "setCheat", "clearCheats",
    "getStats", "on",
  ];
  for (const name of required) {
    assert.equal(typeof MelonDS.prototype[name], "function", `${name} is missing`);
  }
  assert.equal(typeof MelonDS.create, "function");
});

test("create() rejects threads:false with NO_THREADS_BUILD before touching the DOM", async () => {
  await assert.rejects(() => MelonDS.create({ threads: false }), (error) => error.code === "NO_THREADS_BUILD");
});

test("create() without crossOriginIsolated rejects with NO_THREADS", async () => {
  assert.equal(globalThis.crossOriginIsolated, undefined);
  await assert.rejects(() => MelonDS.create({}), (error) => error.code === "NO_THREADS");
});

test("an instance without a player reports empty stats instead of throwing", () => {
  const ds = new MelonDS({});
  assert.deepEqual(ds.getStats(), { fps: 0, emuMs: 0, renderMs: 0, audioBufferMs: 0, threads: false });
  assert.equal(ds.running, false);
  assert.equal(ds.paused, false);
  assert.equal(ds.getSave(), null);
  assert.equal(ds.getFrameCount(), 0);
});

test("methods that need the engine fail with NO_PLAYER, not a TypeError", () => {
  const ds = new MelonDS({});
  const cases = [
    () => ds.start(),
    () => ds.pause(),
    () => ds.setLayout("Top/Bottom"),
    () => ds.setScreenGap(0),
    () => ds.setHybridSmallScreen("one"),
    () => ds.setPostProcess(null),
    () => ds.getFrame(),
    () => ds.captureStream(),
    () => ds.setMuted(true),
    () => ds.touchFromCanvas(0, 0, "down"),
    () => ds.attachKeyboard(),
    () => ds.attachGamepad(),
  ];
  for (const call of cases) {
    assert.throws(call, (error) => error.code === "NO_PLAYER");
  }
});

test("loadRom() without an engine rejects with NO_PLAYER (async)", async () => {
  const ds = new MelonDS({});
  await assert.rejects(() => ds.loadRom(fakeRom("X", "IPGS")), (error) => error.code === "NO_PLAYER");
});

test("setVolume validates the range with a RangeError (contract §2)", () => {
  const ds = new MelonDS({});
  assert.throws(() => ds.setVolume(1.5), RangeError);
  assert.throws(() => ds.setVolume(-0.1), RangeError);
  assert.throws(() => ds.setVolume(Number.NaN), RangeError);
});

test("button() rejects an unknown button before reaching the engine", () => {
  const ds = new MelonDS({});
  assert.throws(() => ds.button("TURBO", true), (error) => error.code === "BUTTON_INVALID");
});

test("setFirmware validates the dump size and accepts the three legal ones", () => {
  const ds = new MelonDS({});
  assert.throws(() => ds.setFirmware(new Uint8Array(1000)), (error) => error.code === "FIRMWARE_INVALID");
  assert.throws(() => ds.setFirmware("not bytes"), (error) => error.code === "FIRMWARE_INVALID");
  for (const size of FIRMWARE_SIZES) assert.doesNotThrow(() => ds.setFirmware(new Uint8Array(size)));
  assert.doesNotThrow(() => ds.setFirmware(null));
});

test("setBios validates the two BIOS lengths and accepts null (FreeBIOS)", () => {
  const ds = new MelonDS({});
  assert.doesNotThrow(() => ds.setBios(null));
  assert.doesNotThrow(() => ds.setBios({ arm7: new Uint8Array(16384), arm9: new Uint8Array(4096) }));
  assert.throws(() => ds.setBios({ arm7: new Uint8Array(4096) }), (error) => error.code === "BIOS_INVALID");
  assert.throws(() => ds.setBios({ arm9: "x" }), (error) => error.code === "BIOS_INVALID");
});

test("on() returns an unsubscribe function and never throws for unknown events", () => {
  const ds = new MelonDS({});
  const off = ds.on("frame", () => {});
  assert.equal(typeof off, "function");
  assert.doesNotThrow(() => off());
});

test("on('ready') is delivered asynchronously even when the instance is not booted", async () => {
  const ds = new MelonDS({});
  let called = 0;
  ds.on("ready", () => called++);
  await Promise.resolve();
  assert.equal(called, 0, "ready must not fire before create()");
});
