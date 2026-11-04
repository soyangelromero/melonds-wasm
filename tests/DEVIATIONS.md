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
