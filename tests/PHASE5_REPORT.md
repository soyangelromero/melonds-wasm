# Informe de la Fase 5: entrada y pantalla táctil

Estado (2026-11-04): **teclado, mando (simulado) y ratón/táctil funcionan en la demo y llegan al núcleo real**. `npm test`: 42/43 (el fallo es `tests/phase0.test.mjs`, que ya fallaba antes: espera `dist/hello.*`). `npm run test:input`: **65/65 en el núcleo (Node) y 72/72 en Chromium sin interfaz**. Audio, guardado, trucos y estados siguen como `TODO(fase N)`; no se avanzó a otras fases. Sin parches nuevos (`core/patches/` y el submódulo intactos).

## Versiones

| Elemento | Valor |
|---|---|
| Emscripten | 6.0.13 (emsdk commit `d7b4130`, sin Docker; reinstalado en esta sesión) |
| Node | v22.23.4 |
| Chromium / Playwright | 153.0.8010.12 / playwright 1.63.0 (WebGL2 por SwiftShader en la nube) |
| Núcleo | melonDS DS `f394adba` (v1.4.0) + los 7 parches existentes |
| ROM de prueba | `nmap.nds` (rmn20/normalmappingds `6fb2d425`, CC0), SHA-256 `b21f5889…19132`, en `tests/artifacts/` (ignorada por git) |

## Comandos exactos

```bash
git fetch origin && git checkout -b feat/phase-5 origin/feat/phase-3
git submodule update --init third_party/melonds-ds
source /home/user/emsdk/emsdk_env.sh
bash scripts/build-core.sh && bash scripts/build-host.sh      # dist/melonds.{js,wasm}
# coloca el homebrew CC0 en tests/artifacts/nmap.nds
npm test                                                       # unitarias (touch.test.mjs, input.test.mjs, ...)
node tests/phase5-core.mjs tests/artifacts/nmap.nds            # núcleo real en Node
node tests/phase5-browser.mjs tests/artifacts/nmap.nds [--gl=swiftshader]   # Chromium sin interfaz
npm run test:input                                             # las dos anteriores
npm run serve                                                  # demo: http://127.0.0.1:8080/demo/index.html
```
Resultados del navegador: `tests/artifacts/phase5-browser-results.json` y `phase5-rotate-left-touch.png` (ignorados por git). Regresión comprobada: `phase3-browser.mjs` 46/46 y `phase3-layouts.mjs` siguen pasando.

## Qué pide realmente el núcleo (verificado, [VERIFICAR] resueltos)

`mds_get_input_queries()` tras 120 fotogramas devuelve 13 = máscara + puntero + analógico:

- `RETRO_DEVICE_ID_JOYPAD_MASK`: **sí** (el anfitrión responde `true` a `GET_INPUT_BITMASKS`, `environment.cpp:848`). Los ids sueltos **no** se piden; el anfitrión también los atiende por si acaso.
- Bits que lee el núcleo (`input/joypad.cpp`): A B SELECT START ←→↑↓ R L X Y (la consola), **L2** (acelerar/frenar el cursor joystick; con **Y** = alternar tapa), **R2** (tocar con joystick), **L3** (micrófono), **R3** (siguiente layout; sin efecto con `melonds_number_of_screen_layouts=1`). No hay botón de tapa propio: `LID` = L2+Y.
- Puntero: `RETRO_DEVICE_POINTER` índice 0, `X`, `Y`, `PRESSED`.
- **Analógico** (`RETRO_DEVICE_ANALOG`, palanca derecha): lo pide (modo táctil Auto/Joystick). El anfitrión devuelve 0: **el cursor con joystick no está implementado** (ver «No verificado»).
- **Rotación**: `screenlayout.cpp:312-319`: `pointerMatrix = ts(buffer/2, buffer/(2·32767))` y luego `rotate(…, ángulo del layout)` solo si el anfitrión aceptó `SET_ROTATION` (la Fase 3 lo acepta). Es decir, el núcleo espera el puntero **en el espacio del fotograma mostrado (ya girado)** y gira él mismo. JS no gira nada: el canvas ya está girado, así que `(clientX-left)/width` es la posición correcta. Confirmado con el núcleo real: el cursor aparece bajo el puntero en Rotated Left, Rotated Right y Upside Down.
- Cursor por defecto (`melonds_show_cursor`): `timeout` (3 s) en escritorio; el núcleo lo dibuja **en el fotograma compuesto** (inversión de color de un cuadrado de 4×4 px). Eso da un efecto observable aunque la ROM ignore el táctil.

## Qué se hizo

- **`core/host/host.cpp`** (cambio localizado, solo añadido): `mds_set_key_mask(mask)`, `mds_set_pointer(nx,ny,pressed)`, `mds_get_input_queries()`; `inputStateCb` responde `JOYPAD` (máscara y ids), `POINTER` (X/Y/PRESSED, índice 0) y `ANALOG` (0). Un toque en el centro exacto se desplaza 1/32767 para que el núcleo no lo tome por «fuera de pantalla». `scripts/build-host.sh`: 3 exportaciones añadidas a `EXPORTS`.
- **`js/input.js`** (nuevo): `InputState` (hilo principal) fusiona API + teclado + mando en un `SharedArrayBuffer` de 8 enteros; `InputReader` (worker) lo lee **antes de cada `mds_run_frame`**. Elegido en vez de mensajes porque no hay cola ni latencia añadida y varios eventos entre dos fotogramas se funden en el último estado. Para no perder pulsaciones más cortas que un fotograma (~16,7 ms) guarda `TAP_BITS` (teclas) y un contador `SEQ` con la posición del toque, que se entregan durante exactamente un fotograma.
  - `button(name, down)`, `attachKeyboard(el, map)`, `attachGamepad(opts)`, `touchFromCanvas(nx, ny, state)`, `attachPointer(canvas)`; funciones puras `normalizeClient`, `toPointerSpace`, `gamepadToMask`, `keyToButton`.
  - **Teclado**: mapa del contrato por `event.code`; `preventDefault` en flechas y Espacio aunque no estén asignadas; no actúa con Ctrl/Alt/Meta ni en `input/select/textarea`; `blur` de la ventana suelta todo.
  - **Mando** (Gamepad API, solo `mapping === "standard"`): botón derecho→A, inferior→B, superior→X, izquierdo→Y (posiciones de Nintendo), LB/RB→L/R, Back→Select, Start→Start, cruceta (12-15) y palanca izquierda (umbral 0,5) → cruceta. Varios mandos se combinan con OR. Gatillos, clics de palanca, Home y palanca derecha: sin asignar.
  - **Puntero** (Pointer Events + `touch-action:none`): un único punto táctil (el primero manda, los demás dedos se ignoran); captura de puntero, de modo que soltar fuera del canvas termina el toque y arrastrar fuera lo pega al borde; `pointercancel` suelta; el ratón fuera del canvas manda (0,0) «ausente»; solo botón izquierdo; el rectángulo se mide en cada evento (`getBoundingClientRect`). `contentFit` descuenta barras si algún día el elemento no coincide con el fotograma.
- **`js/emu-worker.js`, `js/player.js`** (unas líneas): el buffer viaja en `init`; `VideoPlayer` expone `input`, `button`, `touchFromCanvas`, `attachKeyboard`, `attachGamepad`, `attachPointer`.
- **Demo** (`demo/demo.js`, `demo/index.html`): conecta teclado, mando y puntero tras cargar la ROM (y los desconecta al recargar), desenfoca los `<select>` tras cambiarlos, muestra la entrada en el panel y la leyenda de controles.

## Resultados reales

**`npm test`**: 43 pruebas, 42 correctas; `touch.test.mjs` (19) e `input.test.mjs` (15) pasan al completo. El fallo es el anterior de la Fase 0.
- `touch.test.mjs`: esquinas y centro de la normalización, recorte de valores, proporción independiente del escalado CSS, barras (`contentFit`), rotación (la normalización no depende de ella), estado down/move/up, tap corto → exactamente un fotograma de toque, ratón (arrastrar, soltar), botón derecho, **soltar fuera del canvas**, `pointercancel`, **varios dedos**, ratón que sale del canvas, canvas redimensionado entre eventos, desconexión.
- `input.test.mjs`: bits = ids libretro y numeración de la sala online; mapa por defecto del contrato; `code` frente a `key`; 12 teclas, `preventDefault`, atajos y formularios; repetición y dos teclas en un botón; `blur`; combinación API/teclado/mando; mando simulado (todos los botones, palanca y umbral, desconexión, no estándar ignorados).

**`node tests/phase5-core.mjs` (núcleo real, 65/65)**: el núcleo pide máscara y puntero; UP, SELECT, LEFT y A producen imágenes distintas y deterministas en `nmap.nds`; en **8 layouts** (Top/Bottom, Bottom/Top, Bottom Only, Left/Right, Right/Left, Upside Down, Rotated Left, Rotated Right) y 3 puntos cada uno el cursor dibujado por el núcleo cae a ≤ 1,41 px del punto enviado (tras aplicar la rotación solo para comparar) y desaparece al soltar; el hover no dibuja con «touching»; el toque en el centro exacto se registra.

**`node tests/phase5-browser.mjs` (Chromium, 72/72, con y sin `--gl=swiftshader`)**, con eventos reales de Playwright/CDP por todo el camino DOM → SAB → worker → núcleo → canvas:
- teclado (UP cambia la imagen; Z+Enter; `preventDefault` en 5 teclas y no en `P`; sin scroll; sin teclas con foco en `<select>`; `blur` suelta), mando simulado (cruceta, palanca, botones A/X, desconexión, la imagen cambia), ratón en **6 layouts** × 2 puntos (cursor del núcleo a ≤ 1,41 px del puntero, desaparece al soltar; el canvas visible mide lo mismo que el fotograma, sin barras), arrastrar y soltar fuera, botón derecho, **toque real por CDP en 3 layouts (Rotated Left, Left/Right, Top/Bottom) con un segundo dedo ignorado**, y sin errores de consola, de página ni peticiones fallidas.

## Efecto observable sin ROM de Nintendo

`nmap.nds` **no usa la pantalla táctil** (su `main.c` solo lee botones), así que no hay una ROM libre aquí que reaccione a un toque. La verificación del toque usa el **cursor que dibuja el propio núcleo** sobre el fotograma compuesto (`melonds_show_cursor=touching`), que es exactamente la posición con la que el núcleo llama a `nds.TouchScreen` (`software.cpp:176-212` usa `ConsoleTouchPosition`). Lo que **no** se ha visto es que una ROM reaccione al toque: `NDS::TouchScreen` recibe esas coordenadas pero no hay una ROM que lo demuestre.

## No verificado [VERIFICAR]

- **Mando físico**: solo un `Gamepad` simulado (`navigator.getGamepads` sustituido). Falta comprobar botones y palanca de un mando real (Xbox/DualSense/Switch Pro) y los eventos de conexión.
- **Pantalla táctil real** y lápiz: solo CDP (`Input.dispatchTouchEvent`) y ratón. Falta un móvil/tablet y Safari/Firefox (el test solo corre en Chromium).
- **Juego real (SoulSilver)**: que los menús y el mapa táctil respondan, la precisión en los bordes del contorno de la pantalla inferior, y la sensación de latencia. La latencia de entrada no se midió (el camino es lectura directa de un SAB antes de cada fotograma; el techo es un fotograma).
- Layouts **Large Screen**, **Hybrid** y **Top Only** (9 de los 17; se probaron 8): no se probó el puntero en ellos (el factor de escala 2 y los modos `one`/`both` los resuelve el núcleo; no probados aquí). Tampoco el hueco entre pantallas.
- **Cursor con palanca derecha** (modo táctil Joystick/Auto): `RETRO_DEVICE_ANALOG` devuelve 0; para jugar al táctil solo con mando haría falta una función `mds_set_analog` (no está en el contrato) [siguiente paso posible].
- **Micrófono** (L3 / `MIC`): el bit llega al núcleo pero no se probó ningún efecto (Fase 4+).
- `LID` (L2+Y): la tapa alternaba por lectura de código; **no se probó** en ejecución.
- Pantallas con `devicePixelRatio` fraccionario o con zoom del navegador: el rectángulo se mide en cada evento, pero no se probó.
- Teclados no QWERTY con ñ/acentos y IME: se usa `event.code`, no probado en teclados reales.

## Qué debes probar tú con SoulSilver

1. `npm run serve`, abre la demo, carga la ROM. El panel «Entrada» debe mostrar los botones al pulsarlos (flechas, `Z`=A, `X`=B, `Enter`=Start).
2. Teclado: ¿las flechas mueven al personaje sin desplazar la página? ¿`Z`/`X` aceptan/cancelan en los menús? Mantén una tecla y cambia de ventana: nada debe quedar pegado.
3. Mando físico: conéctalo y pulsa un botón antes de usarlo (el navegador no lo expone hasta entonces). Comprueba A/B/X/Y (posiciones Nintendo), L/R, Start/Select, cruceta y palanca izquierda.
4. Táctil: con ratón y con pantalla táctil, toca el menú de la pantalla inferior (Pokégear, mochila, mapa). Pruébalo en Top/Bottom y **en los tres girados** (Rotated Left/Right, Upside Down), y con separación ≠ 0. Un toque corto (tap) no debe perderse. El cursor del núcleo (`melonds_show_cursor`) aparecerá 3 s tras el último toque; no es un fallo.
5. Prueba también un toque al borde y soltar fuera de la imagen: debe soltarse el lápiz.

## Siguiente paso

Fases 4/6/8 siguen en otras sesiones. Para la unión: los conflictos probables están en `core/host/host.cpp` (mi bloque va entre `audioCb` y `extern "C"`, y un `IN = InputBox{}` en `mds_destroy`), `scripts/build-host.sh` (`EXPORTS`), `js/emu-worker.js` (`init` y `loop`) y `package.json`/`README.md`/`API_CONTRACT.md`/`tests/DEVIATIONS.md` (solo líneas añadidas). Opcional más adelante: `mds_set_analog` para el cursor con joystick.
