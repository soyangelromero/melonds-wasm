# melonds-wasm

A port of **melonDS DS v1.4.0** (libretro core) to WebAssembly with Emscripten, with its own minimal libretro host and a
JavaScript library that has no runtime dependencies.

The master plan is in `PLAN.md`, the API contract in `API_CONTRACT.md` and the per-phase prompts in `PROMPTS.md`.
Note: the design documents (`PLAN.md`, `PROMPTS.md`, `REVIEW*.md`, `tests/*REPORT*.md`, `tests/BENCH.md`, …) are written in
Spanish; the code, comments and this README are in English.

## Legal notice

A hobby project, **not affiliated with Nintendo, Game Freak or The Pokémon Company**. It does not include or distribute
any ROM, BIOS, firmware or other Nintendo-copyrighted material: it only works with **legitimate copies** that the user
supplies from their own computer (they are never uploaded anywhere). The code is licensed under GPL-3.0 (see `LICENSE`);
the provenance of the dependencies linked into the binary is listed in `THIRD_PARTY.md`.

## How it was made (transparency about the use of AI)

This port was developed **with the help of AI models**: **Claude** (Anthropic) and **DeepSeek**. It was written and
reviewed by AI assistants under the direction and testing of the author (who publishes it and is responsible for the
repository); the code has not had an independent human audit. Be critical of it.

What it is and what it is not, to avoid misunderstandings:

- **It is not a decompilation.** melonDS is open source (GPL-3.0). Here it is **recompiled** to WebAssembly with
  Emscripten (melonDS DS v1.4.0 libretro core, with 7 patches of our own in `core/patches/`) and a minimal C++ host plus a
  JavaScript library, both written for this project, are added on top.
- **It contains nothing from Nintendo and nothing was obtained from Nintendo material**: no ROM, no BIOS, no firmware. The
  BIOS and firmware used by default are free ones (FreeBIOS and a firmware generated in the browser).
- The emulation work belongs to **melonDS and its authors**; this repository only brings it to the browser.
- Like any AI-assisted code, it may contain bugs or subtle faults: the automated tests (`tests/`) cover what can be
  measured, but they are no substitute for trying it with your own games.

## Requirements

- Docker (pinned image `emscripten/emsdk:6.0.13`).
- Node.js 22 or newer (only for the static server and the tests).
- **Your own** Nintendo DS ROM. This repository does not include any ROM, BIOS or firmware.

## Build

```bash
# Clone WITH the submodule. On Windows, without converting line endings (otherwise the patches do not apply):
git clone -c core.autocrlf=false --recurse-submodules https://github.com/soyangelromero/melonds-wasm.git
cd melonds-wasm

# Linux / macOS / Git Bash
./scripts/build.sh

# Windows PowerShell
./scripts/build.ps1
```

The output goes to `dist/`. The build runs inside Docker, so you do not need to install Emscripten on your machine.

## Try it

```bash
npm test                 # Node tests (server, artifacts, unit tests)
npm run serve            # http://localhost:8080/demo/hello.html
```

The server sends `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`, which are
required by `SharedArrayBuffer` and by the threaded build.

If your hosting cannot send those headers (GitHub Pages, `python -m http.server`, object storage…), also copy `coi-sw.js`
to the published root and open the demo with **`?coi=1`**: the service worker registers once and reloads until the page is
isolated (`crossOriginIsolated === true`). It is opt-in so the normal COOP/COEP warning is not altered. It needs HTTPS or
`localhost` (like any service worker). The package built by `scripts/package.mjs` already includes it.

## Version, license and hygiene

- `CHANGELOG.md` has the history; version `1.0.0` in `package.json`.
- GPL-3.0 license (`LICENSE`) and provenance of everything linked into the `.wasm` (`THIRD_PARTY.md`).
- `node scripts/check-clean.mjs` fails if it finds ROMs/BIOS/firmware/save files, credentials or paths from the author's
  profile (`--strict` also fails on any absolute Windows path). Ideally run it in CI or as a hook.
- How it was integrated into the web app: `adapters/INTEGRATION.md`; acceptance checklist with evidence:
  `tests/FINAL_REPORT.md`.

## Layout

```
core/        C++ glue and minimal libretro host
js/          ES module library (MelonDS class)
adapters/    adapter for the existing web app
demo/        standalone demo (and demo/host.html for multiplayer)
tests/       tests, contract deviations and benchmark
scripts/     Docker build, static server and check-clean
coi-sw.js    optional service worker (COOP/COEP on hosts without those headers)
dist/        generated artifacts (ignored by git)
third_party/ melonDS DS v1.4.0 submodule
```

## Video demo (Phase 3)

```bash
npm run serve            # http://127.0.0.1:8080/demo/index.html  (with COOP/COEP)
```

Pick your own `.nds` with the file selector (it is not uploaded anywhere): layouts, screen gap, filter and scaling. It
needs a compiled `dist/` (`bash scripts/build-core.sh && bash scripts/build-host.sh`) and a browser with Wasm exception
handling and `SharedArrayBuffer` (recent Chrome/Edge/Firefox). Headless Chromium tests: `npm run test:browser` (video)
(see `tests/PHASE3_REPORT.md`).

## Audio (Phase 4)

Same demo (`npm run serve` → `http://127.0.0.1:8080/demo/index.html`): pick the ROM with a click (that gesture unlocks
audio) and use volume, mute and the buffer / underrun / overrun readout. At 1x the audio clock paces the emulator; up to
2x the audio stays audible (pitched up) and above that it is muted.
Tests: `npm test` (unit tests, including the threaded ring buffer and the resampler), `node tests/phase4-core-audio.mjs`
(core in Node), `node tests/phase4-browser.mjs --minutes=3` (headless Chromium). Own test ROM (CC0, no Nintendo content):
`python3 tests/homebrew/audio-tone/mkrom.py tests/artifacts/audio-tone.nds` (needs `gcc-arm-none-eabi`). Details in
`tests/PHASE4_REPORT.md`.

## Input (Phase 5)

In the demo: arrows = D-pad · `Z`=A · `X`=B · `A`=X · `S`=Y · `Q`=L · `E`=R · `Enter`=Start · `V`=Select; standard gamepad
(right button=A, bottom=B, top=X, left=Y, LB/RB, Back/Start, D-pad or left stick); mouse/touch on the picture = touch screen,
in any layout.
Tests: `npm test` (unit tests, including `tests/touch.test.mjs` and `tests/input.test.mjs`) and `npm run test:input` (real
core in Node + headless Chromium). See `tests/PHASE5_REPORT.md`.

## Saves, states (Phase 6) and cheats (Phase 8)

The same demo (`demo/index.html`) has a **Saves and states** panel (download/replace `.sav`, quick state, download/load
state, and autosave to IndexedDB: when you reopen the same ROM it starts with "Continue" from that save) and a **Cheats
(Action Replay)** panel (id, code made of 8-digit hexadecimal words, enable/disable/remove). `demo/saves.html` is the
standalone Phase 6 demo (used by `npm run test:saves-browser`). API: `player.saves.{getSave,getSaveNow,loadSave,onSave,flush,saveState,loadState}`
and `player.{setCheat,clearCheats}`. Tests: `npm run test:saves`, `npm run test:saves-browser`, `npm run test:cheats`;
reports `tests/PHASE6_REPORT.md` and `tests/PHASE8_REPORT.md`.

## Integration (the Phase 4, 5, 6 and 8 branches merged)

`npm run test:integration` (headless Chromium, own ROM `tests/artifacts/integration.nds`, generated with
`npm run build:integration-rom`, needs `gcc-arm-none-eabi`): in a single demo session it loads the ROM, measures the audio in
the worklet, presses a key, touches the bottom screen, enables cheats and reads RAM, gets and reloads a save and a state,
checks "Continue" and that there are no console errors. Report: `tests/INTEGRATION_REPORT.md`.

## Status

Phases 0–6, 7 (JS side), 8, 9, 10, 11, 12 and 13 are done and integrated: the core runs in Wasm, the composed frame is
drawn on a canvas, audio plays in sync (with dynamic rate control at 1x by default), there is keyboard / gamepad / touch
input, saves (`.sav`) and states, Action Replay cheats, a **public `MelonDS` API** that follows `API_CONTRACT.md`, an
**adapter** that lets the existing web app (`?engine=wasm`) use this engine, WebRTC **multiplayer** (host side) and a
GPL-3.0 static package.

The library was verified in Chromium (`node tests/library-browser.mjs`): **NDS 4/4 + GBA 4/4**. The 512 MB game boots in
about 7–10 s at roughly 40 fps of worker speed with the canonical 2 GiB build. `scripts/build-host.sh` asks for
`-sMAXIMUM_MEMORY=2147483648`; `scripts/raise-memory-limit.mjs` remains only as a workaround for old 1 GiB builds. With a
1 GiB build the worker rejects the 512 MB ROM with `ROM_TOO_LARGE` and the web app offers a fallback.

Still pending / optional: Phase 7 in C++ (external BIOS/firmware and microphone: the default firmware already works
without any Nintendo files), a cheap `retro_reset`, `-O3`/LTO/SIMD improvements and `dist/st` (a build without threads);
finer Phase 9 profiling (per section, without rebuilding; plan in `tests/PHASE9_REPORT.md` §7); Phase 14 (native WebGL2 /
DSi: **a feasibility report exists, not implemented**, in [`docs/PHASE14_WEBGL2_DSI.md`](docs/PHASE14_WEBGL2_DSI.md)).
Manual checks that need real hardware (save → close → "Continue" with real games, physical gamepad, real touch screen) are
listed in `tests/MANUAL.md`.

## Public API (Phase 10)

```js
import { MelonDS } from "./js/melonds.js";

const ds = await MelonDS.create({ canvas, threads: "auto" });
await ds.loadRom(romBytes, { save: savBytes });   // -> {title, code, size, saveType}
ds.start();                                        // audio unlocks with the first user gesture
ds.setLayout("Top/Bottom");
ds.setCheat(1, true, "94000130+FFFB0000+62101F2C+00000000+…");
const save = await ds.getSaveNow();                // .sav bytes
```

`MelonDS` follows the table in `API_CONTRACT.md` (asynchronous methods where the worker requires it; see
`tests/DEVIATIONS.md`). Tests: `node --test tests/melonds-api.test.mjs`.

## Image filters

`js/filters.js` ships its own WebGL2 filters (sharp bilinear, smooth, LCD grid, scanlines, soft CRT, DS colors, DS LCD).
They are applied with `ds.setPostProcess({ glsl, scale })`; see `API_CONTRACT.md`. Test: `node tests/filters-browser.mjs`.

## Adapter for the web app (Phase 11)

`adapters/webapp-adapter.js` presents the engine with the shape of `EJS_emulator`/`gameManager`, so the web app's
`nds/index.html` works without being rewritten. The web app serves it at `/nds/wasm/` and it is enabled with
`?engine=wasm` (or with the "melonDS WASM" button in the library). It translates layouts, screen gap, hybrid layout,
fast-forward, cheats, saves, states, filters and `setPostProcess`. It includes automatic scaling (integer when it fits at
≥2x; otherwise a smooth fill).

Browser test (needs the web app hub and a ROM in the library): `npm run test:webapp`.

## Multiplayer (Phase 12)

`adapters/netplay-host.js` is the WebRTC host: it creates the room on the signaling server (socket.io), sends the offer
with `captureStream()` and receives the guest's inputs on the `inputs` channel. Guests join through `nds/join.html`
unchanged; they receive the video over WebRTC and their touches over the socket. `createNetplayHost` accepts injectable
`io` and `RTCPeerConnection`, so it can be tested in Node (`tests/netplay-host.test.mjs`). Two-tab browser test:
`npm run test:netplay`.

## Performance and pacing (Phase 9)

`audioDynamicRate: "always"` is the default: if the CPU cannot sustain 59.83 fps, the audio slows down by up to 20 %
instead of cutting out (floor 0.5 while fast-forwarding); when the CPU keeps up the factor is 1 and nothing changes. It can
be changed at runtime with `MelonDS#setAudioDynamicRate("ff"|"off")` or `VideoPlayer#setAudioDynamicRate(...)`. The 3D
threads stay enabled (41.6 vs 32.8 fps in real 3D with `nmap.nds`; frame 300 determinism intact).

Measurements and how to repeat them: `tests/BENCH.md` (matrix 1x / 1.5x / 2x / unlimited × 3D threads, median of 3×20 s)
and `tests/PHASE9_REPORT.md`. Automatic harness: `node tests/bench-browser.mjs` (~13 min; `--quick` for a smoke run, or
`SPEEDS=1,2 THREADS=1 SECS=10 REPS=1`). Manual bench page: `tests/bench.html` (served with `scripts/serve.mjs`).

## Saving to the PC (File System Access API)

The demo includes the third save layer: a `.sav` **on the user's own computer** from the browser (Chrome/Edge; in
Firefox/Safari it is explained and "Download .sav"/"Replace .sav" are used instead). "Link PC .sav" picks a file and uses
it as the starting save when the ROM loads; "Save now to the PC .sav" and the autosave checkbox write the `.sav` into that
file with `createWritable` (atomic write by the browser). If the browser save and the PC save differ, it asks which one to
use; nothing is ever overwritten silently. Test with doubles of the API: `node tests/fsa-saves-browser.mjs` (8/8). In the web
app the third layer is the server (`PUT /nds/api/sav/:id`, with `.bak` and atomic `rename`).

## 512 MB ROMs: memory cap

The current canonical build uses `-sMAXIMUM_MEMORY=2147483648` (2 GiB) and the 512 MB game loads without patches
(melonDS keeps about 3 copies of the ROM in the heap and needs roughly 1.6–1.7 GiB).
`node scripts/raise-memory-limit.mjs --check` exits **0 without changing anything**. For old 1 GiB builds there is an
artifact workaround (`node scripts/raise-memory-limit.mjs`, reversible with `--restore`), no longer needed with the current
build; the canonical way is to rebuild with `scripts/build-host.sh`.

## Static package (Phase 13)

```bash
node scripts/package.mjs        # -> package/ (or --out <dir>)
ROOT=package PORT=8090 node scripts/serve.mjs
```

`package/` contains only what the browser needs: `dist/melonds.js` + `.wasm`, `js/`, `adapters/`, `demo/`, `index.html`,
`LICENSE`, `THIRD_PARTY.md`, `README.md` and a `manifest.json` with sizes. It does not include tests or `third_party/`
(thousands of files). It fails on purpose if `dist/` is not built.

## License

GPL-3.0: see `LICENSE`. The engine (melonDS and melonDS DS) is GPL-3.0, so when you distribute the `.wasm` you must be able
to provide the corresponding source code. Provenance and licenses of everything linked: `THIRD_PARTY.md`.
This repository does **not** contain any Nintendo ROM, BIOS or firmware: FreeBIOS and the firmware generated by melonDS
replace them, and the test ROMs are CC0 homebrew.
