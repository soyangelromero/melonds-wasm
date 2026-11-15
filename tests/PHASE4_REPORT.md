# Informe de la Fase 4: audio

Estado (2026-11-04): **audio funcionando de extremo a extremo y probado en Chromium sin interfaz: 51/51 comprobaciones** (incluida una
corrida de **181 s ≈ 3 min** a 1x), 13 + 5 pruebas unitarias nuevas, prueba de núcleo en Node y regresiones de las fases 2-3 intactas
(`phase2-smoke` OK, `phase3-layouts` OK, `phase3-browser` 46/46, `npm test` 26 OK / 0 fallos / 1 omitida). Entrada, micrófono y guardado
siguen como `TODO(fase N)`; no se avanzó a la Fase 5. **Sin parches nuevos** en `core/patches/` (submódulo intacto).

**Lo más importante que NO demuestra esta prueba**: nadie ha *oído* nada. Chromium en la nube no tiene tarjeta de sonido; el `AudioContext`
corre contra un reloj (medido: reloj de audio / reloj de pared = 1,0007) y todo se midió dentro del `AudioWorklet` (RMS, picos, saltos entre
muestras, contadores) y en un anillo de captura. Tampoco se probó con un juego real (no hay ROM comercial): la ROM de pruebas es un homebrew propio que
toca un seno de 440 Hz. Ver «No verificado».

## Versiones

| Elemento | Valor |
|---|---|
| Emscripten | 6.0.13 (emsdk `d7b4130`, sin Docker) |
| Node | v22.23.4 |
| Chromium / Playwright | 153.0.8010.12 / 1.63.0; lanzado con `--autoplay-policy=no-user-gesture-required --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist` (además, un clic real del ratón antes de elegir la ROM) |
| AudioContext en el Chromium de la nube | 44100 Hz por defecto (también 22050, 48000 y 96000 pedidos explícitamente) |
| Núcleo | melonDS DS `f394adba` (v1.4.0), 7 parches existentes |
| ROM de pruebas | `tests/artifacts/audio-tone.nds` (generada, ignorada por git; fuente CC0 en `tests/homebrew/audio-tone/`) y `nmap.nds` (silenciosa) para las regresiones de vídeo |
| `gcc-arm-none-eabi` | 13.2.rel1 (apt), solo para compilar la ROM de pruebas |

## Comandos exactos

```bash
git submodule update --init third_party/melonds-ds
source /home/user/emsdk/emsdk_env.sh
bash scripts/build-core.sh && bash scripts/build-host.sh        # dist/melonds.{js,wasm}; build-host exporta ahora mds_get_audio* y HEAP16
sudo apt-get install -y gcc-arm-none-eabi                         # solo para la ROM de pruebas
npm run build:tone-rom                                            # = python3 tests/homebrew/audio-tone/mkrom.py tests/artifacts/audio-tone.nds
npm test                                                          # unitarias: anillo con hilo real (worker_threads), remuestreo, estados, servidor, layouts
node tests/phase4-core-audio.mjs                                  # núcleo real en Node: frecuencia, fotogramas/ejecución, contadores, tono a 440 Hz
npm run test:browser:audio                                        # = node tests/phase4-browser.mjs --gl=swiftshader --minutes=3 (≈ 6 min)
node tests/phase4-browser.mjs --skip-long                         # lo mismo sin la corrida larga (≈ 2 min); --only=A,F para secciones sueltas
npm run serve                                                     # demo manual: http://127.0.0.1:8080/demo/index.html
```
Resultados: stdout, `tests/artifacts/phase4-browser-results.json` y `tests/artifacts/phase4-browser-full.log` (log de la corrida completa citada aquí). Sin la ROM de tono las pruebas se omiten con un mensaje, no fallan.

## Qué se hizo

- **Frecuencia (hallazgo)**: el núcleo entrega **32728,498 Hz** (`33513982/1024`, `constants.hpp:26`; se anuncia en `retro_get_system_av_info` y se pasa al motor como `OutputSampleRate`), **no 32768**. El motor tiene un búfer interno con `blip` y entrega 546–548 fotogramas por `retro_run` (media medida 547,056 = 32728,498/59,826). El contrato asumía 32768: corregido (DEVIATIONS).
- **Anfitrión (`core/host/host.cpp`)**: anillo propio de 8192 fotogramas estéreo; `audioBatchCb` y `audioCb` (por muestra) escriben en él. **El núcleo solo usa el batch** (`environment.cpp:145`, `core.cpp:380`; la callback por muestra es un no-op en el núcleo, `environment.cpp:940`; `mds_get_audio_singles()` = 0). Funciones nuevas: `mds_get_audio(dst, max_frames)` (unidad = **fotograma estéreo**), `_available`, `mds_flush_audio`, `_frames_total`, `_overruns` (fotogramas descartados con el anillo lleno; se descartan los más nuevos), `_underruns` (llamadas que encontraron menos de lo pedido), `_batches`, `_singles`.
- **Anillo compartido (`js/audio-ring.js`)**: SPSC sobre `SharedArrayBuffer`, 16384 fotogramas estéreo int16 (64 KiB de datos), índices de 32 bits libres que se envuelven; el escritor (worker) solo escribe `W`, el lector (worklet) solo escribe `R`; sin bloqueos. Cabecera con contadores y un área de estadísticas `Float64` que escribe solo el worklet (RMS, picos, no nulos, mayor salto).
- **Worklet (`js/audio-worklet.js` + `js/audio-playback.js`)**: `process()` sin asignaciones ni bloqueos (comprobado: 200 000 llamadas, crecimiento de montón < 4 MiB en la prueba unitaria; las estadísticas van por el SAB, no por `postMessage`). Remuestreo **cúbico Catmull-Rom** del reloj del núcleo al del `AudioContext`; máquina de estados *cebando → sonando → sin datos*.
- **Ritmo a 1x (`js/emu-worker.js`)**: el **reloj de audio es el metrónomo**: el worklet consume en tiempo real y el worker emula un fotograma cuando el llenado está por debajo del objetivo (de otro modo duerme con `Atomics.wait`); no usa `requestAnimationFrame` ni `setTimeout` para marcar el ritmo. El worker sabe que el reloj de audio vive por un *latido* (`TICK`, +1 por `process()`): si no avanza en 150 ms (contexto suspendido o aún no creado) vuelve al temporizador de la Fase 3 y descarta el audio, sin parar el vídeo.
- **Tamaño del búfer y por qué**:
  - **Objetivo de llenado = 80 ms (2618 fotogramas)**, configurable (`audioLatencyMs`, deslizador en la demo). Debe cubrir el peor tiempo de un fotograma emulado (16,7 ms al ritmo nominal; en esta VM con SwiftShader compitiendo por CPU se vieron picos mayores) más la fluctuación del planificador del worker más un cuanto de render (128 muestras = 2,9 ms). Menos de ~50 ms da underruns en cuanto un fotograma tarda más de la cuenta; más de ~150 ms se nota como retardo entre botón y sonido.
  - **Capacidad = 16384 fotogramas (≈ 500 ms)**: potencia de dos (máscara en vez de módulo), unas 6× el objetivo. Solo tiene que absorber una ráfaga, no el régimen normal; la latencia real la fija el objetivo, no la capacidad.
  - El llenado en régimen oscila entre el objetivo y objetivo + un fotograma del DS (+16,7 ms); media medida **81,5 ms**.
- **Si se vacía (underrun)**: el worklet deja de leer, la última muestra **decae exponencialmente** (τ = 2 ms) en vez de cortarse, cuenta **un** evento por episodio y muestras de silencio, y **no vuelve a sonar hasta tener el objetivo completo** (así no tartamudea) con una **rampa de entrada de 6 ms**.
- **Si se llena (overrun)**: (1) el escritor, si no cabe, **descarta los fotogramas más nuevos** y los cuenta (nunca toca `R`); (2) el lector, con llenado > 2× objetivo, reproduce un **2 % más rápido** (histéresis hasta < 1,25×) y (3) con > min(90 % de la capacidad, 5× objetivo) **salta** los fotogramas más antiguos hasta el objetivo y los cuenta. Con el worker actual el productor ya duerme mientras el llenado supera el objetivo, así que el exceso se drena solo en tiempo real; las tres defensas protegen contra un productor que no respete el llenado.
- **Velocidad ≠ 1x**: el audio **se silencia** (rampa de 6 ms, se descarta el resto, no se cuenta como underrun) y vuelve solo al volver a 1x. Decisión: a 2x el audio acelerado suena agudo y «sin límite» pide >100 fps estables.
- **Pausa/reanudación**: `pause()` pone el indicador `PAUSED` al instante (no espera al worker); el worklet hace una rampa de 6 ms con el audio real, descarta lo que queda y calla; al reanudar vuelve a cebar y entra con rampa.
- **Volumen/silencio**: un `GainNode` con `setTargetAtTime` (τ = 15 ms, ~50 ms para asentarse); `setMuted` recuerda el volumen. **Primer gesto**: el contexto no se crea hasta que `navigator.userActivation.hasBeenActive` o el primer `pointerdown/keydown/touchend/click` (así el navegador no avisa de autoplay); mientras tanto el emulador corre con temporizador. En la demo basta con hacer clic en el selector de archivo; hay además un botón «Activar audio».
- **`captureStream(fps)`**: `new MediaStream([canvas.captureStream(fps) vídeo + MediaStreamAudioDestinationNode audio])`. El audio sale **antes** del `GainNode`: silenciar en local no deja mudo al invitado.
- **Demo**: volumen, silencio, latencia objetivo, botón de audio, y un panel con estado del `AudioContext` (frecuencia, latencia de salida, quién marca el ritmo), búfer en ms, underruns/overruns/recortes/acelerado, y nivel (RMS, pico, máximo salto).

## Resultados reales

**Unitarias (`npm test`, 26 OK / 1 omitida)**
- *Anillo con hilo real* (`worker_threads`, `SharedArrayBuffer`): 3 000 000 fotogramas en trozos aleatorios de 1–2048 con un anillo de 4096 (≈ 700 vueltas): llegan en orden, completos y sin alterar; overrun: se descartan los más nuevos, el recuento es exacto y los más antiguos sobreviven; con un hilo productor que no respeta el espacio el escritor **no se bloquea**; los índices de 32 bits se envuelven correctamente más allá de 2³¹.
- *Remuestreo* (mismo código que corre en el worklet): tono de 1 kHz a 22 050/44 100/48 000/96 000 Hz: pico a ±0,05 Hz, amplitud ±1 %, **SNR > 45 dB**; consumo exacto de `srcRate/ctxRate` fotogramas por muestra (60 s a 48 kHz, error < 2 fotogramas ⇒ **deriva 0**); a 6 kHz el cúbico da **32,8 dB frente a 24,8 dB del lineal (+8 dB)**; cebado sin underrun falso; underrun = 1 evento por episodio, sin click, recuperación solo tras re-cebar; pausa: rampa, vaciado y silencio; catch-up del 2 %; recorte por ráfaga; estadísticas; sin asignaciones.

**Núcleo en Node (`phase4-core-audio.mjs`, ROM de tono)**: 32 728,498 Hz / 59,826 fps = 547,061 fotogramas de audio por fotograma; 546–548 por `retro_run`, media 547,056; 360 batches, 0 por muestra; RMS 0,1349, pico 0,1906; frecuencia dominante **440 Hz** (la ROM programa 440,04); L == R (pan centrado); contadores del anfitrión: 40 fotogramas sin drenar ⇒ el anillo se llena con 8192 y descarta 13 691; `mds_get_audio` sobre un anillo vacío cuenta un underrun.

**Navegador (`phase4-browser.mjs`, 51/51, 3 min reales)**

| # | Qué | Resultado |
|---|---|---|
| A | El worklet recibe muestras no nulas | 99,97 % de los fotogramas con señal (263 680); RMS **0,1349** (= el del núcleo), pico 0,1907; sin underruns |
| A | Reloj de audio como metrónomo | 59,83 fotogramas emulados por segundo de tiempo de audio (corrida larga: **59,828**); reloj de audio / reloj de pared = 1,0007 |
| A | Tono tras remuestrear (captura del worklet a 44 100 Hz) | **440,05 Hz** (esperado 440,04) |
| B | Con `requestAnimationFrame` muerto 8 s (lo que hace una pestaña oculta) | dibujo parado (Δ 0 fotogramas) pero la emulación sigue a **60,09 fps**, 0 underruns, búfer 72 → 79 ms; el dibujo se reanuda después |
| C | 2x y «sin límite» | silencio (RMS 0,00000), sin underruns falsos, 119,9 y ≈ 270 fps; al volver a 1x suena en ~0,5 s, RMS 0,1349, sin click |
| D | Pausa/reanudación | rampa sin salto > la pendiente del propio tono (0,0129 < 0,0184), anillo vaciado, la emulación se detiene; al reanudar suena a los **46 ms**, sin click ni underrun |
| E | Volumen y silencio (medido tras el `GainNode`) | `setVolume(0.5)` ⇒ RMS ×0,500; sin click; `setMuted(true)` ⇒ RMS 0 en < 0,8 s; al reactivar vuelve a 0,5 (no a 1); fuera de rango ⇒ `RangeError` |
| F1-3 | **Vacío**: el worker se bloquea 400 ms | exactamente **1 underrun**, **333 ms** de silencio/decaimiento, vuelve a sonar a los 431 ms, salto máximo 0,0149 (sin click) |
| F4-5 | **Exceso moderado**: +10 fotogramas del DS de golpe | el búfer sube a **213 ms**, vuelve a < 100 ms en **164 ms**, 5376 fotogramas reproducidos al +2 %, **0 descartados**, 0 underruns, sin click |
| F6-7 | **Ráfaga**: 100 fotogramas del DS (≈ 1,7 s de audio) | el lector recorta (33 869 fotogramas), **el escritor no llegó a descartar** (0): el lector recorta antes de que el anillo se desborde; búfer vuelve a 87 ms |
| G | `captureStream(30)` | 1 pista de vídeo + 1 de audio, ambas `live`; `<video>` presenta 76 fotogramas en 2,5 s (256×384); el audio capturado tiene RMS 0,1350; **con el silencio local activado el audio capturado sigue igual (0,1349)**; `MediaRecorder` (`video/webm;codecs=vp8,opus`, 3 s, 52 KB) se decodifica de vuelta a 3,00 s estéreo con RMS 0,1348 |
| H | Otros `AudioContext` (22 050, 48 000, 96 000 Hz) | el contexto corre realmente a esa frecuencia; 440,05 Hz, RMS 0,1349, 0 underruns, sin click |
| I | **181 s (3 min) a 1x** | `audioBufferMs`: **media 81,5 ms, desv. 6,0, mín 68,4, máx 96,3**; tendencia **0,225 ms/min** (sin deriva); **0 underruns, 0 overruns, 0 recortes, 0 aceleraciones**; salto máximo entre muestras 0,0149 (< pendiente natural del tono ×1,5); RMS por ventanas de 10 s constante en 0,1349 |
| Z | Consola | **sin errores** de consola, de página ni peticiones fallidas (0 avisos propios) |

Duración real de la corrida larga: **181 s (≈ 3 min)**, no los 5 minutos del criterio de la fase; el resto de secciones suman ≈ 2,5 min más con el mismo contexto.

## No verificado [VERIFICAR]

- **Nadie ha oído el audio.** No hay dispositivo de sonido en la nube: no se comprobó la salida real, la latencia de hardware (`outputLatency` del Chromium en la nube es simulada, ~42 ms), ni chasquidos del controlador/DAC. «Sin chasquidos» está medido como *ausencia de saltos entre muestras superiores a la pendiente natural del tono* en la salida del worklet y tras el `GainNode`.
- **5 minutos**: se hicieron 3 (181 s) a 1x en una sola corrida; los 5 min del criterio no se cubrieron. La tendencia (0,225 ms/min) es compatible con cero, pero con 3 min no se puede descartar una deriva más lenta.
- **Un juego real**: la ROM de prueba es un seno constante. No se probó música real, ni SPU con ADPCM/PSG/ruido, ni cambios bruscos de volumen del juego, ni cargas de CPU de SoulSilver.
- **Emulador más lento que el tiempo real**: si tu CPU no llega a 59,83 fps (línea base del plan: 48 fps con EmulatorJS; con este port en la nube la Fase 3 midió 54–59 fps con SwiftShader compitiendo), el búfer se vaciará periódicamente y oirás **cortes periódicos** (silencio de ~100–200 ms con rampas) y el juego irá a < 1x: el diseño no hace *time-stretching*. Con la ROM de tono nunca ocurrió (el homebrew es ligero). **Es el riesgo principal para SoulSilver.**
- **Pestañas en segundo plano reales**: se simuló matando `requestAnimationFrame`, no ocultando una pestaña. Chrome puede congelar/suspender pestañas (Tab Freezing, ahorro de energía), el `AudioContext` puede suspenderse (en ese caso el worker detecta el latido parado a los 150 ms y vuelve al temporizador) y el comportamiento de Firefox/Safari no se probó.
- **Firefox y Safari**: no probados (AudioWorklet con `SharedArrayBuffer` y `Atomics` deberían funcionar en Firefox; Safari no se ha mirado).
- **Remuestreo a < 32,7 kHz** (22 050 Hz probado) sin filtro antialiasing: con un tono de 1 kHz/440 Hz no se nota; contenido con muchos agudos (> 11 kHz) se plegaría. Nunca se prueba con música.
- **Micrófono** (`GET_MICROPHONE_INTERFACE` sigue en false) y la callback por muestra (nunca la usa el núcleo).
- `Canvas2D` + audio: la prueba usa el backend por defecto (WebGL2 sobre SwiftShader); `captureStream()` con Canvas2D no se probó.
- Efecto del `deviceScaleFactor`/DPI y de `AudioContext.outputLatency` real en la sincronía audio-vídeo percibida: el vídeo se dibuja al último fotograma publicado, que va por delante del audio que suena en (búfer ≈ 80 ms + latencia de salida); no hay compensación (retraso del vídeo) todavía.

## Qué debes revisar/oír en tu Chrome con SoulSilver

1. `npm run serve`, abre `http://127.0.0.1:8080/demo/index.html`, **haz clic en «Elegir ROM»** (ese clic desbloquea el audio) y elige SoulSilver. Debe sonar la intro. En el panel: `AudioContext` = `running`, «reloj de audio = metrónomo», búfer ≈ 80 ms, underruns 0.
2. **Escucha**: ¿chasquidos al empezar, al pausar/reanudar, al mover el volumen o al silenciar? ¿El tono de la música es el correcto (no agudo/grave)? ¿Cortes periódicos? Si los hay, mira si el «Emulador» de la demo baja de 59,8 fps (el límite es la CPU) y prueba a subir la latencia objetivo a 150–250 ms (la demo la fija al cargar) para ver si desaparecen.
3. Deja la demo ≥ 5 minutos a 1x en una escena normal y anota el búfer, los underruns/overruns y el «máx. salto»: el búfer debe quedarse en 70–100 ms; cualquier underrun merece un vistazo a la carga de CPU.
4. Cambia de pestaña (o minimiza) un minuto y vuelve: ¿el juego siguió a ritmo normal, sin acumulado de audio atrasado ni «ráfaga» al volver? (no pude comprobarlo.)
5. Pon 2x y «Sin límite»: el audio debe callar limpiamente y volver al volver a 1x.
6. `captureStream`: en la consola de la demo, `__demo.player.captureStream(30)` devuelve el `MediaStream` (vídeo + audio); asígnalo a un `<video>` para verlo/oírlo, y comprueba que silenciar en la demo no lo silencia.
7. Compara el audio con la tabla de rendimiento del plan (≥ 60 fps estables): si tu CPU no llega, es esperable que se oigan cortes.

## Siguiente paso

Fase 5 (entrada y pantalla táctil): `mds_set_key_mask`/`mds_set_pointer`, teclado, mando y `touchFromCanvas`. Pendientes de audio para fases posteriores: micrófono (`setMicInput`), compensar el retardo de vídeo respecto al audio si se nota con juegos reales, y, si SoulSilver no llega a 60 fps, estudiar *time-stretching* en el worklet en lugar de silencio.
