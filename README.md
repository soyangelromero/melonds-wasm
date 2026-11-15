# melonds-wasm

[melonDS](https://melonds.kuribo64.net/) DS v1.4.0 (libretro core) compiled to WebAssembly, with a small JavaScript library
(`MelonDS`) to run Nintendo DS games in the browser. No runtime dependencies, no framework, no build step on your side.

- Video on a canvas (WebGL2, with Canvas2D fallback), layouts, image filters
- Audio in an AudioWorklet, fast-forward, touch / keyboard / gamepad input
- Saves (`.sav`) and save states, Action Replay cheats
- Runs in a Web Worker (needs `SharedArrayBuffer`)

## Legal notice

Unofficial hobby project, **not affiliated with Nintendo, Game Freak or The Pokémon Company**. It does not include any ROM,
BIOS or firmware, and it only works with legitimate copies that you provide yourself (nothing is uploaded anywhere). It uses
a free BIOS (FreeBIOS) and a firmware generated in the browser.

This port was developed **with the help of AI models (Claude and DeepSeek)** under the author's direction and testing. It is
a recompilation of the open-source melonDS.

## Quick start

Requirements: Docker (to build), Node.js 22+ (to serve and test), and your own `.nds` ROM.

```bash
# On Windows keep line endings untouched, otherwise the patches do not apply
git clone -c core.autocrlf=false --recurse-submodules https://github.com/soyangelromero/melonds-wasm.git
cd melonds-wasm

./scripts/build.sh          # Linux / macOS / Git Bash   (Windows PowerShell: ./scripts/build.ps1)
npm run serve               # http://localhost:8080/demo/index.html
```

The build runs inside Docker (`emscripten/emsdk:6.0.13`) and writes `dist/melonds.js` and `dist/melonds.wasm`. Open the demo
and pick your ROM with the file selector.

## Use it in your project

Copy `dist/`, `js/` (and `adapters/` if you want the web-app adapter) to your site, then:

```js
import { MelonDS } from "./js/melonds.js";

const ds = await MelonDS.create({ canvas: document.querySelector("canvas") });
await ds.loadRom(romBytes, { save: savBytes });   // Uint8Array; the save is optional
ds.start();                                        // audio unlocks with the first user gesture
ds.setLayout("Top/Bottom");
const save = await ds.getSaveNow();                // .sav bytes
```

The full API (layouts, speed, volume, cheats, save states, filters, events, errors) is in
[`API_CONTRACT.md`](API_CONTRACT.md). Image filters live in `js/filters.js`.

**Hosting requirement.** Your server must send these headers on the page and its scripts (they enable `SharedArrayBuffer`):

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

If you cannot set headers (GitHub Pages, `python -m http.server`, object storage), also publish `coi-sw.js` at the site root
and open the page with `?coi=1`: a service worker isolates the page after one reload. It needs HTTPS or `localhost`.

To get a folder with only what the browser needs:

```bash
node scripts/package.mjs    # -> package/  (dist, js, adapters, demo, LICENSE, manifest.json)
```

## Modify it

```
core/        C++ glue and minimal libretro host, plus core/patches/ (patches applied to melonDS DS)
js/          the library (ES modules): player, audio, input, saves, cheats, filters, MelonDS class
adapters/    adapter for an existing web app, and the WebRTC multiplayer host
demo/        standalone demo pages
scripts/     Docker build, static server, packaging, release, repository hygiene check
tests/       unit and browser tests (reports and measurements are in Spanish)
third_party/ melonDS DS v1.4.0 submodule
```

- **JavaScript changes** need no rebuild: edit `js/` and reload.
- **C++ / core changes**: edit `core/` or `core/patches/`, then rebuild with
  `bash scripts/build-core.sh && bash scripts/build-host.sh` (inside the Docker image, see `scripts/build.sh`).
- **Tests**: `npm test` runs the unit tests. Browser tests (`npm run test:*`, see `package.json`) need Playwright
  (`npm install`) and some of them a ROM of your own (set `ROM_DIR` to its folder).
- **Before committing**: `node scripts/check-clean.mjs` fails if the repository would contain ROMs, BIOS, firmware, saves,
  credentials or personal paths.

More detail on each area is in `API_CONTRACT.md`, `THIRD_PARTY.md` and `adapters/INTEGRATION.md`; design notes and test reports
under `tests/` are in Spanish.

## License

GPL-3.0, see [`LICENSE`](LICENSE). melonDS and melonDS DS are GPL-3.0 too, so anyone distributing the `.wasm` must make the
corresponding source available. Provenance and licenses of everything linked into the binary: [`THIRD_PARTY.md`](THIRD_PARTY.md).
