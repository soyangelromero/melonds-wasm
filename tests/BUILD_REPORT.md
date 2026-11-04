# Informe de compilación del núcleo

Estado: **Fase 1 completada en la nube, sin ROM** (2026-11-04). `dist/libmelonDS.a` compila y
`node dist/phase1.js` imprime `api_version`, `library_name` y `library_version` con código de
salida 0. No se ha ejecutado ningún fotograma ni se ha cargado ninguna ROM: eso se prueba en local.

## Toolchain

| Elemento | Versión |
|---|---|
| Flujo oficial (Docker) | Imagen `emscripten/emsdk:6.0.13` (digest `sha256:fb7864e398acfda863dfcea78b8bc8adad359fa60c6a0bbeb845931de64aa68a`). **No se ejecutó en la nube** (no hay demonio Docker) |
| Flujo usado en esta ejecución | emsdk (`github.com/emscripten-core/emsdk`, commit `d7b4130`) con `./emsdk install 6.0.13 && ./emsdk activate 6.0.13`; SDK `releases-eb132757325583b787fe9414b09afea9442b72ad-64bit` |
| Emscripten | 6.0.13 (`e13ee988ce3d87a738dd8f3661d02223308c412a`), libc++ de su sysroot |
| CMake | 3.28.3 |
| Generador / host | Unix Makefiles (el que elige `emcmake`), Ubuntu 24.04, 4 núcleos |
| Python | 3.x del sistema, **no se usa** en la compilación del núcleo (las pruebas del núcleo están desactivadas) |
| Node (ejecución de `phase1.js`) | v22.23.4 |

## Versiones fijadas

| Dependencia | Repositorio | Referencia |
|---|---|---|
| melonDS (fork del motor) | `JesseTG/melonDS` | `16f127dbb587a73371827ce79689c5d237c4b59b` (`jtg/fix-uninitialized-opengl`, cabeza el 2026-09-15; v1.4.0 se publicó el 2026-09-27) |
| melonDS DS | `JesseTG/melonds-ds` | `f394adbacb5722ee97c1b37c8064da9a25818310` (etiqueta `v1.4.0`) |
| libretro-common | `libretro/libretro-common` | `fa8a1b572a444fcb552007019f8caf68281108aa` |
| embed-binaries | `andoalon/embed-binaries` | `078b62beba97e8192c99bfb16d5e17220cfc7598` |
| glm | `g-truc/glm` | `6f14f4792a0cde5d0cf2c910506724d61cb95834` |
| libslirp | `JesseTG/libslirp-mirror` | `e61dbd459c8c06607b3a84694489427e8ec60f17` (se descarga pero no se compila ni enlaza: red desactivada) |
| pntr | `robloach/pntr` | `a47fe167703b0ac3bfad00785b20b0dce6712509` |
| fmt | `fmtlib/fmt` | `1be298e1bd68957e4cd352e1f676f00e07dcfb57` (`12.2.0`) |
| yamc | `yohhoy/yamc` | `4e015a7e8eb0d61c34e6928676c8c78881a72d73` |
| span-lite | `martinmoene/span-lite` | `f63fe2974943b5f555b928b10d910e457fbb93d4` |
| date | `HowardHinnant/date` | `179a6b921ccd6179b5b04dce812a89f71a51b4df` (`v3.0.5`) |
| zlib | `madler/zlib` | `da607da739fa6047df13e66a2af6b8bec7c2a498` (`v1.3.2`) |
| tracy | `wolfpld/tracy` | `v0.14.1` (solo si `TRACY_ENABLE=ON`; aquí está desactivado) |

## Opciones CMake

| Opción | Defecto | Valor usado | Motivo |
|---|---|---|---|
| `MELONDSDS_STATIC` | `OFF` (nueva, añadida por parche) | `ON` | Producir un `.a` enlazable, no un módulo `.so` de libretro |
| `MELONDS_REPOSITORY_TAG` | rama móvil `jtg/fix-uninitialized-opengl` | SHA `16f127db…` | Reproducibilidad |
| `ENABLE_JIT` | `ON` | `OFF` | No hay JIT en WebAssembly |
| `ENABLE_OPENGL` | `ON` | `OFF` | Sin GL de escritorio; el renderizador 3D por software es el objetivo |
| `ENABLE_COMPUTE_RENDERER` | `ON` | `OFF` | Requiere OpenGL 4.3 |
| `ENABLE_THREADED_RENDERER` | `ON` | `ON` | Renderizador 3D por software multihilo |
| `ENABLE_NETWORKING` | `ON` | `OFF` | Sin Wi-Fi ni libslirp en la primera versión |
| `ENABLE_DYNAMIC` | `ON` | `OFF` | Evita `HAVE_DYNAMIC`/`dlopen` en el núcleo |
| `ENABLE_EGL` | `OFF` | `OFF` | Sin OpenGL |
| `ENABLE_ZLIB` | `ON` | `ON` | Necesario para comprimir/descomprimir estados y SRAM |
| `TRACY_ENABLE` | `OFF` | `OFF` | Sin perfilador |
| `BUILD_AS_SHARED_LIBRARY` | `OFF` | `OFF` | Sin módulo compartido |
| `BUILD_TESTING` | `OFF` | `OFF` | Sin suite de pruebas del núcleo |
| `ENABLE_LTO_RELEASE` | `ON` si hay IPO | `OFF` | Evitar LTO dentro de Emscripten en la primera compilación |
| `ENABLE_LTO` | `OFF` | `OFF` | Igual que arriba |

## Banderas

```
CMAKE_BUILD_TYPE=Release
CMAKE_C_FLAGS=-pthread -msimd128 -matomics -mbulk-memory
CMAKE_CXX_FLAGS=-pthread -msimd128 -matomics -mbulk-memory
```

## Parches aplicados

`scripts/build-core.sh` los aplica en orden sobre `third_party/melonds-ds` (el submódulo queda
limpio en git; `git -C third_party/melonds-ds checkout -- .` revierte los cambios locales).

| Parche | Archivo(s) | Qué hace |
|---|---|---|
| `0001-static-library.patch` | `src/libretro/CMakeLists.txt` | Añade `MELONDSDS_STATIC` y evita los sufijos `.so`/`.dll` cuando es estático |
| `0002-emscripten-no-mmap.patch` | `cmake/ConfigureFeatures.cmake` | No detecta `mmap` en Emscripten (conflicto de prototipo con `libretro-common`). **Probado: resuelve el fallo de `vfs_implementation.c`** |
| `0003-include-net-headers.patch` | `src/libretro/CMakeLists.txt` | Añade `src/net` del motor a las rutas de inclusión siempre; `config.cpp`, `net.hpp` y `pcap.hpp` incluyen `Net_PCap.h` sin condición |
| `0004-libcxx-iterators.patch` | `config/config.cpp`, `config/parse.hpp` | libc++ envuelve los iteradores de `vector`/`string_view` (`__wrap_iter`); convierte a puntero con `.data()` / `data() + (it - begin())` donde se esperaba `T*` o `const char*` |
| `0005-no-networking-and-regex.patch` | `net/net.hpp`, `core/core.cpp` | `net.hpp` incluye `Net_PCap.h` siempre (define `melonDS::AdapterData`, usado sin condición); `cregex_iterator` recibe punteros |
| `0006-pcap-flags-formatter.patch` | `format.cpp` | El formateador de `FormattedPCapFlags` (único uso bajo `HAVE_NETWORKING_DIRECT_MODE`) pasa a estar bajo ese `#ifdef` |
| `0007-networking-optional-slirp.patch` | `src/libretro/CMakeLists.txt`, `net/net.cpp` | `net.cpp`/`core.hpp` usan `melonDS::Net` siempre: se compilan `Net.cpp`, `LocalMP.cpp`, `PacketDispatcher.cpp` incondicionalmente; solo `Net_Slirp.cpp` y el código de modos directo/indirecto quedan bajo `HAVE_NETWORKING` |

Los parches 0003–0007 existen porque `ENABLE_NETWORKING=OFF` no es una configuración que el
núcleo compile tal cual en v1.4.0 (ver `tests/DEVIATIONS.md`).

Ajuste fuera del submódulo: `scripts/verify-core.sh` añade `--extern-post-js core/test/phase1_autorun.js`,
para que `node dist/phase1.js` ejecute `main` (con `MODULARIZE` no lo hace solo); al importar el archivo
como módulo no hay efectos secundarios, así que `tests/run-phase1.mjs` sigue valiendo.

## Resultado

Ejecutado el 2026-11-04 en un contenedor Linux sin Docker, con emsdk 6.0.13 (la primera versión
probada; no hizo falta probar 4.x ni 3.1.74).

- Compilación limpia (`rm -rf build dist` y `bash scripts/build-core.sh`): **correcta**, 1 min 39 s,
  4 núcleos. Producida `dist/libmelonDS.a` (1 802 228 bytes, contiene solo los objetos de
  `melondsds_libretro`; el motor y las demás bibliotecas están en los `.a` de `build/melonds`, que
  `verify-core.sh` añade al enlazar con `--start-group`).
- Opciones efectivas en `build/melonds/CMakeCache.txt`: `ENABLE_JIT=OFF`, `ENABLE_OPENGL=OFF`,
  `ENABLE_COMPUTE_RENDERER=OFF`, `ENABLE_NETWORKING=OFF`, `ENABLE_THREADED_RENDERER=ON`.
  Definiciones de compilación de `melondsds_libretro`: `ENABLE_THREADED_RENDERER`,
  `HAVE_THREADED_RENDERER` (sin `HAVE_NETWORKING*`, `HAVE_OPENGL*` ni JIT).
- `bash scripts/verify-core.sh`: **correcto**, genera `dist/phase1.js` y `dist/phase1.wasm`.
- `node dist/phase1.js` (Node v22.23.4), código de salida 0:

  ```
  api_version=1
  library_name=melonDS DS
  library_version=1.4.0
  valid_extensions=nds|ids|dsi
  ```
  `node tests/run-phase1.mjs` imprime lo mismo.
- Aprox. 70 avisos de compilación (atributo `gnu::access` desconocido, uso de `fmt` obsoleto,
  inicializadores designados fuera de orden, `wstring_convert` obsoleto); ninguno bloqueante.
  En el enlace: `-pthread + ALLOW_MEMORY_GROWTH` puede ser lento en código no wasm y
  `USE_PTHREADS` está obsoleto (se mantiene por coherencia con `build.sh hello`).

**No verificado** (necesita ROM o navegador, fuera de esta fase en la nube):
- Que el renderizador 3D por software con hilos arranque realmente sus hilos en Wasm: solo se
  comprobó que se compila con `HAVE_THREADED_RENDERER` y que enlaza. [VERIFICAR]
- Cualquier carga de ROM, ejecución de `retro_run`, vídeo o audio.
- El flujo con Docker (`scripts/build.sh core-test`): no ejecutado aquí; el script de compilación es el
  mismo que se probó, pero la imagen no se descargó.
- Ni `retro_assert` (inactivo con `NDEBUG`) ni la comparación `definitions.end()` de `config.cpp`
  se han ejercido en una compilación de depuración.
