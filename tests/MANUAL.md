# Pruebas manuales (con tus ROM, en local)

Nada de esto se puede automatizar aquí: el repositorio no contiene ROM, BIOS ni firmware de Nintendo. Rellena las tablas con tus resultados.

## Antes de empezar

1. Compila: `source emsdk_env.sh && bash scripts/build-core.sh && bash scripts/build-host.sh` (o `scripts/build.sh`/`build.ps1` con Docker).
2. Sirve con aislamiento de origen: `npm run serve` y abre **http://127.0.0.1:8080/demo/saves.html** (usa `127.0.0.1`/`localhost`; sin COOP/COEP no arranca).
3. **Necesitas poder jugar.** La entrada (teclado, ratón sobre la pantalla táctil) es la Fase 5, que se hizo en otra rama. Esta prueba exige haber unido
   la Fase 5 con esta rama (o tener un mando/teclado conectado al `button()` del contrato). Sin entrada no se puede crear una partida nueva ni pulsar «Continuar».
4. **No pongas ningún archivo de firmware/BIOS** en ningún sitio. Ese es el objetivo: debe funcionar con el firmware y la FreeBIOS que genera melonDS.
5. Deja marcada la casilla «Autoguardar en este navegador» solo si quieres que la demo conserve el `.sav` por ti; el procedimiento de abajo no la necesita
   (usa el archivo que descargas), pero así tienes una copia de seguridad.

## PRUEBA CLAVE DE REGRESIÓN (por cada juego)

Juegos: **Pokémon SoulSilver, Platino, Negra y Negra 2** (los 4 de la biblioteca). Con el núcleo antiguo (EmulatorJS/melonDS 0.9.2) fallaba con
«error de conexión» al pulsar «Continuar» sin firmware real; la razón de ser de este port es que **no** falle. Negra 2 es una ROM de
512 MB: usa una `dist/` con tope de 2 GiB (`node scripts/raise-memory-limit.mjs`, o el rebuild con `scripts/build-host.sh`, que ya pide 2 GiB);
con el build de 1 GiB el port la rechaza con `ROM_TOO_LARGE` y la web app ofrece el fallback a EmulatorJS (verificado: también arranca).

Procedimiento exacto (repite entero para cada juego, empezando con el navegador sin guardado almacenado: pulsa «Borrar el guardado almacenado» o usa una ventana privada):

1. Abre `demo/saves.html`. En «ROM» elige el `.nds`. **No elijas ningún `.sav`.** Comprueba en «Tipo de guardado» lo que dice (p. ej. `Flash 512 KiB · 524288 bytes`) y apúntalo.
2. Crea una **partida nueva**: pasa la intro, nombre, etc. hasta poder moverte por el mundo.
3. **Guarda dentro del juego** (menú → Guardar → confirma, espera al mensaje «Partida guardada»).
4. Mira «Último onSave»: debe haber una hora y un tamaño (`#1 …` o más). Es la señal de que `onSave` vio la escritura y la estabilizó.
5. Pulsa **«Descargar .sav (getSave)»**. Guarda el archivo (`game.sav`). Anota su tamaño en bytes; debe coincidir con «Tipo de guardado».
6. **Cierra** la pestaña (o recarga la página). Abre `demo/saves.html` de nuevo.
7. Elige la misma ROM y, en «.sav inicial», el `game.sav` que descargaste → equivale a `loadRom(rom, { save: getSave() })`. Comprueba que «Origen del .sav» dice «archivo game.sav (N bytes)».
   (Variante 2: sin elegir `.sav`, con «Autoguardar» marcado, el origen debe decir «IndexedDB».)
8. En el título del juego, elige **«Continuar»**. Debe cargar tu partida (nombre, medallas/tiempo de juego, posición). **Resultado esperado: carga sin error y sin firmware.**
9. (Extra) Con la partida cargada, juega un rato, guarda de nuevo y comprueba que «Último onSave» vuelve a actualizarse.

Qué contar como fallo y qué guardar si falla: captura del mensaje, el `game.sav` descargado en el paso 5, el texto de «Tipo de guardado», y la consola del navegador (F12); para ver los mensajes del núcleo
añade `verbose: true` en `VideoPlayer.create` de `demo/saves.js` (salen como `[core …]`). **No subas ese `.sav` a ningún sitio público** (es tu partida).

### Tabla de resultados (rellenar)

| Juego | Región/versión | Tipo y tamaño de guardado detectado | Tamaño del `.sav` descargado | `onSave` se disparó | «Continuar» funciona (sí/no) | Con firmware real (si lo probaste) | Notas / mensaje de error |
|---|---|---|---|---|---|---|---|
| Pokémon SoulSilver | | | | | | | |
| Pokémon Platino | | | | | | | |
| Pokémon Negra | | | | | | | |
| Pokémon Negra 2 (512 MB; requiere build/parche de 2 GiB) | | | | | | | |
| (cuarto juego) | | | | | | | |

## Comprobaciones adicionales con tus ROM (opcionales pero recomendadas)

### A. Mismos bytes que melonDS de escritorio / DeSmuME
1. Con el `game.sav` del paso 5, ábrelo en melonDS de escritorio (Archivo → Abrir ROM, y colócalo con el nombre de la ROM + `.sav` al lado) y pulsa «Continuar»: debe cargar.
2. Al revés: juega y guarda en melonDS de escritorio, y pasa su `.sav` en el paso 7. Si la longitud no coincide, la demo lo indica («otra longitud, rellenado/truncado»): anota ambas longitudes.
3. Tabla:

| Juego | Longitud `.sav` del port | Longitud `.sav` de escritorio | ¿Iguales? | ¿Cargan en ambos sentidos? |
|---|---|---|---|---|
| SoulSilver | | | | |
| Platino | | | | |
| Negra | | | | |

### B. Estados
1. Con la partida en marcha, «Estado rápido: guardar»; juega 10 s; «Estado rápido: cargar». Debe volver al momento guardado (imagen y progreso).
2. «Descargar estado (.mdsstate)», recarga la página, abre la misma ROM, «Cargar estado desde archivo». Debe continuar donde lo dejaste. (Pesa unos 18 MiB por estado.)
3. Carga un estado de un juego en **otra** ROM: debe rechazarse con un mensaje (`STATE_INCOMPATIBLE`) o, si coincidieran los tamaños, **puede** cargarse mal: el contenedor no guarda la identidad de la ROM (ver `tests/PHASE6_REPORT.md`). Anota qué pasa.

| Juego | Estado rápido OK | Estado en archivo OK tras recargar | Observaciones |
|---|---|---|---|
| SoulSilver | | | |
| Platino | | | |
| Negra | | | |

### C. Guardar y cerrar enseguida
Guarda en el juego y cierra la pestaña a los 2 s. El `onSave` tiene 500 ms de «debounce» y la demo intenta un `flush()` al ocultar la página (no está garantizado que termine). Anota si el último guardado se conservó en IndexedDB.
