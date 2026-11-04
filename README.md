# melonds-wasm

Port de **melonDS DS v1.4.0** (núcleo libretro) a WebAssembly con Emscripten, con un
anfitrión libretro mínimo propio y una biblioteca JavaScript sin dependencias en tiempo
de ejecución.

El plan maestro está en `PLAN.md`, el contrato de API en `API_CONTRACT.md` y los prompts
por fases en `PROMPTS.md`.

## Requisitos

- Docker (imagen fijada `emscripten/emsdk:6.0.13`).
- Node.js 22 o superior (solo para el servidor estático y las pruebas).
- Una ROM de Nintendo DS **propia**. Este repositorio no incluye ROM, BIOS ni firmware.

## Compilar

```bash
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

## Estructura

```
core/        glue C++ y anfitrión libretro mínimo
js/          biblioteca ES module (clase MelonDS)
adapters/    adaptador para la web app existente
demo/        demo independiente
tests/       pruebas, desviaciones del contrato y benchmark
scripts/     compilación en Docker y servidor estático
dist/        artefactos generados (ignorados por git)
third_party/ submódulo melonDS DS v1.4.0
```

## Demo de vídeo (Fase 3)

```bash
npm run serve            # http://127.0.0.1:8080/demo/index.html  (con COOP/COEP)
```
Elige un `.nds` propio con el selector (no se sube a ningún sitio): layouts, separación, filtro y escala. Requiere `dist/` compilado
(`bash scripts/build-core.sh && bash scripts/build-host.sh`) y un navegador con Wasm EH y `SharedArrayBuffer` (Chrome/Edge/Firefox recientes).
Pruebas en Chromium sin interfaz: `npm run test:browser` (ver `tests/PHASE3_REPORT.md`).

## Entrada (Fase 5)

En la demo: flechas = cruceta · `Z`=A · `X`=B · `A`=X · `S`=Y · `Q`=L · `E`=R · `Enter`=Start · `V`=Select; mando estándar (botón derecho=A, inferior=B, superior=X, izquierdo=Y, LB/RB, Back/Start, cruceta o palanca izquierda); ratón/táctil sobre la imagen = pantalla táctil, en cualquier layout.
Pruebas: `npm test` (unitarias, incluye `tests/touch.test.mjs` y `tests/input.test.mjs`) y `npm run test:input` (núcleo real en Node + Chromium sin interfaz). Ver `tests/PHASE5_REPORT.md`.

## Estado

Fases 0-3 hechas: el núcleo corre en Wasm, el fotograma compuesto se dibuja en un canvas. Sin audio, entrada ni guardado todavía.

## Licencia

GPL-3.0. melonDS y melonDS DS son GPL-3.0; consulta `THIRD_PARTY.md` cuando exista.
