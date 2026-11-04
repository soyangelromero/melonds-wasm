// Phase 6 tests: cartridge save RAM and savestates against the real wasm core (dist/melonds.js).
//   node --test tests/phase6-saves.mjs            (or: npm run test:saves)
//   MDS_ROM=tests/artifacts/nmap.nds node --test tests/phase6-saves.mjs   (adds the optional free-homebrew checks)
// The main ROM is the synthetic cartridge of tests/lib/synth-rom.mjs: a 8 KiB-EEPROM retail-style cart whose ARM9 code writes
// to the EEPROM at frames 30 and 60 and draws a counter on screen, so the SRAM and the frame both evolve.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createCore, sha256 } from "./lib/core-harness.mjs";
import { buildSynthRom, SYNTH_SAVE_SIZE, SYNTH_WRITE_OFFSET } from "./lib/synth-rom.mjs";
import { SaveError, crc32, describeSaveType, parseStateHeader, STATE_HEADER_LEN } from "../js/saves-core.js";

const ROM = buildSynthRom();
const HOMEBREW = buildSynthRom({ homebrew: true });
const O = SYNTH_WRITE_OFFSET;

const pattern = (seed, n = SYNTH_SAVE_SIZE) => { // deterministic pseudo-random bytes, never all 0xFF / 0x00
  const out = new Uint8Array(n); let x = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; out[i] = (x >>> 24) | 0; }
  return out;
};
const same = (a, b) => a && b && a.length === b.length && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
const hex = (b) => Buffer.from(b).toString("hex");
const withGameWrite = (base, first) => { const x = base.slice(); for (let i = 0; i < 16; i++) x[O + i] = first + i; return x; };
const blank = () => new Uint8Array(SYNTH_SAVE_SIZE).fill(0xff);
const indexOfBytes = (hay, needle) => Buffer.from(hay.buffer, hay.byteOffset, hay.length).indexOf(Buffer.from(needle));

async function fresh(opts = {}) { const c = await createCore(opts); c.loadRom(opts.rom ?? ROM, opts.save ?? null); return c; }
async function expectCode(fn, code) {
  assert.throws(fn, (e) => { assert.ok(e instanceof SaveError, `SaveError expected, got ${e}`); assert.equal(e.code, code, e.message); return true; });
}
const resign = (container) => { // recompute the CRC32 of a hand-edited container so only the intended field is wrong
  const h = parseStateHeader(container), end = container.length - 4;
  new DataView(container.buffer, container.byteOffset).setUint32(end, crc32(container.subarray(STATE_HEADER_LEN, end)), true);
  return container;
};

test("SRAM: size, type and blank contents of a cartridge without an incoming save", async () => {
  const c = await fresh();
  const s = c.getSave();
  assert.equal(s.length, SYNTH_SAVE_SIZE, "exactly the cart's EEPROM size: no header, no footer");
  assert.equal(describeSaveType(s.length), "EEPROM 8 KiB");
  assert.ok(same(s, blank()), "blank cart reads 0xFF like melonDS desktop and real flash/EEPROM");
  assert.equal(c.M._mds_get_save_status(), 0);
  c.destroy();
});

test("SRAM: bytes written by the running game (cart SPI) reach getSave without any header", async () => {
  const c = await fresh();
  c.run(29);
  assert.ok(same(c.getSave(), blank()), "nothing written before frame 30");
  c.run(5);
  assert.ok(same(c.getSave(), withGameWrite(blank(), 0xa0)), `after the first write: ${hex(c.getSave().subarray(O - 2, O + 18))}`);
  c.run(30);
  assert.ok(same(c.getSave(), withGameWrite(blank(), 0xb0)), "second write overwrites the same 16 bytes");
  c.destroy();
});

test("SRAM: an incoming save is installed in the cartridge before the first frame (loadRom({save}))", async () => {
  const save = pattern(1234);
  const c = await fresh({ save });
  assert.ok(same(c.getSave(), save), "staging buffer holds the save before the first frame");
  c.run(10); // the first frame installs it into the emulated cart
  assert.ok(same(c.getSave(), save), "game has not written yet: still the incoming bytes");
  // Proof that the *cartridge* has it (not only the staging buffer): the retro_serialize blob contains the cart SRAM.
  const st = c.saveState();
  assert.ok(indexOfBytes(st.subarray(STATE_HEADER_LEN + SYNTH_SAVE_SIZE), save) >= 0, "cart SRAM inside the state blob equals the incoming save");
  c.run(25);
  assert.ok(same(c.getSave(), withGameWrite(save, 0xa0)), "game write lands on top of the loaded save; the rest is untouched");
  c.destroy();
});

test("SRAM: wrong-sized incoming saves are padded/truncated like melonDS desktop and reported", async () => {
  const short = pattern(7, 1000), long = pattern(8, 20000);
  let c = await fresh({ save: short });
  const s = c.getSave();
  assert.ok(same(s.subarray(0, 1000), short) && s.subarray(1000).every((b) => b === 0xff));
  assert.equal(c.M._mds_get_save_status(), 1);
  c.destroy();
  c = await fresh({ save: long });
  assert.ok(same(c.getSave(), long.subarray(0, SYNTH_SAVE_SIZE)));
  assert.equal(c.M._mds_get_save_status(), 1);
  c.destroy();
});

test("SRAM: setSave on a running game replaces the save and restarts the cartridge", async () => {
  const ref = await fresh();
  ref.run(3); const hashRef3 = ref.frameHash(); ref.destroy();

  const c = await fresh();
  c.run(45);
  assert.ok(same(c.getSave(), withGameWrite(blank(), 0xa0)));
  const hashBefore = c.frameHash();
  const save = pattern(99);
  assert.deepEqual(c.setSave(save), { resized: false });
  assert.ok(same(c.getSave(), save), "readable immediately");
  c.run(3);
  assert.ok(same(c.getSave(), save), "survives the first frames after the restart (it is not clobbered by the old live SRAM)");
  assert.equal(c.frameHash(), hashRef3, "the game restarted: frame 3 after loadSave equals frame 3 of a fresh boot");
  assert.notEqual(hashRef3, hashBefore);
  const st = c.saveState();
  assert.ok(indexOfBytes(st.subarray(STATE_HEADER_LEN + SYNTH_SAVE_SIZE), save) >= 0, "the cartridge itself holds the new save");
  c.run(30);
  assert.ok(same(c.getSave(), withGameWrite(save, 0xa0)));
  assert.deepEqual(c.setSave(pattern(5, 100)), { resized: true });
  c.destroy();
});

test("SRAM: change detector (what onSave is built on) fires once per burst of writes", async () => {
  const c = await fresh();
  const revs = [];
  let last = c.M._mds_poll_save();
  for (let f = 1; f <= 100; f++) { c.run(1); const r = c.M._mds_poll_save(); if (r !== last) { revs.push(f); last = r; } }
  assert.deepEqual(revs.map((f) => f > 30 && f < 36 ? "first" : f > 60 && f < 66 ? "second" : `unexpected ${f}`), ["first", "second"], `changes seen at frames ${revs}`);
  c.setSave(pattern(3));
  const afterSet = c.M._mds_poll_save();
  assert.equal(c.M._mds_poll_save(), afterSet, "mds_set_save resynchronises the snapshot: not reported as a game write");
  c.destroy();
});

test("no save memory: homebrew gives null, setSave throws NO_SAVE_MEMORY, an incoming save is flagged (status 2)", async () => {
  const c = await fresh({ rom: HOMEBREW, save: pattern(1, 512) });
  assert.equal(c.getSave(), null);
  assert.equal(c.M._mds_get_save_status(), 2);
  assert.equal(describeSaveType(0), "none");
  await expectCode(() => c.setSave(pattern(1)), "NO_SAVE_MEMORY");
  c.run(40);
  assert.equal(c.M._mds_poll_save(), 0);
  c.destroy();
});

test("state: container layout (magic, version, flags, coreAbi, sramLen, stateLen, SRAM, blob, CRC32)", async () => {
  const c = await fresh();
  c.run(45);
  const st = c.saveState();
  const h = parseStateHeader(st);
  assert.equal(h.magic, "MDSSTATE");
  assert.equal(h.version, 1);
  assert.equal(h.flags, 0);
  assert.equal(h.coreAbi, c.M._mds_get_core_abi() >>> 0);
  assert.equal(h.sramLen, SYNTH_SAVE_SIZE);
  assert.ok(h.stateLen > 1_000_000, `retro_serialize blob of ${h.stateLen} bytes`);
  assert.equal(st.length, STATE_HEADER_LEN + h.sramLen + h.stateLen + 4);
  assert.ok(same(st.subarray(STATE_HEADER_LEN, STATE_HEADER_LEN + h.sramLen), c.getSave()), "embedded SRAM equals getSave()");
  const crcStored = new DataView(st.buffer, st.byteOffset).getUint32(st.length - 4, true);
  assert.equal(crcStored, crc32(st.subarray(STATE_HEADER_LEN, st.length - 4)), "CRC32 covers SRAM + state");
  console.log(`      retro_serialize_size = ${h.stateLen} bytes (${(h.stateLen / 1048576).toFixed(2)} MiB); container ${st.length} bytes; coreAbi 0x${h.coreAbi.toString(16)}`);
  c.run(20);
  assert.equal(parseStateHeader(c.saveState()).stateLen, h.stateLen, "size is stable while the game runs");
  c.destroy();
});

for (const threads of [false, true]) {
  test(`state: round trip (save, modify SRAM, run 120 frames, load) restores frame hash and SRAM — threaded 3D renderer ${threads}`, async () => {
    // Control run that is never disturbed: where the game would be 1 and 30 frames after the saved moment.
    const ctl = await fresh({ threads });
    ctl.run(45);
    const sramAtSave = ctl.getSave();
    ctl.run(1); const ctlHash1 = ctl.frameHash(), ctlSram1 = ctl.getSave();
    ctl.run(29); const ctlHash30 = ctl.frameHash(), ctlSram30 = ctl.getSave();
    ctl.destroy();
    assert.ok(same(sramAtSave, withGameWrite(blank(), 0xa0)));
    assert.ok(same(ctlSram30, withGameWrite(blank(), 0xb0)), "control: the 2nd game write happens within the 30 frames after the saved moment");

    const a = await fresh({ threads });
    a.run(45);
    const state = a.saveState();
    // Modify the SRAM (restarts the cart), then play 120 more frames so both video and SRAM diverge.
    a.setSave(pattern(4242));
    a.run(120);
    assert.notEqual(a.frameHash(), ctlHash1);
    assert.ok(!same(a.getSave(), sramAtSave));
    a.loadState(state);
    assert.ok(same(a.getSave(), sramAtSave), "SRAM right after loadState is the SRAM of the saved moment");
    a.run(1);
    assert.equal(a.frameHash(), ctlHash1, "composed frame hash after load + 1 frame equals the undisturbed run");
    assert.ok(same(a.getSave(), ctlSram1));
    a.run(29);
    assert.equal(a.frameHash(), ctlHash30, "30 frames later: same video");
    assert.ok(same(a.getSave(), ctlSram30), "30 frames later: same SRAM, including the game write that happens after the saved moment");
    a.destroy();

    // The container is self-contained: a brand-new instance with the same ROM resumes identically.
    const b = await fresh({ threads });
    b.loadState(state);
    assert.ok(same(b.getSave(), sramAtSave));
    b.run(30);
    assert.equal(b.frameHash(), ctlHash30);
    assert.ok(same(b.getSave(), ctlSram30));
    b.destroy();
  });
}

test("state: determinism (same point => identical container; two instances => identical container)", async () => {
  const a = await fresh(), b = await fresh();
  a.run(50); b.run(50);
  const s1 = a.saveState(), s2 = a.saveState(), s3 = b.saveState();
  assert.equal(sha256(s1), sha256(s2), "saving twice without running gives the same bytes");
  assert.equal(sha256(s1), sha256(s3), `two independent instances at frame 50 give the same bytes (${sha256(s1).slice(0, 12)})`);
  a.run(10); b.run(10);
  assert.equal(sha256(a.saveState()), sha256(b.saveState()));
  // load -> save is a fixed point
  const c = await fresh();
  c.loadState(s1);
  assert.equal(sha256(c.saveState()), sha256(s1), "loadState then saveState reproduces the container");
  a.destroy(); b.destroy(); c.destroy();
});

test("state: errors with altered data (STATE_VERSION, STATE_INCOMPATIBLE, STATE_CORRUPT) leave the emulator untouched", async () => {
  const c = await fresh();
  c.run(45);
  const good = c.saveState();
  c.run(1);
  const ref = await fresh(); ref.loadState(good); ref.run(1); const hashLoaded1 = ref.frameHash(); ref.destroy();
  const dv = (b) => new DataView(b.buffer, b.byteOffset);
  const clone = () => good.slice();
  const cases = [];

  let b = clone(); dv(b).setUint32(8, 2, true); cases.push(["version 2", b, "STATE_VERSION"]);
  b = clone(); dv(b).setUint32(8, 0, true); cases.push(["version 0", b, "STATE_VERSION"]);
  b = clone(); dv(b).setUint32(16, dv(b).getUint32(16, true) ^ 1, true); cases.push(["other coreAbi", b, "STATE_INCOMPATIBLE"]);

  b = clone(); b[0] = 0x58; cases.push(["bad magic", b, "STATE_CORRUPT"]);
  b = clone(); b[STATE_HEADER_LEN + 5] ^= 0x01; cases.push(["flipped SRAM bit", b, "STATE_CORRUPT"]);
  b = clone(); b[STATE_HEADER_LEN + SYNTH_SAVE_SIZE + 1000] ^= 0x80; cases.push(["flipped state bit", b, "STATE_CORRUPT"]);
  b = clone(); b[b.length - 1] ^= 0xff; cases.push(["wrong CRC", b, "STATE_CORRUPT"]);
  cases.push(["truncated by 1", good.subarray(0, good.length - 1).slice(), "STATE_CORRUPT"]);
  cases.push(["extra trailing byte", Uint8Array.from([...good.subarray(0, 1000), ...good.subarray(1000), 0]), "STATE_CORRUPT"]);
  cases.push(["shorter than the header", good.subarray(0, 20).slice(), "STATE_CORRUPT"]);
  cases.push(["empty", new Uint8Array(0), "STATE_CORRUPT"]);
  b = clone(); dv(b).setUint32(20, SYNTH_SAVE_SIZE + 1, true); cases.push(["sramLen +1", b, "STATE_CORRUPT"]);
  b = clone(); dv(b).setUint32(24, dv(b).getUint32(24, true) - 1, true); cases.push(["stateLen -1", b, "STATE_CORRUPT"]);
  b = clone(); dv(b).setUint32(20, 0xffffffff, true); dv(b).setUint32(24, 0xffffffff, true); cases.push(["huge lengths (overflow check)", b, "STATE_CORRUPT"]);

  // Valid containers (CRC recomputed) that do not fit this game => STATE_INCOMPATIBLE.
  const stateLen = parseStateHeader(good).stateLen;
  b = Uint8Array.from([...good.subarray(0, good.length - 4 - 4), 0, 0, 0, 0]); // state blob 4 bytes shorter
  dv(b).setUint32(24, stateLen - 4, true); cases.push(["valid CRC, state 4 bytes short", resign(b), "STATE_INCOMPATIBLE"]);
  const noSram = Uint8Array.from([...good.subarray(0, STATE_HEADER_LEN), ...good.subarray(STATE_HEADER_LEN + SYNTH_SAVE_SIZE)]);
  dv(noSram).setUint32(20, 0, true); cases.push(["valid CRC, SRAM length differs from the loaded game", resign(noSram), "STATE_INCOMPATIBLE"]);

  for (const [name, bytes, code] of cases) {
    await expectCode(() => c.loadState(bytes), code);
    console.log(`      ${name.padEnd(48)} -> ${code}`);
  }
  // Nothing above touched the emulation: the run continues exactly as if no load had been attempted.
  const ctl = await fresh(); ctl.run(46 + 10); const ctlHash = ctl.frameHash(); ctl.destroy();
  c.run(10);
  assert.equal(c.frameHash(), ctlHash, "failed loads do not disturb the running game");
  // ...and the good one still works.
  c.loadState(good); c.run(1);
  assert.equal(c.frameHash(), hashLoaded1);
  c.destroy();
});

test("state: no game loaded => NO_ROM; homebrew (no SRAM) round-trips with sramLen 0", async () => {
  const c = await createCore();
  assert.throws(() => c.saveState(), (e) => e.code === "NO_ROM" || e.code === "STATE_UNSUPPORTED");
  c.loadRom(HOMEBREW);
  c.run(30);
  const st = c.saveState();
  assert.equal(parseStateHeader(st).sramLen, 0);
  const h30 = (c.run(10), c.frameHash());
  c.loadState(st); c.run(10);
  assert.equal(c.frameHash(), h30);
  // A container that carries SRAM must not load into a game that has none.
  const withSram = await fresh(); withSram.run(5); const other = withSram.saveState(); withSram.destroy();
  await expectCode(() => c.loadState(other), "STATE_INCOMPATIBLE");
  c.destroy();
});

const optionalRom = process.env.MDS_ROM;
test("optional free homebrew (MDS_ROM): no save memory, state round trip", { skip: !optionalRom || !existsSync(optionalRom) }, async () => {
  const rom = new Uint8Array(readFileSync(optionalRom));
  const c = await createCore();
  c.loadRom(rom);
  console.log(`      ${optionalRom}: save memory = ${c.getSave()?.length ?? 0} bytes (${describeSaveType(c.getSave()?.length ?? 0)})`);
  c.run(60);
  const st = c.saveState();
  c.run(30); const h = c.frameHash();
  c.loadState(st); c.run(30);
  assert.equal(c.frameHash(), h, "state round trip on the real homebrew");
  c.destroy();
});
