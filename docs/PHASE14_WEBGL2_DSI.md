# Fase 14 (opcional) — Informe de viabilidad

**A) Renderizador 3D nativo en WebGL2 desde el worker de emulación (`OffscreenCanvas`)**
**B) Modo DSi con BIOS, firmware y NAND aportados por el usuario**

> **Estado:** **informe de viabilidad; nada de la Fase 14 está implementado.** Este documento es el
> entregable que pide `docs/GUIA_COMPLETAR_PORT.md` §4.7 (`:456-458`). No se ha tocado el motor, ni el
> wasm, ni el host para esta fase, y **no se implementará sin la aprobación explícita del usuario**
> (regla de la propia guía y de `PROGRESO.md` §7).
>
> **Fecha de la investigación:** 2026-11-15. **Repo:** `port melonds`, rama `feat/integration`, todo sin commit.
> **Versiones:** melonDS DS **v1.4.0** (`third_party/melonds-ds/CHANGELOG.md`, entrada `[1.4.0] - 2026-09-27`)
> sobre melonDS upstream `16f127dbb587a73371827ce79689c5d237c4b59b` (`scripts/build-core.sh:23`).
>
> **Método:** lectura estática del código real del port, del núcleo de melonDS DS, del melonDS upstream
> compilado (`build/melonds/_deps/melonds-src`) y de los informes de fases anteriores. **No se ha podido
> recompilar** (Docker Desktop parado y emsdk no instalado, `PROGRESO.md` §10.3 `:196`), así que no hay
> pruebas de ejecución nuevas de esta fase. Cada afirmación lleva `ruta:línea`; lo que es una estimación o
> no está comprobado va marcado `[VERIFICAR]` o «estimación».

---

## 0. Resumen para decidir

| Pregunta | Respuesta de este informe |
|---|---|
| **A. ¿Renderer 3D WebGL2 nativo desde el worker?** | **No ahora / aplazar.** Hoy WebGL2 ya se usa, pero solo para dibujar el fotograma compuesto (un triángulo). Llevar el 3D a WebGL2 obliga a portar el renderer GL de melonDS (que es GL de escritorio 3.2/4.3, **no GLES**) a GLES3, más el contexto GL desde un worker. Son semanas y rompe el diseño de `captureStream`/WebRTC. La ganancia en los juegos reales del usuario es pequeña porque el cuello es la CPU, no el rasterizado (§A.5). |
| **B. ¿Modo DSi?** | **No ahora; aplazar con condiciones.** El núcleo ya soporta DSi, pero exige **cinco archivos nativos** (4 BIOS + firmware) y una **NAND de 240/245,5 MiB**; sin estados, sin cámara y con la tarjeta SD virtual activada por defecto (4 GB) —inviable en wasm—. La NAND no cabe con soltura en el build de 1 GiB que hay hoy, y falta el rebuild de 2 GiB (`scripts/build-host.sh:13-17`, pendiente). Además la biblioteca actual del usuario no contiene títulos que necesiten DSi. |
| **Recomendación global** | **Entregar este informe y no implementar la Fase 14 por ahora.** Primero: rebuild con 2 GiB + mejoras C++ ya planificadas (`-O3`/LTO/SIMD) y las pruebas manuales pendientes. El modo DSi solo tiene sentido si el usuario aporta dumps **y** quiere DSiWare/títulos DSi; el renderer GL solo si pide reescalado 3D o el 3D domina el perfil. |

---

## A) Renderizador 3D nativo en WebGL2 desde el worker (OffscreenCanvas)

### A.1 Qué hace hoy el port (todo verificado)

La arquitectura actual está pensada para que **el worker emule y componga** y **el hilo principal solo
presente**:

```
[worker de emulación]
  mds_run_frame()                      (core/host/host.cpp:358-362)
    └─ núcleo melonDS → SoftRenderer   (GPU de software; 3D en un pthread aparte
       si melonds_threaded_renderer)   (build/melonds/_deps/melonds-src/src/GPU.cpp:336)
    └─ el núcleo compone UN frame XRGB8888 de 256×384 (o el layout pedido)
       y lo entrega en videoCb         (core/host/host.cpp:200-212)
  copia el frame del heap wasm al anillo SAB   (js/emu-worker.js:130-136)
[ hilo principal ]
  FrameRenderer.draw(frame)            (js/player.js:199-207)
    └─ sube 1 textura RGBA8 + dibuja 1 triángulo WebGL2, con rotación y post-proceso
                                       (js/renderer.js:162-187)
```

Hechos que importan para esta fase:

1. **El renderer 3D del núcleo es software.** El port compila `ENABLE_OPENGL=OFF` y
   `ENABLE_COMPUTE_RENDERER=OFF` (`scripts/build-core.sh:34-35`); melonDS crea su `SoftRenderer`
   (`GPU.cpp:336`). La ruta GL de melonDS DS es de escritorio y en este build ni siquiera se compila.
2. **El 3D con hilos ya está activo** (`-DENABLE_THREADED_RENDERER=ON`, `scripts/build-core.sh:39`;
   opción `melonds_threaded_renderer` que el port fija a `enabled`/`disabled`, `js/player.js:44`). El
   rasterizado por software corre en un pthread (hilo de trabajo wasm) que se crea con
   `Platform::Thread_Create` (`build/.../GPU3D_Soft.cpp:48-56`, `:1774-1803`); el host se enlaza con
   `-pthread` y `-sPTHREAD_POOL_SIZE=4` (`scripts/build-host.sh:30-31`).
3. **WebGL2 del hilo principal no dibuja el 3D de la DS**: solo pinta el fotograma ya compuesto
   (una textura y un triángulo, `js/renderer.js:162-187`). El único coste GPU actual es despreciable.
4. **El canvas visible está en el hilo principal a propósito**, porque `captureStream()` lo necesita:
   `js/renderer.js:58-64` rechaza un `OffscreenCanvas` con `NO_CANVAS`, y el fotograma se transporta por
   un anillo `SharedArrayBuffer` con triple buffer (`tests/PHASE3_REPORT.md:36-37`). El requisito está
   escrito en la fase 3: «`captureStream()` se pueda hacer sobre el canvas visible del hilo principal (no
   sobre un `OffscreenCanvas` transferido)». De ahí cuelgan la captura de pantalla
   (`js/melonds.js:308-315`) y el multijugador WebRTC (`adapters/netplay-host.js:4-6`, `:88-92`).
5. **`captureStream` y el aislamiento ya están resueltos**: el port exige `crossOriginIsolated` y
   `SharedArrayBuffer` (`js/player.js:28-30`; las cabeceras COOP/COEP se documentan en
   `docs/GUIA_COMPLETAR_PORT.md:466-468`). Un contexto GL en worker no necesitaría cabeceras nuevas,
   pero sí un canvas transferido o una copia por fotograma.

### A.2 Qué permite melonDS: la abstracción `Renderer`

melonDS sí tiene una abstracción limpia para cambiar de renderer:

- `Renderer` (software vs OpenGL): `GPU.h:833-876`, con `DrawScanline`, `DrawSprites`, `VBlank`,
  `AllocCapture`, `GetFramebuffers` y `RendererSettings` (`GPU.h:818-831`; incluye
  `Threaded`, `ScaleFactor`, `HiresCoordinates`, `BetterPolygons`).
- `Renderer3D` (común a software y GL): `GPU3D.h:321-346` (`RenderFrame`, `FinishRendering`,
  `GetLine`). Implementaciones: `GPU3D_Soft.cpp` (1852 líneas), `GPU3D_OpenGL.cpp` (1491),
  `GPU3D_Compute.cpp` (1278).
- En el núcleo libretro, `RenderStateWrapper` elige `software` / `opengl` / `compute`
  (`config/definitions/video.hpp:26-53`; `render/render.cpp:124-188`). Es decir, **cambiar el renderer
  es una opción del núcleo**, no una reescritura del emulador.

La pega es qué renderer GL es: **no es GLES**. melonDS DS aborta la configuración si se pide algo que no
sea `OPENGL_PROFILE=OpenGL` («melonDS does not support OpenGL ES yet», `third_party/melonds-ds/CMakeLists.txt:80-82`),
y el renderer pide al frontend un contexto **`RETRO_HW_CONTEXT_OPENGL_CORE` 3.2** (compute: 4.3),
porque «melonDS's OpenGL renderer needs at least OpenGL 3.2» (`src/libretro/render/opengl.cpp:52-54`,
`:178-191`; los shaders del compute son `#version 430 core`, `:180-181`). **WebGL2 es OpenGL ES 3.0**,
no un contexto GL de escritorio 3.2: los shaders (`#version 330 core`/`430 core`), la carga de funciones
(`glsym`/`rglgen`, `render/opengl.cpp:245-275`) y el propio `RETRO_HW_RENDER` no encajan sin portar.

### A.3 Qué significaría «WebGL2 nativo desde el worker»

Serían **tres cambios**, no un flag:

1. **Renderer GLES3 dentro de melonDS** (o una variante `HAVE_OPENGLES` del renderer GL). El código
   GL de melonDS que habría que portar/adaptar son ~4.700 líneas:
   `GPU_OpenGL.cpp` 935, `GPU3D_OpenGL.cpp` 1491, `GPU2D_OpenGL.cpp` 1913, `OpenGLSupport.cpp` 363
   (recuento de líneas real de esos archivos). A eso se suma la composición GL del núcleo libretro
   (`src/libretro/render/opengl.cpp`, 955 líneas + `glsl/melondsds.frag`/`.vert`). Habría que traducir
   GLSL de escritorio a GLSL ES 3.00, sustituir las suposiciones de GL core (VAO/UBO, `glGetIntegerv`
   de versión, extensiones) y mantener el renderer software como *fallback*.
2. **Contexto GL desde el worker + `RETRO_ENVIRONMENT_SET_HW_RENDER` en el host.** Hoy el host
   devuelve `false` a `SET_HW_RENDER` y el comentario dice que el núcleo «falls back to its
   software/stdio paths» (`core/host/host.cpp:178-181`). Habría que crear un `OffscreenCanvas` (o
   transferir el del `<canvas>`) y un contexto WebGL2 **en el pthread del módulo**, y rellenar
   `retro_hw_render_callback` (contexto, `context_reset`, `get_proc_address`,
   `get_current_framebuffer`). Emscripten lo permite con `-sOFFSCREENCANVAS_SUPPORT=1` («enables
   support for transferring canvases to pthreads and creating WebGL contexts in them», documentación de
   `settings.js` de Emscripten) y las variantes `-sMIN_WEBGL_VERSION=2 -sMAX_WEBGL_VERSION=2 -sFULL_ES3`;
   **hoy el build no usa ninguna** (`scripts/build-host.sh:21-42`). Con GL en un pthread aparecen además
   las restricciones conocidas de Emscripten (contexto creado y usado en el mismo hilo, *swap* explícito
   o `OffscreenCanvas`), y la versión del núcleo pide GL 3.2: habría que **parchear también el núcleo**
   para pedir `RETRO_HW_CONTEXT_OPENGLES3` y aceptar GLES (`[VERIFICAR]` el detalle de parche mínimo).
3. **Presentación y `captureStream`.** Dos opciones:
   - **Transferir el control** con `canvas.transferControlToOffscreen()`: el `<canvas>` pasa a
     *placeholder* y «cannot have a rendering context» (spec de HTML, `transferControlToOffscreen`). El
     worker pinta directo. Qué hace `captureStream()` sobre el placeholder **no está garantizado** por la
     especificación (`[VERIFICAR]` en Chromium/WebKit/Safari); si no funciona, se rompe WebRTC
     (`adapters/netplay-host.js:88-92`) y habría que volver a un canvas del hilo principal.
   - **Renderizar en el worker sobre un `OffscreenCanvas` suelto y enviar `ImageBitmap`** por fotograma
     (patrón documentado: `transferToImageBitmap()` + `ImageBitmapRenderingContext`,
     <https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvas>). El hilo principal sigue siendo
     dueño del canvas visible y `captureStream()` sigue funcionando. El coste es una transferencia de
     ~393 KB por fotograma (256×384×4) más un `drawImage`/`transferFromImageBitmap`; es asumible, pero
     añade una etapa que hoy no existe.
   - Complicación de `COOP/COEP`: no cambia (ya se exigen, `js/player.js:28-30`); el problema no es el
     aislamiento, es dónde vive el canvas que captura el vídeo.

### A.4 Bloqueos y dependencias (resumen)

| # | Bloqueo | Evidencia | Consecuencia |
|---|---|---|---|
| A1 | melonDS no soporta GLES; solo GL de escritorio 3.2/4.3 | `CMakeLists.txt:80-82`; `render/opengl.cpp:52-54,178-191` | Hay que portar ~5.700 líneas GL + shaders a GLES3 |
| A2 | El renderer GL está desactivado en el build | `scripts/build-core.sh:34-36` | Ni siquiera se compila la ruta GL |
| A3 | El host rechaza `SET_HW_RENDER` | `core/host/host.cpp:178-181` | Falta todo el puente host↔GL |
| A4 | Emscripten necesita `OFFSCREENCANVAS_SUPPORT` (+ variantes WebGL2) y no está activado | `scripts/build-host.sh:21-42`; docs de Emscripten `OFFSCREENCANVAS_SUPPORT` | Cambio de flags y de gestión de canvas |
| A5 | `captureStream`/WebRTC dependen del canvas visible del hilo principal | `js/renderer.js:58-64`; `adapters/netplay-host.js:88-92` | Hay que conservar un canvas del hilo principal o copiar por `ImageBitmap` |
| A6 | Soporte de navegador: `OffscreenCanvas` en Safari/iOS solo desde 17 (16.2-16.6 parcial) | <https://caniuse.com/offscreencanvas> | El port presume de móvil; habría que mantener la ruta actual para WebKit antiguo |
| A7 | WebGPU no es atajo: el compute de melonDS es `#version 430 core` y WebGPU es otra API; Safari 26+ parcial | `render/opengl.cpp:180-181`; <https://caniuse.com/webgpu> | Sería otro port, más grande que el de GLES |
| A8 | Las pruebas de navegador del repo corren con WebGL de software (SwiftShader) | `tests/BENCH.md:9`; `tests/PHASE9_REPORT.md:311-313` | Un renderer GL nuevo no se podría validar de verdad en CI/headless |
| A9 | El renderizado 3D por software ya usa un pthread y gana | `tests/BENCH.md:154-164` | Antes de portar GL hay que demostrar que el rasterizado es el cuello |

### A.5 Ganancia esperable (con los datos que hay)

- **Escena 3D real (`nmap.nds`, homebrew CC0, sin navegador):** con hilos 3D **41,6 fps** de mediana
  frente a **32,8 fps** sin hilos (+19-28 %) (`tests/BENCH.md:154-164`; `tests/PHASE9_REPORT.md:190-194`).
  Es decir, en contenido 3D puro el rasterizado serial pesa lo suficiente como para que paralelizarlo se
  note un ~25 %: llevarlo a la GPU podría recuperar una parte de ese tiempo de CPU.
- **Juego real del usuario (SoulSilver, arranque/título, headless):** con hilos 57,2 fps a 1x vs 58,3 sin
  hilos (ruido); la diferencia solo aparece a 2x/sin límite (87,3 vs 72,6; 79,2 vs 67,5)
  (`tests/PHASE9_REPORT.md:194-195`). A 1x el 3D **no** es el cuello: el límite es la emulación de CPU
  (`PROGRESO.md` §4 `:62` «La CPU es el límite»). El usuario ya mide 59,8 fps de media en SoulSilver
  (`PROGRESO.md:55`).
- **Dónde sí habría ganancia clara:** (a) juegos con mucho 3D y CPUs flojas, (b) **reescalado 3D real**
  (2x-8x) y *hires coordinates*, que son funciones del renderer GL (`video.hpp:55-94`) y no solo un filtro
  de la textura final; (c) móviles con poca CPU. Pero (b) es una mejora **visual**, no de fps, y hoy el
  blit ya permite escalado entero y post-proceso barato (`js/renderer.js:42-49,215-226`).

**Conclusión A.5:** la mejora de rendimiento no está demostrada para los juegos del usuario; la de
calidad (3D en alta resolución) sí, pero es otra motivación y otro coste.

### A.6 Esfuerzo y riesgos

| Tarea | Esfuerzo (estimación) |
|---|---|
| Prototipo de contexto GL desde el worker (sin tocar melonDS: solo host + Emscripten, dibujar un triángulo) | 3-5 días |
| Portar el renderer GL de melonDS a GLES3/WebGL2 (renderer + shaders + glsym) y parchear el núcleo para pedir GLES | **4-8 semanas** de una persona con experiencia en GL/GLSL y wasm |
| Composición GL del núcleo libretro (layout/post-proceso) o adaptar la composición software | 1-2 semanas |
| Presentación (`ImageBitmap` o canvas transferido) + mantener `captureStream`, screenshot y WebRTC | 1 semana |
| Pruebas en Chromium/Firefox/Safari y móvil, *fallbacks* y documentación | 1-2 semanas |
| **Total realista** | **6-12 semanas** con riesgo alto de más (estimación; depende de cuánto GLES3 haya que reescribir) |

Riesgos principales: (1) el port de GL puede no llegar a paridad visual y obligar a mantener dos rutas;
(2) la ruta GL no se puede probar en headless (A8), así que el usuario tendría que validar cada cambio;
(3) `captureStream`/WebRTC es requisito del port (fase 12) y cualquier solución basada en transferir el
canvas lo pone en riesgo; (4) en móvil, GL en worker + memoria/calor puede empeorar la batería sin ganar
fps; (5) más superficie de *bugs* en un port que ya está cerrado en JS.

### A.7 Recomendación A

**No implementar ahora; aplazar.** No hay evidencia de que el rasterizado sea el cuello en los juegos del
usuario (A.5) y el coste es de semanas con riesgo de romper WebRTC. Antes de replantearlo, hacer lo barato
que ya está planificado: rebuild con 2 GiB, `-O3`/LTO/SIMD y optimizar el renderer software (tamaño de
lote, SIMD) —`PROGRESO.md` §10.6 `:242-244`—. **Replantear solo si** (a) tras esas mejoras el perfil del
worker muestra que el 3D pasa de ~30-40 % del fotograma en batallas reales, o (b) el usuario pide
explícitamente reescalado 3D en alta resolución; en ese caso, tratarlo como proyecto aparte con tiempo y
dispositivos de prueba reales.

---

## B) Modo DSi con BIOS, firmware y NAND del usuario

### B.1 Qué soporta melonDS DS v1.4.0 (verificado)

- Opción de núcleo **`melonds_console_mode`** con valores `Auto` (por defecto), `DS` y **`DSi (experimental)`**
  (`src/libretro/config/constants.hpp:137`; `src/libretro/config/definitions/system.hpp:25-52`;
  `src/libretro/config/parse.hpp:110-113`; `src/libretro/config/config.cpp:174-178`).
- **Auto** resuelve a DSi solo si el título lo necesita: `UnitCode == 0x03` (solo DSi) o DSiWare retail
  (`src/libretro/config/console.cpp:238-256`). Forzar DS con un título DSi retail lanza
  `wrong_console_mode_exception` (`:276-282`).
- El **modo DSi es experimental** y el propio texto de la opción avisa: «Native BIOS/firmware/NAND files
  must be provided, including for the regular DS» y «Some features (such as savestates) are not available
  in DSi mode» (`system.hpp:35-38`).
- **No hay *fallback*** en esta versión: el `TODO` de usar el DSi BIOS integrado de melonDS existe, pero
  el comentario explica que no hay NAND *stub* y que DSiWare/títulos DSi siguen necesitando un dump real
  (`console.cpp:501-515`).

### B.2 Archivos que exige el modo DSi

Todos son contenido del usuario; el núcleo los busca en el directorio de sistema (`/system` en el port,
`core/host/host.cpp:98-100`) o en su subcarpeta `melonDS DS`.

| Archivo | Tamaño exigido | Dónde se exige |
|---|---|---|
| `bios7.bin` (ARM7 DS) | 16.384 B | `console.cpp:526-529`; `config.hpp:327-328`; tamaños `MemConstants.h:30-32` |
| `bios9.bin` (ARM9 DS) | 4.096 B | `console.cpp:531-534` |
| `dsi_bios7.bin` (ARM7i DSi) | 65.536 B | `console.cpp:516-519`; `MemConstants.h:32` (`DSiBIOSSize = 0x10000`) |
| `dsi_bios9.bin` (ARM9i DSi) | 65.536 B | `console.cpp:521-524` |
| Firmware DSi | 128, 256 o 512 KiB, con cabecera de tipo DSi | `console.cpp:536-551`; tamaños `definitions/system.hpp:111-132` |
| Imagen NAND | 251.658.304 B (240 MiB + footer no$gba) o 257.425.472 B (245,5 MiB + footer); el footer también vale en el offset 0xFF800 | `definitions/system.hpp:134-156`; `constants.hpp:285`; validación `constants.cpp:43-100` |

Detalles que condicionan la viabilidad:

1. **La NAND se abre en lectura/escritura** (`console.cpp:1400-1416`: `FileMode::ReadWriteExisting`). En
   el port eso es MEMFS (`/system`), que se pierde al recargar la página: haría falta exportar la NAND
   modificada (nuevo API) para conservar instalaciones/cambios.
2. **melonDS no carga la NAND entera en RAM**, sino que lee bloques por archivo (`src/DSi_NAND.h:49-82`,
   `NANDImage` guarda un `FileHandle*`); pero en wasm el archivo completo vive igualmente en el heap
   (MEMFS), ~240 MiB (§B.5).
3. **El firmware DSi tiene que ser de tipo DSi**; si no, `wrong_firmware_type_exception`
   (`console.cpp:545-551`). El firmware DSi **no es arrancable** por sí mismo (comentario en
   `console.cpp:552`), así que el arranque del menú DSi depende del BIOS completo y de la NAND
   (`src/DSi.cpp:139-152`, `:461-468`).
4. **Las BIOS de DS también son obligatorias** en modo DSi, no solo las DSi (texto de la opción en
   `config/definitions/system.hpp:37-38`; carga en `console.cpp:526-534`).

### B.3 Restricciones y dependencias en ejecución

| Tema | Realidad en v1.4.0 | Evidencia |
|---|---|---|
| **Estados (savestates)** | **No disponibles en DSi**: `retro_serialize_size()` devuelve 0 y serialize/unserialize fallan | `src/libretro/core/core.cpp:966-970,1016-1020,1057-1061`. El port ya lo traduce a `STATE_UNSUPPORTED` (`core/host/saves.cpp:37,160-164`; `js/saves-core.js:14`; `tests/DEVIATIONS.md:101`) |
| **Ranura GBA** | No soportada en DSi; avisa y no carga GBA | `console.cpp:290-296` |
| **Cámara DSi** | **No implementada**: los callbacks `Camera_Start/Stop/CaptureFrame` están vacíos (640×480 declarado) | `src/libretro/platform/platform.cpp:38-39,102-109` |
| **Micrófono** | El host no responde a `GET_MICROPHONE_INTERFACE` (`core/host/host.cpp:181`); la Fase 7-C++/micrófono sigue pendiente de rebuild | `host.cpp:178-193`; `PROGRESO.md` §10.6 `:244` |
| **DSP del DSi** | Usa el DSP **LLE** (Teakra), no HLE (`DSPHLE=false`), y no necesita dump extra | `console.cpp:631-633`; `DSi_DSP.cpp:273-309` |
| **Tarjeta SD virtual** | **Activada por defecto**; si no hay imagen se crea una imagen FAT (4 GB por defecto) | `config.cpp:92-93,516-538`; creación en `FATStorage.cpp:1069-1093` |
| **DSiWare retail** | Se instala temporalmente en la NAND y **necesita el TMD** (metadata); si no está cacheado, lo descarga por HTTP | `console.cpp:598-616,811-856`; descarga condicionada a `HAVE_NETWORKING` (`:833-840`) |
| **Red** | Este build compila `ENABLE_NETWORKING=OFF` | `scripts/build-core.sh:36` |
| **Región** | La NAND debe ser de una región compatible con el `DSiRegionMask` del título | `console.cpp:1429-1436` |
| **Menú DSi (sin ROM)** | Posible en melonDS si el BIOS DSi está completo (`FullBIOSBoot`) y hay NAND (`DSi.cpp:139-152,182-186`), pero **la API del port exige ROM**: `mds_load_rom` siempre recibe un buffer | `core/host/host.cpp:335-356`; el núcleo sí admite `retro_load_game(NULL)` (`src/libretro/libretro.cpp:88-96`) |

### B.4 Qué habría que tocar en el port

**Host C++ (`core/host/`)** — requiere recompilar (hoy imposible, `PROGRESO.md:196`):

1. **Escritura de archivos grandes por trozos**: `mds_write_system_file` recibe el buffer completo
   (`host.cpp:324-332`) y el worker hace `_malloc` + `HEAPU8.set` del archivo entero
   (`js/emu-worker.js:277-289`); con 240 MiB eso son tres copias a la vez (§B.5). Haría falta una API de
   escritura por bloques (`mds_system_file_begin/write/end`).
2. **Lectura/exportación de archivos del sistema** (la NAND se escribe) y, si se quiere persistir, un
   `mds_read_system_file`/export por bloques.
3. **Carga sin ROM** para el menú DSi (`mds_load_rom` con `len == 0` → `retro_load_game(nullptr)`, que el
   núcleo ya soporta) y `melonds_boot_mode=native`.
4. **Valores por defecto seguros para wasm**: forzar `melonds_dsi_sdcard=disabled` antes de cargar (evita
   la imagen FAT de 4 GB) y `melonds_dsi_sdcard_sync_sdcard_to_host=disabled`.
5. **Subdirectorios en el directorio de sistema** para el TMD cacheado (`/system/tmd/<juego>.tmd`,
   `console.cpp:858-878`): el host actual no crea carpetas y el nombre de archivo no puede llevar `/`
   (`host.cpp:324-332`). Alternativa: parchear el núcleo para leer el TMD de otra ruta.
6. Opcional: implementar el micrófono (`GET_MICROPHONE_INTERFACE`) y, si se quiere, la cámara DSi (hoy
   vacía en el núcleo: habría que portar la cámara de melonDS standalone).

**API JS (`js/melonds.js`, `API_CONTRACT.md`)** — sin recompilar se puede preparar ya:

- `setConsoleMode("auto"|"ds"|"dsi")` (opción `melonds_console_mode`) y un `dsi: true` en `create()`.
- `setDsiBios({arm7i, arm9i})`, `setDsiFirmware(bytes)` y `setNandImage(bytes|File)`; validar tamaños
  (65.536 B, 128/256/512 KiB, 240/245,5 MiB) con códigos de error propios: `DSI_BIOS_INVALID`,
  `DSI_FIRMWARE_INVALID`, `NAND_INVALID`, `NAND_TOO_LARGE` (para el tope de memoria), `NAND_READONLY`.
- Estado explícito `statesSupported` y rechazo `STATE_UNSUPPORTED` en DSi (ya previsto,
  `js/saves-core.js:14`), y documentar que **no hay estados** en modo DSi.
- Almacenamiento: la NAND de ~240 MiB no debería meterse a ciegas en IndexedDB (cuota variable
  `[VERIFICAR]`); ofrecer File System Access API o volver a pedir el archivo en cada sesión. Exportar la
  NAND modificada solo si el usuario lo pide (es su contenido).

**UI y pruebas:** el modo DSi necesita avisos claros (5 archivos, sin estados, sin cámara) y una prueba
con *dumps* reales que **solo el usuario puede aportar**: no hay material legal de prueba en el repo
(regla `PROGRESO.md:110`; `scripts/check-clean.mjs:34` ya bloquea `.dsi`). Un homebrew DSi/test ROM podría
probar el cambio de modo de consola, pero no sustituye a la NAND real (`[VERIFICAR]` qué homebrew DSi
arranca sin NAND en este build).

### B.5 Memoria: interacción con el tope de 1 GiB

- El build actual es de **1 GiB** (`scripts/build-host.sh:36-37`; `PROGRESO.md:198`), y
  `scripts/build-host.sh` ya pide **2 GiB** pendiente de recompilar (`:13-17`).
- La NAND ocupa ~**240 MiB** en MEMFS. Solo cargarla con el camino actual implica: bytes en el hilo
  principal → *clone* del `postMessage` → `_malloc` + `HEAPU8.set` en el worker → escritura en MEMFS:
  hasta ~4 copias simultáneas (960 MiB para 240 MiB) `[VERIFICAR]` según el navegador (transferencia vs
  clon), pero en cualquier caso muy por encima de lo que cabe junto a una ROM.
- Una ROM de 128 MB ya ocupa ~3 copias en el heap wasm (buffer de `mds_load_rom` + `NDSCart::ParseROM` +
  `CartRetail`), el problema que hoy hace fallar Negra 2 con 1 GiB (`PROGRESO.md` §10.7 `:261`;
  `js/emu-worker.js:81-103`). Sumar 240 MiB de NAND a eso **no cabe en 1 GiB** en el caso general y
  probablemente tampoco en 2 GiB con ROMs grandes (2 GiB - 3×512 MB - 240 MB ≈ 0, `[VERIFICAR]`
  medición real).
- El propio DSi añade RAM (16 MiB de RAM principal, `src/libretro/core/core.cpp:50`, más NWRAM), pequeña frente a la
  NAND pero no despreciable.
- **Conclusión:** el modo DSi es, en la práctica, un requisito de memoria de **rebuild a 2 GiB** más
  escritura por trozos y, aun así, con ROMs grandes habría que rechazar elegantemente. No es un cambio
  solo de JS.

### B.6 Legalidad, tamaño y privacidad

- **La NAND es contenido del usuario**: contiene datos únicos de consola (ConsoleID/EMMCID, tickets,
  ajustes de usuario, nickname) y ~240 MiB. **Nunca** puede ir al repo ni al paquete (`package/`), y no
  se debe enviar a ningún servidor. La regla ya está en `PROGRESO.md:110` y el comprobador
  `scripts/check-clean.mjs:34` bloquea `.dsi`.
- Tampoco tiene sentido empaquetarla: el paquete estático son 35 archivos/2,68 MiB
  (`PROGRESO.md:160`); una NAND lo multiplicaría por ~90.
- **Privacidad:** si se cachea en IndexedDB, esos datos quedan en el navegador del usuario; hay que
  borrarlos con el mismo gesto que el resto («borrar datos del emulador») y no incluirlos en capturas ni
  logs.
- El firmware DSi también es contenido con copyright: aplica el mismo aviso legal del README
  (`port melonds/README.md:10-15`).

### B.7 Esfuerzo y riesgos

| Tarea | Esfuerzo (estimación) |
|---|---|
| Cableado JS (opciones, archivos, errores, `statesSupported`) + validaciones, **sin tocar C++** | 2-3 días |
| Prototipo real con dumps del usuario y el build de 2 GiB (ver si arranca un título DSi-enhanced desde cartucho) | 3-5 días, condicionado a rebuild + dumps |
| Host C++: escritura/lectura por trozos, sin-ROM, defaults, subdirectorios/TMD | 1-2 semanas (+ rebuild) |
| Persistencia/exportación de la NAND en JS (FSA/IndexedDB) y UI | 3-5 días |
| Pruebas, documentación y avisos legales | 3-5 días |
| **Total para «soportado de verdad»** | **3-5 semanas**, con pruebas bloqueadas por material que solo tiene el usuario |

Riesgos: (1) **sin estados** y con la NAND escribiéndose en MEMFS se puede perder progreso si no se
exporta; (2) **DSiWare retail no funcionará** sin TMD y sin red (`ENABLE_NETWORKING=OFF`) —como mucho
títulos DSi-enhanced/solo DSi desde cartucho; (3) la cámara y el micrófono no están; (4) memoria (B.5);
(5) la NAND de prueba no se puede conseguir legalmente en el repo, así que las pruebas automatizadas
serán limitadas y el usuario tendrá que validar; (6) el menú DSi exige cambiar la API (carga sin ROM).

### B.8 Recomendación B

**No implementar ahora; aplazar con condiciones.** El modo DSi no aporta nada a la biblioteca actual del
usuario (juegos NDS/DSi-enhanced que ya arrancan en modo DS; `[VERIFICAR]` los UnitCode concretos de
Negra/Negra 2), y exige rebuild de 2 GiB, host nuevo, dumps del usuario y renunciar a los estados.
**Condiciones para retomarlo:** (1) rebuild de 2 GiB hecho y verificado; (2) el usuario aporta y acepta
los 5 archivos + NAND y quiere DSiWare o títulos solo-DSi; (3) se hace **primero un *spike* de 3-5 días**
(JS + host mínimo) para comprobar que un DSi-enhanced arranca en `melonds_console_mode=dsi` y medir la
memoria real. Si el *spike* falla, documentarlo y no seguir. **No prometer DSiWare** sin resolver el TMD
y la red.

---

## Recomendación global

1. **Fase 14 se queda como informe, no como implementación.** El criterio de la guía («solo si las fases
   anteriores cumplen… no lo implementes sin aprobación», `docs/GUIA_COMPLETAR_PORT.md:456-458`) se
   respeta: hay informe, no hay cambios.
2. **Prioridad real del port** (coincide con `PROGRESO.md` §10.6): rebuild con 2 GiB, mejoras C++ ya
   planificadas (`-O3`/LTO/SIMD, tamaño de lote del renderer software), micrófono/Fase 7-C++, pruebas
   manuales del usuario y despliegue. Ahí está el valor pendiente, no en la Fase 14.
3. **Orden si algún día se retoma:** primero DSi (más barato y aislado; depende del rebuild de 2 GiB y de
   los dumps), después el renderer GLES3 (proyecto de semanas). Los dos pueden convivir, pero el GL no
   desbloquea DSi y el DSi no necesita GL.
4. **Lo que no se debe hacer:** activar `ENABLE_OPENGL=ON` y esperar que funcione (el CMake aborta con
   GLES y el host no implementa `SET_HW_RENDER`), ni poner `melonds_console_mode=dsi` sin los archivos
   (el núcleo lanza excepción y el port fallaría al cargar), ni crear la tarjeta SD virtual de 4 GB en
   wasm.

---

## Pendiente de aprobación del usuario

> **La Fase 14 no está aprobada y no se ha implementado.** Este documento es solo el informe que pide la
> guía. Para pasar a implementación hace falta que el usuario diga explícitamente **qué** quiere:
>
> - **A (renderer WebGL2/GLES3 nativo):** aprobar un proyecto de varias semanas; a cambio tendría
>   reescalado 3D real y posible mejora en escenas 3D pesadas, con riesgo para WebRTC/móvil.
> - **B (modo DSi):** aportar los archivos (4 BIOS, firmware DSi y NAND de 240/245,5 MiB), aceptar que
>   **no habrá estados**, que la cámara no está y que DSiWare retail probablemente no funcione; y
>   autorizar el rebuild de 2 GiB que ya está pendiente.
>
> Sin esa aprobación, la recomendación es **no hacer nada de la Fase 14** y seguir con la lista de
> `PROGRESO.md` §10.6.

---

## Anexo A — Puntos `[VERIFICAR]`

1. Comportamiento exacto de `canvas.captureStream()` sobre un `<canvas>` convertido en *placeholder* por
   `transferControlToOffscreen()` en Chromium/Firefox/WebKit (la spec no lo garantiza; la alternativa por
   `ImageBitmap` sí lo conserva).
2. Soporte real de contextos **WebGL2 dentro de un `OffscreenCanvas` en un worker** en Safari/iOS
   (caniuse da `OffscreenCanvas` completo desde Safari 17, pero no separa WebGL en worker).
3. Viabilidad exacta del parche mínimo del núcleo para pedir `RETRO_HW_CONTEXT_OPENGLES3` y aceptar GLES
   (no se ha probado a compilar; `ENABLE_OPENGL` en Emscripten no está soportado por el CMake actual).
4. Qué homebrew/título DSi puede arrancar en este build sin NAND (para una prueba automatizada sin
   material de Nintendo); los UnitCode de los juegos del usuario.
5. Número real de copias simultáneas de la NAND en memoria con el camino actual de `postMessage` +
   `_malloc` + MEMFS, y si un DSi-enhanced + NAND cabe en 2 GiB (medición pendiente; no se puede
   recompilar aquí).
6. Cuota real de IndexedDB/File System Access para ~240 MiB en los navegadores objetivo.
7. Comportamiento de la tarjeta SD virtual de 4 GB en MEMFS (fallo limpio vs abort) si no se desactiva;
   el código permite deducirlo (`FATStorage.cpp:1069-1093`) pero no se ha ejecutado.

## Anexo B — Fuentes citadas (mapa rápido)

- Port: `js/renderer.js`, `js/player.js`, `js/emu-worker.js`, `js/melonds.js`, `js/saves-core.js`,
  `adapters/netplay-host.js`, `core/host/host.cpp`, `core/host/saves.cpp`, `scripts/build-core.sh`,
  `scripts/build-host.sh`, `API_CONTRACT.md`, `README.md`.
- Informes previos: `tests/BENCH.md` (§5), `tests/PHASE3_REPORT.md`, `tests/PHASE9_REPORT.md` (§6),
  `tests/DEVIATIONS.md`, y `PROGRESO.md` (§2-§7, §10).
- melonDS DS v1.4.0: `third_party/melonds-ds/CMakeLists.txt`,
  `src/libretro/{config/console.cpp,config/config.cpp,config/constants.*,config/definitions/system.hpp,config/definitions/video.hpp,core/core.cpp,render/render.cpp,render/opengl.cpp,platform/platform.cpp,libretro.cpp}`.
- melonDS upstream `16f127d…`: `build/melonds/_deps/melonds-src/src/{GPU.h,GPU.cpp,GPU_Soft.cpp,GPU3D.h,GPU3D_Soft.cpp,GPU3D_Soft.h,DSi.cpp,DSi_DSP.cpp,DSi_NAND.h,NDS.cpp,NDS.h,MemConstants.h,Savestate.h,FATStorage.cpp}`.
- Referencias web: MDN `OffscreenCanvas`, spec de HTML (`transferControlToOffscreen`), Emscripten
  `settings.js` (`OFFSCREENCANVAS_SUPPORT`), caniuse (`offscreencanvas`, `webgpu`).
