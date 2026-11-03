# Plan: port de melonDS a WebAssembly ("melonds-wasm")

Este documento es el plan maestro. Los prompts para DeepSeek están en `PROMPTS.md` y el contrato de API en
`API_CONTRACT.md`. Los archivos de `reference/` son extractos de la web app actual para dar contexto.

> Todo lo marcado **[VERIFICAR]** es una suposición que el implementador debe comprobar en el código real antes de
> apoyarse en ella. No se ha compilado nada de esto todavía.

---

## 1. Objetivo

Compilar **melonDS DS v1.4.0** (el núcleo libretro más reciente; ver sección 2) a WebAssembly con Emscripten y ejecutarlo
con un **anfitrión libretro mínimo propio**, envuelto en una pequeña biblioteca JavaScript, de forma que:

1. **Sea independiente.** Una carpeta `port melonds/` que se compila y se ejecuta sola, con su propia página de demostración
   (`demo/`), sin depender de EmulatorJS, de la web app ni de ningún servidor propio salvo uno estático con las
   cabeceras COOP/COEP.
2. **Sea compatible con la web app** de este proyecto (`<web-app>`, carpeta `nds/`): debe poder sustituir al núcleo
   actual de EmulatorJS cumpliendo `API_CONTRACT.md`, mediante un adaptador (`adapters/webapp-adapter.js`) y sin cambiar
   los demás archivos de la web app salvo un interruptor de motor.

## 2. Por qué se hace (contexto verificado)

- La web app usa hoy **EmulatorJS** con su núcleo `melonds`, que viene del repositorio `EmulatorJS/melonDS`
  (fork de `libretro/melonDS`, última actualización dic. 2024). Su base es **melonDS 0.9.2**.
- Ese núcleo, sin firmware, crea uno casi vacío (MAC `FF:FF:FF:FF:FF:FF`, sin calibración Wi-Fi). Los Pokémon de DS
  (Platino, HeartGold/SoulSilver, Negra/Blanca) dan "error de conexión" al cargar una partida guardada. Se resolvió en la
  web app generando un firmware válido en el navegador (`reference/firmware.js`, portado del generador de melonDS moderno).
- **Versión objetivo, verificada en GitHub:** **melonDS DS v1.4.0** (`JesseTG/melonds-ds`, publicada el 27-sep-2026,
  commit `f394adba`, licencia GPL-3.0). Es un **núcleo libretro** (no el emulador de escritorio) y es la última versión de ese
  proyecto. Ojo con los nombres:
  - `melonDS` (`melonDS-emu/melonDS`): emulador de escritorio, última versión publicada **1.1** (18-nov-2025); su rama
    principal tiene cambios posteriores (hasta oct-2026) sin publicar.
  - `melonDS DS` (`JesseTG/melonds-ds`): el núcleo libretro, **v1.4.0**. Compila un **fork** del motor
    (`github.com/JesseTG/melonDS`, rama `jtg/fix-uninitialized-opengl`, definida por rama móvil en su
    `cmake/FetchDependencies.cmake`; se fijará a un SHA concreto al compilar, ver §5) y descarga
    otras bibliotecas al configurar: libretro-common, glm, zlib, libslirp (red), pntr, fmt, yamc, span-lite y date.
  - Cambios de melonDS DS que importan aquí: firmware y BIOS libre por defecto, modo de consola "Auto", memoria accesible
    por dirección, ocho ranuras de layout de pantalla configurables (17 valores por ranura), caída a render por software si falla OpenGL, soporte de OpenGL ES 3.
- Ya existe un precedente: **DS Anywhere** (`brxxn/ds-anywhere`, GPL-3.0) compiló un melonDS de nov-2024 (era 1.0 RC)
  con una interfaz web propia. Su carpeta `wasmelonDS/src/frontend/wasm/` es la mejor referencia de cómo se hace el
  enlace (WasmEmulator, WasmEmuThread, WasmPlatform, WasmFirmwareSettings, WasmNdsCart). No está terminado.
- **Rendimiento medido en el equipo del autor** (Chrome, CPU de 8 hilos lógicos, GPU integrada AMD Vega 8, SoulSilver
  en una escena normal, núcleo de EmulatorJS con renderizador con hilos): normal 48 fps · sin vsync 52 · avance rápido
  máximo 51. Es decir, **el emulador ya está limitado por la CPU** y no llega a 60 fps. Por eso el objetivo de
  rendimiento es una prueba medible (apartado 9), no una promesa.

## 3. Alcance

**Entra:** núcleo DS (no DSi como objetivo inicial), render por software (con hilos si es posible), audio, entrada
(botones, pantalla táctil, micrófono opcional), guardado (SRAM/Flash/EEPROM), estados guardados, trucos Action Replay,
firmware generado + BIOS libre (FreeBIOS) + BIOS/firmware externos opcionales, velocidad variable, capturas,
`captureStream` para multijugador por WebRTC.

**No entra (al principio):** JIT (imposible en WASM), Wi-Fi real/red, cámara DSi, DSiWare, Slot-2 (GBA/rumble),
OpenGL de escritorio. El renderizador WebGL2 y DSi quedan como fases opcionales.

## 4. Arquitectura propuesta

```
port melonds/
├─ PLAN.md  API_CONTRACT.md  PROMPTS.md  README.md   (README lo escribe la Fase 0)
├─ reference/                 extractos de la web app (solo lectura)
├─ third_party/melonds-ds/    submódulo git de JesseTG/melonds-ds, fijado a la etiqueta v1.4.0 (commit f394adba)
├─ core/                      enlace C++ ("glue"): CMakeLists.txt, src/*.cpp, include/*.h
├─ js/                        biblioteca ES module: melonds.js (clase MelonDS) + worklet de audio
├─ adapters/
│   └─ webapp-adapter.js      expone la API que usa nds/index.html sobre MelonDS
├─ demo/                      página independiente (index.html, demo.js, servidor estático con COOP/COEP)
├─ tests/                     pruebas headless, DEVIATIONS.md, MANUAL.md, benchmark
├─ scripts/                   build.sh / build.ps1 (Docker con emsdk), serve.mjs
└─ dist/                      salida: melonds.wasm, melonds.js (ignorado en git salvo en releases)
```

Decisiones clave:

- **Motor:** **melonDS DS v1.4.0** como submódulo fijado a esa etiqueta, compilado a WebAssembly como **núcleo libretro**
  (biblioteca estática, sin Qt ni SDL).
- **Anfitrión:** un **anfitrión libretro mínimo propio** (`core/host/`, C++ y JS) que implementa solo lo que el núcleo necesita
  (`retro_run`, `retro_load_game`, callbacks de vídeo/audio/entrada, `environment`, opciones, memoria, serialización,
  trucos). **No** se usa RetroArch ni EmulatorJS, así que el port es independiente. La ventaja de libretro es que las
  funciones de la web app se corresponden casi 1:1 con su API (`retro_cheat_set`, `retro_get_memory_data`, `retro_serialize`).
- **Hilos:** el hilo principal del navegador **no** ejecuta la emulación. Un Web Worker ejecuta el bucle del emulador
  (`pthread`/`SharedArrayBuffer`); un segundo hilo opcional para el renderizador 3D por software
  (`ENABLE_THREADED_RENDERER` de melonDS). El hilo principal solo pinta y gestiona la entrada. En la variante sin hilos
  (`-st`) no hay worker ni `SharedArrayBuffer`: el bucle corre en el hilo principal con un temporizador de alta resolución,
  `getFrame()` se lee directamente y `getStats().threads` es `false`.
- **Vídeo (corregido tras `REVIEW.md`, verificado en `src/libretro/render/software.cpp`):** el núcleo **ya compone** las dos pantallas
  según el diseño elegido y entrega **un único fotograma** por `retro_video_refresh`, en formato **XRGB8888**, con el cursor
  dibujado si procede. Por tanto: el worker ejecuta `retro_run`; el callback de vídeo copia el fotograma compuesto a un buffer
  circular compartido; el hilo principal dibuja **una sola textura** con WebGL2 (conversión XRGB→RGBA en el shader, escalado y filtro
  opcional) o Canvas2D como alternativa. **No** hay compositor de pantallas en JS. El diseño se cambia con las opciones del núcleo
  (`melonds_screen_layout1` + `melonds_number_of_screen_layouts=1`) y el núcleo avisa del cambio de geometría
  (`SET_GEOMETRY`). El callback puede recibir `data == nullptr` (repite el fotograma anterior) y el `pitch` puede no ser
  `width * 4`: el glue respeta el `stride`. El canvas interno (backing store) se dimensiona al fotograma y el CSS lo escala,
  de modo que el lienzo coincide con el espacio del puntero; si se permiten barras, `touchFromCanvas` las descuenta.
  `captureStream()` debe hacerse sobre el canvas visible del hilo principal (no sobre un `OffscreenCanvas`
  transferido). Si algún día hicieran falta las dos pantallas por separado, habría que engancharse a `nds.GPU.GetFramebuffers`
  (API interna del motor, inestable entre versiones): queda como riesgo documentado, no como diseño base.
- **Táctil:** también lo resuelve el núcleo (`input/cursor.cpp` transforma el puntero con el diseño, el hueco y el modo híbrido y llama a
  `nds.TouchScreen`). El anfitrión solo debe responder a `RETRO_DEVICE_POINTER` con la posición normalizada
  (`-32767..32767`) y el estado de pulsación. `touchFromCanvas(nx, ny, state)` normaliza respecto al rectángulo dibujado del
  fotograma. No hay `touch(x, y)` en coordenadas DS: exigiría la inversa del mapeo de layout, que el núcleo no expone.
- **Audio:** AudioWorklet con un buffer circular alimentado por el worker (32 kHz nativo de DS, remuestreo).
  El reloj de audio sirve de metrónomo para el límite de velocidad.
- **Velocidad:** un único controlador de ritmo (frame pacing) en el worker: x1 sincronizado con el audio/refresco,
  xN con tope, "máx" sin tope. Sin depender de `requestAnimationFrame` (se frena en pestañas en segundo plano).
- **Firmware:** por defecto el que genera melonDS DS (fork del motor: `src/SPI_Firmware.cpp` para el firmware
  generado y `src/FreeBIOS.cpp`/`src/FreeBIOS_Data.h` para la BIOS libre; las opciones de idioma, usuario y cumpleaños
  están en `src/libretro/config/definitions/firmware.hpp`). Si el usuario aporta
  `firmware.bin`/`bios7`/`bios9`, se usan. **Nunca** se incluyen archivos de Nintendo en el repositorio.
- **Trucos (verificado en `src/libretro/core/core.cpp` y `core.hpp`):** `retro_cheat_set(index, enabled, code)` usa el motor de
  Action Replay y acepta palabras de 8 hex separadas por `+`, espacios, guiones o saltos de línea (mismo formato que la web app).
  Ojo: `index` es la **posición en un vector** (si `index < tamaño` reemplaza; si no, añade al final), no un id. El anfitrión
  mantiene un mapa `id → ranura` para cumplir el id estable del contrato. Además, **desactivar un código no revierte lo ya escrito
  en RAM** (lo advierte el propio núcleo): queda documentado como desviación en `tests/DEVIATIONS.md`.
- **Persistencia de guardado:** el glue expone los bytes de la SRAM/Flash y avisa cuando cambian; el almacenamiento
  (IndexedDB, servidor…) es responsabilidad de quien usa la biblioteca. `saveState()` usa el contenedor versionado de
  `API_CONTRACT.md` §6 (magic, versión, `coreAbi`, SRAM, estado de `retro_serialize` y CRC sobre ambos).

## 5. Compilación (puntos a resolver, **[VERIFICAR]** cada uno)

- Toolchain: `emsdk` en Docker (`emscripten/emsdk`) o WSL. La web app actual usa EmulatorJS con emsdk 3.1.74; para esto
  conviene una versión reciente (≥ 3.1.74; probar 4.x). C++17 es suficiente según el núcleo libretro 1.4.0; melonDS
  v1.4.0 usa C++17 según su CMake; los submódulos del motor pueden pedir más **[VERIFICAR]**.
- Opciones CMake reales de melonDS DS v1.4.0 (corregidas tras `REVIEW.md`; `HAVE_*` son variables que calcula
  `cmake/ConfigureFeatures.cmake`, no opciones): `ENABLE_JIT=OFF`, `ENABLE_THREADED_RENDERER=ON`, `ENABLE_NETWORKING=OFF` (libslirp),
  `ENABLE_OPENGL=OFF`, `ENABLE_COMPUTE_RENDERER=OFF`, `ENABLE_DYNAMIC=OFF` y `ENABLE_EGL=OFF` (candidatos), `TRACY_ENABLE=OFF`,
  `BUILD_AS_SHARED_LIBRARY=OFF`, `BUILD_TESTING=OFF`. Usa **C++17**. Necesita **Python** durante la configuración
  (`cmake/CreatePythonVenv.cmake` crea el entorno virtual y `cmake/FindPythonModules.cmake` busca los módulos; pueden romperse
  dentro de Docker) y **red** para `FetchContent`.
- **Fijar el fork del motor a un commit:** `cmake/FetchDependencies.cmake` línea 44 descarga `JesseTG/melonDS` por **rama móvil**
  (`jtg/fix-uninitialized-opengl`), no por hash. Hay que elegir un SHA concreto y pasarlo como `-DMELONDS_REPOSITORY_TAG=<sha>`,
  anotarlo en `tests/BUILD_REPORT.md` y, si se puede, cachear las dependencias (espejo propio o `URL_HASH`) para compilar sin red.
  El resto de dependencias (libretro-common, glm, zlib, libslirp, pntr, fmt, yamc, span-lite, date, tracy 0.14.1 opcional)
  sí van por etiqueta o hash.
- Banderas de compilación: `-O3 -flto -msimd128 -pthread -matomics -mbulk-memory`; enlace con `-sUSE_PTHREADS=1`,
  `-sPTHREAD_POOL_SIZE`, `-sALLOW_MEMORY_GROWTH=1` (cuidado: con pthreads crecer memoria es costoso), `-sEXPORT_ES6=1`,
  `-sMODULARIZE=1`, `-sENVIRONMENT=web,worker`, `-sEXPORTED_FUNCTIONS=…`, `-sASSERTIONS=0` en release.
  Evaluar `-sWASM_BIGINT`, `-sMALLOC=mimalloc` y `-sSTACK_SIZE`.
- Salida con **dos variantes**: con hilos (`melonds-mt`) y sin hilos (`melonds-st`) para navegadores sin
  `SharedArrayBuffer`/sin aislamiento de origen cruzado. La biblioteca JS elige sola.
- El servidor que sirva la demo debe enviar `Cross-Origin-Opener-Policy: same-origin` y
  `Cross-Origin-Embedder-Policy: require-corp` (la web app ya lo hace en `server.mjs`).

## 6. Fases (resumen; los prompts completos están en `PROMPTS.md`)

| Fase | Entregable | Criterio de aceptación |
|---|---|---|
| 0 | Estructura, README, scripts de Docker, submódulo melonDS | `scripts/build` genera un `hello.wasm` |
| 1 | `melondsds_libretro` compilado a WASM como biblioteca estática | enlaza sin errores; opciones CMake y dependencias fijadas |
| 2 | Anfitrión libretro mínimo + prueba headless en Node | arranca una ROM propia y avanza N fotogramas; hash del fotograma compuesto estable |
| 3 | Vídeo | demo muestra el fotograma compuesto por el núcleo; los diseños cambian por opciones del núcleo y la geometría se actualiza |
| 4 | Audio | sonido continuo sin chasquidos a 1x; silencio al pausar |
| 5 | Entrada y pantalla táctil | teclado, mando, ratón/táctil; el puntero se normaliza bien y el núcleo hace el resto |
| 6 | Guardado y estados | guardar en el juego, recargar, "Continuar" funciona **sin firmware externo** |
| 7 | Firmware/BIOS | el que resuelve el núcleo por defecto; externos opcionales; comparado con `reference/firmware.js` |
| 8 | Trucos (`retro_cheat_set`) | activar/desactivar en caliente; los 4 catálogos reales de la web app cargan |
| 9 | Rendimiento y ritmo | tabla de fps (apartado 9) y velocidades x1/x2/x3/máx reales |
| 10 | Biblioteca JS + demo independiente | `demo/` funciona con solo `npm run serve` |
| 11 | Adaptador para la web app | `nds/index.html?engine=wasm` funciona con la misma interfaz |
| 12 | Multijugador (captureStream) | un invitado ve y controla la partida por WebRTC |
| 13 | Paquete y licencias | `THIRD_PARTY.md`, GPL-3.0, sin archivos de Nintendo |
| 14 (opc.) | Renderizador WebGL2 y DSi | solo si las fases 0-13 cumplen |

## 7. Compatibilidad con la web app (resumen)

La web app (`nds/index.html`) hoy habla con `EJS_emulator.gameManager`. El adaptador debe ofrecer, sobre `MelonDS`,
exactamente las operaciones que la web usa (tabla en `API_CONTRACT.md`, sección 3): `setCheat(index, enabled, code)`,
`toggleFastForward`/`setFastForwardRatio`/`setVSync`, `getFrameNum`, `setVariable` (diseño y separación de pantallas),
`getSaveFile`/`loadSaveFiles`, `restart`, `setVolume`, `screenshot`, pausa/reanudar, entrada táctil simulada y
`canvas.captureStream()` para el multijugador. La web app solo necesita un interruptor `?engine=wasm` que cree el
adaptador en lugar de cargar EmulatorJS.

## 8. Pruebas

- **ROM de prueba:** el implementador usa sus propias ROM (el repositorio **no** contiene ninguna). Lista de comprobación en
  `tests/MANUAL.md`: Platino ES (`CPUS`), SoulSilver ES (`IPGS`), Negra ES (`IRBS`), Negra 2 ES (`IRES`).
- **Prueba clave de regresión:** nueva partida → guardar dentro del juego → recargar → Continuar. Con el núcleo antiguo y
  sin firmware falla con "error de conexión"; con el port debe funcionar **sin** archivos de Nintendo.
- **Pruebas automáticas:** Node (headless): carga, N fotogramas, hash del fotograma compuesto, guardado/carga de SRAM,
  estado guardado ida y vuelta, trucos que escriben en RAM conocida.
- **Matriz de navegadores:** Chrome y Firefox recientes (con y sin aislamiento de origen cruzado).

## 9. Benchmark (criterio de éxito del rendimiento)

Misma escena de SoulSilver en el mismo equipo, medido con `getStats()`:

| Configuración | fps medidos con EmulatorJS (línea base) | objetivo del port |
|---|---|---|
| normal (x1) | 48 | ≥ 60 estables |
| avance rápido máximo | 51 | claramente > línea base; documentar el techo |
| con renderizador 3D en hilo aparte | (ya incluido arriba) | ≥ línea base |

Si el port **no mejora** esa tabla, se documenta y el proyecto se queda como motor alternativo, sin sustituir al actual.

## 10. Riesgos

1. **WASM sin JIT:** el rendimiento puede ser igual de limitado. Mitigación: hilos, SIMD, `-O3/LTO`, menos copias de vídeo.
2. **Incompatibilidades de compilación** (alguna dependencia puede exigir C++20 **[VERIFICAR]**, dependencias descargadas por CMake, Python). Mitigación: fijar versiones, desactivar red y herramientas.
3. **Sin SharedArrayBuffer** en algunos entornos. Mitigación: variante `-st`.
4. **Latencia de audio** y desincronización en pestañas en segundo plano. Mitigación: AudioWorklet y ritmo propio.
5. **Mantenimiento:** hay que seguir las versiones de melonDS a mano.

### Plan B (si la Fase 1 o la 2 no avanzan)

Si melonDS DS v1.4.0 no compila con Emscripten tras un esfuerzo razonable (dependencias, Python en la configuración, fork del motor),
se cambia el motor a **melonDS 1.1 oficial** (`melonDS-emu/melonDS`, etiqueta `1.1`) y se escribe un enlace propio sin libretro,
como hizo DS Anywhere (`brxxn/ds-anywhere`, `wasmelonDS/src/frontend/wasm/`). El contrato de API (`API_CONTRACT.md`) no cambia:
solo cambia lo que hay detrás. Hay que reescribir a mano lo que libretro da hecho: carga de firmware y BIOS, guardado, estados,
trucos (`AREngine`), diseño de pantallas y remuestreo de audio. Criterio para decidir: documentar en `tests/BUILD_REPORT.md` qué
bloqueó la Fase 1 antes de cambiar.

## 10 bis. Decisiones tras las revisiones (`REVIEW.md` y `REVIEW-2.md`)

`REVIEW.md` y `REVIEW-2.md` (revisiones hechas por otro agente contra el código real de v1.4.0) se tomaron como correctas tras
comprobar por separado el vídeo compuesto (`software.cpp`), el índice de trucos por posición (`core.cpp`), el táctil en el
núcleo (`cursor.cpp`) y los nombres de las opciones CMake (`ConfigureFeatures.cmake`). Decisiones:

- **Git (H-6/R-7):** la carpeta se convierte en repositorio independiente (`git init` **antes** de añadir el submódulo) con
  `third_party/melonds-ds` como submódulo; el adaptador que vive en la web app puede obtener el tag con un script en vez de submódulo.
- **Ruta con espacio (H-10):** se mantiene `port melonds` por petición del autor; todos los scripts deben entrecomillar rutas.
- **Formato de píxel (H-8):** se mantiene XRGB8888 de extremo a extremo y la conversión a RGBA la hace el shader.
- **Diseños (H-9/R-3):** el contrato usa los 17 valores del núcleo y los traduce a sus claves internas (tabla 2.1 de
  `API_CONTRACT.md`); el adaptador traduce los valores de la web app.
- **`saveState` (H-7/R-8):** contenedor propio con `coreAbi`, `sramLen`, `stateLen` y CRC sobre SRAM + estado (ver
  `API_CONTRACT.md` §6).
- **Vídeo (R-1/R-12):** `getFrame()` incluye `stride`; `mds_get_framebuffer` se sustituye por `mds_get_frame`/`mds_copy_frame`;
  el callback maneja `data == nullptr` (fotograma duplicado).
- **Entrada (R-2/R-6):** se elimina `touch(x, y)`; solo queda `touchFromCanvas`, relativo al rectángulo dibujado del fotograma.
- **Canvas (R-5):** solo `HTMLCanvasElement`; `OffscreenCanvas` no se admite porque rompe `captureStream()`.
- **Híbrido (R-4):** `one`/`both`; el adaptador traduce `Duplicate → both` y `Top`/`Bottom → one`.
- **Variante sin hilos (R-14):** bucle en el hilo principal, sin `SharedArrayBuffer`; `getStats().threads === false`.
- **Firmware (R-9):** la generación está en `src/SPI_Firmware.cpp` y `FreeBIOS.cpp`; `firmware.hpp` solo define opciones.

## 11. Licencias y higiene del repositorio

- El resultado es **GPL-3.0** (melonDS lo es; `reference/firmware.js` también deriva del generador de melonDS).
- Incluir `THIRD_PARTY.md` con melonDS, FreeBIOS (parte de melonDS), Emscripten (MIT), y cualquier biblioteca usada.
- `.gitignore`: `dist/`, `third_party/` si es submódulo no incluido, `*.nds`, `*.gba`, `*.sav`, `*.bin`, `*.rom`, BIOS/firmware.
- Aviso: proyecto de aficionados sin relación con Nintendo, Game Freak ni The Pokémon Company. Solo para usar con copias
  legítimas del usuario.
