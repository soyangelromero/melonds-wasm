// Small DSP helpers shared by the Phase 4 tests.
/** Power of `x` at frequency `f` (Hz) for sample rate `fs` (Goertzel). */
export function goertzel(x, f, fs) {
  const w = (2 * Math.PI * f) / fs, c = 2 * Math.cos(w);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < x.length; i++) { const s = x[i] + c * s1 - s2; s2 = s1; s1 = s; }
  return (s1 * s1 + s2 * s2 - c * s1 * s2) / (x.length * x.length);
}
/** Frequency of the strongest component in [lo, hi] Hz, refined by a parabola through the three best bins. */
export function peakFrequency(x, fs, lo = 50, hi = 4000, step = 0.5) {
  let best = { f: lo, p: -1 }; const pw = [];
  for (let f = lo; f <= hi; f += step) { const p = goertzel(x, f, fs); pw.push(p); if (p > best.p) best = { f, p }; }
  const i = Math.round((best.f - lo) / step), a = pw[i - 1] ?? pw[i], b = pw[i], c = pw[i + 1] ?? pw[i];
  const d = a - 2 * b + c; return d ? best.f + (step * 0.5 * (a - c)) / d : best.f;
}
export const rms = (x) => Math.sqrt(x.reduce((a, v) => a + v * v, 0) / x.length);
