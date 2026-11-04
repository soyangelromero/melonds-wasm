# Desviaciones del contrato

Aquí se anota toda diferencia entre `API_CONTRACT.md` y la implementación real, con la
razón y el impacto. No se cambia el contrato en silencio.

| Fecha | Contrato | Implementación | Razón | Impacto |
|---|---|---|---|---|
| — | — | — | Pendiente de la Fase 0 | — |

## Fase 1: decisiones y desviaciones del plan de compilación

| Fecha | Plan / instrucción | Realidad | Razón | Impacto |
|---|---|---|---|---|
| 2026-11-04 | Compilar con la imagen Docker `emscripten/emsdk:6.0.13` | Se usó un emsdk 6.0.13 instalado con `git clone` de emsdk (commit `d7b4130`), sin Docker | El entorno de la nube no tiene demonio Docker | Misma versión de Emscripten (6.0.13); `scripts/build.sh` usa `emcmake` directamente si no hay `docker` y hay emsdk activo (`USE_DOCKER=1` fuerza Docker). El flujo Docker no se ejecutó |
| 2026-11-04 | `ENABLE_NETWORKING=OFF` debería bastar para quitar la red | En v1.4.0 el núcleo no compila así: `net.cpp` y `core.hpp` usan `melonDS::Net`/`Net_Slirp`/`AdapterData` incondicionalmente | Código upstream asume red activada | Parches 0003, 0005, 0006 y 0007: la red (libslirp, pcap) queda desactivada, pero se compilan `Net.cpp`, `LocalMP.cpp` y `PacketDispatcher.cpp`, que no dependen de libslirp. Wi-Fi no disponible; el modo `Indirect` registra un aviso y queda sin controlador |
| 2026-11-04 | Parche 0002 «sin probar» | Probado: elimina el conflicto de `mmap`; no hizo falta tocar `libretro-common` | — | Ninguno |
| 2026-11-04 | Compilar con libc++ de Emscripten | Dos incompatibilidades con libc++ (iteradores envueltos) | El código upstream asume iteradores que son punteros (libstdc++) | Parche 0004 y parte del 0005; sin cambio de comportamiento |
| 2026-11-04 | `node dist/phase1.js` debe imprimir los datos | Con `MODULARIZE=1`/`EXPORT_ES6=1` el archivo solo exporta una función | Criterio de aceptación de la Fase 1 | `--extern-post-js core/test/phase1_autorun.js` ejecuta `main` solo al lanzarlo directamente con Node; `tests/run-phase1.mjs` sigue funcionando |
| 2026-11-04 | Probar emsdk 4.x o 3.1.74 si 6.0.13 fallaba | No fue necesario | 6.0.13 compila con parches pequeños | Ninguno |

## Fase 2: anfitrión libretro y API `mds_*`

| Fecha | Plan / instrucción | Realidad | Razón | Impacto |
|---|---|---|---|---|
| 2026-11-04 | El núcleo compilado en la Fase 1 sirve tal cual | Hay que compilarlo con `-fwasm-exceptions` (`scripts/build-core.sh`, y `scripts/build-host.sh` al enlazar) | `LoadGame` lanza y captura excepciones C++ para ROMs inválidas; con Emscripten sin excepciones el `throw` abortaba el proceso | `dist/libmelonDS.a` de la Fase 1 deja de valer; hay que recompilar. Requiere Wasm EH (Node ≥ 22 y navegadores actuales; fuera de `node` no probado) [VERIFICAR en navegador] |
| 2026-11-04 | El anfitrión solo exporta lo del contrato | Exporta además `retro_sleep` (interna, no exportada a JS) y `PThread` como método de ejecución | `retro_sleep` es obligatoria en Emscripten (`retro_timers.h`: «defined in frontend»); `PThread` solo sirve a `tests/headless.mjs` para contar workers | `PThread` es de diagnóstico; puede quitarse del enlace final de producción |
| 2026-11-04 | `mds_load_rom(rom,len,save,savelen)` | `save` se ignora (`TODO(fase 5)`); no se escribe copia de la ROM en MEMFS, solo se pasa `info.data` | El núcleo es `need_fullpath=false`; mismo hash con y sin copia | Pendiente [VERIFICAR] en Fase 5 si el nombre de guardado exige que el archivo exista |
| 2026-11-04 | `scripts/build.sh host` sin Docker | La detección de «sin Docker» usa `docker info` en vez de `command -v docker` | En esta nube existe el binario `docker` pero no el demonio | `build.sh core/core-test/host/host-test` usan emsdk local si Docker no responde; objetivos `host`/`host-test` añadidos también a `build.ps1` |
| 2026-11-04 | `API_CONTRACT.md` §8: `mds_create(threads)` | `mds_create(verbose)`; los hilos se eligen con `mds_set_option("melonds_threaded_renderer","enabled"\|"disabled")` antes de `mds_load_rom` | Es la opción real del núcleo (`config/constants.hpp:184`) | El contrato debe actualizarse en la Fase 3 (no se cambia aquí) |
| 2026-11-04 | Funciones del contrato §8 | Faltan `mds_set_firmware`, `mds_set_bios` (hay `mds_write_system_file`), `mds_copy_frame`, `mds_get_audio`, `mds_set_key_mask`, `mds_set_pointer`, `mds_get_save`/`set_save`, estados, trucos y `mds_get_stats` | Fuera del alcance de la Fase 2 (audio, entrada y guardado = `TODO(fase N)`) | Sin impacto hasta esas fases |

## Compilación local en Windows con Docker (prueba con ROM comercial)

| Fecha | Plan / instrucción | Realidad | Razón | Impacto |
|---|---|---|---|---|
| 2026-11-04 | `build-core.sh` aplica los parches y sigue | En Docker sobre Windows los parches no se aplicaban y la compilación fallaba en `mmap` sin explicar por qué | Git dentro del contenedor rechaza la carpeta montada (propietario distinto) y el script ocultaba el error con `2>/dev/null` | El script usa ahora `git -c safe.directory='*'` y falla con un mensaje claro si un parche ni se aplica ni estaba ya aplicado |
| 2026-11-04 | Los parches encajan en el submódulo | En Windows con `core.autocrlf=true` el submódulo queda con CRLF y los parches (LF) no encajan | Conversión de saltos de línea al hacer checkout | Solución local: `git -C third_party/melonds-ds config core.autocrlf false && git -C third_party/melonds-ds rm --cached -r -q . && git -C third_party/melonds-ds reset --hard`. El mensaje de error del script lo indica |
| 2026-11-04 | `scripts/build.sh host` compila el anfitrión con Docker | El objetivo `host` solo existe en la rama sin Docker; con Docker se compiló con `docker run … bash -lc "bash scripts/build-core.sh && bash scripts/build-host.sh"` | Los objetivos `host`/`host-test` no se añadieron al bloque de Docker | Pendiente de añadir al bloque de Docker de `build.sh` y `build.ps1` |

Prueba con ROM comercial (Pokémon Plata SoulSilver, española, sin subirla): 600 fotogramas con `--threads=1` y `--threads=0`, sin `Aborted`;
hashes de los fotogramas 120/240/360/480/600 idénticos entre ambos modos y distintos entre sí salvo 480 y 600 (pantalla estática);
1 worker con hilos y 0 sin ellos; 109 fps (hilos) y 124 fps (sin hilos) sin límite de velocidad, sin audio ni entrada. Escena de la intro, no es un benchmark.

## Fase 3: vídeo

| Fecha | Plan / instrucción | Realidad | Razón | Impacto |
|---|---|---|---|---|
| 2026-11-04 | `API_CONTRACT.md` §8 `mds_create(threads)` | `mds_create(verbose)` + opción `melonds_threaded_renderer` | Fase 2 (ya anotado): es la opción real del núcleo | **Contrato actualizado en la Fase 3** (§8) |
| 2026-11-04 | SET_ROTATION era un no-op (aceptado sin hacer nada) | Se guarda y se **aplica en el renderizador**; `getFrame()` gana el campo `rotation` | `screenlayout.cpp:317`: con Rotated Left/Right y Upside Down el núcleo entrega la imagen Top/Bottom sin girar y espera que el anfitrión la gire (y gira él el puntero si devolvemos true). Si se aceptaba sin girar, se veía mal y el táctil habría quedado girado | Contrato actualizado (`getFrame.rotation`). El canvas tiene el tamaño del fotograma **rotado**; Fase 5: el puntero va en el espacio del canvas |
| 2026-11-04 | `getFrame()` devuelve el fotograma que se está dibujando | `VideoPlayer.getFrame()` devuelve una **copia** del último fotograma dibujado en el hilo principal, no se llama a wasm | El wasm vive en el worker; el hilo principal solo ve el buffer circular | Sin impacto; `mds_get_frame`/`mds_copy_frame` existen para el worker |
| 2026-11-04 | `setPostProcess(...): void` | La implementación del renderizador devuelve `{ok, error}` | Un GLSL inválido no debe fallar en silencio | Contrato actualizado (nota); la clase `MelonDS` final (Fase 10) puede lanzar `Error` en su lugar |
| 2026-11-04 | «Suavizado opcional» en el shader | Suavizado = `image-rendering` CSS (`auto` vs `pixelated`) | El backing store es del tamaño del fotograma (requisito de coordenadas del puntero), así que el escalado lo hace el compositor del navegador; el filtro `scanlines` actúa a resolución nativa (1 de cada 2 filas) | Los filtros no pueden ser de mayor resolución que el fotograma. Para CRT «bonito» haría falta un canvas mayor y recalcular el puntero (no hecho) |
| 2026-11-04 | WebGL con `SharedArrayBuffer` directo | `texImage2D` rechaza vistas sobre SAB, así que cada fotograma pasa por una copia a un `Uint8Array` normal antes de subirlo | Restricción de la especificación WebGL | 1 copia extra de ≤2,3 MB por fotograma (a 256x384: 393 KB) |
| 2026-11-04 | `npm test` = `node --test tests/` | `node --test tests/*.test.mjs` | En Node 22 el argumento de directorio falla (`Cannot find module .../tests`); roto desde antes de la Fase 3 | `tests/phase0.test.mjs` sigue fallando (espera `dist/hello.*`, solo se genera con el build de la Fase 0) |
| 2026-11-04 | La demo funciona sin aislamiento de origen cruzado | Sin COOP/COEP la demo muestra un error claro y no arranca | `dist/melonds.wasm` se compila con `-pthread` (memoria compartida); sin `SharedArrayBuffer` no instancia. La variante `-st` es Fase 10 | Hay que servir con `npm run serve` |

## Fase 6: guardado y estados

| Fecha | Plan / instrucción | Realidad | Razón | Impacto |
|---|---|---|---|---|
| 2026-11-04 | `getSave(): Uint8Array \| null` síncrono | `SaveClient.getSave()` es síncrono pero devuelve la **última copia en caché** (hasta ≈170 ms de retraso mientras el juego corre); `getSaveNow()` es asíncrono y exacto | El wasm vive en el worker; el hilo principal no puede leer su memoria de forma síncrona | La clase final (Fase 10) puede mantener el síncrono (caché) y ofrecer `getSaveNow()` para «guardar y cerrar» |
| 2026-11-04 | `saveState(): Uint8Array`, `loadState(data): void` síncronos | `Promise<Uint8Array>` y `Promise<void>` | Misma razón (un viaje al worker; ≈18 MiB por estado, transferidos sin copiar) | El contrato debe pasar a `Promise` en estos dos y en `loadSave` (devuelve `{resized}`) |
| 2026-11-04 | `onSave` con `debounceMs` en JS | El worker **detecta** el cambio (compara la SRAM cada 10 fotogramas con `mds_poll_save`) y el hilo principal hace el «debounce» (500 ms por defecto) | Un temporizador en el hilo principal sigue funcionando en pausa; el worker solo emite un aviso `saveChanged` | `flush()` entrega ya el pendiente (llamar al ocultar/cerrar la página) |
| 2026-11-04 | `mds_load_rom` ignora el guardado (`TODO fase 5-6`) | Aplica `save` en el búfer intermedio de SRAM del núcleo **antes del primer fotograma**; estado en `mds_get_save_status()` (0 ok, 1 otra longitud: se rellena con 0xFF o se trunca como `CartRetail`, 2 el juego no tiene memoria de guardado) | Es la vía de `retro_get_memory_data(RETRO_MEMORY_SAVE_RAM)` que usa el núcleo (`core/core.cpp: InstallNdsSram`) | `mds_load_rom` sigue devolviendo 0 aunque el `.sav` tenga otra longitud; el aviso va por `saveStatus` en el mensaje `loaded` |
| 2026-11-04 | Un cartucho nuevo arranca con la SRAM que dé el núcleo | El anfitrión rellena el búfer con **0xFF** cuando no hay `.sav` | El búfer intermedio del núcleo nace a ceros y se instala tal cual en el cartucho; melonDS de escritorio y los chips reales parten de 0xFF | `getSave()` de una partida nueva es todo 0xFF (como en escritorio) |
| 2026-11-04 | `loadSave` «equivale a loadSaveFiles + restart» | `mds_set_save` hace `retro_reset()` y **después** escribe el búfer | `CoreState::Reset` copia la memoria viva del cartucho de vuelta al búfer; escribir antes se perdía | Reinicia la consola (como pide el contrato) |
| 2026-11-04 | `coreAbi` = CRC32 de un identificador de la compilación | CRC32 del texto fijo `"melonds-ds f394adba;melonDS 16f127db;state-layout 1"` (`core/host/saves.cpp`) | No hay un identificador automático que cambie con cada compilación; así es estable y reproducible | **Hay que subir el sufijo `state-layout` a mano** si un parche cambia el formato de `DoSavestate` o si se mueven los pines del núcleo/motor. No detecta un cambio de ROM |
| 2026-11-04 | Errores `STATE_VERSION`, `STATE_INCOMPATIBLE`, `STATE_CORRUPT` | Además: `STATE_UNSUPPORTED` (modo DSi: `retro_serialize_size() == 0`), `NO_ROM`, `NO_SAVE_MEMORY` (`setSave` en un juego sin SRAM). Un estado válido pero de otro juego (longitudes que no cuadran) = `STATE_INCOMPATIBLE` | Casos reales del núcleo (`core/core.cpp`) | El contrato nombra solo tres; los demás son adicionales |
| 2026-11-04 | `build-host.sh` solo compila `host.cpp` | Compila también `core/host/saves.cpp` (una palabra más en la orden `em++`); las funciones `mds_*` nuevas se exportan con `EMSCRIPTEN_KEEPALIVE`, **sin tocar la lista `EXPORTS`** | Evita conflictos con las otras fases | Al unir ramas basta con conservar ambos cambios |
| 2026-11-04 | `nmap.nds` (CC0) como ROM de prueba de la Fase 6 | No se pudo descargar en esta sesión (el proxy de la nube bloquea `rmn20/normalmappingds`; el acceso se denegó); las pruebas usan un **cartucho sintético propio** (`tests/lib/synth-rom.mjs`, código ARM original en `tests/synth/synthrom.s`) y `MDS_ROM=` activa la prueba opcional con `nmap.nds` | Sin ROM de Nintendo en la nube; el homebrew no usa SRAM de todos modos | El cartucho sintético escribe en la EEPROM por el bus SPI del cartucho, así que prueba la ruta real juego → SRAM → `getSave`. No sustituye a las ROM comerciales (ver `tests/PHASE6_REPORT.md`) |
