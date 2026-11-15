# PHASE 10 — Biblioteca JS final (`MelonDS`): informe (2026-11-15)

Estado: **hecha (primera versión completa)**, en el árbol de trabajo de `feat/integration` sin commit. Se apoya en
`VideoPlayer` (fases 3-6) y expone la API de `API_CONTRACT.md` §2. La demo independiente sigue usando `VideoPlayer`
directamente (ver desviación al final).

## 1. Qué se entrega

`js/melonds.js` — clase `MelonDS` con:

| Grupo | Métodos / propiedades |
|---|---|
| Ciclo de vida | `static create(opts)`, `loadRom(bytes, {save})`, `start()`, `pause()`, `resume()`, `reset()`, `dispose()`, `running`, `paused` |
| Firmware/BIOS (Fase 7) | `setFirmware(bytes|null, settings?)`, `setBios({arm7, arm9}\|null)` |
| Velocidad / stats | `setSpeed(multiplier)`, `getFrameCount()`, `getStats()` → `{fps, emuMs, renderMs, audioBufferMs, threads}` + extras |
| Vídeo | `setLayout(label)`, `setScreenGap(px)`, `setHybridSmallScreen(mode)`, `setPostProcess(shader)`, `setScaling({integer,smooth})`, `getFrame()`, `screenshot()` (Promise<Blob>) |
| Audio | `setVolume(v)`, `setMuted(m)`, `unlockAudio()`, `setAudioDynamicRate("off"\|"ff"\|"always")`, `captureStream(fps)` |
| Entrada | `button(name, down, player)`, `touchFromCanvas(nx, ny, state)`, `attachKeyboard(el, map)`, `attachGamepad(opts)`, `attachPointer(el, opts)` |
| Guardado | `getSave()`, `getSaveNow()`, `loadSave(bytes)`, `onSave(cb, debounceMs)`, `saveState()`, `loadState(bytes)` |
| Trucos | `setCheat(id, enabled, code)`, `clearCheats()` |
| Eventos | `on(event, cb)` → `ready`, `error`, `frame`, `paused`, `resumed`, `stats` |

Además exporta utilidades que usan el adaptador y las pruebas: `readRomInfo(bytes)`, `FIRMWARE_SIZES`,
`BIOS_SIZES`, `LAYOUT_LABELS`, `SCANLINES`, y la clase `VideoPlayer` sigue exportada por `js/player.js`.

## 2. Pruebas

| Comando | Resultado |
|---|---|
| `node --test --test-force-exit tests/melonds-api.test.mjs` | **16/16**: cabecera de ROM, tamaños de firmware/BIOS, superficie del contrato, validaciones (`ROM_INVALID`, `NO_PLAYER`, `BUTTON_INVALID`, `SPEED_INVALID`, `FIRMWARE_INVALID`, `BIOS_INVALID`, códigos de error), `threads:false` → `NO_THREADS_BUILD`, `MIC_UNSUPPORTED`, etc. |
| `node --test --test-force-exit tests/webapp-adapter.test.mjs` | 6/6 (lo usa la Fase 11) |
| `node tests/phase11-browser.mjs` | 17/17 con `MelonDS` detrás del adaptador (la prueba real de la API en el navegador) |

## 3. Desviaciones (detalle en `tests/DEVIATIONS.md`)

- Los métodos que cruzan al worker son **Promises** aunque el contrato los declare síncronos (`reset`, `saveState`,
  `loadState`, `setCheat`, …): el núcleo vive en un worker.
- `threads: false` se rechaza con `NO_THREADS_BUILD`: solo hay build con hilos; la variante sin hilos (`dist/st`) es
  trabajo pendiente de recompilar.
- `setMicInput()` lanza `MIC_UNSUPPORTED` hasta que se implemente la interfaz de micrófono en C++ (decisión 3 del
  usuario; requiere recompilar).
- `reset()` recrea el worker (~1 s) porque no hay `retro_reset` en el anfitrión actual (requiere recompilar).
- La **demo independiente** (`demo/index.html`) sigue usando `VideoPlayer` en vez de `MelonDS`: `MelonDS` es la API
  pública que consume la web app; migrar la demo tocaría los cambios del usuario sin commit. `VideoPlayer` sigue
  siendo la capa interna documentada.

## 4. Límites conocidos

- `getStats()` es una foto de la última ventana del worker (~500 ms); para medidas finas usar `tests/bench-browser.mjs`.
- `captureStream()` necesita el AudioContext desbloqueado por un gesto para incluir audio (si no, el adaptador cae a
  vídeo solo).
- El límite de memoria del build (1 GiB) se manifiesta como `ROM_TOO_LARGE` en `loadRom` (ver Fase 9/13).
