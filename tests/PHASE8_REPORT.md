# Informe de la Fase 8: trucos Action Replay

Estado (2026-11-04): **trucos funcionando y probados contra el núcleo real con el homebrew CC0 `nmap.nds`**: `npm run test:cheats` = 9 + 21 pruebas, todas pasan (1 se omite sin catálogos reales). Sin parches nuevos en `core/patches/` (submódulo intacto). Audio, entrada y guardado no se tocaron.

## Versiones

| Elemento | Valor |
|---|---|
| Emscripten | 6.0.13 (emsdk `d7b4130`, sin Docker) |
| Node | v22.23.4 |
| Núcleo | melonDS DS `f394adba` (v1.4.0), 7 parches existentes |
| Motor | fork `JesseTG/melonDS` `16f127db` (el que fija `scripts/build-core.sh`); `AREngine.cpp` leído en `build/melonds/_deps/melonds-src/src/` |
| ROM de prueba | `nmap.nds` (rmn20/normalmappingds `6fb2d425`, CC0), SHA-256 `b21f5889…19132`, en `tests/artifacts/` (ignorada) |
| Datos efímeros | libretro/libretro-database `2fdd069d` (2026-11-01), solo `cht/Nintendo - Nintendo DS` (4204 archivos), en `tests/artifacts/libretro-database-src/` (ignorada, **no se sube**) |

## Comandos exactos

```bash
git submodule update --init third_party/melonds-ds
source /home/user/emsdk/emsdk_env.sh
bash scripts/build-core.sh && bash scripts/build-host.sh      # dist/melonds.{js,wasm}
mkdir -p tests/artifacts                                       # coloca nmap.nds (o tu .nds) en tests/artifacts/nmap.nds

npm run test:cheats          # = node --test tests/cheats.test.mjs tests/cheats-memory.test.mjs
npm test                     # todo (incluye lo anterior; phase0.test.mjs falla desde antes, ver DEVIATIONS.md Fase 3)

# catálogos reales (los cuatro JSON): carpeta por variable de entorno o por argumento
CHEATS_DIR=/ruta/a/nds/cheats node --test tests/cheats.test.mjs
node tests/cheats.test.mjs /ruta/a/nds/cheats

# datos de prueba de libretro-database (efímeros)
git clone -q --depth 1 --filter=blob:none --sparse https://github.com/libretro/libretro-database.git tests/artifacts/libretro-database-src
git -C tests/artifacts/libretro-database-src sparse-checkout set "cht/Nintendo - Nintendo DS"
node --test tests/cheats.test.mjs                  # imprime recuento y escribe tests/artifacts/cht-report.json
CHT_FULL=1 node --test tests/cheats-memory.test.mjs   # carga TODOS los códigos aceptados en el núcleo (por defecto 1 de cada 10; ROM=/ruta.nds cambia la ROM)
```
Sin `dist/` o sin la ROM, `tests/cheats-memory.test.mjs` se **omite** (skip) con el motivo; no falla.

## 1. Cómo lo implementa el núcleo (leído en el código real)

**`libretro.cpp:207-218`** solo reenvía: `retro_cheat_reset()` → `Core.CheatReset()`, `retro_cheat_set(index, enabled, code)` → `Core.CheatSet(...)`.

**`core/core.cpp:1207-1259`**:
- `CheatReset`: `Console->AREngine.Cheats.clear()` (si hay consola).
- `CheatSet(index, enabled, code)`: sale **sin hacer nada** si `code` está vacío o no hay `Console`; valida con `_cheatSyntax = ^\s*[0-9A-Fa-f]{8}([+\s-]*[0-9A-Fa-f]{8})*$` (`core.hpp:186`) y, si falla, solo muestra un aviso en pantalla («Cheat #N … isn't valid, ignoring it»); extrae las palabras con `[0-9A-Fa-f]{8}`, crea un `melonDS::ARCode{Name=code, Enabled=enabled, Code=palabras}` y hace `Cheats[index] = código` si `index < Cheats.size()`, o `Cheats.push_back` si no. **`index` es una posición, no un id.** Un `index` mayor que el tamaño añade al final (no deja huecos).
- `core.cpp:328/358`: al recrear la consola (cambio de configuración) el vector de trucos se conserva. `NDS.cpp` no toca `Cheats` (grep): sobreviven a un reset [VERIFICAR: no hay `mds_reset` todavía, no probado].
- **Nota:** el regex no admite separadores al final (`$`): un `"…\n"` final lo rechaza; por eso el conversor entrega la forma canónica `A+B+C` sin separador final.

**Motor AR (`AREngine.cpp`, `ARM.cpp`)**: no hay hilo ni temporizador propios. `ARM::TriggerIRQ()` (ARM.cpp:527-548): cuando la **ARM7** toma una IRQ y `IF[1] & IE[1]` tiene VBlank activo, llama a `AREngine.RunCheats()`, que recorre el vector y ejecuta `RunCheat` de cada código con `Enabled`. Es decir, los códigos se ejecutan **una vez por VBlank (≈60/s), mientras el juego tenga activada la IRQ VBlank de la ARM7 y las IRQ no estén enmascaradas** (`CPSR & 0x80` → no corre). Todas las lecturas/escrituras pasan por el bus de la ARM7 (`ARM7Read*/Write*`). «Activar/desactivar en caliente» = cambiar `Enabled` del `ARCode` (reemplazando el elemento de su posición): surte efecto en el siguiente VBlank, sin reiniciar.

Opcodes del motor: `0x00-0xBF` (nibble alto 0-B: escribir 32/16/8 bits `0x/1x/2x`, condicionales `3x..Ax`, `Bx` puntero), `C0` FOR, `C4` (**no soportado**: registra un error y para), `C5` contador, `C6`, `D0` ENDIF, `D1` NEXT, `D2` NEXT+FLUSH, `D3-DC` registro de datos/offset, `Ex` copia con payload, `Fx` copia de memoria. Cualquier otro opcode: registra «bad AR opcode» y **detiene ese código**.

**Dos fallos de seguridad del motor que el glue evita** (importante): `RunCheat` lee las instrucciones **de dos en dos sin comprobar límites**: un número impar de palabras, o un `Exxxxxxx` cuyo payload anunciado excede el código, hace que lea memoria fuera del vector. El regex del núcleo no lo impide (solo mira la sintaxis de cada palabra). Por eso `js/cheats.js` y `core/host/cheats.cpp` validan ambos casos.

## 2. Glue C++ (`core/host/cheats.cpp`, archivo nuevo)

- `mds_cheat_set(id, enabled, ptr, len)` → ranura (≥0) o error: `-1` sin juego, `-2` vacío/id desconocido, `-3` palabra no válida, `-4` número impar, `-5` payload E-type incompleto. Mantiene `std::map<id, {ranura, texto, enabled}>`: id nuevo ⇒ siguiente ranura; id existente ⇒ su misma ranura (reemplaza en el núcleo). Con `len == 0` y id conocido reutiliza el texto guardado (conmutar sin reenviarlo).
- **Ranura = tamaño del vector del núcleo** solo si nada que el núcleo ignore llega a `retro_cheat_set`. Por eso el glue reconstruye el texto en forma canónica y **rechaza antes** lo que el núcleo descartaría (vacío, no válido, sin juego): si un código nuevo «fantasma» consumiera una ranura, las siguientes se desplazarían y se acabarían duplicando códigos. Hay una prueba específica.
- `mds_cheat_clear()` → `retro_cheat_reset()` + vaciar el mapa (seguro antes de cargar la ROM).
- Diagnóstico: `mds_cheat_count`, `mds_cheat_slot(id)`, `mds_cheat_enabled(id)`, `mds_heap_used()` (`mallinfo().uordblks`, para la prueba de fugas).
- **Lectura de RAM**: no hace falta `mds_peek` ni parche. `retro_get_memory_data(RETRO_MEMORY_SYSTEM_RAM)` devuelve `Console->MainRAM` (4 MiB en DS; `core.cpp:1131-1140`, `GetMemorySize`); `mds_ram_data()`/`mds_ram_size()` lo exponen. El puntero es de la memoria wasm, **no está alineado a 4** (leer con `HEAPU8`, no `HEAPU32`) y puede cambiar si el núcleo recrea la consola: consúltalo cada vez. Dirección DS = `0x02000000 + desplazamiento`. (`SET_MEMORY_MAPS` sigue aceptándose sin guardar; no se usó.)
- Cambios en archivos compartidos (mínimos): `host.cpp` (+4 líneas: declaración y llamada `mds_cheats_forget()` en `mds_destroy`, y `mds_host_loaded()`), `build-host.sh` (+1 línea: `core/host/cheats.cpp \`; no se tocó la lista `EXPORTS` porque `EMSCRIPTEN_KEEPALIVE` ya exporta), `emu-worker.js` (+2 líneas: import y `...cheatHandlers(() => M)`), `package.json` (+1 script).

## 3. Conversor JS (`js/cheats.js`, `js/cheats-worker.js`)

- `parseCheat(texto)` → `{ok:true, words, code, warnings}` o `{ok:false, error:{code, message, line, column, token, wordIndex}}`. Acepta palabras de exactamente 8 dígitos hex (mayúsc./minúsc.) separadas por `+`, `-`, espacios, tabuladores o saltos de línea: forma `A+B+C`, líneas sueltas y pares `XXXXXXXX XXXXXXXX`. Salida canónica en mayúsculas, sin separador final.
- Errores: `EMPTY`, `NOT_STRING`, `BAD_TOKEN` (longitud ≠ 8, no hex, prefijo `0x`; con línea y columna), `ODD_WORDS`, `TRUNCATED_PAYLOAD`, `TOO_LONG`. Avisos (el código se acepta): `PAYLOAD_PADDED`, `UNKNOWN_OPCODE`, `UNSUPPORTED_OPCODE` (C4).
- **Decisión sobre payload E-type corto** (descubierta con datos reales): hay códigos muy extendidos, p. ej. «Evitar la protección antipiratería» de HGSS (está en `reference/cheats-sample.json` y en libretro-database), cuyo `E23FF104 00000080` anuncia 32 palabras y trae 30. Rechazarlo haría fallar el catálogo real. Si faltan **≤ 4 palabras** (`MAX_PAD_WORDS`, valor elegido por mí mirando los datos: 17 casos de libretro-database faltan 2, uno falta 4, y el resto falta 30, 330 o millones) se rellena con ceros y se avisa (en lugar de dejar que el motor lea memoria ajena); si faltan más, error.
- `catalogEntries` / `parseCatalog` recorren el formato de la web app `{id,title,categories:[{name,en,cheats:[{n,c,e}]}]}`. El `index` es correlativo; el esquema de ids de la web app no se conoce aquí.
- `js/cheats-worker.js`: `setCheat(M,id,enabled,code)`, `clearCheats(M)` y `cheatHandlers(getModule)` (mensajes `{type:"cheat",id,enabled,code}` y `{type:"cheatClear"}`); lanza `Error` con `code` (`CHEAT_BAD_TOKEN`, …) y `line`/`column`. **No** hay todavía método en una clase `MelonDS` (Fase 10) ni en `VideoPlayer`.

## 4. Resultados reales

**Parser y catálogos (`tests/cheats.test.mjs`)**: 8 pasan, 1 omitida (catálogos reales, no están aquí). `reference/cheats-sample.json`: **6/6 parsean** (1 con aviso `PAYLOAD_PADDED`). Comprobado con un catálogo falso con un código roto: `CHEATS_DIR` lo detecta y falla con `BAD.json #2 [General] «roto»: BAD_TOKEN línea 1, columna 10…`.

**libretro-database NDS (datos efímeros)**: 4204 archivos, 645 072 códigos (24 161 entradas sin línea `cheatN_code`, ignoradas). **645 025 parsean (99,993 %)**, 47 no (detalle en `tests/artifacts/cht-report.json`):

| Causa | Casos | Qué son |
|---|---|---|
| `TRUNCATED_PAYLOAD` | 26 | `E…` con payload mucho más corto de lo anunciado: Black/White (faltan 330 palabras, ~13 archivos), Naruto Shippuden (millones de bytes), Strange Journey, y códigos desalineados cuyas palabras de datos se leen como instrucción (`E59F0000` como recuento de bytes) |
| `BAD_TOKEN` | 11 | no son códigos: `master`, `folder` como texto del código (marcadores del `.cht`) |
| `EMPTY` | 5 | entradas de RetroArch con `cheatN_code = ""` |
| `ODD_WORDS` | 5 | número impar de palabras (p. ej. Iron Man 2 #5, Ratatouille #4: un `0000000A` suelto delante; Up (Greece) #18/#19) |

Los 18 con `PAYLOAD_PADDED` se aceptan. **Qué NO sé**: si esos 47 funcionan en melonDS de escritorio (el motor leería memoria fuera del vector en los impares/truncados) ni si el catálogo real del usuario los contiene; el test de CHEATS_DIR los listará con su nombre.

**Todo lo que acepta JS lo acepta C++ y el núcleo**: `CHT_FULL=1` carga (desactivados, en lotes de 1000 ids) los **645 025** códigos: 0 rechazados (24 s). Paridad de códigos de error JS↔C++ comprobada con 18 entradas.

**Efecto en memoria (`tests/cheats-memory.test.mjs`, 21/21, ≈10 s)**:
- Dirección elegida: **`0x02200000`–`0x0223FFFF` (256 KiB)**. Medida: 262 144 bytes a cero en el fotograma 30 y **ningún cambio en 600 fotogramas** (instantáneas cada 5).
- `02200000+DEADBEEF`: antes `0`, sin truco sigue `0`, tras activarlo vale `DEADBEEF` **al primer fotograma**; si lo borro a mano, **vuelve al siguiente VBlank** (se reaplica); desactivado (sin reenviar el texto) **el valor se queda** (no revierte) y el motor **deja de escribir** (un valor puesto a mano se mantiene 10 fotogramas); reactivar vuelve a escribir. En `nmap.nds` la IRQ VBlank de la ARM7 está activa (es el caso `libnds` por defecto).
- Once códigos sintéticos **todos verificados** (cada uno solo, con valores previos sembrados): escritura 32 (`0x`), 16 (`1x`) y 8 bits (`2x`) comprobando que no tocan los bytes vecinos; `5x` IF == verdadero con `D0` ENDIF; `5x` falso (no escribe lo anidado y sí lo posterior al `D0`); `9x` IF 16 bits con máscara; `3x` IF mayor; `C0`+`D5`/`D6`+`D2` **bucle** (4 palabras consecutivas, la quinta intacta); `Ex` copia de bloque; `Bx` puntero + `D6`; `D4` operaciones de datos (`+`, `|`). **No verificados**: `4x/6x/7x/8x/Ax` (mismo código que los verificados con otro operador), `C5`, `C6`, `D1`, `D7-DC`, `Fx`, y los que dependen de la entrada del jugador (`94000130…`, la mayoría del catálogo real: hace falta la Fase 5); `C4` ni se prueba (el motor lo rechaza).
- **Estrés**: 20 activaciones/desactivaciones del mismo código con 3 fotogramas entre cada una: una sola ranura (`count`=1, `slot`=0), cada estado escribe o no escribe según toca, **heap +0 bytes**; 20 000 llamadas más sin emular: **+0 bytes**; sin cuelgues.
- **Ids dispersos 5, 1000, 3** → ranuras 0, 1, 2 (orden de aparición); repetir 1000 con otro código mantiene la ranura 1, `count` sigue en 3 y el código antiguo **deja de escribir** (el reemplazo ocurre de verdad en el núcleo); repetir 5 y 3 no crece; id 7 → ranura 3; desactivar uno no afecta a los demás; `clear` ⇒ ranuras desde 0 y nada sigue escribiendo.
- Sin juego cargado: `mds_cheat_set` = -1, sin ranura. Inválidos (-3/-4/-5/-2) no consumen ranura y el primer válido usa la 0; un id existente con texto inválido conserva su código.
- Las 6 entradas de `cheats-sample.json` se cargan y se emulan 120 fotogramas sin problema (en `nmap.nds` sus condiciones no se cumplen: no hay efecto que medir).
- Regresión: hash del fotograma 300 de `headless.mjs` = `a0d4f91c…` (igual que Fases 2/3); `phase3-browser.mjs` 46/46 (el worker carga con el nuevo `import`).

## No verificado [VERIFICAR]

- **Los cuatro catálogos reales** (`CPUS`, `IPGS`, `IRBS`, `IRES`): no están aquí; solo el test de `CHEATS_DIR` está listo. Tampoco los «10 códigos conocidos» de dinero / MTs / atravesar paredes del contrato §4 (necesitan SoulSilver y la dirección real).
- Efecto con códigos que dependen de **entrada** (no hay Fase 5) y con ROMs comerciales: solo `nmap.nds`.
- Comportamiento tras un reset de la consola y con `loadState` (no existen todavía `mds_reset`/estados); que `loadState` no toque el vector de trucos.
- Modo DSi (RAM de 16 MiB): no probado; el núcleo está en modo DS.
- El comportamiento exacto de melonDS de escritorio con los 47 códigos rechazados y con el relleno a ceros de los 18 aceptados.
- Navegador: el worker carga con el nuevo `import` (46/46 de la demo), pero **no se ejercitó** el mensaje `{type:"cheat"}` en un Worker real; solo los handlers en Node.
- Desactivar no revierte: no hay forma de hacerlo sin guardar los bytes originales (ver DEVIATIONS.md).

## Qué debes probar con tus catálogos y SoulSilver

1. `CHEATS_DIR=/ruta/a/nds/cheats node --test tests/cheats.test.mjs`: **debe pasar**. Si falla, la salida da catálogo, índice, categoría, nombre y motivo de cada código (lo más probable: impares o payload truncado, mira la tabla de arriba).
2. Revisa los avisos `PAYLOAD_PADDED` del resumen (`# IPGS.json: N/N parsean, M con avisos`).
3. En SoulSilver: «Evitar la protección antipiratería» y «Parche de comprobación de overlay» (están en la muestra) suelen ser códigos maestros: actívalos primero. Luego dinero, MTs y atravesar paredes; comprueba que surten efecto, que al desactivar «atravesar paredes» el juego vuelve a la normalidad **solo para lo que el código aplica cada fotograma** (si el código escribe una vez, el valor queda), y repite activar/desactivar varias veces.
4. Recuerda que esos códigos dependen de leer el teclado (`94000130…`): hasta la Fase 5 no habrá forma de ejercitarlos dentro del emulador.

## Siguiente paso

Cablear `setCheat(id, enabled, code)` / `clearCheats()` en la clase final (Fase 10) con los mensajes `cheat`/`cheatClear` ya soportados por `js/emu-worker.js`, y repetir la prueba de efecto con SoulSilver y el módulo de entrada (Fase 5) cuando se una todo.
