import test from "node:test";
import assert from "node:assert/strict";
import { LAYOUT_VALUES, LAYOUTS, layoutOptions, gapOptions, hybridSmallScreenOptions } from "../js/layouts.js";

test("17 layouts translate to core keys (API_CONTRACT table 2.1)", () => {
  assert.equal(LAYOUTS.length, 17);
  assert.equal(new Set(Object.values(LAYOUT_VALUES)).size, 17);
  assert.deepEqual(layoutOptions("Hybrid (Focus Top)"), { melonds_number_of_screen_layouts: "1", melonds_screen_layout1: "hybrid-top" });
  assert.equal(LAYOUT_VALUES["Upside Down"], "rotate-180");
});
test("invalid input is rejected, not passed through", () => {
  assert.throws(() => layoutOptions("top-bottom"), { code: "LAYOUT_INVALID" });
  assert.throws(() => gapOptions(127), { code: "GAP_INVALID" });
  assert.throws(() => gapOptions(-1), { code: "GAP_INVALID" });
  assert.throws(() => hybridSmallScreenOptions("top"), { code: "HYBRID_INVALID" });
  assert.deepEqual(gapOptions(40), { melonds_screen_gap: "40" });
});
