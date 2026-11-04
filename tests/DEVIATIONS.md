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
