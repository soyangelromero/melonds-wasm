# Contrato de API de `melonds-wasm`

Este contrato tiene que cumplirse **tal cual** para que el port sea (a) usable por sí solo y (b) intercambiable con el
núcleo actual de la web app mediante `adapters/webapp-adapter.js`. Si algo no se puede cumplir, se documenta en
`tests/DEVIATIONS.md` en lugar de cambiarlo en silencio.

## 1. Principios

- Biblioteca **ES module** sin variables globales; todo cuelga de una instancia.
- **No** hace peticiones de red por su cuenta. Quien la usa le pasa los bytes (ROM, firmware, BIOS, guardado).
- **No** contiene ROM, BIOS ni firmware de Nintendo.
- Funciona con y sin hilos; la elección es automática (`threads: "auto"`).
- Cada método asíncrono devuelve una `Promise`; los errores son `Error` con `code` (`"ROM_INVALID"`, `"NO_THREADS"`, …).

## 2. API de la clase `MelonDS`

```ts
type Button = "A"|"B"|"X"|"Y"|"L"|"R"|"START"|"SELECT"|"UP"|"DOWN"|"LEFT"|"RIGHT"|"LID";
// Los 17 valores que acepta el núcleo (opciones melonds_screen_layoutN; las etiquetas están en
// src/libretro/config/definitions/screen.hpp y las claves internas en src/libretro/config/constants.hpp):
type Layout =
  | "Top/Bottom" | "Bottom/Top" | "Left/Right" | "Right/Left" | "Top Only" | "Bottom Only"
  | "Large Screen (Focus Top)" | "Large Screen (Focus Bottom)"
  | "Flipped Large Screen (Focus Top)" | "Flipped Large Screen (Focus Bottom)"
  | "Hybrid (Focus Top)" | "Hybrid (Focus Bottom)" | "Flipped Hybrid (Focus Top)" | "Flipped Hybrid (Focus Bottom)"
  | "Rotated Left" | "Rotated Right" | "Upside Down";
// El anfitrión traduce estas etiquetas a las claves que espera el núcleo
// (tabla 2.1); no se pasan tal cual a melonds_screen_layout1.

interface CreateOptions {
  canvas?: HTMLCanvasElement; // si falta, solo hay API de fotogramas (modo headless); OffscreenCanvas no se admite porque captureStream() necesita el canvas visible del hilo principal
  threads?: "auto" | true | false;              // true exige SharedArrayBuffer
  locateFile?: (name: string) => string;        // dónde están melonds*.wasm / worker / worklet
  audio?: boolean;                              // por defecto true
}

class MelonDS {
  static create(opts?: CreateOptions): Promise<MelonDS>;

  // --- ciclo de vida ---
  loadRom(rom: Uint8Array, opts?: { save?: Uint8Array | null }): Promise<RomInfo>; // RomInfo = {title, code, size, saveType}
  start(): void;  pause(): void;  resume(): void;  reset(): void;  dispose(): void;
  readonly running: boolean;  readonly paused: boolean;

  // --- firmware / BIOS (ANTES de loadRom) ---
  setFirmware(fw: Uint8Array | null, settings?: { language?: 0|1|2|3|4|5; nickname?: string; birthday?: [number, number]; favoriteColor?: number; mac?: number[] }): void; // null = generado por melonDS
  setBios(b: { arm7?: Uint8Array; arm9?: Uint8Array } | null): void;  // null = FreeBIOS

  // --- velocidad ---
  setSpeed(multiplier: number): void;   // 1 = normal; 2, 3, 4...; 0 = sin límite
  getFrameCount(): number;              // fotogramas emulados desde loadRom (equivale a getFrameNum de EmulatorJS)

  // --- vídeo ---
  setLayout(l: Layout): void;               // traduce la etiqueta a la clave del núcleo (tabla 2.1) y fija melonds_screen_layout1 + melonds_number_of_screen_layouts=1; el núcleo emite la nueva geometría
  setScreenGap(px: number): void;           // 0..126
  setHybridSmallScreen(s: "one" | "both"): void; // one = mostrar la pantalla opuesta; both = mostrar ambas (antiguo "Duplicate")
  setPostProcess(shader: { glsl: string } | null): void; // filtro opcional (WebGL2); null = nítido. `glsl` es un fragmento GLSL ES 3.00 que define `vec4 mds_post(vec2 uv)` (uv 0..1, y hacia abajo, sobre el fotograma mostrado) y puede usar `mds_fetch(uv)` (RGBA ya convertido y rotado), `u_size` y `u_frameSize`. Si no compila se conserva el filtro anterior y se devuelve {ok:false,error} (Fase 3; el contrato `void` se mantiene en la clase final lanzando Error). Canvas2D no admite filtros
  screenshot(): Promise<Blob>;              // PNG del lienzo; Error("NO_CANVAS") en modo headless
  getFrame(): { width: number; height: number; stride: number; rotation: 0|1|2|3; format: "XRGB8888"; data: Uint8Array }; // fotograma compuesto por el núcleo, SIN rotar; data.length === stride * height y `stride` puede incluir padding. `rotation` (añadido en la Fase 3): giros de 90° antihorarios que el anfitrión debe aplicar (layouts Rotated Left/Right y Upside Down); el canvas ya los aplica y su tamaño es el del fotograma rotado
  captureStream(fps?: number): MediaStream; // vídeo (canvas.captureStream) + audio (MediaStreamAudioDestinationNode) en un solo MediaStream; exige canvas visible y audio ya iniciado (si no, Error code "AUDIO_NOT_STARTED"); el audio sale ANTES del volumen/silencio locales

  // --- audio (Fase 4) ---
  setVolume(v: number): void;  // 0..1 (RangeError fuera de rango); lineal, con rampa de ~50 ms (GainNode.setTargetAtTime), sin chasquidos
  setMuted(m: boolean): void;  // mismo GainNode; recuerda el volumen. No afecta a captureStream(): un invitado WebRTC sigue oyendo
  // El AudioContext se crea y se reanuda tras el primer gesto del usuario (pointerdown/keydown/touchend/click, o
  // navigator.userActivation.hasBeenActive); antes de eso el emulador corre con temporizador y descarta el audio.
  // A 1x el reloj de audio es el metrónomo del emulador. A 2x/sin límite el audio se SILENCIA (decisión, ver DEVIATIONS).

  // --- entrada ---
  button(b: Button, down: boolean, player?: 0): void;
  touchFromCanvas(nx: number, ny: number, state: "down"|"move"|"up"): void; // 0..1 respecto al rectángulo dibujado del fotograma (sin barras negras); solo NORMALIZA y alimenta el puntero libretro, el diseño lo resuelve el núcleo
  // No hay touch(x, y) en coordenadas DS: exigiría la inversa del mapeo de layout, que el núcleo no expone.
  attachKeyboard(el?: EventTarget, map?: Record<string, Button>): () => void; // devuelve la función de desconexión
  attachGamepad(): () => void;
  setMicInput(source: MediaStream | null): void;

  // --- guardado ---
  getSave(): Uint8Array | null;            // bytes crudos (.sav) de la partida en curso. REAL (Fase 6): `player.saves.getSave()` devuelve la última copia en caché (≤ ~170 ms de retraso); `await player.saves.getSaveNow()` es exacto
  loadSave(data: Uint8Array): void;        // aplica y reinicia el cartucho (equivale a loadSaveFiles + restart). REAL: `player.saves.loadSave()` → Promise<{resized}>
  onSave(cb: (bytes: Uint8Array) => void, debounceMs?: number): () => void; // se llama cuando la SRAM cambió y se estabilizó
  saveState(): Uint8Array;                 // formato propio versionado con SRAM y CRC (ver sección 6). REAL (Fase 6): `player.saves.saveState()` → Promise<Uint8Array>
  loadState(data: Uint8Array): void;       // REAL: `player.saves.loadState(data)` → Promise<void>; rechaza con STATE_VERSION / STATE_INCOMPATIBLE / STATE_CORRUPT / STATE_UNSUPPORTED / NO_ROM

  // --- trucos (Action Replay) ---
  setCheat(id: number, enabled: boolean, code: string): void; // ver sección 4; `id` es estable (el anfitrión lo traduce a una ranura del núcleo). REAL (integración): `VideoPlayer.setCheat` → Promise<void>; rechaza con Error.code CHEAT_* (BAD_TOKEN, ODD_WORDS, EMPTY, NO_ROM…); con `code` vacío y un id conocido solo cambia `enabled`
  clearCheats(): void;                     // REAL: Promise<void>

  // --- estadísticas ---
  getStats(): { fps: number; emuMs: number; renderMs: number; audioBufferMs: number; threads: boolean };
  // audioBufferMs (Fase 4) = audio emulado pendiente de reproducir en el anillo compartido, en ms (instantáneo: oscila entre el
  // objetivo, 80 ms por defecto, y objetivo + 16,7 ms). La implementación de la Fase 4 (VideoPlayer.getStats()) añade además
  // `audio: { fillFrames, bufferMs, sourceRate, contextRate, mode, underrunEvents, underrunFrames, overrunFrames, overrunEvents,
  //   trimmedFrames, catchupFrames, sumSq, framesOut, nonZeroFrames, peak, maxJump, contextState, outputLatencyMs }`.

  // --- eventos ---
  on(event: "frame"|"ready"|"error"|"paused"|"resumed", cb: Function): () => void;
}
```

### 2.1 Traducción de `Layout` a las claves del núcleo

`retro_environment(GET_VARIABLE)` devuelve el **valor** de la opción, no su etiqueta. Para
`melonds_screen_layout1..8` el núcleo espera estas claves (`src/libretro/config/constants.hpp`):

| `Layout` (API) | Valor del núcleo |
|---|---|
| `Top/Bottom` | `top-bottom` |
| `Bottom/Top` | `bottom-top` |
| `Left/Right` | `left-right` |
| `Right/Left` | `right-left` |
| `Top Only` | `top` |
| `Bottom Only` | `bottom` |
| `Large Screen (Focus Top)` | `largescreen-top` |
| `Large Screen (Focus Bottom)` | `largescreen-bottom` |
| `Flipped Large Screen (Focus Top)` | `flipped-largescreen-top` |
| `Flipped Large Screen (Focus Bottom)` | `flipped-largescreen-bottom` |
| `Hybrid (Focus Top)` | `hybrid-top` |
| `Hybrid (Focus Bottom)` | `hybrid-bottom` |
| `Flipped Hybrid (Focus Top)` | `flipped-hybrid-top` |
| `Flipped Hybrid (Focus Bottom)` | `flipped-hybrid-bottom` |
| `Rotated Left` | `rotate-left` |
| `Rotated Right` | `rotate-right` |
| `Upside Down` | `rotate-180` |

`setLayout()` aplica esta tabla antes de escribir la opción. `setHybridSmallScreen("one"|"both")`
se traduce a `melonds_hybrid_small_screen` con los valores `one` y `both`.

## 3. Equivalencias con lo que hoy usa la web app (para el adaptador)

La web app (`nds/index.html`) usa estas llamadas de EmulatorJS. El adaptador las implementa sobre `MelonDS`:

| Web app / EmulatorJS | MelonDS | Notas |
|---|---|---|
| `gameManager.setCheat(index, enabled, code)` | `setCheat(index, enabled, code)` | `code` en formato libretro `A+B+C…`, ver 4 |
| `gameManager.toggleFastForward(0/1)` + `setFastForwardRatio(r)` | `setSpeed(r)` (`r=0` ⇒ sin límite) | `1` al desactivar |
| `gameManager.setVSync(0/1)` | sin equivalente: ignorar | el ritmo lo lleva el port |
| `gameManager.getFrameNum()` | `getFrameCount()` | para el medidor de fps |
| `gameManager.setVariable("melonds_screen_layout", v)` | `setLayout(map[v])` | `"Top/Bottom"→"Top/Bottom"`, `"Left/Right"→"Left/Right"`, `"Hybrid Top"→"Hybrid (Focus Top)"`, `"Top Only"→"Top Only"`; la tabla 2.1 traduce la etiqueta a la clave del núcleo. La opción antigua `melonds_screen_layout` ya no existe |
| `gameManager.setVariable("melonds_screen_gap", n)` | `setScreenGap(+n)` | |
| `gameManager.setVariable("melonds_hybrid_small_screen", v)` | `setHybridSmallScreen(map[v])` | `"Duplicate"→"both"`; `"Top"` y `"Bottom"`→`"one"` (la distinción antigua se pierde: el núcleo elige la pantalla pequeña según el foco del layout híbrido) |
| `gameManager.getSaveFile()` | `getSave()` | |
| `FS.writeFile(getSaveFilePath(), bytes)` + `loadSaveFiles()` + `restart()` | `loadSave(bytes)` | |
| `gameManager.restart()` | `reset()` | |
| `gameManager.quickSave/quickLoad` | `saveState()/loadState()` | opcional; guardar bytes en IndexedDB |
| `ejs.setVolume(0..1)` | `setVolume(v)` | |
| `ejs.screenshot(cb)` | `screenshot()` | |
| `ejs.pause()/play()`, `ejs.paused` | `pause()/resume()`, `paused` | |
| `ejs.canvas`, `ejs.toggleFullscreen` | el `canvas` pasado a `create` | |
| `ejs.enableShader(name)` | `setPostProcess({glsl})` | los nombres de filtros los define el adaptador |
| `ejs.config.threads` | `getStats().threads` | |
| toques remotos (`MouseEvent` sintético sobre el lienzo) | `touchFromCanvas(nx, ny, state)` | coordenadas respecto al rectángulo dibujado del fotograma, no al canvas con barras |
| `EJS_emulator.netplay` (host) | ver 7 | la web app tiene su propio flujo de invitados |
| BIOS/firmware (`EJS_externalFiles`) | `setBios` / `setFirmware` | el adaptador pasa el firmware generado de `reference/firmware.js` o el real |

La web app guarda también por su cuenta: partidas en IndexedDB (EmulatorJS) o descargas `.sav` (exportar/importar), y
los trucos activos en `localStorage`. El port solo expone bytes y eventos.

## 4. Formato de trucos

- Entrada: texto en formato libretro (el mismo que acepta `retro_cheat_set`): palabras de 32 bits en hexadecimal, **separadas por `+`**, ejemplo real de la web app:
  `94000130+FFFB0000+62101F2C+00000000+B2101F2C+00000000+2000E302+00000001+D2000000+00000000`.
  También se aceptan líneas separadas por salto de línea o espacios, y pares `XXXXXXXX XXXXXXXX`.
- Si `retro_cheat_set` del núcleo ya acepta ese formato, se le pasa tal cual; si no, el port lo convierte a lo que el núcleo espere **[VERIFICAR]**.
- `setCheat(id, true, code)` crea o reemplaza el código `id` y lo activa; `setCheat(id, false, code)` lo desactiva
  **sin** necesidad de reiniciar. `clearCheats()` los quita todos.
- **Ranuras (verificado en `core.cpp`):** `retro_cheat_set(index, …)` usa `index` como **posición en un vector** (reemplaza si
  `index < tamaño`, añade al final si no). El anfitrión mantiene `Map<id, slot>`: id nuevo ⇒ siguiente ranura libre; id existente ⇒
  su misma ranura; `clearCheats()` ⇒ `retro_cheat_reset()` y vaciar el mapa. Los ids pueden ser dispersos (los del catálogo).
- **Desactivar no revierte** lo que el código ya escribió en RAM (el motor solo deja de reaplicarlo). Se documenta en
  `tests/DEVIATIONS.md`; un revert real exigiría cargar un estado o guardar los bytes originales (fuera de alcance).
- Los códigos con "master code" o tipo `D2` (fin) y condicionales deben ejecutarse como en melonDS escritorio.
- Prueba de aceptación: los cuatro catálogos de `nds/cheats/{CPUS,IPGS,IRBS,IRES}.json` (campos `n` nombre, `c` código,
  ~1400-2200 cada uno) cargan sin error y al menos 10 códigos conocidos hacen efecto (dinero, MTs, atravesar paredes).

## 5. Entrada (compatibilidad con libretro y con la sala online)

La sala online de la web app envía por un canal de datos JSON `{player, index, value}` con la numeración libretro:

| index | botón | index | botón |
|---|---|---|---|
| 0 | B | 8 | A |
| 1 | Y | 9 | X |
| 2 | SELECT | 10 | L |
| 3 | START | 11 | R |
| 4 | UP | 5 | DOWN |
| 6 | LEFT | 7 | RIGHT |

El adaptador traduce `index` ⇒ `Button`. `value` es `1` (pulsado) o `0`.

Teclas por defecto: flechas = cruceta, `Z`=A, `X`=B, `A`=X, `S`=Y, `Q`=L, `E`=R, `Enter`=START, `V`=SELECT
(deben coincidir con la pestaña "Controles" de la web app).
Los eventos de teclado **no** deben dejar que la página haga scroll con las flechas/espacio mientras se juega.

**Fase 5 (implementado en `js/input.js`; detalles en `tests/PHASE5_REPORT.md`):** las teclas se identifican por `KeyboardEvent.code` (posición física; el mapa personalizado también acepta `event.key`); el mando usa la Gamepad API con mapeo `standard`; `LID` = L2+Y del núcleo (alterna la tapa) y se añade `MIC` = L3 como extensión del tipo `Button`; `attachPointer(canvas)` (ratón/táctil/lápiz con Pointer Events) es el complemento DOM de `touchFromCanvas`.

## 6. Guardado y estados

- `getSave()` devuelve los bytes **exactos** que escribiría melonDS escritorio en un `.sav` (compatibles con
  melonDS, DeSmuME y flashcarts). El tamaño depende del juego (p. ej. 512 KB en Negra/Blanca, 512 KB en Platino).
  **[VERIFICAR]** que melonDS no añade cabeceras.
- `onSave` debe dispararse unos cientos de ms después de que el juego deje de escribir (no en cada escritura).
- `saveState()` devuelve un contenedor propio (porque `retro_serialize` no incluye la memoria de guardado, que se pide aparte con
  `retro_get_memory_data(RETRO_MEMORY_SAVE_RAM)`):

  ```
  magic    "MDSSTATE" (8 bytes)
  version  uint32 LE
  flags    uint32 LE (reservado, 0)
  coreAbi  uint32 LE (identificador corto de la compilación del núcleo)
  sramLen  uint32 LE
  stateLen uint32 LE
  sram     sramLen bytes
  state    stateLen bytes (blob de retro_serialize)
  crc32    uint32 LE sobre sram + state
  ```
  `coreAbi` puede ser el CRC32 de los primeros 4 bytes del SHA-1 del commit del núcleo o cualquier
  identificador estable que cambie con la compilación. `loadState` valida magic, versión, `coreAbi`,
  longitudes y CRC, y lanza `STATE_VERSION`, `STATE_INCOMPATIBLE` o `STATE_CORRUPT` según corresponda.
  La prueba de ida y vuelta debe incluir una SRAM modificada, no solo el fotograma.
- **Formato de píxel:** el núcleo entrega **XRGB8888** (no RGBA). Se mantiene así hasta el final y la conversión se hace en el shader.

## 7. Multijugador (host por WebRTC)

El servidor de señalización de la web app (`server.mjs`, Socket.IO) habla este protocolo y **ya funciona** con la
página de invitados `nds/join.html`; el port debe poder ser el "anfitrión":

- Eventos del socket: `open-room {extra, maxPlayers, password}` (ack), `join-room`, `users-updated`, `data-message`,
  `webrtc-signal {target, offer|answer|candidate}` (el servidor añade `sender`), `leave-room`.
- El anfitrión crea, por cada invitado, un `RTCPeerConnection` y **envía la oferta**: añade las pistas de
  `captureStream()` (vídeo + audio) y crea el canal de datos `"inputs"` (`ordered: true`).
- Mensajes del canal: JSON `{player, index, value}` (tabla de la sección 5) o `{type: "host-left"}`.
- Por el socket (`data-message`) llegan además `{touch: {x, y, s}}` con `x,y` en 0..1 respecto al vídeo y
  `s ∈ {"down","move","up"}`: se traducen a `touchFromCanvas`.
- STUN público: `stun:stun.l.google.com:19302`. Sin TURN.
- Entregable de la Fase 12: un módulo `adapters/netplay-host.js` independiente de la web app (recibe una instancia
  `MelonDS`, una URL de socket y el nombre de sala) que cumple lo anterior.

## 8. Anfitrión libretro y API C exportada (referencia para el implementador)

El motor es **melonDS DS v1.4.0**, un núcleo libretro. El anfitrión propio implementa la API libretro del lado del frontend:
`retro_set_environment`, `retro_set_video_refresh`, `retro_set_audio_sample_batch`, `retro_set_input_poll`,
`retro_set_input_state`, `retro_init`, `retro_load_game`, `retro_run`, `retro_reset`, `retro_get_memory_data/size`
(`RETRO_MEMORY_SAVE_RAM`), `retro_serialize_size/serialize/unserialize`, `retro_cheat_reset/retro_cheat_set`, y los
`RETRO_ENVIRONMENT_*` que el núcleo pida (directorio del sistema, variables, formato de píxel, log, micrófono, etc.).
Opciones del núcleo relevantes (leídas del código de v1.4.0; **[VERIFICAR]** los valores exactos de cada una):
`melonds_screen_layout1`…`melonds_screen_layout8` y `melonds_number_of_screen_layouts` (**cambian respecto al núcleo antiguo,
que usaba `melonds_screen_layout`**), `melonds_screen_gap` (0-126), `melonds_hybrid_small_screen`, `melonds_hybrid_ratio`,
`melonds_opengl_filtering`, más las de firmware, audio y CPU. El adaptador traduce los nombres antiguos a estos.

Nombres sugeridos para las funciones C exportadas (prefijo `mds_`); el implementador puede ajustarlos mientras la API JS de
la sección 2 no cambie:

```
mds_create(verbose) / mds_destroy      // REAL (Fase 2): verbose = 0|1; los hilos del renderizador 3D se eligen con mds_set_option("melonds_threaded_renderer","enabled"|"disabled") ANTES de mds_load_rom
mds_set_option(key,value)               // REAL: opciones del núcleo (melonds_*); los cambios se aplican en el siguiente mds_run_frame
mds_get_frame_serial() / mds_get_frame_rotation()   // REAL (Fase 3): serial estable si el núcleo repitió fotograma (data==NULL); rotación 0..3 a aplicar
mds_get_geometry(&bw,&bh,&mw,&mh,&aspect) / mds_get_geometry_serial() / mds_get_fps() / mds_get_sample_rate()  // REAL (Fase 3): lo anunciado por SET_GEOMETRY / SET_SYSTEM_AV_INFO / retro_get_system_av_info
mds_set_firmware(ptr,len,flags,...) / mds_set_bios(ptr7,len7,ptr9,len9)
mds_load_rom(ptr,len,save_ptr,save_len) -> int (0 = ok)
mds_run_frame()                     // un fotograma; usado por el bucle del worker
mds_get_frame(unsigned *width, unsigned *height, size_t *stride) -> const void* // fotograma compuesto XRGB8888; válido hasta el siguiente mds_run_frame
mds_copy_frame(void *dst, size_t dst_len, unsigned *width, unsigned *height, size_t *stride) -> size_t
mds_get_audio(int16_t *dst, size_t max_frames) -> n   // REAL (Fase 4): PCM estéreo 16 bit intercalado (L,R); unidad = FOTOGRAMAS estéreo (un par), no valores int16; frecuencia = mds_get_sample_rate() = 33513982/1024 = 32728,498 Hz (NO 32768; constants.hpp SAMPLE_RATE). ~547 fotogramas por mds_run_frame (546..548); máximo 2048
mds_get_audio_available() / mds_flush_audio()          // REAL (Fase 4): pendientes en el anillo del anfitrión (8192 fotogramas) / descartarlos
mds_get_audio_frames_total() / _overruns() / _underruns() / _batches() / _singles()   // REAL (Fase 4): overruns = fotogramas DESCARTADOS (anillo lleno: se tiran los más nuevos); underruns = llamadas a mds_get_audio que encontraron menos de lo pedido; singles = 0 siempre (el núcleo no usa retro_audio_sample)
mds_set_key_mask(mask) / mds_set_pointer(nx,ny,pressed) / mds_get_input_queries() // REAL (Fase 5): mask = bit i ↔ RETRO_DEVICE_ID_JOYPAD_i (B=0 … R=11, L2=12, L3=14); nx,ny normalizados -32767..32767 en el espacio del fotograma MOSTRADO (ya girado), (0,0) sin pulsar = puntero ausente; el núcleo resuelve layout, hueco, híbrido y rotación; queries = diagnóstico de lo que el núcleo pide
mds_get_save(ptr_out,len_out) / mds_set_save(ptr,len)
mds_save_state(ptr_out,len_out) / mds_load_state(ptr,len)
mds_cheat_set(id,enabled,ptr,len) / mds_cheat_clear()
mds_get_frame_count() / mds_get_stats(ptr)
```

## 9. Requisitos no funcionales

- Arranque en frío del wasm + ROM de 128 MB < 3 s tras la descarga (sin contar la red).
- Sin copias innecesarias de la ROM (pasarla una vez al heap).
- Consumo de memoria: documentar el máximo con una ROM de 512 MB (Negra 2) y comportarse con elegancia si no cabe
  (`Error("ROM_TOO_LARGE")`).
- Compila con una sola orden (`scripts/build`) y sin pasos manuales.
