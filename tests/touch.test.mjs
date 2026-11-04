// Phase 5: normalisation and state of the pointer (js/input.js). Pure Node, no browser, no core.
// The layout / gap / hybrid / rotation transform is the core's job and is checked against the real core in tests/phase5-core.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { toPointerSpace, normalizeClient, InputState, InputReader, POINTER_MAX } from "../js/input.js";

const rect = (left, top, width, height) => ({ left, top, width, height });

test("toPointerSpace: corners, centre and clamping", () => {
  assert.equal(toPointerSpace(0), -POINTER_MAX);
  assert.equal(toPointerSpace(1), POINTER_MAX);
  assert.equal(toPointerSpace(0.5), 0);
  assert.equal(toPointerSpace(-3), -POINTER_MAX);
  assert.equal(toPointerSpace(7), POINTER_MAX);
  assert.equal(toPointerSpace(0.25), Math.round(-0.5 * POINTER_MAX));
});

test("normalizeClient: relative to the drawn rectangle, not to the page", () => {
  const r = rect(100, 50, 256, 384);
  assert.deepEqual(normalizeClient(100, 50, r), { nx: 0, ny: 0, inside: true });
  assert.deepEqual(normalizeClient(356, 434, r), { nx: 1, ny: 1, inside: true });
  assert.deepEqual(normalizeClient(228, 242, r), { nx: 0.5, ny: 0.5, inside: true });
  const q = normalizeClient(100 + 64, 50 + 96, r);
  assert.equal(q.nx, 0.25); assert.equal(q.ny, 0.25);
});

test("normalizeClient: outside the picture clamps and says so", () => {
  const r = rect(10, 10, 100, 200);
  assert.deepEqual(normalizeClient(-500, 5000, r), { nx: 0, ny: 1, inside: false });
  assert.deepEqual(normalizeClient(110.5, 10, r), { nx: 1, ny: 0, inside: false });
  assert.equal(normalizeClient(5, 5, rect(0, 0, 0, 0)).inside, false); // collapsed canvas never divides by zero
});

test("normalizeClient: CSS scaling (rect != backing store) is irrelevant, only the proportion counts", () => {
  const a = normalizeClient(75, 150, rect(0, 0, 100, 200));
  const b = normalizeClient(300, 600, rect(0, 0, 400, 800));
  assert.deepEqual([a.nx, a.ny], [b.nx, b.ny]);
});

test("normalizeClient: letterboxed element with contentFit subtracts the bars", () => {
  // 512x192 picture (aspect 2.667) inside a 400x400 element: picture is 400x150, centred (bars of 125 px top and bottom).
  const r = rect(0, 0, 400, 400), fit = { width: 512, height: 192 };
  assert.deepEqual(normalizeClient(0, 125, r, fit), { nx: 0, ny: 0, inside: true });
  assert.deepEqual(normalizeClient(400, 275, r, fit), { nx: 1, ny: 1, inside: true });
  const bar = normalizeClient(200, 50, r, fit);
  assert.equal(bar.inside, false); assert.equal(bar.ny, 0);
  assert.equal(normalizeClient(200, 200, r, fit).ny, 0.5);
});

test("rotation: normalisation does not depend on it (the canvas already shows the rotated frame)", () => {
  // Rotated Left shows a 384x256 canvas; a click at 3/4 across and 1/4 down is (0.75, 0.25) whatever the unrotated frame was.
  const r = rect(0, 0, 384, 256);
  const p = normalizeClient(288, 64, r);
  assert.deepEqual([p.nx, p.ny], [0.75, 0.25]);
});

test("touchFromCanvas: down / move / up drive the shared pointer state", () => {
  const s = new InputState();
  assert.deepEqual(s.pointer, { x: 0, y: 0, pressed: false });
  s.touchFromCanvas(0, 0, "down");
  assert.deepEqual(s.pointer, { x: -POINTER_MAX, y: -POINTER_MAX, pressed: true });
  s.touchFromCanvas(1, 1, "move");
  assert.deepEqual(s.pointer, { x: POINTER_MAX, y: POINTER_MAX, pressed: true });
  s.touchFromCanvas(0.5, 0.5, "up");
  assert.deepEqual(s.pointer, { x: 0, y: 0, pressed: false });
  s.touchFromCanvas(0.25, 0.75, "move"); // hover (cursor only)
  assert.equal(s.pointer.pressed, false);
  assert.equal(s.pointer.x, Math.round(-0.5 * POINTER_MAX));
});

test("touchFromCanvas: out-of-range values clamp, bad input throws", () => {
  const s = new InputState();
  s.touchFromCanvas(-4, 9, "down");
  assert.deepEqual(s.pointer, { x: -POINTER_MAX, y: POINTER_MAX, pressed: true });
  assert.throws(() => s.touchFromCanvas(0.5, 0.5, "tap"), { code: "TOUCH_INVALID" });
  assert.throws(() => s.touchFromCanvas(NaN, 0.5, "down"), { code: "TOUCH_INVALID" });
});

test("pointerAway: the core reads (0, 0) as 'not over the play area'", () => {
  const s = new InputState();
  s.touchFromCanvas(0.9, 0.1, "move"); s.pointerAway();
  assert.deepEqual(s.pointer, { x: 0, y: 0, pressed: false });
});

test("worker reader: a tap shorter than one frame still produces exactly one frame of touch at the tap position", () => {
  const s = new InputState(), r = new InputReader(s.buffer);
  assert.deepEqual(r.read(), { mask: 0, x: 0, y: 0, pressed: false });
  s.touchFromCanvas(0.2, 0.8, "down"); s.touchFromCanvas(0.3, 0.7, "up"); // both before the next frame
  const a = r.read();
  assert.equal(a.pressed, true);
  assert.equal(a.x, toPointerSpace(0.2)); assert.equal(a.y, toPointerSpace(0.8));
  const b = r.read();
  assert.equal(b.pressed, false); // released on the next frame, no phantom second touch
  assert.equal(r.read().pressed, false);
});

test("worker reader: a held touch stays pressed across frames and follows the drag", () => {
  const s = new InputState(), r = new InputReader(s.buffer);
  s.touchFromCanvas(0.1, 0.1, "down");
  assert.equal(r.read().pressed, true);
  s.touchFromCanvas(0.6, 0.4, "move");
  const m = r.read();
  assert.equal(m.pressed, true); assert.equal(m.x, toPointerSpace(0.6));
  s.touchFromCanvas(0.6, 0.4, "up");
  assert.equal(r.read().pressed, false);
});

// ---- Pointer Events on a fake canvas ----------------------------------------------------------------------------------
function fakeCanvas(r = rect(100, 100, 256, 384)) {
  const c = new EventTarget();
  c.style = {}; c.captured = new Set();
  c.getBoundingClientRect = () => ({ ...r, right: r.left + r.width, bottom: r.top + r.height });
  c.setPointerCapture = (id) => c.captured.add(id);
  c.fire = (type, props) => { const e = new Event(type, { cancelable: true }); Object.assign(e, { pointerId: 1, pointerType: "mouse", button: 0, ...props }); c.dispatchEvent(e); return e; };
  return c;
}

test("attachPointer: mouse press / drag / release on the canvas", () => {
  const s = new InputState(), c = fakeCanvas(), off = s.attachPointer(c);
  assert.equal(c.style.touchAction, "none");
  c.fire("pointermove", { clientX: 228, clientY: 292 });             // hover
  assert.deepEqual(s.pointer, { x: 0, y: 0, pressed: false });        // exact centre
  const down = c.fire("pointerdown", { clientX: 100, clientY: 100 });
  assert.equal(down.defaultPrevented, true);
  assert.deepEqual(s.pointer, { x: -POINTER_MAX, y: -POINTER_MAX, pressed: true });
  assert.ok(c.captured.has(1));
  c.fire("pointermove", { clientX: 356, clientY: 484 });
  assert.deepEqual(s.pointer, { x: POINTER_MAX, y: POINTER_MAX, pressed: true });
  c.fire("pointerup", { clientX: 356, clientY: 484 });
  assert.equal(s.pointer.pressed, false);
  off();
});

test("attachPointer: right / middle mouse buttons do not touch", () => {
  const s = new InputState(), c = fakeCanvas(); s.attachPointer(c);
  c.fire("pointerdown", { clientX: 150, clientY: 150, button: 2 });
  assert.equal(s.pointer.pressed, false);
});

test("attachPointer: releasing OUTSIDE the canvas (capture) lifts the touch and clamps to the edge", () => {
  const s = new InputState(), c = fakeCanvas(); s.attachPointer(c);
  c.fire("pointerdown", { clientX: 200, clientY: 200 });
  assert.equal(s.pointer.pressed, true);
  c.fire("pointermove", { clientX: -900, clientY: 99999 });          // way outside while captured
  assert.deepEqual(s.pointer, { x: -POINTER_MAX, y: POINTER_MAX, pressed: true });
  c.fire("pointerup", { clientX: -900, clientY: 99999 });
  assert.equal(s.pointer.pressed, false);
  assert.equal(s.owner, null);
});

test("attachPointer: pointercancel releases (touch stolen by the OS / palm rejection)", () => {
  const s = new InputState(), c = fakeCanvas(); s.attachPointer(c);
  c.fire("pointerdown", { pointerId: 7, pointerType: "touch", clientX: 150, clientY: 150 });
  assert.equal(s.pointer.pressed, true);
  c.fire("pointercancel", { pointerId: 7, pointerType: "touch" });
  assert.deepEqual(s.pointer, { x: 0, y: 0, pressed: false });
  assert.equal(s.owner, null);
});

test("attachPointer: several fingers, the first owns the DS touch and the others are ignored", () => {
  const s = new InputState(), c = fakeCanvas(); s.attachPointer(c);
  c.fire("pointerdown", { pointerId: 1, pointerType: "touch", clientX: 100, clientY: 100 });
  c.fire("pointerdown", { pointerId: 2, pointerType: "touch", clientX: 356, clientY: 484 }); // second finger
  assert.deepEqual(s.pointer, { x: -POINTER_MAX, y: -POINTER_MAX, pressed: true });
  c.fire("pointermove", { pointerId: 2, pointerType: "touch", clientX: 228, clientY: 292 });
  assert.equal(s.pointer.x, -POINTER_MAX);                           // finger 2 does not drag it
  c.fire("pointerup", { pointerId: 2, pointerType: "touch", clientX: 228, clientY: 292 });
  assert.equal(s.pointer.pressed, true);                              // lifting finger 2 does not release finger 1
  c.fire("pointermove", { pointerId: 1, pointerType: "touch", clientX: 356, clientY: 100 });
  assert.deepEqual([s.pointer.x, s.pointer.y], [POINTER_MAX, -POINTER_MAX]);
  c.fire("pointerup", { pointerId: 1, pointerType: "touch", clientX: 356, clientY: 100 });
  assert.deepEqual(s.pointer, { x: 0, y: 0, pressed: false });        // finger lifted: nothing is "over" the screen any more
  c.fire("pointerdown", { pointerId: 3, pointerType: "touch", clientX: 228, clientY: 292 }); // a later finger can take over
  assert.equal(s.pointer.pressed, true);
});

test("attachPointer: mouse leaving the canvas without pressing sends 'away'; leaving while pressed keeps the drag", () => {
  const s = new InputState(), c = fakeCanvas(); s.attachPointer(c);
  c.fire("pointermove", { clientX: 150, clientY: 150 });
  c.fire("pointerleave", {});
  assert.deepEqual(s.pointer, { x: 0, y: 0, pressed: false });
  c.fire("pointerdown", { clientX: 150, clientY: 150 });
  c.fire("pointerleave", {});
  assert.equal(s.pointer.pressed, true);
});

test("attachPointer: a canvas resized by CSS between events is re-measured every time", () => {
  const s = new InputState();
  const box = rect(0, 0, 100, 100), c = fakeCanvas(box); s.attachPointer(c);
  c.fire("pointerdown", { clientX: 50, clientY: 50 });
  assert.equal(s.pointer.x, 0);
  Object.assign(box, { width: 400, height: 400 });
  c.fire("pointermove", { clientX: 100, clientY: 100 });
  assert.equal(s.pointer.x, Math.round(-0.5 * POINTER_MAX));
});

test("detaching removes the listeners and releases the touch", () => {
  const s = new InputState(), c = fakeCanvas(), off = s.attachPointer(c);
  c.fire("pointerdown", { clientX: 150, clientY: 150 });
  off();
  assert.equal(s.pointer.pressed, false);
  c.fire("pointerdown", { clientX: 150, clientY: 150 });
  assert.equal(s.pointer.pressed, false);
});
