// Phase 5: buttons, keyboard map and gamepad map (js/input.js). Pure Node: fake EventTarget and simulated Gamepad objects.
import test from "node:test";
import assert from "node:assert/strict";
import { BUTTON_MASK, BUTTONS, JOYPAD_BIT, INDEX_TO_BUTTON, DEFAULT_KEYMAP, DEFAULT_PADMAP, keyToButton, gamepadToMask, InputState, InputReader } from "../js/input.js";

const ev = (type, { target = {}, ...props }) => {
  const e = new Event(type, { cancelable: true });
  Object.defineProperty(e, "target", { value: target }); // Event.target is a read-only getter
  return Object.assign(e, props);
};
const press = (el, code, extra = {}) => { const e = ev("keydown", { code, key: extra.key ?? "", ...extra }); el.dispatchEvent(e); return e; };
const release = (el, code, extra = {}) => { const e = ev("keyup", { code, key: extra.key ?? "", ...extra }); el.dispatchEvent(e); return e; };
const names = (mask) => BUTTONS.filter((b) => (mask & BUTTON_MASK[b]) === BUTTON_MASK[b] && b !== "LID" && b !== "MIC").sort();

test("button bits follow libretro ids and the online-room numbering (API_CONTRACT section 5)", () => {
  INDEX_TO_BUTTON.forEach((name, index) => assert.equal(JOYPAD_BIT[name], index, name));
  assert.equal(INDEX_TO_BUTTON.length, 12);
  assert.equal(BUTTON_MASK.A, 1 << 8); assert.equal(BUTTON_MASK.B, 1);
  assert.equal(BUTTON_MASK.LID, (1 << 12) | (1 << 1)); // L2 + Y (joypad.cpp toggles the lid on Y while L2 is held)
  assert.equal(BUTTON_MASK.MIC, 1 << 14);              // L3
});

test("default keyboard map is the one in API_CONTRACT section 5", () => {
  const expect = { ArrowUp: "UP", ArrowDown: "DOWN", ArrowLeft: "LEFT", ArrowRight: "RIGHT", KeyZ: "A", KeyX: "B", KeyA: "X", KeyS: "Y", KeyQ: "L", KeyE: "R", Enter: "START", KeyV: "SELECT" };
  assert.deepEqual({ ...DEFAULT_KEYMAP }, expect);
  assert.equal(new Set(Object.values(DEFAULT_KEYMAP)).size, 12); // every DS button reachable
});

test("keyToButton: by physical code first, then by key (case-insensitive single characters)", () => {
  assert.equal(keyToButton({ code: "KeyZ", key: "y" }), "A");              // QWERTZ / AZERTY: the position wins
  assert.equal(keyToButton({ code: "", key: "z" }), "A");
  assert.equal(keyToButton({ code: "", key: "Z" }), "A");
  assert.equal(keyToButton({ code: "Enter", key: "Enter" }), "START");
  assert.equal(keyToButton({ code: "KeyP", key: "p" }), null);
  assert.equal(keyToButton({ code: "KeyP", key: "p" }, { p: "A" }), "A");
});

test("attachKeyboard: press / release, all 12 default keys, and the shared mask", () => {
  const s = new InputState(), el = new EventTarget(), off = s.attachKeyboard(el);
  for (const [code, button] of Object.entries(DEFAULT_KEYMAP)) {
    press(el, code); assert.equal(s.mask, BUTTON_MASK[button], `${code} down`);
    release(el, code); assert.equal(s.mask, 0, `${code} up`);
  }
  press(el, "ArrowRight"); press(el, "KeyZ");
  assert.deepEqual(names(s.mask), ["A", "RIGHT"]);
  release(el, "ArrowRight");
  assert.deepEqual(names(s.mask), ["A"]);
  off();
  assert.equal(s.mask, 0, "detaching releases everything");
});

test("attachKeyboard: arrows and Space never scroll the page (preventDefault), even unmapped; shortcuts are left alone", () => {
  const s = new InputState(), el = new EventTarget(); s.attachKeyboard(el);
  for (const code of ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"]) {
    assert.equal(press(el, code).defaultPrevented, true, `${code} keydown`);
    assert.equal(release(el, code).defaultPrevented, true, `${code} keyup`);
  }
  assert.equal(press(el, "KeyZ").defaultPrevented, true);
  assert.equal(press(el, "KeyP").defaultPrevented, false, "unmapped letters keep their default");
  assert.equal(press(el, "KeyR", { ctrlKey: true }).defaultPrevented, false, "Ctrl+R still reloads");
  assert.equal(press(el, "KeyZ", { metaKey: true }).defaultPrevented, false);
  assert.equal(s.mask, BUTTON_MASK.A, "only the plain KeyZ press counted");
});

test("attachKeyboard: typing in a form control is not hijacked", () => {
  const s = new InputState(), el = new EventTarget(); s.attachKeyboard(el);
  for (const tagName of ["INPUT", "TEXTAREA", "SELECT"]) {
    const e = press(el, "KeyZ", { target: { tagName } });
    assert.equal(e.defaultPrevented, false); assert.equal(s.mask, 0);
  }
  assert.equal(press(el, "KeyZ", { target: { isContentEditable: true } }).defaultPrevented, false);
});

test("attachKeyboard: auto-repeat does nothing; two keys on one button release only when both are up", () => {
  const s = new InputState(), el = new EventTarget(); s.attachKeyboard(el, { KeyZ: "A", KeyK: "A" });
  press(el, "KeyZ"); press(el, "KeyZ", { repeat: true }); press(el, "KeyK");
  release(el, "KeyZ"); assert.equal(s.mask, BUTTON_MASK.A);
  release(el, "KeyK"); assert.equal(s.mask, 0);
});

test("attachKeyboard: custom map; blur (window loses focus) releases held keys so none stick", () => {
  const s = new InputState(), el = new EventTarget();
  globalThis.addEventListener ??= (...a) => globalThis.__bus.addEventListener(...a);
  globalThis.removeEventListener ??= (...a) => globalThis.__bus.removeEventListener(...a);
  globalThis.__bus ??= new EventTarget();
  const off = s.attachKeyboard(el, { KeyJ: "START" });
  press(el, "KeyJ"); assert.equal(s.mask, BUTTON_MASK.START);
  globalThis.__bus.dispatchEvent(new Event("blur"));
  assert.equal(s.mask, 0);
  assert.equal(press(el, "KeyZ").defaultPrevented, false, "default map is replaced, not merged");
  off();
});

test("button(): API presses OR with keyboard and gamepad and survive their releases", () => {
  const s = new InputState(), el = new EventTarget(); s.attachKeyboard(el);
  s.button("A", true); press(el, "KeyZ"); release(el, "KeyZ");
  assert.equal(s.mask, BUTTON_MASK.A, "A still held through the API");
  s.button("A", false); assert.equal(s.mask, 0);
  s.button("LID", true); assert.equal(s.mask, BUTTON_MASK.LID);
  assert.throws(() => s.button("TURBO", true), { code: "BUTTON_INVALID" });
});

test("worker reader: a key tapped within one frame is still seen for exactly one frame", () => {
  const s = new InputState(), r = new InputReader(s.buffer);
  s.button("START", true); s.button("START", false);
  assert.equal(r.read().mask, BUTTON_MASK.START);
  assert.equal(r.read().mask, 0);
  s.button("B", true);
  assert.equal(r.read().mask, BUTTON_MASK.B); assert.equal(r.read().mask, BUTTON_MASK.B, "held stays");
  s.button("B", false);
  assert.equal(r.read().mask, 0);
});

// ---- gamepad ------------------------------------------------------------------------------------------------------------
const pad = (pressed = [], axes = [0, 0, 0, 0], extra = {}) => ({
  connected: true, mapping: "standard", axes,
  buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: pressed.includes(i), value: pressed.includes(i) ? 1 : 0 })), ...extra,
});

test("gamepadToMask: standard layout -> DS (Nintendo positions)", () => {
  const cases = { 0: "B", 1: "A", 2: "Y", 3: "X", 4: "L", 5: "R", 8: "SELECT", 9: "START", 12: "UP", 13: "DOWN", 14: "LEFT", 15: "RIGHT" };
  assert.deepEqual({ ...DEFAULT_PADMAP }, cases);
  for (const [index, button] of Object.entries(cases)) assert.equal(gamepadToMask(pad([+index])), BUTTON_MASK[button], `button ${index}`);
  assert.equal(gamepadToMask(pad([6, 7, 10, 11, 16])), 0, "triggers, stick clicks and home are unmapped");
  assert.equal(gamepadToMask(pad([0, 1, 12])), BUTTON_MASK.B | BUTTON_MASK.A | BUTTON_MASK.UP);
  assert.equal(gamepadToMask(null), 0);
});

test("gamepadToMask: left stick as D-pad with dead zone", () => {
  assert.equal(gamepadToMask(pad([], [0.49, -0.49])), 0, "inside the threshold");
  assert.equal(gamepadToMask(pad([], [0.5, 0])), BUTTON_MASK.RIGHT);
  assert.equal(gamepadToMask(pad([], [-1, 0])), BUTTON_MASK.LEFT);
  assert.equal(gamepadToMask(pad([], [0, -0.9])), BUTTON_MASK.UP);
  assert.equal(gamepadToMask(pad([], [0, 0.9])), BUTTON_MASK.DOWN);
  assert.equal(gamepadToMask(pad([], [0.9, 0.9])), BUTTON_MASK.RIGHT | BUTTON_MASK.DOWN);
  assert.equal(gamepadToMask(pad([], [1, 1]), { stick: false }), 0);
  assert.equal(gamepadToMask(pad([], [0.3, 0]), { threshold: 0.25 }), BUTTON_MASK.RIGHT);
  assert.equal(gamepadToMask(pad([], [0, 0, 1, 1])), 0, "the right stick is not the D-pad");
});

test("gamepadToMask: plain-number buttons and custom maps", () => {
  assert.equal(gamepadToMask({ buttons: [1, 0, 0], axes: [] }, { map: { 0: "START" } }), BUTTON_MASK.START);
  assert.throws(() => gamepadToMask(pad([0]), { map: { 0: "NOPE" } }), { code: "BUTTON_INVALID" });
});

function fakePads() {
  const state = { pads: [], frame: null, frames: 0 };
  return {
    state,
    opts: { getGamepads: () => state.pads, raf: (f) => { state.frame = f; return ++state.frames; }, caf: () => { state.frame = null; } },
    tick() { const f = state.frame; state.frame = null; f?.(); },
  };
}

test("attachGamepad: polls each frame, ORs pads, ignores non-standard and disconnected ones, releases on detach", () => {
  const s = new InputState(), g = fakePads(), off = s.attachGamepad(g.opts);
  g.state.pads = [null, pad([1]), pad([4], [0, 0, 0, 0], { mapping: "" }), pad([5], [0, 0, 0, 0], { connected: false })];
  g.tick(); assert.equal(s.mask, BUTTON_MASK.A, "only the standard connected pad counts");
  g.state.pads = [pad([1]), pad([13])];
  g.tick(); assert.equal(s.mask, BUTTON_MASK.A | BUTTON_MASK.DOWN, "two pads are merged");
  g.state.pads = [pad([], [-1, 0])];
  g.tick(); assert.equal(s.mask, BUTTON_MASK.LEFT);
  g.state.pads = []; g.tick(); assert.equal(s.mask, 0, "unplugging releases");
  g.state.pads = [pad([9])]; g.tick(); assert.equal(s.mask, BUTTON_MASK.START);
  off(); assert.equal(s.mask, 0); assert.equal(g.state.frame, null, "polling stopped");
});

test("gamepad and keyboard coexist: releasing the key does not release the pad's A", () => {
  const s = new InputState(), g = fakePads(), el = new EventTarget();
  s.attachKeyboard(el); s.attachGamepad(g.opts);
  g.state.pads = [pad([1])]; g.tick();
  press(el, "KeyZ"); release(el, "KeyZ");
  assert.equal(s.mask, BUTTON_MASK.A);
});
