# Informe de integración: Fases 4 (audio), 5 (entrada), 6 (guardado/estados) y 8 (trucos)

Estado (2026-11-04): las cuatro ramas están unidas en `feat/integration` y funcionan juntas en **una sola demo** (`demo/index.html`).
Todo pasa **salvo tres comprobaciones de margen estrecho de la prueba de audio de la Fase 4** (`A6`, `B2`, `I6`, y un underrun aislado
`I3` en una de cuatro corridas largas), que fallan de forma intermitente **también en la rama de la Fase 4 sola** en esta VM (ver
«Audio: fallos intermitentes»). Se encontraron y arreglaron **dos defectos reales de integración** (id de truco pisado y diseño de la
demo), ver «Conflictos» y «Defectos de integración».

**Lo más importante que NO se ha verificado**: nadie ha *oído* nada ni jugado a un juego comercial (no hay ROM de Nintendo; Chromium en la
nube no tiene tarjeta de sonido, el audio se mide dentro del `AudioWorklet`). Ver «Lo que NO se pudo verificar».

## Versiones

| Elemento | Valor |
|---|---|
| Ramas unidas (puntas) | `feat/phase-4` `b6b3255`, `feat/phase-5` `7e276e7`, `feat/phase-6` `c4789eb`, `feat/phase-8` `dad4928` (ninguna modificada; `main` intacta) |
| Emscripten | 6.0.13 (emsdk `d7b4130`, instalado con `./emsdk install 6.0.13`, **sin Docker**) |
| Node / Python | v22.23.4 / 3.13.18 |
| Chromium / Playwright | 153.0.8010.12 / 1.63.0 (`/opt/pw-browsers`, ya instalado) |
| Núcleo | melonDS DS `f394adba` (v1.4.0), motor `16f127db`, 7 parches existentes (**ninguno nuevo**) |
| `gcc-arm-none-eabi` | 13.2.1 (apt), solo para las ROM de prueba |
| ROM de vídeo | `nmap.nds` (rmn20/normalmappingds `6fb2d425`, CC0). **Se pudo descargar** clonando el repositorio (`dist/nmap.nds`); SHA-256 `b21f5889…b8cb19132`, idéntico al de la Fase 8. En `tests/artifacts/` (ignorada por git) |
| ROM de audio / integración | `tests/artifacts/audio-tone.nds` y `tests/artifacts/integration.nds`, generadas desde fuentes CC0 propias (ignoradas por git). Sin ROM, BIOS, firmware ni guardados de Nintendo en el repositorio |

## Comandos exactos

```bash
git fetch origin && git checkout -b feat/integration origin/feat/phase-4
git merge --no-ff origin/feat/phase-5      # 9 archivos en conflicto, resueltos a mano
git merge --no-ff origin/feat/phase-6      # 5 archivos en conflicto
git merge --no-ff origin/feat/phase-8      # 5 archivos en conflicto
git submodule update --init third_party/melonds-ds
git clone https://github.com/emscripten-core/emsdk.git /home/user/emsdk && /home/user/emsdk/emsdk install 6.0.13 && /home/user/emsdk/emsdk activate 6.0.13
source /home/user/emsdk/emsdk_env.sh
bash scripts/build-core.sh && bash scripts/build-host.sh          # dist/melonds.{js,wasm}; enlaza host.cpp + saves.cpp + cheats.cpp
npm install                                                         # playwright 1.63.0
apt-get update && apt-get install -y gcc-arm-none-eabi
git clone https://github.com/rmn20/normalmappingds /tmp/nmapsrc && git -C /tmp/nmapsrc checkout 6fb2d425 && cp /tmp/nmapsrc/dist/nmap.nds tests/artifacts/
npm run build:tone-rom && npm run build:integration-rom
# verificación (la batería completa corre como tests/artifacts/final/*.log):
npm test
node tests/phase2-smoke.mjs
node tests/phase3-layouts.mjs tests/artifacts/nmap.nds
node tests/headless.mjs tests/artifacts/nmap.nds 300 --threads=0     # y --threads=1
npm run test:browser
npm run test:audio-core
node tests/phase4-browser.mjs --gl=swiftshader --skip-long          # npm run test:browser:audio es lo mismo con --minutes=3
npm run test:browser:audio
npm run test:input
npm run test:saves && npm run test:saves-browser
npm run test:cheats
npm run test:integration                                             # = node tests/integration-browser.mjs --gl=swiftshader
git push -u origin feat/integration
```

## Conflictos y cómo se resolvieron

Regla general: conservar lo de todas las ramas (casi todo son cambios añadidos por cada fase). Cada fase mantiene su sección propia en
`DEVIATIONS.md` y sus scripts en `package.json`.

### Unión 1: `origin/feat/phase-5` sobre la Fase 4 (9 archivos)

| Archivo | Conflicto | Resolución |
|---|---|---|
| `API_CONTRACT.md` §8 | las dos líneas de `mds_get_audio` (4) y `mds_set_key_mask/pointer` (5) | línea de audio de la Fase 4 (unidad = fotograma estéreo, 32728,498 Hz) + línea de entrada de la Fase 5 (incluye `mds_get_input_queries`). **Se descartó** la línea de audio antigua «@ 32768 Hz» que traía la rama 5 |
| `core/host/host.cpp` | solo el comentario de cabecera | texto combinado «Fase 4: anillo de audio; Fase 5: entrada». El resto (anillo de audio, `InputBox`, callbacks) se fusionó solo |
| `demo/demo.js` | bloque de estadísticas: filas de audio (4) y fila de entrada (5) | conservadas ambas, en ese orden |
| `demo/index.html` | fieldset «Audio» (4) frente a «Controles» (5) y dos notas «aún no» | dos `<fieldset>` seguidos; las notas «aún no» se sustituyeron al llegar el guardado |
| `js/emu-worker.js` | imports (`AudioRingWriter` + `InputReader`); firma de `init`; **el bucle** | ver «Orden del bucle del worker» |
| `js/player.js` | imports; mensaje `init` | imports de las dos fases; `init` lleva `audioRing, audioLatencyMs` **y** `input` |
| `package.json` | scripts | `test:layouts`, `test:audio-core`, `test:browser:audio`, `build:tone-rom` y `test:input` |
| `scripts/build-host.sh` | lista `EXPORTS` | las 8 funciones de audio **y** `mds_set_key_mask/set_pointer/get_input_queries` |
| `tests/DEVIATIONS.md` | dos secciones nuevas al final | «Fase 4» y «Fase 5» una tras otra, sin mezclar filas |

### Unión 2: `origin/feat/phase-6` (5 archivos)

| Archivo | Conflicto | Resolución |
|---|---|---|
| `core/host/host.cpp` | `mds_destroy`: `IN = InputBox{}` frente a `mds::savesReset()` | **las dos líneas**. `mds_destroy` queda: `retro_unload_game` → `retro_deinit` → `H = Host{}` (esto reinicia el anillo de audio, que vive dentro de `Host`) → `IN = InputBox{}` → `mds::savesReset()`; la Fase 8 añade `mds_cheats_forget()` |
| `js/emu-worker.js` | imports; variables globales; final de `loadRom`; **el bucle** | imports y globales de las dos fases; `loadRom` conserva `srcRate`/`setSourceRate` (4) y `saves.reset()` + información de guardado en el mensaje `loaded` (6); bucle: ver abajo |
| `js/player.js` | imports; constructor (`audio…` frente a `SaveClient`); `loadRom/start/pause/resume` | las dos cosas; `loadRom(rom, {save})` con la lógica de `start()/pause()/resume()` de audio de la Fase 4 |
| `package.json` | scripts | + `test:saves`, `test:saves-browser` |
| `tests/DEVIATIONS.md` | sección «Fase 6» | conservada entera tras la 5 |

`build-host.sh` **no** dio conflicto en la unión 2 (git fusionó solo `host.cpp saves.cpp`), pero la Fase 6 exporta sus funciones con
`EMSCRIPTEN_KEEPALIVE` sin tocar `EXPORTS`; se añadieron a la lista a mano (`_mds_get_core_abi, _mds_get_save_status, _mds_get_save,
_mds_set_save, _mds_poll_save, _mds_save_state, _mds_load_state`) para que la lista sea completa.

### Unión 3: `origin/feat/phase-8` (5 archivos)

| Archivo | Conflicto | Resolución |
|---|---|---|
| `js/emu-worker.js` | import de `cheatHandlers`; tabla `handlers` (`pause`) | `...cheatHandlers(() => M)` junto al `pause` de la Fase 6 (que hace una última comprobación de SRAM) |
| `package.json` | `test:cheats` | añadido; más `build:integration-rom` y `test:integration` (nuevos) |
| `scripts/build-host.sh` | orden `em++` | `em++ core/host/host.cpp core/host/saves.cpp core/host/cheats.cpp`. `EXPORTS` ahora incluye también `_mds_cheat_set/_clear/_count/_slot/_enabled`, `_mds_ram_data/_ram_size/_heap_used` |
| `tests/DEVIATIONS.md` | sección «Fase 8» | conservada |
| `tests/lib/core-harness.mjs` | **add/add**: la Fase 6 exporta `createCore/sha256`, la Fase 8 exporta `bootCore/RAM_BASE/haveCore` | **un solo archivo con ambos arneses**, sin colisiones de nombres; las pruebas de ambas fases lo importan sin cambios |

`host.cpp` y `js/player.js` se fusionaron solos en esta unión (`mds_cheats_forget()` en `mds_destroy`, `mds_host_loaded()`).

### Orden del bucle del worker (`js/emu-worker.js`)

Cada vuelta del bucle:

1. `refreshAudioMode(now)` (Fase 4): ¿vive el reloj de audio? (latido del worklet < 150 ms, velocidad 1x). Cambia entre «reloj de audio» y
   «temporizador» y vacía el anillo del anfitrión al cambiar.
2. Si manda el reloj de audio: `stepFrame()` solo si el llenado del anillo compartido está por debajo del objetivo (80 ms); si no,
   `Atomics.wait` ≤ 8 ms. Si manda el temporizador: `stepFrame()` y duerme hasta el siguiente fotograma.
3. `stepFrame()` = **`applyInput()`** (Fase 5: `mds_set_key_mask` + `mds_set_pointer`, justo antes del fotograma que los consume; dentro de
   `stepFrame` para que también valga con `debugBurst`) → `mds_run_frame()` → `publishFrame()` (copia única heap→anillo de vídeo) →
   **`drainAudio()`** (Fase 4: anillo del anfitrión → anillo compartido, o `mds_flush_audio()` si no manda el reloj de audio) →
   **`saves.tick()`** (Fase 6: cada 10.º fotograma compara la SRAM; va **después** del fotograma, que es cuando el juego ha escrito).
4. Estadísticas cada 500 ms.
5. `await yieldToEvents()`: aquí se atienden los mensajes del hilo principal, es decir **los manejadores de la Fase 8** (`cheat`,
   `cheatClear`) y de la Fase 6 (`getSave`, `setSave`, `saveState`, `loadState`) **entre dos fotogramas**, nunca en mitad de uno (el worker
   es de un solo hilo). Tras `loadState`/`setSave` se vacía el audio pendiente (pertenece a la línea temporal anterior). Los trucos los
   ejecuta el núcleo dentro de `mds_run_frame` (en la IRQ de VBlank de la ARM7), por eso se aplican «en el siguiente fotograma».
6. `pause` hace `stop()` (vacía audio) y una última comprobación de SRAM (`saves.tick(true)`).

## Defectos de integración encontrados (y arreglados en la integración, no en las pruebas)

1. **El id del truco se perdía** (`js/player.js`, `js/cheats-worker.js`). La Fase 8 solo probó su manejador en Node, nunca a través del
   `VideoPlayer`. `VideoPlayer.#call()` añade a todo mensaje su propio `id` (de confirmación), que **pisaba el `id` del truco**: el truco se
   registraba con un id inventado y `setCheat(2, true, "")` (activar uno ya conocido sin reenviar el texto) fallaba con «código vacío».
   Ahora el mensaje lleva `cheatId` (el manejador acepta `cheatId ?? id`; el test de la Fase 8 sigue valiendo) y `VideoPlayer` expone
   `setCheat(id, enabled, code)` / `clearCheats()` (Promesas). Lo detectó la prueba nueva.
2. **La demo movía el lienzo** (`demo/index.html`). Al añadir los paneles de guardado y trucos, la columna lateral quedó más alta que la
   ventana y estiró `<main>`; el lienzo (centrado) bajó fuera de la ventana y **6 de las 72 comprobaciones** de `phase5-browser.mjs` fallaron
   (el ratón caía fuera). Corregido con `aside {position: sticky; height: 100vh}`. Después aún había fallos **intermitentes** (+7 px en el
   cursor, 70/72) porque una línea de estado de audio que se parte en dos cambiaba la altura de la lista bajo el lienzo y con
   `place-items: center` lo desplazaba la mitad. Corregido con `#stage {place-items: start center}`. Tras eso: **72/72 en 3 corridas
   seguidas** y en la batería final.

Cambios de contrato (también en `API_CONTRACT.md` y `tests/DEVIATIONS.md`, sección «Integración»): `saveState/loadState/loadSave/setCheat/
clearCheats` son Promesas en `VideoPlayer`; `getSave()` síncrono es una copia en caché (≤ 170 ms), `getSaveNow()` es exacto.

## Una sola demo

**Decisión: se integró todo en `demo/index.html`** (no solo un enlace). Cuesta poco (IndexedDB y botones) y así hay una única página con
vídeo, audio, entrada, **Guardado y estados** (descargar/reemplazar `.sav`, estado rápido, descargar/cargar estado, autoguardado en
IndexedDB y **«Continuar»** automático al reabrir la misma ROM, `.sav` inicial opcional) y **Trucos** (id, código, activar/desactivar/quitar
todos). `demo/saves.html` + `demo/saves.js` se **conservan** porque `tests/phase6-browser.mjs` depende de ellos; ambas páginas comparten la
misma IndexedDB (`melonds-wasm-demo`/`saves`) y la misma clave por ROM.

## Resultados reales

Batería final sobre `feat/integration` (estado `c6b38c0`, código idéntico al de esta entrega salvo este informe), logs en `tests/artifacts/final/*.log` (no versionados).

| Prueba | Resultado |
|---|---|
| `npm test` | **95 pruebas: 91 OK, 0 fallos, 4 omitidas**. Omitidas: `phase0.test.mjs` (**se omite limpiamente**: «dist/hello.* not built»; ya no falla) y 3 de la Fase 8 que necesitan catálogos de trucos externos (con los datos efímeros descargados `npm run test:cheats` las ejecuta: ver abajo) |
| `node tests/phase2-smoke.mjs` | `phase2-smoke: OK` |
| `node tests/phase3-layouts.mjs tests/artifacts/nmap.nds` | exit 0, 24 filas, ninguna con comprobación a `false` |
| `tests/headless.mjs nmap.nds`, fotograma 300 | **`a0d4f91c80973e4d619f7f8aab1cafe18607f06cc22c56f3b26d9ec9b62890bf`** con `--threads=0` (61,9 fps) **y** `--threads=1` (73,5 fps): idéntico al de la Fase 2/3 |
| `npm run test:browser` (Fase 3) | **46/46** |
| `npm run test:audio-core` | `phase4-core-audio: OK` (546–548 fotogramas por ejecución, 32728,498 Hz, tono a 440 Hz) |
| `phase4-browser.mjs --skip-long` | 45/45 en la batería final; en la primera pasada 44/45 (`A6`), ver «Audio: fallos intermitentes» |
| `npm run test:browser:audio` (3 min) | **intermitente, ver abajo**: 49/51, 48/51, 49/51 en tres corridas; la Fase 4 sola dio 50/51 |
| `npm run test:input` | núcleo en Node **65/65**; Chromium **72/72** (en la primera pasada 66/72 y 70/72: los dos defectos de demo ya arreglados) |
| `npm run test:saves` | 14 pruebas: 13 OK, 0 fallos, 1 omitida (cartucho gratuito opcional `MDS_ROM`). Con `MDS_ROM=tests/artifacts/nmap.nds node --test tests/phase6-saves.mjs`: **14/14** |
| `npm run test:saves-browser` | «all checks passed» (19 comprobaciones PASS) |
| `npm run test:cheats` | 30 pruebas: 27 OK, 0 fallos, 3 omitidas (datos externos). Con libretro-database clonada (datos efímeros, **no se suben**): 4204 archivos, 645 072 códigos, 645 025 parsean, 47 no; el resultado de la Fase 8 |
| **`npm run test:integration`** (nueva) | **34/34** (ver abajo) |

### La prueba nueva `tests/integration-browser.mjs`

Una sesión de Chromium de la demo única con **una** ROM propia (`tests/homebrew/integration`, CC0: seno de 440 Hz en la ARM7, imagen que
depende de las teclas, EEPROM de 8 KiB escrita en los fotogramas 30 y 60, contador de VBlank en RAM, IRQ de VBlank de la ARM7 activada,
que es lo que necesita el motor de trucos). Comprueba, todo junto y en este orden:

- ROM cargada, aislamiento COOP/COEP, reloj de audio como metrónomo, tipo de guardado «EEPROM 8 KiB», partida nueva.
- **Audio**: RMS del worklet 0,1349 (pico 0,194) sin cortes en 2 s.
- **Tecla** real `Z`: la máscara libretro vale 256 (A), el color de la pantalla superior cambia (0,0,251 → 251,8,0) y vuelve al soltar.
- **Táctil**: pantalla inferior estable; ratón pulsado en (76,8; 307,2) dibuja el cursor del núcleo en (76,0; 307,0), distancia 0,82 px, 16 px;
  al soltar desaparece.
- **Trucos**: código inválido → `CHEAT_BAD_TOKEN`; `02300000 DEADBEEF` activado escribe `0xDEADBEEF` en la RAM (leída del montón de wasm vía
  `debugPeek`); desactivado no escribe y al activarlo (mismo id, sin texto) escribe `0x11223344`; el panel de la demo (id 3) escribe
  `0xCAFEBABE` y muestra «#3 ON»; «Quitar todos»; el audio sigue sonando con trucos activos.
- **Guardado**: `getSave` = 8192 bytes con `B0..BF` en 0x10; `onSave` se dispara (debounce) y se guarda en IndexedDB; `loadSave` aplica un
  marcador (0x5A… en 0x100) y **reinicia** el juego (contador 289 → 2); el botón «Descargar .sav» entrega 8192 bytes.
- **Estado**: `saveState` = contenedor `MDSSTATE` de 18,3 MiB; `loadState` devuelve el contador de VBlank al momento guardado (132 → 194
  → 133); un estado con un byte alterado se rechaza con `STATE_CORRUPT` **y el juego sigue**; botones de estado rápido; **el audio y la
  entrada siguen funcionando después** de cargar estados.
- **«Continuar»**: segunda página del mismo perfil: la demo dice «IndexedDB: «Continuar»» y `getSaveNow()[0x100] == 0x5A` nada más arrancar.
- **Rendimiento con todo activo**: 59,9 fps, 3,91 ms por fotograma emulado, dibujo 58,1 fps (SwiftShader, sin GPU).
- **Cero** errores de consola, de página ni peticiones fallidas en todo el recorrido.

### Audio: fallos intermitentes (lo único que no queda en verde)

Resultados de la prueba larga (`--minutes=3`, 181 s a 1x) y de las de ventana corta, **todas las corridas**:

| Corrida | Resultado | Comprobaciones que fallaron |
|---|---|---|
| Integración, 1.ª batería | 49/51 | `A6` (55,092), `B2` (56,35 fps) |
| Integración, batería final | 48/51 | `A6` (55,005), `I3` (**1 underrun** en 3 min), `I6` (59,697 fps) |
| Integración, repetición | 49/51 | `A6` (55,172), `I6` (59,702) |
| **Fase 4 sola** (worktree aparte, mismo `libmelonDS.a`) | 50/51 | `I6` (59,693) |
| Fase 4 sola, solo `--only=A,B`, ×2 | 12/13 y 13/13 | `A6` (55,172) en una |
| Integración, solo `--only=A,B`, ×3 | 12/13, 12/13, 13/13 | `A6` en dos |

En las mismas corridas, `I1` (búfer estable: media 82,1 ms, desviación 6,9), `I2` (deriva 0,07 y −0,32 ms/min), `I4` (sin clics, salto máximo
0,0149) e `I5` (nivel constante) **pasan siempre**.

**Por qué no lo considero una regresión de la unión**: (1) la rama de la Fase 4 sola falla `A6` e `I6` igual en esta VM (59,693 frente a
59,697/59,702; `A6` 55,172 idéntico); (2) `A6`, `B2` e `I6` calculan fotogramas por segundo con `getStats().frameCount`, que viene del
mensaje de estadísticas del worker **cada 500 ms**, así que un cálculo sobre una ventana de 6 s tiene un error de ±30 fotogramas según
cómo caiga la ventana frente a ese reloj (la propia prueba solo admite ±3); (3) medido directamente, sin ese contador, durante 28 s
(`audioFramesPerEmuFrame` = **547,1 constante**, 0 underruns, fps del worker 58,0–59,9, fotogramas por segundo de audio 59,4–60,5 salvo una
muestra de 45,0 por ese mismo retraso). **Sin embargo no lo he demostrado de forma concluyente**: el underrun único de `I3` en una de cuatro
corridas largas de la integración (0 en la de la Fase 4 sola, que solo se corrió una vez) podría ser ruido de la VM o un coste ligeramente
mayor por fotograma (`applyInput`, `saves.tick`); con una sola muestra no se puede distinguir. Hay que repetirlo en una máquina menos
cargada. No toqué la prueba de la Fase 4 (instrucción); si se quiere un verde estable, el arreglo correcto es de la prueba: medir con un
contador de fotogramas fresco (por ejemplo en el `SharedArrayBuffer`) en vez del mensaje de 500 ms.

## Lo que NO se pudo verificar

- **Nadie ha oído audio**: no hay tarjeta de sonido en la nube; se midió RMS/pico/saltos dentro del worklet y en un anillo de captura.
  Tampoco hay prueba de latencia percibida ni de calidad con música real.
- **Ningún juego comercial** (SoulSilver, etc.): no hay ROM de Nintendo. No se probó el guardado real de SoulSilver (Flash de 512 KiB),
  ni estados ni trucos sobre un juego real; los trucos solo se probaron escribiendo RAM con códigos propios y con el catálogo de
  libretro-database *solo en sintaxis* y cargando una muestra en el núcleo, no ejecutándolos en juegos.
- **GPU real, Firefox, Safari, móvil**: todo en Chromium 153 sin interfaz con SwiftShader. Entrada con mando real, teclado con otras
  distribuciones y pantalla táctil real: solo eventos simulados de Playwright (y un mando simulado).
- **Memoria FRAM, modo DSi** (los estados se rechazan en DSi con `STATE_UNSUPPORTED`), `mds_reset` (no existe) y el comportamiento de los
  trucos tras un reinicio: marcados `[VERIFICAR]` en los informes de las Fases 6 y 8.
- **Rendimiento en hardware real**: 59,9 fps en esta VM de 4 núcleos con SwiftShader (3,91 ms/fotograma con la ROM de prueba), pero con un
  juego 3D real el coste por fotograma será mucho mayor.
- Las comprobaciones de margen estrecho de audio (arriba) no dan un verde estable.
- La Fase 7, la 9 y posteriores no se tocaron.

## Qué debe probar el usuario en su Chrome con SoulSilver

1. `npm run serve` y abre `http://127.0.0.1:8080/demo/index.html` (necesita `dist/` compilado y COOP/COEP: lo da el servidor). Elige la ROM **con un clic** en el selector.
2. **Audio**: ¿suena el juego, sin chasquidos ni tartamudeo, durante 5 minutos? Mira en el panel «Audio» que *underruns* se quede en 0 o casi.
   Prueba silencio y volumen, pausa/reanudar, y velocidad 2x (debe callar a propósito).
3. **Entrada**: flechas, `Z`=A, `X`=B, `A`=X, `S`=Y, `Enter`=Start, `V`=Select; un mando estándar; el **ratón/dedo en la pantalla inferior**
   (menús táctiles de HeartGold/SoulSilver, el Pokégear). Comprueba que las flechas no desplazan la página.
4. **Guardado**: guarda dentro del juego (Informe), espera ~1 s y mira «Último onSave»; cierra la pestaña, vuelve a abrir la demo, elige la **misma
   ROM** y confirma que dice «IndexedDB: «Continuar»» y que **el juego conserva la partida**. Descarga el `.sav` y comprueba que tiene 524 288 bytes
   (Flash 512 KiB) [VERIFICAR]. Prueba también «Estado rápido».
5. **Trucos**: pega un código Action Replay conocido de SoulSilver (palabras hexadecimales de 8 dígitos; el panel acepta cualquier
   separador), «Activar» y comprueba el efecto; «Desactivar» y «Quitar todos». Un código que no haga nada con otra ROM no es un fallo de la demo.
6. **Rendimiento**: fps de emulación y ms por fotograma en el panel «Emulador» (objetivo ≈59,8 fps), con y sin «Renderizador 3D con hilos», y
   mirando si el audio aguanta en escenas 3D (batallas). Anota el modelo de CPU/GPU.
7. Abre la consola de DevTools: no debería haber errores en rojo.
