# Informe de la Fase 2: anfitrión libretro mínimo y API `mds_*`

Estado (2026-11-04): **host compila y enlaza; `dist/melonds.js` carga en Node; ROM homebrew real (CC0) ejecutada 300 fotogramas, con y sin hilos.**
Audio, entrada y guardado siguen como `TODO(fase N)` (no implementados). No se avanzó a la Fase 3.

## Versiones

| Elemento | Valor |
|---|---|
| Emscripten | 6.0.13 (`e13ee988ce3d87a738dd8f3661d02223308c412a`), emsdk commit `d7b4130`, sin Docker |
| Node / CMake | v22.23.4 / 3.28.3 |
| melonDS DS (submódulo) | `f394adbacb5722ee97c1b37c8064da9a25818310` (`v1.4.0`), motor `16f127db…`, 7 parches de `core/patches` (sin parches nuevos) |
| ROM de prueba | `nmap.nds` de `rmn20/normalmappingds` (commit `6fb2d425f505a546094576433a2ed24844ae7fb8`, licencia CC0-1.0), 266 240 bytes, SHA-256 `b21f588910e3b8fb471e223af62141e55a5a4c59eeaf80bd88b8ab3cb8b19132`. Descargada en la sesión a `tests/artifacts/nmap.nds` (ignorada por git); **no está en el repositorio** |

## Comandos exactos

```bash
git submodule update --init third_party/melonds-ds
source /home/user/emsdk/emsdk_env.sh          # emsdk 6.0.13 activado
bash scripts/build-core.sh                      # ~2 min, genera dist/libmelonDS.a (ahora con -fwasm-exceptions)
bash scripts/build-host.sh                      # genera dist/melonds.js + dist/melonds.wasm
node tests/phase2-smoke.mjs                     # sin ROM
node tests/headless.mjs tests/artifacts/nmap.nds 300 --threads=0
node tests/headless.mjs tests/artifacts/nmap.nds 300 --threads=1
```
Atajos: `bash scripts/build.sh host` y `bash scripts/build.sh host-test` (compila y lanza la prueba sin ROM).
`tests/headless.mjs` acepta además `--every=N`, `--png=salida.png` (último fotograma), `--verbose`, `--bios7= --bios9= --firmware=`.

## Resultados reales

**Compilación**: núcleo completo desde cero (`rm -rf build/melonds`) y anfitrión: correctos. `dist/libmelonDS.a` 1 868 702 B, `dist/melonds.wasm` 2 423 866 B, `dist/melonds.js` 82 811 B.
`node dist/phase1.js` (Fase 1) sigue imprimiendo `api_version=1 / melonDS DS / 1.4.0`.

**Carga y errores (`tests/phase2-smoke.mjs`, código 0)**: `mds_create` → 0; segundo `mds_create` → −1; `mds_load_rom` con 4 KiB de `0xAA` → −3 («ROM isn't valid, did you select the right file?»);
con 0 bytes → −3 («Loaded an empty file as content…»); después `mds_run_frame` no hace nada, `mds_get_frame` devuelve NULL y `mds_destroy` termina limpio. Sin cuelgue ni aborto.

**ROM homebrew (`nmap.nds`)**: se ve (PNG volcado con `--png`) la escena 3D de normal mapping y el texto de ayuda, en pantalla de 256x384, `stride=1024`, XRGB8888.

| Ejecución | Hash SHA-256 en los fotogramas 60,120,180,240,300 | fps (Node, 1 hilo JS + workers) |
|---|---|---|
| `--threads=0` run a / b | `a0d4f91c80973e4d619f7f8aab1cafe18607f06cc22c56f3b26d9ec9b62890bf` (los 5) | 48,8 / 52,9 (en otra tanda 53,7–66,6) |
| `--threads=1` run a / b | idéntico al anterior (los 5) | 61,7 / 58,6 (en otra tanda 58,6–63,2) |

- **Estable entre ejecuciones y entre modos de hilos: sí** (mismo hash en las 4 ejecuciones).
- **Hashes distintos: solo al arrancar.** Con `--every=1`, los fotogramas 1, 2, 3 dan `c97fce78…`, `3edb3e16…`, `37091d6d…` y desde el 4 en adelante `a0d4f91c…`.
  La demo es estática mientras no se pulsa nada (las luces solo se mueven con el pad, y la entrada es Fase 5), así que 300 fotogramas sin entrada **no pueden** dar hashes distintos entre sí. Es una limitación de esta ROM, no del anfitrión. No hallé otro homebrew animado con `.nds` precompilado (probé 8 repositorios libres; la mayoría solo trae código fuente).
- **fps**: ~50-65 fps en Node con esta ROM ligera (rango observado en 8 ejecuciones: 48,8–66,6); medidas ruidosas, no son un benchmark. Con la ROM tan estática, `threads=1` no es claramente más rápido.
- **Hilos del renderizador 3D en Node** (era [VERIFICAR] de la Fase 1): **sí arrancan**. Contando `PThread.pthreads` tras cargar y tras 300 fotogramas: `--threads=1` → 1 worker en marcha (3 libres en el pool de 4); `--threads=0` → 0 workers (4 libres).
  Solo se ha comprobado en Node (`worker_threads`), no en navegador (ahí hacen falta cabeceras COOP/COEP; [VERIFICAR]).
- `duplicated=0` (el núcleo nunca pasó `data == NULL`); el camino NULL está implementado pero no se ejercitó.

## Errores hallados y corregidos en el código «sin probar»

1. `retro_sleep` sin definir (enlace fallaba): definida en `host.cpp`.
2. Enlace incluía `_CMakeLTOTest*/libfoo.a` (restos del sondeo de LTO de CMake): excluidos en `build-host.sh`.
3. El núcleo abortaba el proceso con ROM inválida (excepciones desactivadas): `-fwasm-exceptions` en núcleo y enlace.
4. `storeDefaults` pisaba `mds_set_option` (la opción `--threads=0` no surtía efecto): ahora `emplace`.
5. `SET_INPUT_DESCRIPTORS` no manejado (aceptado); mensaje OSD «Layout 1/2» (uno por fotograma) ya solo con `verbose`.
6. Se eliminó la copia innecesaria de la ROM en MEMFS (mismo hash).
Ciclo de vida completo y reacción del núcleo a cada `RETRO_ENVIRONMENT_*`: ver `tests/PHASE2_NOTES.md`. Desviaciones: `tests/DEVIATIONS.md`.

## No verificado [VERIFICAR]

- Ejecución en navegador/Worker (Wasm EH, `SharedArrayBuffer`, COOP/COEP); solo Node 22.
- Flujo con Docker (`build.sh` con demonio Docker); no hay demonio en la nube.
- Tiempos con una ROM comercial/3D pesada; el modo `DSi`; arranque con BIOS/firmware reales (se usó FreeBIOS y firmware integrado; la ruta `--bios7/--bios9/--firmware` no se ejercitó).
- `video_refresh(NULL)`, nombres de guardado y que `info.path` inexistente no importe en guardados (Fase 5).
- Estabilidad del hash con una escena animada.

## Para la prueba con una ROM comercial en local

```bash
bash scripts/build-core.sh && bash scripts/build-host.sh        # o ya tener dist/ compilado
node tests/headless.mjs /ruta/juego.nds 600 --threads=1 --png=tests/artifacts/frame.png
node tests/headless.mjs /ruta/juego.nds 600 --threads=0          # comparar hashes entre modos
# opcional, con BIOS/firmware propios (nunca se suben): --bios7=bios7.bin --bios9=bios9.bin --firmware=firmware.bin
```
Comprobar: no hay `Aborted`, los hashes cambian entre fotogramas (juego animado), coinciden entre dos ejecuciones y entre `threads=0/1`, y `pthread workers` pasa de 0 a 1.
Con FreeBIOS un juego comercial puede arrancar con direct boot, pero algunos exigen BIOS/firmware originales. Los `.nds`, `.bin` y `.png` de `tests/artifacts/` están ignorados por git.
