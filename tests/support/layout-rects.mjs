// Shared by phase5-core.mjs and phase5-browser.mjs.
// Bottom-screen rectangle in DISPLAYED space for each layout (software renderer, scale 1), derived from the sizes the core
// announces in tests/phase3-layouts.mjs. Deliberately independent of how the core maps the pointer.
export const LAYOUT_RECTS = {
  "top-bottom": { w: 256, h: 384, rect: [0, 192, 256, 192] },
  "bottom": { w: 256, h: 192, rect: [0, 0, 256, 192] },
  "left-right": { w: 512, h: 192, rect: [256, 0, 256, 192] },
  "right-left": { w: 512, h: 192, rect: [0, 0, 256, 192] },
  "bottom-top": { w: 256, h: 384, rect: [0, 0, 256, 192] },
  "rotate-180": { w: 256, h: 384, rect: [0, 0, 256, 192] },
  "rotate-left": { w: 384, h: 256, rect: [192, 0, 192, 256] },
  "rotate-right": { w: 384, h: 256, rect: [0, 0, 192, 256] },
};

// Core option value -> API label (js/layouts.js)
export const LAYOUT_LABEL = {
  "top-bottom": "Top/Bottom", "bottom": "Bottom Only", "left-right": "Left/Right", "right-left": "Right/Left",
  "bottom-top": "Bottom/Top", "rotate-180": "Upside Down", "rotate-left": "Rotated Left", "rotate-right": "Rotated Right",
};
