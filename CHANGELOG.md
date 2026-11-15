# Changelog

Todas las versiones notables de `melonds-wasm` (port de melonDS DS v1.4.0 a WebAssembly). Fechas `AAAA-MM-DD`.
El proyecto no es un producto de Nintendo: no incluye ROM, BIOS ni firmware; solo se usa con copias legítimas.

## [1.0.0] — 2026-11-15

Primera versión con la API pública, el adaptador de la web app, el multijugador y el paquete estático.

### Añadido

- **API pública `MelonDS`** (`js/melonds.js`) con la forma de `API_CONTRACT.md` §2: `create`, `loadRom`, arranque y
  pausa, velocidad, vídeo (layouts, gap, híbrido, escalado, post-proceso), audio (volumen, mute, desbloqueo), entrada
  (teclado, mando, puntero), guardado (`.sav`, estados), trucos, firmware/BIOS opcionales, `captureStream` y
  `getStats`. 16 pruebas unitarias sin navegador.
- **Firmware/BIOS por JS** (Fase 7): `mds_write_system_file` escribe `firmware.bin`/`bios7.bin`/`bios9.bin` en `/system`
  antes de `loadRom`; por defecto no hace falta ningún archivo (FreeBIOS + firmware integrado del núcleo).
- **Control dinámico de velocidad del audio** (`audioDynamicRate: "always"` por defecto, Fase 9): con una CPU justa el
  audio se ralentiza hasta un 20 % a 1x (suelo 0,5 en avance rápido) en vez de cortarse; con la CPU a tiempo no cambia
  nada. `setAudioDynamicRate("ff"|"off")` en caliente. Medido en `tests/BENCH.md`, informe en `tests/PHASE9_REPORT.md`.
- **Perfilado y optimizaciones JS** (Fase 9): gancho de prueba `debugProfile` y tres optimizaciones conmutables para
  avance rápido/sin límite (publicación de fotogramas decimada, cadencia del detector de guardado y `yield` del bucle).
- **Adaptador para la web app** (`adapters/webapp-adapter.js`, Fase 11): presenta el port con la forma de
  `EJS_emulator`/`gameManager`; `nds/index.html` lo usa con `?engine=wasm` o el selector «melonDS WASM». Escala
  automática del lienzo y pad táctil móvil. Si una ROM no cabe en la build de 1 GiB (Negra 2, 512 MB), el motor
  responde `ROM_TOO_LARGE` y la página ofrece **fallback a EmulatorJS** (verificado: la ROM de 512 MB arranca con el
  motor viejo y toda la biblioteca NDS es jugable en la web app mientras llega la recompilación con 2 GiB).
- **Multijugador WebRTC** (`adapters/netplay-host.js`, Fase 12): anfitrión independiente con socket.io inyectable,
  `captureStream` (audio si está desbloqueado, si no vídeo), canal `inputs`, toques por socket y `host-left`; demo
  independiente `demo/host.html`.
- **Tercera capa de guardado (`.sav` en el PC)**: la demo puede vincular un archivo del PC con la File System Access API,
  usarlo como partida inicial y escribirlo en cada guardado, preguntando si difiere del guardado del navegador
  (`tests/fsa-saves-browser.mjs`).
- **Acceso remoto seguro**: con `ACCESS_KEY`, la señalización socket.io también exige la clave (`allowRequest`), no solo
  las páginas y las APIs; smoke test `tests/hub-remote-smoke.mjs` (11/11).
- **`coi-sw.js`** con registro opt-in `?coi=1` para hostings sin COOP/COEP.
- **Higiene**: `LICENSE` GPL-3.0, `THIRD_PARTY.md`, aviso legal y `scripts/check-clean.mjs` (0 errores).
- **Paquete estático** (`scripts/package.mjs`): solo archivos de navegador, `manifest.json`, demo independiente y
  `demo/host.html` del multijugador; falla si `dist/` no está compilado.
- **Informes** `PHASE7..13_REPORT.md`, `tests/BENCH.md`, `tests/FINAL_REPORT.md` (checklist de aceptación con evidencia).

### Cambiado

- **Tope de memoria a 2 GiB sin recompilar** (workaround temporal, hasta el rebuild): `scripts/raise-memory-limit.mjs`
  parchea los artefactos de `dist/` (máximo de la memoria importada en el `.wasm` y `maximum`/`getHeapMax()` del glue)
  con copias `.bak`, validación y `--check`/`--restore`. Con él la biblioteca completa se verificó en Chromium:
  **NDS 4/4 + GBA 4/4** (Negra 2, 512 MB, arranca en 9,7 s a 40,7 fps). `scripts/build-host.sh` ya pide 2 GiB; el
  rebuild hará canónico el tope y el parche pasa a no-op.

- `demo/index.html` registra `coi-sw.js` con `?coi=1` (opt-in) para hostings sin cabeceras; sin el parámetro la demo
  sigue avisando de que hace falta COOP/COEP.
- `scripts/build-host.sh` pide `-sMAXIMUM_MEMORY=2147483648` (2 GiB) y **el wasm se recompiló el 2026-11-15** con Docker
  Desktop 4.74.0 + `emscripten/emsdk:6.0.13`: `dist/melonds.wasm` (2 456 726 B) tiene max 32768 páginas y Negra 2 carga
  sin parche. `scripts/raise-memory-limit.mjs` queda solo como workaround para builds antiguas de 1 GiB.

### Límites conocidos

- **Negra 2 (512 MB)** necesita un tope de 2 GiB: la **build canónica recompilada el 2026-11-15** lo incluye y la
  biblioteca completa está verificada como **NDS 4/4 + GBA 4/4**; el parche `raise-memory-limit` solo hace falta con
  builds antiguas de 1 GiB (que además tienen `ROM_TOO_LARGE` elegante + fallback a EmulatorJS en la web app).
- **Micrófono** y varios ajustes en C++ (Fase 7-C++, `retro_reset`) requieren recompilar; pendientes.
- **Sin Wi-Fi emulado** (los servidores de Nintendo cerraron; sería otro trabajo) y **sin estados de DSi**.
- **Safari real** sin probar (el motor WebKit sí se probó en Playwright; esa build no expone `AudioWorkletNode`, ver «Compatibilidad de navegadores»); el multijugador no usa TURN (redes con NAT simétrico pueden no conectar).
- Las pruebas manuales del usuario (guardar «Continuar» sin firmware, mando físico, táctil real, trucos reales) siguen
  pendientes y están en `tests/MANUAL.md`.

### Suite de pruebas totalmente en verde

- **`tests/audio-ring.test.mjs` estabilizado**: cuando el productor aún no había escrito, el consumidor hacía un *spin*
  de hasta 50 M de iteraciones y bajo carga podía fallar por «consumer starved»; ahora cede la CPU con `Atomics.wait` y
  solo falla si pasan 120 s sin fotogramas. `npm test` da **138 pruebas, 135 pasan, 0 fallan, 3 omitidas** de forma
  repetible.

### Recompilación canónica (2 GiB)

- **Wasm recompilado el 2026-11-15** con Docker Desktop 4.74.0 + `emscripten/emsdk:6.0.13`
  (`bash scripts/build-core.sh && bash scripts/build-host.sh`): `dist/melonds.wasm` 2 456 726 B, memoria importada max
  32768 páginas (2 GiB), `raise-memory-limit --check` = 0 sin parche. Verificado: biblioteca **NDS 4/4 + GBA 4/4**,
  `phase11` 17/17, suite 138/134/3/1, release regenerado (`release.test` 1/1) y `third-party` 9/9. Ya no hace falta el
  workaround de artefactos para jugar Negra 2.

### Prueba de «tercero» del release

- **`tests/third-party-release.mjs`**: copia únicamente `release/melonds-wasm-1.0.0/` fuera del repositorio, la sirve con
  un servidor HTTP plano sin COOP/COEP, verifica MIME y SHA-256 del `.wasm`, y comprueba que con `?coi=1` el service
  worker aísla la página y la demo arranca y juega `nmap.nds` (9/9). Cierra la prueba de tercero de la guía sin cuentas.

### Bundle de release

- **`scripts/release.mjs`**: prepara `release/melonds-wasm-1.0.0/` con el paquete completo, un ZIP propio (deflate +
  CRC32, sin dependencias), `SHA256SUMS`, metadata con los hashes de `dist/`, el commit y el tope de memoria, y
  `RELEASE_NOTES.md`. Subir el ZIP al release de GitHub y crear el tag `v1.0.0` es el paso que queda del usuario.

### Compatibilidad de navegadores

- **Chromium, Firefox y WebKit** (Safari) verificados con la demo y la web app real (`?engine=wasm`):
  crossOriginIsolated, SharedArrayBuffer, WebGL2, canvas, fotogramas y guardado; el WebKit de Playwright no expone
  `AudioWorkletNode` (sin audio ahí; Safari real sí, [VERIFICAR]). Test: `tests/cross-browser-smoke.mjs`.

### Acceso remoto

- **Acceso remoto verificado de extremo a extremo** con un túnel rápido de Cloudflare (`tests/remote-tunnel-browser.mjs`,
  9/9): HTTPS público con COOP/COEP, `ACCESS_KEY` en páginas/APIs/socket.io y la ROM booteando por el túnel. Es una
  validación efímera; el despliegue estable sigue necesitando un túnel con nombre o VPS.

## [0.1.0] — 2026-11-04

- Fases 0-6 y 8 integradas en `feat/integration`: núcleo en Wasm, vídeo con 17 layouts, audio con AudioWorklet,
  entrada teclado/mando/táctil, guardado y estados, trucos Action Replay.
- Artefactos iniciales `dist/melonds.js` + `dist/melonds.wasm` (1 GiB de memoria máxima).
