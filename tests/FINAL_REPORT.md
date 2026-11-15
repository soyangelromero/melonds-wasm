# FINAL REPORT — checklist de aceptación del "port completo" (2026-11-15)

Este documento responde a la lista de la **sección 6 de `docs/GUIA_COMPLETAR_PORT.md`** con la evidencia real de la
sesión. Donde algo solo puede hacerlo el usuario, se dice explícitamente. **Nada está commiteado ni publicado** (el
usuario prueba primero y luego pide commit/push).

## Lista de aceptación

- **Evidencia automática de la última pasada**: `tests/FINAL_ACCEPTANCE.md` — **10/10** comprobaciones (suite, `check-clean`,
  paquete, release, prueba de tercero, `phase11`/`phase12`, cross-browser, biblioteca NDS 4/4 + GBA 4/4 y remoto por túnel),
  con la nota de *thermal throttling* y las repeticiones aisladas en frío.

- [x] **Clonar y jugar con una ROM propia siguiendo el README.** El paquete estático se construye
  (`node scripts/package.mjs` → 35 archivos, 2,69 MiB + `manifest.json` con 32 entradas) y se sirve en aislado;
  `node tests/package.test.mjs` → **1/1** (construye, sirve con `scripts/serve.mjs`, abre la demo en Chromium, 200/MIME/
  COOP/`crossOriginIsolated`, cero 404 y cero errores). La demo independiente (`demo/index.html`) carga una ROM propia
  desde el disco. **Pendiente del usuario:** el clon limpio con *solo* el README (el repo es privado y no hay release
  todavía; ver más abajo).
- [x] **La biblioteca cumple `API_CONTRACT.md`** (o desviación documentada). Clase `MelonDS` en `js/melonds.js`, 16
  pruebas de contrato (`tests/melonds-api.test.mjs`); desviaciones listadas en `tests/DEVIATIONS.md` (Promises,
  `NO_THREADS_BUILD`, `MIC_UNSUPPORTED`, `reset()` que recrea el worker, demo sobre `VideoPlayer`).
- [x] **Funciona sin BIOS/firmware de Nintendo.** Biblioteca NDS verificada sin ningún archivo (FreeBIOS + firmware
  integrado): Platino, SoulSilver y Negra arrancan y guardan (524 288 B Flash 512 KiB).
  - **Con firmware/BIOS reales** (dumps del usuario, JS): `node tests/phase7-browser.mjs` → **8/8** (los 3 dumps se
    descargan con tamaños válidos, arranque en 2,3 s con 51 fps y guardado; el camino por defecto no descarga nada).
  - **Pendiente del usuario:** la prueba clave partida nueva → guardar → cerrar → «Continuar» **sin firmware ni BIOS**
    en SoulSilver, Platino y Negra (`tests/MANUAL.md`). El firmware *generado* es del núcleo viejo de EmulatorJS; el
    port usa el integrado o dumps reales.
- [x] **Toda la biblioteca NDS jugable en la web app hoy.** **Las 4 ROM con el port WASM** cuando el tope de memoria es 2 GiB: `node tests/library-browser.mjs` → **NDS 4/4 + GBA 4/4, exit 0** (Negra 2, 512 MB: arranque ~7-10 s, ~40 fps de worker, guardado 524 288 B) con la **build canónica de 2 GiB recompilada el 2026-11-15** (Docker Desktop 4.74.0 + `emscripten/emsdk:6.0.13`), sin parches de artefactos. Con el build original de 1 GiB la ROM se rechaza con `ROM_TOO_LARGE` y la web app ofrece **fallback a EmulatorJS** (`library-fallback-browser` 9/9 y `fallback-emulatorjs-browser` 3/3: arranca en 23 s); ahora que la 512 MB arranca con el port, el primer test hace SKIP. La recompilación con 2 GiB (ya pedida en `build-host.sh`) hará canónico el tope.
- [x] **Compatibilidad de navegadores.** `node tests/cross-browser-smoke.mjs` → **Chromium, Firefox y WebKit** (el motor de Safari): demo (nmap.nds, sin SRAM) y **web app real** (`?engine=wasm`, Platino) con `crossOriginIsolated`, SharedArrayBuffer, WebGL2, canvas 256×384, fotogramas y **guardado de 524 288 B en la web app** (la demo usa nmap, que no tiene SRAM: `save=0`) y 0 pageerrors. FPS headless con GPU de software **orientativos y variables** (Chromium ~42-54, Firefox ~23-36, WebKit ~31-37). Firefox con AudioWorklet; el WebKit de Playwright no expone `AudioWorkletNode` (vídeo/entrada sí; Safari real lo tiene desde 14.1 [VERIFICAR]).
- [x] **Audio, entrada, guardado, estados, trucos, 17 layouts, velocidad y captura.** Pruebas unitarias (audio 22/22,
  input, layouts, saves, cheats: **20/20** contra el núcleo real con `nmap.nds` tras arreglar el bug de rutas de
  Windows) y de navegador (`phase11` 35/35, `phase12` 11/11, `library` NDS 4/4 + GBA 4/4 (build canónica 2 GiB)). Captura: `captureStream`
  probado en el multijugador (vídeo recibido por el invitado).
  - **Pendiente del usuario:** mando físico, táctil real y trucos dentro de un juego real.
  - **Pendiente de rebuild:** micrófono (`MIC_UNSUPPORTED`, decisión 3; requiere `RETRO_ENVIRONMENT_GET_MICROPHONE_INTERFACE`).
- [x] **Guardado en tres capas** (navegador/IndexedDB, archivo `.sav` en el PC y servidor de la web app) con elección
  explícita ante conflictos, copia de seguridad y token en las escrituras del servidor. La demo implementa la capa del
  PC con la **File System Access API** (`node tests/fsa-saves-browser.mjs` → **8/8**: vincular el `.sav`, usarlo como
  partida inicial, escribir con `createWritable`, preguntar si el guardado del navegador difiere, y aviso en navegadores
  sin la API); la web app implementa la capa de servidor (`PUT` con `.bak` y `rename` atómico).
- [x] **Control dinámico del audio (`audioDynamicRate`) medido con y sin él.** `tests/BENCH.md` §4: `always` 0
  underruns en 6 medidas de 1x vs `off` con 4 underruns en una de tres; unitarias deterministas 4/4 nuevas (22/22 en
  total). **Pendiente del usuario:** oír a 1x en su escena (si molesta, `setAudioDynamicRate("ff"|"off")`).
- [x] **Rendimiento: `tests/BENCH.md` con tabla y comparación con EmulatorJS.** Matriz 1x/1,5x/2x/sin límite × hilos 3D
  (20 s × 3, mediana), DRC, perfilado del bucle por tramos y 3 optimizaciones JS medidas (`BENCH.md` §3-7);
  comparación con los ~48 fps del núcleo viejo (dato del usuario). Los números son de esta máquina headless
  (Ryzen 5 3500U, SwiftShader) para comparar configuraciones; el usuario midió 59,8 fps con su GPU.
- [x] **Adaptador `?engine=wasm`, layout móvil jugable, pantalla de carga estilo WatermelonDS, HUD y multijugador WebRTC operativos.** `phase11` **35/35**
  (escritorio
  + móvil 390×844/844×390: pantalla y controles juntos, hoja de Menú, overlay de carga, HUD de velocidad/fps/audio y
  **pantalla completa con pad y barra superpuesta**), `phase12`
  11/11 (vídeo, START, toque y latencia de entrada de 7-14 ms (según la pasada)), `demo/host.html` 6/6 servida por el hub. Fallback a
  EmulatorJS para la ROM de 512 MB (9/9; con el tope 2 GiB el port la arranca y el test pasa a SKIP).
- [x] **Acceso remoto verificado de extremo a extremo (sin cuenta).** `node tests/remote-tunnel-browser.mjs` → **9/9** con un túnel rápido de Cloudflare y el hub con `ACCESS_KEY`: 403 sin clave / 200 con `?k=`/cookie, COOP/COEP conservados por HTTPS público, biblioteca y adaptador servidos, socket.io protegido y **Platino arrancando por el túnel en 19 s a 53,3 fps** (crossOriginIsolated, guardado 524 288 B, sin errores). El túnel es efímero y se cierra al terminar.
- [ ] **Despliegue estable en un servidor con las cabeceras de 5.1 (dos servidores).** El software está listo
  (`deploy/` con Cloudflare Tunnel con nombre, Tailscale, Caddy/Nginx/systemd; `coi-sw.js` para hostings sin
  cabeceras, con registro opt-in `?coi=1`; demos en `/nds/wasm/demo/`) y con el **acceso remoto verificado en
  software** (`node tests/hub-remote-smoke.mjs` → **11/11**: `ACCESS_KEY` protege páginas, APIs **y socket.io**,
  `HOST`/`PORT` escuchan y la lista blanca del port responde), pero **requiere una cuenta/servidor del usuario** para
  desplegar de verdad y comprobar `crossOriginIsolated` desde fuera de la LAN.
- [x] **Wasm recompilado con 2 GiB canónico (2026-11-15).** Docker Desktop 4.74.0 + `emscripten/emsdk:6.0.13`
  (`bash scripts/build-core.sh && bash scripts/build-host.sh`): `dist/melonds.wasm` = 2 456 726 B, memoria importada
  max 32768 páginas (2 GiB), `raise-memory-limit --check` = 0 **sin parche**. Verificado con la build nueva: biblioteca
  NDS 4/4 + GBA 4/4, `phase11` 35/35, suite 138/135/0/3, release regenerado (`release.test` 1/1) y `third-party` 9/9.
- [x] **Prueba de «tercero» del release (cerrada).** `node tests/third-party-release.mjs` → **9/9**: copia solo
  `release/melonds-wasm-1.0.0/` fuera del repo, la sirve con un servidor HTTP plano **sin COOP/COEP**, verifica que el
  `.wasm` llega como `application/wasm` con el SHA-256 del release, que sin `?coi=1` la demo avisa y que con `?coi=1`
  `coi-sw.js` aísla la página y la demo arranca y juega `nmap.nds` (más de 30 frames (31-32 según la pasada), WebGL2, 256×384, 0 pageerrors/404).
- [x] **Bundle de release preparado (solo falta subirlo).** `node scripts/release.mjs` → `release/` con el paquete completo
  (35 archivos / 2,69 MiB), ZIP de ~0,98 MiB (escritor propio, sin dependencias), `SHA256SUMS`,
  `release-1.0.0.json` (hashes de `dist/`, commit, tope de 2 GiB) y `RELEASE_NOTES.md`; `tests/release.test.mjs` 1/1.
  El tag `v1.0.0` y la subida al release de GitHub necesitan la cuenta del usuario.
- [x] **`scripts/check-clean.mjs` pasa; `LICENSE`, `THIRD_PARTY.md`, aviso legal y `CHANGELOG.md` presentes.**
  `check-clean`: **0 errores** (los avisos son rutas absolutas en comandos de prueba documentados; `--strict` las lista).
  `LICENSE` GPL-3.0 íntegro, `THIRD_PARTY.md` con la procedencia de todo lo binario, aviso legal en `README.md` y
  `CHANGELOG.md` (1.0.0 / 0.1.0). **Pendiente del usuario:** etiqueta `v1.0.0` y release de GitHub con `dist/`.
- [x] **Todas las pruebas automáticas en verde (o las omitidas justificadas).** `npm test` → **138 pruebas: 135 pasan,
  0 fallan, 3 omitidas**. El antiguo intermitente `audio-ring` (hilo real con 3 M de fotogramas) se estabilizó con
  `Atomics.wait` y la suite se repitió en verde. Las
  3 omitidas: `phase0` sin `dist/hello.*`, ROM de tono e libretro-database efímera. Navegador: phase7 8/8, phase11
  35/35, phase12 11/11, package 1/1, coi-sw 9/9, demo-host 6/6, **library NDS 4/4 + GBA 4/4 con la build canónica 2 GiB**
  (build canónica 2 GiB; con el build de 1 GiB, 3/4 + `ROM_TOO_LARGE` y fallback), fallback 9/9 (SKIP con 2 GiB),
  benchmark reproducible.
- [x] **`PROGRESO.md` actualizado** con lo que queda fuera de alcance y los límites conocidos (sin Wi-Fi emulado, DSi
  sin estados, micrófono y Fase 7-C++ opcionales (la build canónica de 2 GiB ya está recompilada), Safari real sin probar (el motor WebKit sí se probó)
  sin probar, sin TURN en el multijugador).

## Lo que queda (todo depende del usuario o de un rebuild)

1. **Recompilación canónica: HECHA el 2026-11-15** con Docker Desktop 4.74.0 + `emscripten/emsdk:6.0.13`; el wasm
   tiene 2 GiB y Negra 2 carga sin parche (biblioteca 4/4 y `phase11` repetidos). Quedan opcionales: `-O3`/LTO/SIMD,
   `dist/st`, Fase 7-C++ y micrófono.
2. **Pruebas manuales** de `tests/MANUAL.md`: guardado «Continuar» sin firmware en SoulSilver/Platino/Negra, mando y
   táctil reales, trucos reales, oír el DRC a 1x y el avance rápido a 1,5x/2x.
3. **Desplegar** (Cloudflare Tunnel con nombre, Tailscale o VPS) y probar desde el móvil/remoto.
4. **Publicar**: commit/push (cuando lo pida), tag `v1.0.0`, release con `dist/` y clon limpio de prueba.
5. Opcional: Fase 14 (WebGL2 nativo/DSi) y micrófono, ambos con aprobación/recompilación. El **informe de viabilidad
   de la Fase 14 ya está entregado** (`docs/PHASE14_WEBGL2_DSI.md`, 424 líneas): recomienda **aplazar** ambas partes
   (renderer WebGL2 nativo desde el worker: 6-12 semanas y el cuello es la CPU; DSi: NAND de 240 MiB + 5 archivos
   nativos, sin estados ni cámara, ya no bloqueado por la memoria de 2 GiB, que es canónica desde el 2026-11-15). No se implementa sin aprobación explícita.

## Evidencia rápida (comandos)

```powershell
cd "<repo>"
npm test                                  # 138: 135 pass / 0 fail / 3 skip (todo verde)
node scripts/check-clean.mjs              # 0 errores (los avisos son rutas de prueba; --strict las lista)
node scripts/raise-memory-limit.mjs --check  # tope actual (0 = 2 GiB listo; parchea con patch:memory)
node tests/library-browser.mjs            # NDS 4/4 + GBA 4/4 con la build canónica 2 GiB
node tests/library-fallback-browser.mjs   # 9/9
node tests/fallback-emulatorjs-browser.mjs # 3/3 (opcional: internet; Negra 2 con EmulatorJS)
node tests/fsa-saves-browser.mjs          # 8/8: capa .sav del PC (File System Access API)
node tests/hub-remote-smoke.mjs           # 11/11: ACCESS_KEY/HOST/PORT + socket.io + lista blanca
node tests/remote-tunnel-browser.mjs      # 9/9 opcional: extremo a extremo por HTTPS público (cloudflared + internet)
node tests/cross-browser-smoke.mjs        # Chromium + Firefox + WebKit: demo y web app con el port
node scripts/release.mjs                  # bundle listo para el release de GitHub (ZIP + SHA256SUMS + notas)
node tests/third-party-release.mjs         # 9/9: solo el release, servidor plano sin cabeceras, ?coi=1, ROM jugando
node tests/phase7-browser.mjs             # 8/8
node tests/phase11-browser.mjs            # 35/35 (escritorio + móvil retrato/apaisado)
node tests/phase12-browser.mjs            # 11/11 (latencia 7-14 ms)
node tests/coi-sw-browser.mjs             # 9/9 (con ?coi=1 y sin él)
node tests/demo-host-browser.mjs          # 6/6
node tests/package.test.mjs               # 1/1 (paquete 35 archivos / 2,69 MiB)
node tests/bench-browser.mjs --quick      # humo; matriz completa ~13 min
node tests/decimation-browser.mjs         # decimación: pausa/control (4 pasan; +1 skip con throttling térmico)
node scripts/package.mjs                  # package/ + manifest.json
```
