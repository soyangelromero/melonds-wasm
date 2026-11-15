# melonds-wasm

Port de **melonDS DS v1.4.0** (núcleo libretro) a WebAssembly con Emscripten, con un
anfitrión libretro mínimo propio y una biblioteca JavaScript sin dependencias en tiempo
de ejecución.

El plan maestro está en `PLAN.md`, el contrato de API en `API_CONTRACT.md` y los prompts
por fases en `PROMPTS.md`.

## Aviso legal

Proyecto de aficionados, **sin relación con Nintendo, Game Freak ni The Pokémon Company**. No incluye ni distribuye
ROM, BIOS, firmware ni ningún otro material con copyright de Nintendo: funciona únicamente con **copias legítimas**
que el usuario aporte desde su propio equipo (nunca se suben a ningún sitio). La licencia del código es GPL-3.0
(ver `LICENSE`); la procedencia de las dependencias enlazadas en el binario está en `THIRD_PARTY.md`.

## Cómo se hizo (transparencia sobre el uso de IA)

Este port se ha desarrollado **con ayuda de modelos de inteligencia artificial**: **Claude** (Anthropic) y **DeepSeek**.
Lo han escrito y revisado asistentes de IA bajo la dirección y las pruebas del autor (que es quien lo publica y se
responsabiliza del repositorio); el código no ha tenido una auditoría humana independiente. Sé crítico con él.

Qué es y qué no es, para que no haya malentendidos:

- **No es una descompilación.** El código de melonDS es abierto (GPL-3.0). Aquí se **recompila** a WebAssembly con Emscripten
  (núcleo libretro de melonDS DS v1.4.0, con 7 parches propios en `core/patches/`) y se le añade un anfitrión mínimo en C++
  y una biblioteca JavaScript escritos para este proyecto.
- **No contiene ni se ha obtenido de material de Nintendo**: ni ROM, ni BIOS, ni firmware. La BIOS y el firmware que usa por
  defecto son libres (FreeBIOS y un firmware generado en el navegador).
- El trabajo de emulación es de **melonDS y sus autores**; este repositorio solo lo lleva al navegador.
- Como todo código generado con ayuda de IA, puede tener errores o fallos sutiles: las pruebas automáticas
  (carpeta `tests/`) cubren lo medible, pero no sustituyen a probarlo con tus propios juegos.

## Requisitos

- Docker (imagen fijada `emscripten/emsdk:6.0.13`).
- Node.js 22 o superior (solo para el servidor estático y las pruebas).
- Una ROM de Nintendo DS **propia**. Este repositorio no incluye ROM, BIOS ni firmware.

## Compilar

```bash
# Clonar CON el submódulo. En Windows, sin convertir los finales de línea (si no, los parches no aplican):
git clone -c core.autocrlf=false --recurse-submodules https://github.com/soyangelromero/melonds-wasm.git
cd melonds-wasm

# Linux / macOS / Git Bash
./scripts/build.sh

# Windows PowerShell
./scripts/build.ps1
```

La salida va a `dist/`. La compilación se ejecuta dentro de Docker, de modo que no hace
falta instalar Emscripten en el equipo.

## Probar

```bash
npm test                 # pruebas de Node (servidor, artefactos, unidades)
npm run serve            # http://localhost:8080/demo/hello.html
```

El servidor envía `Cross-Origin-Opener-Policy: same-origin` y
`Cross-Origin-Embedder-Policy: require-corp`, necesarias para `SharedArrayBuffer` y para
la variante con hilos.

Si el hosting no puede enviar esas cabeceras (GitHub Pages, un `python -m http.server`, almacenamiento de objetos…),
copia también `coi-sw.js` a la raíz publicada y abre la demo con **`?coi=1`**: el service worker se registra una vez y
recarga hasta que la página queda aislada (`crossOriginIsolated === true`). Es opt-in para no alterar el aviso normal de
COOP/COEP. Necesita HTTPS o `localhost` (cualquier service worker). El paquete de `scripts/package.mjs` ya lo incluye.

## Versión, licencia e higiene

- `CHANGELOG.md` con el histórico; versión `1.0.0` en `package.json`.
- Licencia GPL-3.0 (`LICENSE`) y procedencia de todo lo enlazado en el `.wasm` (`THIRD_PARTY.md`).
- `node scripts/check-clean.mjs` falla si encuentra ROM/BIOS/firmware/partidas, credenciales o rutas del perfil del
  autor (`--strict` también falla con cualquier ruta absoluta de Windows). Lo ideal es ponerlo en CI/hook.
- Cómo se integró en la web app: `adapters/INTEGRATION.md`; checklist de aceptación con evidencia: `tests/FINAL_REPORT.md`.

## Estructura

```
core/        glue C++ y anfitrión libretro mínimo
js/          biblioteca ES module (clase MelonDS)
adapters/    adaptador para la web app existente
demo/        demo independiente (y demo/host.html del multijugador)
tests/       pruebas, desviaciones del contrato y benchmark
scripts/     compilación en Docker, servidor estático y check-clean
coi-sw.js    service worker opcional (COOP/COEP en hostings sin cabeceras)
dist/        artefactos generados (ignorados por git)
third_party/ submódulo melonDS DS v1.4.0
```

## Demo de vídeo (Fase 3)

```bash
npm run serve            # http://127.0.0.1:8080/demo/index.html  (con COOP/COEP)
```
Elige un `.nds` propio con el selector (no se sube a ningún sitio): layouts, separación, filtro y escala. Requiere `dist/` compilado
(`bash scripts/build-core.sh && bash scripts/build-host.sh`) y un navegador con Wasm EH y `SharedArrayBuffer` (Chrome/Edge/Firefox recientes).
Pruebas en Chromium sin interfaz: `npm run test:browser` (vídeo) (ver `tests/PHASE3_REPORT.md`).

## Audio (Fase 4)

Misma demo (`npm run serve` → `http://127.0.0.1:8080/demo/index.html`): elige la ROM con un clic (ese gesto activa el audio), y usa
volumen, silencio y el indicador de búfer/underruns/overruns. A 1x el reloj de audio marca el ritmo del emulador; a 2x o sin límite se silencia.
Pruebas: `npm test` (unitarias, incluye el anillo con hilo real y el remuestreo), `node tests/phase4-core-audio.mjs` (núcleo en Node),
`node tests/phase4-browser.mjs --minutes=3` (Chromium sin interfaz). ROM de prueba propia (CC0, sin contenido de Nintendo):
`python3 tests/homebrew/audio-tone/mkrom.py tests/artifacts/audio-tone.nds` (necesita `gcc-arm-none-eabi`). Detalles en `tests/PHASE4_REPORT.md`.

## Entrada (Fase 5)

En la demo: flechas = cruceta · `Z`=A · `X`=B · `A`=X · `S`=Y · `Q`=L · `E`=R · `Enter`=Start · `V`=Select; mando estándar (botón derecho=A, inferior=B, superior=X, izquierdo=Y, LB/RB, Back/Start, cruceta o palanca izquierda); ratón/táctil sobre la imagen = pantalla táctil, en cualquier layout.
Pruebas: `npm test` (unitarias, incluye `tests/touch.test.mjs` y `tests/input.test.mjs`) y `npm run test:input` (núcleo real en Node + Chromium sin interfaz). Ver `tests/PHASE5_REPORT.md`.

## Guardado y estados (Fase 6) y trucos (Fase 8)

La misma demo (`demo/index.html`) tiene los paneles **Guardado y estados** (descargar/reemplazar `.sav`, estado rápido, descargar/cargar
estado, y autoguardado en IndexedDB: al reabrir la misma ROM arranca con «Continuar» desde ese guardado) y **Trucos (Action Replay)**
(id, código de palabras hexadecimales de 8 dígitos, activar/desactivar/quitar). `demo/saves.html` es la demo independiente de la Fase 6
(la usa `npm run test:saves-browser`). API: `player.saves.{getSave,getSaveNow,loadSave,onSave,flush,saveState,loadState}` y
`player.{setCheat,clearCheats}`. Pruebas: `npm run test:saves`, `npm run test:saves-browser`, `npm run test:cheats`; informes
`tests/PHASE6_REPORT.md` y `tests/PHASE8_REPORT.md`.

## Integración (ramas de las Fases 4, 5, 6 y 8 unidas)

`npm run test:integration` (Chromium sin interfaz, ROM propia `tests/artifacts/integration.nds`, que se genera con
`npm run build:integration-rom` y necesita `gcc-arm-none-eabi`): en una sola sesión de la demo carga la ROM, mide el audio en el worklet,
pulsa una tecla, toca la pantalla inferior, activa trucos y lee la RAM, obtiene y recarga un guardado y un estado, comprueba «Continuar»
y que no haya errores de consola. Informe: `tests/INTEGRATION_REPORT.md`.

## Estado

Fases 0-6, 7 (lado JS), 8, 9, 10, 11, 12 y 13 hechas e integradas en `feat/integration` (**sin commit**: el usuario
prueba antes): el núcleo corre en Wasm, el fotograma compuesto se dibuja en un canvas, el audio suena sincronizado
(con control dinámico de velocidad a 1x por defecto), hay teclado/mando/táctil, guardado (`.sav`) y estados, trucos
Action Replay, una **API pública `MelonDS`** conforme a `API_CONTRACT.md`, un **adaptador** que hace que la web app
(`<web-app>`, `?engine=wasm`) use este motor, **multijugador** WebRTC de anfitrión y paquete estático GPL-3.0.

Biblioteca verificada en Chromium (`node tests/library-browser.mjs`): **NDS 4/4 + GBA 4/4**, con **exit 0**. Negra 2
(512 MB) arranca en ~7-10 s a ~40 fps de worker con la **build canónica de 2 GiB recompilada el 2026-11-15**
(Docker Desktop 4.74.0 + `emscripten/emsdk:6.0.13`; sin parches de artefactos). `scripts/build-host.sh` pide
`-sMAXIMUM_MEMORY=2147483648` y ya se ejecutó; `scripts/raise-memory-limit.mjs` queda solo como workaround para builds
antiguas de 1 GiB. Con una build de 1 GiB el worker rechaza Negra 2 con `ROM_TOO_LARGE` y la web app ofrece fallback.

Hecho (2026-11-15): wasm recompilado con 2 GiB canónico y Negra 2 verificada. Pendientes/opcionales: Fase 7 en C++
(BIOS/firmware externos y micrófono: hoy el firmware por defecto ya funciona sin archivos de Nintendo), `retro_reset`
barato, mejoras `-O3`/LTO/SIMD y `dist/st`; perfilado fino de la Fase 9 (por tramos, sin recompilar; plan en
`tests/PHASE9_REPORT.md` §7); Fase 14 (WebGL2 nativo/DSi:
**informe de viabilidad hecho y sin implementar**, pendiente de aprobación del usuario, en
[`docs/PHASE14_WEBGL2_DSI.md`](docs/PHASE14_WEBGL2_DSI.md)).

## API pública (Fase 10)

```js
import { MelonDS } from "./js/melonds.js";

const ds = await MelonDS.create({ canvas, threads: "auto" });
await ds.loadRom(romBytes, { save: savBytes });   // -> {title, code, size, saveType}
ds.start();                                        // el audio se desbloquea con el primer gesto
ds.setLayout("Top/Bottom");
ds.setCheat(1, true, "94000130+FFFB0000+62101F2C+00000000+…");
const save = await ds.getSaveNow();                // bytes .sav
```

`MelonDS` cumple la tabla de `API_CONTRACT.md` (métodos asíncronos donde el worker obliga; ver `tests/DEVIATIONS.md`).
Pruebas: `node --test tests/melonds-api.test.mjs`.

## Adaptador para la web app (Fase 11)

`adapters/webapp-adapter.js` presenta el motor con la forma de `EJS_emulator`/`gameManager`, para que `nds/index.html`
funcione sin reescribirse. La web app lo sirve en `/nds/wasm/` y se activa con `?engine=wasm` (o con el botón
«melonDS WASM» de la biblioteca). Traduce layouts, separación, híbrida, avance rápido, trucos, guardado, estados y
`setPostProcess`. Incluye el ajuste de escala automático (entera si da ≥2x; si no, relleno suave).

Prueba de navegador (necesita el hub y una ROM en la biblioteca): `npm run test:webapp`.

## Multijugador (Fase 12)

`adapters/netplay-host.js` es el anfitrión WebRTC: crea la sala en el servidor de señalización (socket.io), manda la
oferta con `captureStream()` y recibe las entradas del invitado por el canal `inputs`. Los invitados entran por
`nds/join.html` sin cambiar nada; el vídeo les llega por WebRTC y los toques por el socket.
`createNetplayHost` acepta `io` y `RTCPeerConnection` inyectables, así que se prueba en Node (`tests/netplay-host.test.mjs`).
Prueba en navegador con dos pestañas: `npm run test:netplay`.

## Rendimiento y ritmo (Fase 9)

`audioDynamicRate: "always"` es el defecto: si la CPU no sostiene 59,83 fps, el audio se ralentiza hasta un 20 % en vez
de cortarse (suelo 0,5 en avance rápido); con la CPU a tiempo el factor es 1 y no cambia nada. Se cambia en caliente con
`MelonDS#setAudioDynamicRate("ff"|"off")` o `VideoPlayer#setAudioDynamicRate(...)`. Los hilos 3D se mantienen activados
(41,6 vs 32,8 fps en 3D real con `nmap.nds`; determinismo del fotograma 300 intacto).

Medidas y cómo repetirlas: `tests/BENCH.md` (matriz 1x/1,5x/2x/sin límite × hilos 3D, SoulSilver, mediana de 3×20 s) y
`tests/PHASE9_REPORT.md`. Arnés automático: `node tests/bench-browser.mjs` (~13 min; `--quick` para un humo, o
`SPEEDS=1,2 THREADS=1 SECS=10 REPS=1`). Banco manual: `tests/bench.html` (servido con `scripts/serve.mjs`).

## Guardado en el PC (File System Access API)

La demo incluye la tercera capa de guardado de la decisión 0.0 #2: un `.sav` **en el PC del usuario** desde el navegador
(Chrome/Edge; en Firefox/Safari se explica y se usan «Descargar .sav»/«Reemplazar .sav»). «Vincular .sav del PC» elige un
archivo y lo usa como partida inicial al cargar la ROM; «Guardar ahora en el .sav del PC» y la casilla de autoguardado
escriben el `.sav` en ese archivo con `createWritable` (escritura atómica por parte del navegador). Si el guardado del
navegador y el del PC difieren, se pregunta cuál usar; nunca se pisa nada en silencio. Prueba con dobles de la API:
`node tests/fsa-saves-browser.mjs` (8/8). En la web app la tercera capa es el servidor (`PUT /nds/api/sav/:id`, con
`.bak` y `rename` atómico).

## ROMs de 512 MB: cap de memoria

La **build canónica actual se recompiló el 2026-11-15** con Docker Desktop 4.74.0 y `emscripten/emsdk:6.0.13`:
`dist/melonds.wasm` tiene `-sMAXIMUM_MEMORY=2147483648` (2 GiB) y Negra 2 (512 MB) carga sin parches (melonDS mantiene ~3
copias del ROM en el heap y necesita ~1,6-1,7 GiB). `node scripts/raise-memory-limit.mjs --check` sale **0 sin aplicar
nada**. Para builds antiguas de 1 GiB queda el workaround de artefactos (`node scripts/raise-memory-limit.mjs`, reversible
con `--restore`), ya innecesario con la build actual; la vía canónica es recompilar con `scripts/build-host.sh`.

## Paquete estático (Fase 13)

```bash
node scripts/package.mjs        # -> package/ (o --out <dir>)
ROOT=package PORT=8090 node scripts/serve.mjs
```

`package/` contiene solo lo que necesita el navegador: `dist/melonds.js` + `.wasm`, `js/`, `adapters/`, `demo/`,
`index.html`, `LICENSE`, `THIRD_PARTY.md`, `README.md` y un `manifest.json` con tamaños. No incluye pruebas ni
`third_party/` (miles de archivos). Falla a propósito si `dist/` no está compilado.

## Licencia

GPL-3.0: ver `LICENSE`. El motor (melonDS y melonDS DS) es GPL-3.0, así que al distribuir el `.wasm` hay que poder
obtener el código correspondiente. Procedencia y licencias de todo lo enlazado: `THIRD_PARTY.md`.
Este repositorio **no** contiene ROM, BIOS ni firmware de Nintendo: FreeBIOS y el firmware generado por melonDS los
sustituyen, y las ROM de prueba son homebrew CC0.
