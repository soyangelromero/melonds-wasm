# PHASE 11 — Adaptador para la web app: informe (2026-11-15)

Estado: **hecha y verificada en Chromium**. Sin commit. Documento de integración con el "diff exacto":
`adapters/INTEGRATION.md`.

## 1. Qué se entrega

- **`adapters/webapp-adapter.js`**: presenta el port con la forma que la web app ya usa (`window.EJS_emulator` +
  `gameManager`), de modo que `nds/index.html` no se reescribe. Cubre: `getFrameNum`, `setVariable` (layouts, gap,
  híbrido), velocidad/avance rápido (recordando el último ratio; `0` = sin límite), reinicio, guardado en `.sav`,
  estados en IndexedDB, trucos, pausa/play, volumen, captura, fullscreen, `shaders` (solo `disabled`), `Module.*`
  como no-ops, `netplay: null` (la Fase 12 pone ahí el anfitrión propio) y `melonDS` como puente directo al port.
- **Ajuste automático de escala**: entera si da ≥2x; si no, relleno suave. El juego pasa de 256×384 a 374×562 en
  escritorio y 328×492 en móvil 390×844.
- **Layout móvil jugable (ronda 11)**: al jugar se ocultan cabecera y paneles, la pantalla ocupa el alto restante y el pad
  queda siempre visible: **retrato** pantalla + barra compacta (envuelta, todos los botones) + pad; **apaisado** pantalla a la
  izquierda y pad a la derecha. Hay botón **Menú** que abre la hoja de partida/trucos/opciones, y **pantalla completa** usa
  el `.console` completo (no solo el canvas) para que los controles sigan visibles, con botón flotante «Salir». No copiamos
  la app Android de WatermelonDS (Kotlin/Compose), pero sí su idea: juego a pantalla completa con los controles siempre a mano.
- **Personalización (ronda 14)**: pestaña Aspecto con presets de tema, color base/activo, transparencia, tamaño del pad,
  fondo del marco, layout, separación y toggles de HUD/FPS/SELECT-START/pad; persistencia en localStorage y sincronía con
  la pestaña Partida. Verificado con `aspect-probe` (9 comprobaciones) y en `phase11-browser` (35/35).
- **Carga visible, HUD y pantalla completa (ronda 12)**: overlay de carga con spinner/mensaje mientras se
  descarga la ROM (también error explicado y botón de fallback), HUD de velocidad/fps/audio, botón de velocidad con
  1x/2x/x3/Máx, aviso de que el audio se silencia por encima de 2x, barra superpuesta en pantalla completa
  (pausa/velocidad/menú) y pad translúcido con pulsación iluminada.

- **Pad táctil móvil** (`setupTouchPad` en `nds/index.html`): cruceta, A/B/X/Y, L/R, SELECT/START; visible con puntero
  grueso o con el conmutador «Botones»; el primer toque desbloquea el audio.
- **Arranque por motor**: `?engine=wasm` (o el botón «melonDS WASM» del hub) usa el port; sin ese parámetro la web app
  sigue con EmulatorJS (no se cambia el comportamiento del usuario hasta que él lo pruebe).
- **Demo del port accesible desde el hub**: `server.mjs` sirve también `/nds/wasm/demo/…` (lista blanca `dist|js|adapters|demo`), así que la demo independiente y `demo/host.html` se abren desde el mismo origen que el hub (socket.io del mismo origen, COOP/COEP ya puestos) y son alcanzables por el túnel remoto.
- **Fallo elegante de ROM demasiado grande**: `ROM_TOO_LARGE` (Negra 2, 512 MB con la build de 1 GiB) muestra el motivo y
  un botón `#wasmFallback` que recarga con `?core=melonds&play=<id>` (EmulatorJS), conservando `?k=`.

## 2. Pruebas

| Comando | Resultado |
|---|---|
| `node tests/phase11-browser.mjs` | **35/35** en Chromium real con Platino: `crossOriginIsolated`, adaptador instalado como `EJS_emulator`, canvas 256×384, fotogramas avanzando, **contenido visible**, fps ~50-60 (según carga), guardado 524 288 B (Flash 512 KiB), canvas 374×562, pausa/play, botón de layout, cero 404, cero errores; **móvil 390×844**: pad visible, `START` llega al emulador (pulsación y suelta), canvas 328×492 y sin errores |
| `node tests/library-fallback-browser.mjs` | **9/9**: Negra 2 en `?engine=wasm` → `ROM_TOO_LARGE`, mensaje en español, botón de fallback, navegación a `?core=melonds&play=3` sin pageerrors y conservando la clave |
| `node tests/fallback-emulatorjs-browser.mjs` | **3/3** (opcional, internet): Negra 2 (512 MB) arranca de verdad con el motor EmulatorJS en 23 s, canvas 614×585 y sin pageerrors; así toda la biblioteca NDS es jugable en la web app hoy |
| `node tests/library-browser.mjs` | NDS 4/4 con el port (tope 2 GiB: rebuild o parche `raise-memory-limit`) + GBA 4/4 (la biblioteca completa); con el build de 1 GiB, 3/4 + fallback |
| `node --test --test-force-exit tests/webapp-adapter.test.mjs` | 6/6 unitarias (traducción de layouts, variables de núcleo, fábrica sin DOM) |

Artefactos: `tests/artifacts/phase11-desktop.png`, `phase11-mobile.png`, `library-fallback-negra2.png`.

## 3. Límites y desviaciones (detalle en `tests/DEVIATIONS.md`)

- **Filtros de imagen**: el port solo trae el shader de scanlines; el selector de la página muestra solo «Ninguno» con
  este motor (`ejs.shaders` expone solo `disabled`).
- **`ejs.Module.pauseMainLoop/resumeMainLoop`**: no-ops; el limitador de avance rápido de la página no hace falta
  porque el port se auto-regula con el reloj de audio.
- **`melonds_threaded_renderer` en caliente**: se elige al arrancar (hilos 3D ON por defecto); el `setVariable` de la
  página se acepta pero no cambia el modo en marcha.
- **Netplay**: `ejs.netplay` es `null`; con `?engine=wasm` la pestaña Online usa `setupOnlineWasm()` y
  `adapters/netplay-host.js` (Fase 12).
- **Negra 2 (512 MB)**: no cabe en la build de 1 GiB; mientras no se recompile con 2 GiB se ofrece el fallback a
  EmulatorJS (toda la biblioteca sigue siendo jugable en la web app).
- La web app es `<web-app>` (**no es git**): los cambios no se pueden commitear desde este repositorio.
