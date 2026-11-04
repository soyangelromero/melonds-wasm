# Informe de la Fase 6: guardado de partida y estados

Estado (2026-11-04): **pruebas de guardado y estado pasando** contra el núcleo real (13 de 14 pruebas de Node, 1 opcional omitida) y en Chromium sin interfaz
con el worker real (19/19 comprobaciones). **No se pudo probar con ninguna ROM comercial** (no hay en la nube): la prueba clave con SoulSilver/Platino/Negra
queda para ti (`tests/MANUAL.md`, tabla vacía). Audio, entrada y trucos no se tocaron. **Sin parches nuevos** en `core/patches/` (submódulo intacto salvo los 7 parches ya existentes que aplica `build-core.sh`).

## Versiones

| Elemento | Valor |
|---|---|
| Núcleo | melonDS DS `f394adba` (v1.4.0); motor (fork) `16f127db`; 7 parches existentes, ninguno nuevo |
| Emscripten | 6.0.13 (emsdk instalado desde cero, sin Docker) |
| Node | v22.23.4 |
| Chromium / Playwright | 153.0.8010.12 / 1.63.0 (global en la nube) |
| ROM de prueba | **cartucho sintético propio** (`tests/lib/synth-rom.mjs`, código ARM en `tests/synth/synthrom.s`), 64 KiB, sin contenido de Nintendo (ni siquiera el logo: solo el campo de CRC16 que melonDS comprueba, `0xCF56`). `nmap.nds` (CC0) **no se pudo descargar**: el proxy de la sesión bloquea ese repositorio |

## Comandos exactos

```bash
git submodule update --init third_party/melonds-ds
source /home/user/emsdk/emsdk_env.sh
bash scripts/build-core.sh && bash scripts/build-host.sh     # dist/melonds.{js,wasm}
npm run test:saves             # node --test tests/phase6-saves.mjs     (≈40 s)  guardado + estados contra el núcleo real
npm run test:saves-browser     # node tests/phase6-browser.mjs           (≈6 s)   worker real + SaveClient en Chromium
npm test                       # incluye tests/saves-client.test.mjs (debounce/caché, sin wasm); phase0.test.mjs sigue fallando (ya documentado en Fase 3)
MDS_ROM=tests/artifacts/nmap.nds npm run test:saves   # añade la prueba opcional con el homebrew libre, si lo colocas ahí
npm run serve                  # demo manual: http://127.0.0.1:8080/demo/saves.html
```

## Qué soporta melonDS (leído del código, no supuesto)

`NDSCart/CartRetail.cpp` (motor) elige el tamaño por `ROMParams.SaveMemType` (base de datos de juegos `ROMList.cpp`; si el código de juego no está: homebrew = sin memoria, resto = tipo 2, EEPROM 8 KiB):

| `SaveMemType` | Bytes | Familia en melonDS (`SRAMType`) |
|---|---|---|
| 0 | 0 | ninguna (homebrew y juegos sin guardado) |
| 1 | 512 | EEPROM pequeña |
| 2 / 3 / 4 | 8 KiB / 64 KiB / 128 KiB | EEPROM «normal» |
| 5 / 6 / 7 | 256 KiB / 512 KiB / 1 MiB | Flash |
| 8 / 9 / 10 | 8 / 16 / 64 MiB | NAND (juegos tipo WarioWare Touched) |

FRAM no tiene tipo propio: melonDS la trata con el protocolo de EEPROM de 64 KiB **[VERIFICAR con un juego FRAM]**. Los Pokémon de DS usan Flash de 512 KiB (según el contrato; **[VERIFICAR]** con tus ROM: la demo muestra el tipo y el tamaño detectados).

**Cómo llega la SRAM al anfitrión**: `retro_get_memory_data/size(RETRO_MEMORY_SAVE_RAM)` devuelve el *búfer intermedio* del núcleo (`sram.cpp`, `SaveManager`) con **exactamente** el tamaño de la SRAM del cartucho: bytes crudos, sin cabecera ni pie. El anfitrión lo rellena entre `retro_load_game` y el primer `retro_run`; el primer fotograma lo instala en el cartucho (`core.cpp: InstallNdsSram`). Las escrituras del juego vuelven al mismo búfer al instante (`Platform::WriteNDSSave` → `SaveManager::Flush`), y `retro_unserialize` también lo reescribe. **No se usa `/save` (MEMFS)** para la SRAM de cartuchos. «Bytes idénticos a melonDS de escritorio»: verificado **por lectura de código** (mismo buffer del cartucho, misma longitud, sin envoltorio) y por la prueba de que `getSave()` mide exactamente el tamaño del cartucho; **no** comparado con un `.sav` real de escritorio (ver «No verificado»).

## Qué se hizo

- **`core/host/saves.cpp` + `saves.hpp`** (archivos nuevos; `host.cpp` solo gana 3 líneas de enganche y `build-host.sh` una palabra): `mds_load_rom` aplica el guardado; `mds_get_save`, `mds_set_save`, `mds_get_save_status`, `mds_poll_save` (detector de cambios), `mds_save_state`, `mds_load_state` (valida magic, versión, `coreAbi`, longitudes, CRC32 **antes** de tocar el emulador), `mds_get_core_abi`.
- **`js/saves-core.js`** (lado wasm, compartido por el worker y las pruebas), **`js/saves.js`** (`SaveClient`: `getSave` en caché, `getSaveNow`, `loadSave`, `onSave(cb, debounceMs=500)`, `flush`, `saveState`, `loadState`), enganche en `js/emu-worker.js` y `js/player.js` (`player.saves`, `loadRom(rom, {save})`, el ack lleva resultado). Errores `SaveError.code`: `STATE_VERSION`, `STATE_INCOMPATIBLE`, `STATE_CORRUPT` (+ `STATE_UNSUPPORTED`, `NO_ROM`, `NO_SAVE_MEMORY`).
- **`demo/saves.html` + `saves.js`**: demo aparte (no toca `demo/index.html`) con ROM, `.sav` inicial, descarga de `.sav`, estados rápidos y en archivo, autoguardado en IndexedDB (comodidad de la demo; la biblioteca no guarda nada).
- **Cartucho sintético** con código ARM propio que dibuja un contador y **escribe en la EEPROM por el bus SPI del cartucho** en los fotogramas 30 y 60 (`0xA0..0xAF` y `0xB0..0xBF` en el desplazamiento `0x10`): ejercita la ruta real juego → SRAM → `getSave` sin ROM comercial.

## Hallazgos del código que cambian el diseño

1. **Cartucho nuevo = ceros en el núcleo**: el búfer intermedio nace a cero y se instala tal cual; melonDS de escritorio y los chips reales parten de `0xFF`. El anfitrión rellena con `0xFF` si no hay `.sav` (desviación anotada).
2. **`retro_reset` pisa lo escrito antes**: `CoreState::Reset` copia la memoria viva del cartucho al búfer. `mds_set_save` hace el reset **primero** y escribe **después** (probado: sin ese orden el nuevo guardado se perdía).
3. **`retro_serialize` incluye la SRAM del cartucho** y `retro_unserialize` la reescribe en el búfer (`CartRetail::DoSavestate`). Por eso el estado vuelve la SRAM al momento guardado y `getSave()` lo refleja. La SRAM duplicada del contenedor sirve de comprobación y de inspección externa.
4. **Tamaño del estado**: `retro_serialize_size()` = **19 228 045 bytes (18,34 MiB)** en el cartucho de prueba (contenedor: 19 236 269). El tamaño es estable mientras el juego corre. **Modo DSi: sin estados** (`retro_serialize_size() == 0`; error `STATE_UNSUPPORTED`).
5. **Reloj**: el estado incluye el RTC y, con el reloj real, dos instancias iniciadas en segundos distintos difieren en 1 byte del estado (más el CRC). La prueba de determinismo fija el reloj (`melonds_start_time_mode=absolute`); con reloj fijo el contenedor es **idéntico byte a byte** entre instancias.
6. **Longitud distinta del `.sav`**: el motor rellena con `0xFF` o trunca (`CartRetail`); el anfitrión hace lo mismo y avisa (`saveStatus` 1). Un `.dsv` de DeSmuME (pie de 122 bytes tras los datos) se truncaría al tamaño correcto por esa misma regla, **pero no se ha probado**.

## Resultados reales

**Node, núcleo real (`npm run test:saves`, 13/14, 1 omitida = homebrew opcional)**
- SRAM de un cartucho sin guardado: 8192 bytes exactos, todo `0xFF`, tipo «EEPROM 8 KiB».
- Escrituras del propio juego (SPI): nada antes del fotograma 30; `0xA0..0xAF` en `0x10` después; `0xB0..0xBF` tras el 60; el resto intacto.
- `loadRom` con `.sav`: está en el búfer antes del primer fotograma, sigue ahí tras 10 fotogramas, y **el cartucho lo tiene** (el bloque de `retro_serialize` contiene esos 8192 bytes); la escritura del juego cae encima y lo demás no cambia.
- `.sav` de longitud incorrecta (1000 y 20000 bytes): relleno `0xFF` / truncado, `saveStatus` 1.
- `setSave` en caliente: reinicia (el fotograma 3 tras reiniciar = el fotograma 3 de un arranque limpio), el guardado nuevo sobrevive a los primeros fotogramas y llega al cartucho.
- Detector de cambios: exactamente 1 cambio por ráfaga (2 en 100 fotogramas); `setSave` no se cuenta como escritura del juego.
- Sin memoria de guardado (homebrew `####`): `getSave()` = `null`, `setSave` → `NO_SAVE_MEMORY`, `.sav` entrante → `saveStatus` 2, sin cambios.
- Contenedor: `MDSSTATE`, versión 1, flags 0, `coreAbi` `0x5df6fedb`, `sramLen` 8192, `stateLen` 19 228 045, longitud total = 28 + sram + estado + 4, CRC32 correcto, SRAM incrustada = `getSave()`.
- **Ida y vuelta** (guardar en el fotograma 45, modificar la SRAM con `setSave` —reinicia—, avanzar 120 fotogramas, cargar): la SRAM tras `loadState` es la del momento guardado; 1 y 30 fotogramas después el **hash SHA-256 del fotograma compuesto y la SRAM** coinciden con una ejecución de control sin perturbar (incluida la escritura del juego que ocurre *después* del momento guardado, lo que demuestra que se restauró la CPU), con el renderizador 3D **con y sin hilos**; y una instancia nueva con la misma ROM que carga el contenedor continúa igual.
- **Errores** con datos alterados (cada caso comprobado por `code`): versión 2 y 0 → `STATE_VERSION`; `coreAbi` con un bit cambiado → `STATE_INCOMPATIBLE`; magic malo, un bit de la SRAM, un bit del estado, CRC mal, truncado en 1, byte sobrante, menos que la cabecera, vacío, `sramLen` +1, `stateLen` −1, longitudes `0xFFFFFFFF` (sin desbordamiento) → `STATE_CORRUPT`; contenedor válido (CRC rehecho) con 4 bytes menos de estado, o con otra longitud de SRAM → `STATE_INCOMPATIBLE`. Tras todos los fallos el juego sigue **exactamente igual** que una ejecución de control (hash del fotograma) y el estado bueno aún carga.
- Determinismo: guardar dos veces seguidas = mismos bytes; dos instancias independientes en el fotograma 50 y 60 = mismos bytes (con reloj fijo); cargar y volver a guardar reproduce el contenedor.
- `mds_get_save`/`getSave` sin ROM: `NO_ROM`.

**Chromium + worker real (`npm run test:saves-browser`, 19/19)**: `loadRom` informa «EEPROM 8 KiB · 8192»; `onSave` se dispara **una vez por ráfaga** (2 en total, con 300 ms de debounce) con los bytes exactos; `getSave()` (caché) y `getSaveNow()`; `saveState()` devuelve el contenedor (19 236 269 bytes, transferido sin copia); `loadSave` y `loadState` restauran la SRAM; los tres códigos de error cruzan la frontera del worker; **análogo de la prueba clave**: `getSave()` → `dispose` → nuevo `VideoPlayer` → `loadRom(rom, {save})` devuelve exactamente los mismos bytes antes del primer fotograma; la demo reutiliza el guardado de IndexedDB tras recargar; sin errores de consola ni de página.

## No verificado (honesto)

- **Ninguna ROM comercial.** No se probó SoulSilver/Platino/Negra, ni Flash de 512 KiB, ni NAND, ni FRAM, ni que «Continuar» funcione sin firmware (la razón de ser del port). El cartucho sintético solo cubre EEPROM de 8 KiB; el camino de código es el mismo para el resto de tamaños, pero no está probado con ellos.
- **Bytes idénticos a un `.sav` de melonDS de escritorio**: verificado leyendo el código, no comparando archivos reales (hazlo con `tests/MANUAL.md` §A).
- **`nmap.nds`**: no se descargó (acceso a ese repositorio denegado en la sesión); la prueba opcional con él (`MDS_ROM=`) queda sin ejecutar. No usa SRAM de todos modos.
- **El contenedor no identifica la ROM**: un estado de otro juego con las mismas longitudes (SRAM y `retro_serialize_size`) podría cargarse mal sin error. El contrato no incluye ese campo (`flags` está reservado a 0); si lo quieres, propongo un campo de CRC de ROM en `flags`/versión 2.
- **`coreAbi` es un texto fijo**: no cambia solo al recompilar; hay que subirlo a mano si un parche cambia el formato (ver DEVIATIONS).
- **`getSave()` síncrono tiene hasta ≈170 ms de retraso** (caché); usa `await getSaveNow()` para guardar y cerrar. Cerrar la pestaña dentro de los ≈500 ms posteriores a la última escritura puede perder esa escritura en IndexedDB (la demo llama a `flush()` en `pagehide`, sin garantía).
- Estados de ≈18 MiB sin comprimir; no se evaluó compresión ni el límite de IndexedDB.
- Modo DSi: estados no soportados por el núcleo; guardado no probado.
- Prueba con la **Fase 5 (entrada)** unida: necesaria para jugar; esta rama no la tiene.

## Qué debes probar con tus ROM

`tests/MANUAL.md`: prueba clave de regresión por juego (partida nueva → guardar en el juego → `getSave()` → cerrar → reabrir con `loadRom(rom, {save})` → «Continuar», **sin firmware ni BIOS**), comparación de longitud/bytes con melonDS de escritorio, estados rápidos y en archivo, y guardar-y-cerrar. Tablas de resultados vacías.

## Siguiente paso

Unir las ramas de las Fases 4, 5 y 8 con esta (conflictos esperados y pequeños: `host.cpp` —3 líneas mías—, `build-host.sh` —una palabra—, `emu-worker.js`, `player.js`, `package.json`, `DEVIATIONS.md`), pasar el contrato (§2 `Promise` en `saveState/loadState/loadSave`, §6, §8) y ejecutar la prueba clave de `tests/MANUAL.md`.
