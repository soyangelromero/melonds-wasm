# Informe de compilación del núcleo

Estado: **en curso** (Fase 1). Este archivo se completa cuando `dist/libmelonDS.a`
compila y el programa de prueba enlaza.

## Toolchain

| Elemento | Versión |
|---|---|
| Imagen Docker | `emscripten/emsdk:6.0.13` (fijada por etiqueta, digest `sha256:fb7864e398acfda863dfcea78b8bc8adad359fa60c6a0bbeb845931de64aa68a`) |
| Emscripten | 6.0.13 |
| CMake | 3.28.3 |
| Python (contenedor) | 3.12.3, **no se usa**: `CreatePythonVenv.cmake` solo se incluye desde `test/CMakeLists.txt`, y las pruebas están desactivadas |
| Node (host) | 26.13.0 |

## Versiones fijadas

| Dependencia | Repositorio | Referencia |
|---|---|---|
| melonDS (fork del motor) | `JesseTG/melonDS` | `16f127dbb587a73371827ce79689c5d237c4b59b` (`jtg/fix-uninitialized-opengl`, cabeza el 2026-09-15; v1.4.0 se publicó el 2026-09-27) |
| melonDS DS | `JesseTG/melonds-ds` | `f394adbacb5722ee97c1b37c8064da9a25818310` (etiqueta `v1.4.0`) |
| libretro-common | `libretro/libretro-common` | `fa8a1b5` |
| embed-binaries | `andoalon/embed-binaries` | `078b62b` |
| glm | `g-truc/glm` | `6f14f47` |
| libslirp | `JesseTG/libslirp-mirror` | `e61dbd4` (se descarga pero no se enlaza: red desactivada) |
| pntr | `robloach/pntr` | `a47fe16` |
| fmt | `fmtlib/fmt` | `12.2.0` |
| yamc | `yohhoy/yamc` | `4e015a7` |
| span-lite | `martinmoene/span-lite` | `f63fe29` |
| date | `HowardHinnant/date` | `v3.0.5` |
| zlib | `madler/zlib` | `v1.3.2` |
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

| Parche | Archivo | Qué hace |
|---|---|---|
| `0001-static-library.patch` | `src/libretro/CMakeLists.txt` | Añade `MELONDSDS_STATIC` y evita los sufijos `.so`/`.dll` cuando es estático |
| `0002-emscripten-no-mmap.patch` | `cmake/ConfigureFeatures.cmake` | No detecta `mmap` en Emscripten: `libretro-common` y `sys/mman.h` declaran prototipos incompatibles |

## Resultado

Pendiente de la primera compilación completa.
