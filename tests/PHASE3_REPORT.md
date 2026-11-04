# Informe de la Fase 3: vídeo en el navegador

Estado (2026-11-04): **demo funcionando y probada en Chromium sin interfaz con el homebrew CC0 `nmap.nds`: 46/46 comprobaciones**, con y sin `--gl=swiftshader`.
Audio, entrada y guardado siguen como `TODO(fase N)`. No se avanzó a la Fase 4. Sin parches nuevos en `core/patches/` (submódulo intacto).

## Versiones

| Elemento | Valor |
|---|---|
| Emscripten | 6.0.13 (emsdk instalado desde cero en esta sesión, sin Docker) |
| Node | v22.23.4 |
| Chromium / Playwright | 153.0.8010.12 / playwright 1.63.0 (global en la nube; `devDependencies` en `package.json`) |
| WebGL2 del Chromium de la nube | **ANGLE sobre SwiftShader (render por CPU)**, `WebGL 2.0 (OpenGL ES 3.0 Chromium)`. Con y sin `--use-gl=angle --use-angle=swiftshader` el resultado es el mismo renderizador |
| Núcleo | melonDS DS `f394adba` (v1.4.0), 7 parches existentes |
| ROM | `nmap.nds` (rmn20/normalmappingds `6fb2d425`, CC0), SHA-256 `b21f5889…19132` (igual que en la Fase 2), en `tests/artifacts/` (ignorada) |

## Comandos exactos

```bash
git submodule update --init third_party/melonds-ds
source /home/user/emsdk/emsdk_env.sh
bash scripts/build-core.sh && bash scripts/build-host.sh     # dist/melonds.{js,wasm}
mkdir -p tests/artifacts && # coloca tu .nds (o el homebrew) en tests/artifacts/nmap.nds
node tests/phase3-layouts.mjs tests/artifacts/nmap.nds       # Node: los 17 layouts + gap contra el núcleo real
npm test                                                     # unitarias: buffer circular con hilo real, tabla de layouts, servidor
npm run test:browser                                         # Chromium: node tests/phase3-browser.mjs tests/artifacts/nmap.nds [--gl=swiftshader] [--seconds=6]
npm run serve                                                # demo manual: http://127.0.0.1:8080/demo/index.html
```
Resultados de la prueba de navegador: `tests/artifacts/phase3-browser-results.json` y capturas por layout en `tests/artifacts/layouts/` (ignorados por git).

## Qué se hizo

- **Anfitrión (`core/host/host.cpp`)**: `SET_GEOMETRY`/`SET_SYSTEM_AV_INFO` ahora se guardan (`mds_get_geometry`, `mds_get_fps`…); número de serie de fotograma (`mds_get_frame_serial`: si no cambia tras `mds_run_frame`, el núcleo pasó `data == NULL` y no se publica nada); `mds_copy_frame` (contrato §8); **`SET_ROTATION` se guarda y se expone** (`mds_get_frame_rotation`).
- **Hallazgo importante**: los layouts *Rotated Left/Right* y *Upside Down* entregan la imagen Top/Bottom sin girar y el núcleo espera que el anfitrión la gire (`screenlayout.cpp:317`). La Fase 2 devolvía `true` sin hacer nada. Ahora el renderizador gira (0/90/180/270 antihorario) y el canvas tiene el tamaño rotado.
- **Layouts (`js/layouts.js`)**: tabla 2.1 verificada contra `constants.hpp`/`screen.hpp` (las 17 claves coinciden); `setLayout` escribe `melonds_number_of_screen_layouts=1` + `melonds_screen_layout1`; etiquetas, gap (0..126) y `one`/`both` inválidos lanzan error en vez de llegar al núcleo.
- **Renderizador (`js/renderer.js`)**: WebGL2 con una textura RGBA8, `UNPACK_ROW_LENGTH = stride/4`, XRGB→RGBA y rotación en el shader; alternativa Canvas2D (conversión por palabra de 32 bits); `setPostProcess({glsl})` + filtro `scanlines`; recuperación de `webglcontextlost`; `OffscreenCanvas` rechazado (`NO_CANVAS`). Backing store = tamaño del fotograma (rotado); `fitCanvas` escala por CSS (entera en píxeles de dispositivo cuando cabe, `image-rendering: pixelated`/`auto`). El canvas es exactamente el rectángulo del fotograma: sin barras, `(clientX-rect.left)/rect.width` es el puntero normalizado (Fase 5).
- **Transporte (`js/frame-ring.js`)**: triple buffer sin esperas sobre un `SharedArrayBuffer` (3 ranuras de 1024×576×4 B = máximo del núcleo a escala 1). Escritor = worker, lector = hilo principal. Cada lado posee una ranura y la tercera está aparcada en `ctrl[0]` con un bit «nueva»; se intercambian con `Atomics.exchange` (secuencialmente consistente), así la cabecera y los píxeles escritos antes del `publish` son visibles tras el `poll`, y nadie escribe en la ranura que el otro lee ⇒ **sin desgarros y sin bloqueos**; el lector siempre ve el fotograma más reciente y los no leídos se descartan (contador `dropped`). Hay una sola copia (heap wasm → ranura) más una copia a un `Uint8Array` normal en el hilo principal porque WebGL no acepta vistas sobre SAB. El canvas visible está en el hilo principal (`captureStream()` posible).
- **Worker (`js/emu-worker.js`)**: módulo wasm en el worker, bucle a `mds_get_fps()` (≈59,83) con `Atomics.wait` para dormir, velocidad 1x/2x/ilimitada, estadísticas cada 500 ms, opciones entre fotogramas.
- **Demo (`demo/index.html`, `demo/demo.js`)** y `scripts/serve.mjs` (ya enviaba COOP/COEP/CORP; solo se corrigió la URL impresa).

## Resultados reales

**Núcleo en Node (`phase3-layouts.mjs`)**: los 17 layouts cambian de geometría y entregan fotograma. Tamaños (tras rotar): Top/Bottom, Bottom/Top, Upside Down 256×384; Left/Right, Right/Left 512×192; Top/Bottom Only 256×192; los 4 Large Screen y 4 Hybrid 768×384 (ratio 2); Rotated Left/Right 384×256 (rotación 1 y 3 sobre 256×384). Gap 0/1/40/126 ⇒ altura 384/385/424/510. Máximo anunciado 1024×576. Regresión: hash del fotograma 300 = `a0d4f91c…` (idéntico a la Fase 2), `phase2-smoke` código 0.

**Navegador (`phase3-browser.mjs`, 46/46)**: `crossOriginIsolated` true; WebGL2 disponible; canvas no negro (52 563/98 304 px no negros, ≥64 colores); **canvas idéntico píxel a píxel al fotograma del núcleo (tras la rotación) en los 17 layouts** (WebGL2) y en 6 layouts incluidas las 3 rotaciones (Canvas2D); el tamaño del canvas cambia a lo esperado en cada layout y con el gap; híbrido `one`/`both` aceptado; `scanlines` (fila par intacta, impar ×0,7), GLSL inválido ⇒ mensaje de error y se sigue dibujando; escala entera (3,0 a 1800×1400); pausa detiene el contador; 30 muestras en marcha sin ningún fotograma incoherente; **sin errores de consola, de página ni peticiones fallidas**; sin COOP/COEP la demo explica el motivo.
Revisión visual de las capturas: Rotated Left se lee de abajo arriba, Rotated Right de arriba abajo, Upside Down a 180° (coincide con la definición libretro de `SET_ROTATION`).

**Hilos del renderizador 3D en navegador (era [VERIFICAR])**: **sí arrancan**: con `melonds_threaded_renderer=enabled` `PThread.pthreads` = 1 worker; con `disabled` = 0. Wasm EH y `SharedArrayBuffer` funcionan en Chromium 153 desde un Worker de módulo con pthreads anidados.

**fps (medidos por la propia página; ver advertencias)**:

| Configuración | Emulador | Dibujado | Notas |
|---|---|---|---|
| WebGL2, hilos 3D, 1x | 58,5–59,8 fps | 57–57,5 fps | 17 de 358 fotogramas descartados en 6 s (≈5 %) en la segunda tanda |
| WebGL2, hilos 3D, sin límite | 66,7–68,8 fps | ≈59 fps (tope del rAF) | el buffer circular descarta sin bloquear |
| Canvas2D, sin hilos 3D, 1x | 53,9–58,5 fps | 55–56 fps | |
| Canvas2D, sin hilos 3D, sin límite | 55–58 fps | — | |

**Advertencias honestas**: VM de 4 CPU **con WebGL por software (SwiftShader) compitiendo con el emulador por la misma CPU**, ROM homebrew ligera y estática: son cifras de humo, no un benchmark, y no dicen nada de tu GPU. Las diferencias entre configuraciones están dentro del ruido. El descarte del ≈5 % a 1x viene del desfase entre los 59,83 fps del DS y el rAF (no hay sincronización por vsync, a propósito según el plan).

## No verificado [VERIFICAR]

- Chrome real con **GPU** (solo SwiftShader aquí), Firefox y Safari. Rendimiento con SoulSilver u otra ROM 3D pesada.
- «Sin parpadeo» al cambiar de layout: por diseño (el canvas se redimensiona y se redibuja en la misma tarea de rAF) y en la prueba nunca hubo un fotograma incoherente, pero no se grabó vídeo ni se midió parpadeo con GPU real.
- `captureStream()` (el canvas es el visible y tiene `preserveDrawingBuffer:true`, pero no se probó), `screenshot()` como API; botón «Captura PNG» sin probar.
- Cursor táctil / puntero con layouts girados (Fase 5): el canvas está en espacio girado, que es el que el núcleo espera tras `SET_ROTATION=true`, pero no se ha ejercitado.
- `data == NULL` en `videoCb`: implementado y publicado como «sin fotograma nuevo», nunca ocurrió (`duplicated=0`).
- Opciones no expuestas: `melonds_hybrid_ratio` (3:1), `secondary_screen_scale`, `opengl_filtering` (la demo solo usa ratio 2 y escala 100 %). Pérdida de contexto WebGL sin probar. Pantallas con `devicePixelRatio` fraccionario.
- Recreación de la ROM: cargar otra ROM recrea el worker (no se ha medido la fuga de memoria).

## Qué debes revisar en tu Chrome con SoulSilver y tu GPU

1. `npm run serve`, abre `http://127.0.0.1:8080/demo/index.html`, elige la ROM. Debe verse el juego y el panel debe mostrar `crossOriginIsolated true`, backend `webgl2`, «Hilos 3D» = 1 (con la casilla activada).
2. Recorre los 17 layouts, sobre todo los 3 girados, y mueve la separación: ¿se ve algún parpadeo o desgarro? ¿Las dos pantallas están donde dice el nombre?
3. Fps del emulador y del dibujado en la escena normal (la línea base del plan es 48 fps con EmulatorJS) a 1x y «Sin límite»; compara con y sin la casilla de hilos 3D.
4. Cambia a «Forzar Canvas2D» y comprueba que se ve igual. Prueba `scanlines` y el GLSL propio.
5. Para repetir la prueba automática con tu ROM: `node tests/phase3-browser.mjs /ruta/juego.nds` (las comprobaciones de «no negro» y de igualdad píxel a píxel valen con cualquier ROM; algunas muestras de color asumen el homebrew solo en la de `scanlines`, que usa filas 100/101).

## Siguiente paso

Fase 4 (audio): `retro_audio_sample_batch` → buffer circular → AudioWorklet, con el reloj de audio como metrónomo. El worker y el anillo de esta fase quedan como base.
