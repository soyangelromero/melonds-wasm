// Reader for libretro `.cht` files (libretro-database/cht/*): `cheatN_desc = "..."`, `cheatN_code = "..."`, `cheatN_enable = false`.
// Test helper only: used with ephemeral data under tests/artifacts/ (git-ignored), never shipped.
export function parseCht(text) {
  const byIndex = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*cheat(\d+)_(desc|code)\s*=\s*"(.*)"\s*$/.exec(raw);
    if (!m) continue;
    const i = Number(m[1]);
    const e = byIndex.get(i) ?? { index: i };
    e[m[2]] = m[3];
    byIndex.set(i, e);
  }
  return [...byIndex.values()].sort((a, b) => a.index - b.index);
}
