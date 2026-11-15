# PHASE 9 — Rendimiento y ritmo: informe (2026-11-15)

Estado: **Fase 9 cerrada en el lado JS**: medición, control dinámico del audio a 1x, perfilado del bucle y tres
optimizaciones JS con conmutador de prueba (§7). Lo que exige **recompilar el wasm** queda documentado como pendiente
porque en esta máquina Docker Desktop está parado y no hay emsdk (ver `PROGRESO.md` §10.3). No se ha hecho commit ni
push: todo son cambios en el árbol de trabajo de `feat/integration`.

Documentos relacionados: `tests/BENCH.md` (tabla de medidas y equipo), `tests/DEVIATIONS.md` (desviaciones de la
fase), `docs/GUIA_COMPLETAR_PORT.md` §4.3 (especificación de la fase).

---

## 1. Resumen

| Punto de la guía | Estado |
|---|---|
| `setSpeed` 1 / N / 0 predecible | Ya estaba hecho (fases anteriores); sin cambios en esta fase |
| `getStats()` con fps, ms de emulación y render, buffer de audio, hilos | Ya estaba; ahora el objeto `audio` añade `drc` y `drcMode` para validar el control dinámico |
| Medir 10–20 s por configuración (1x, 1,5x, 2x, sin límite; hilos 3D on/off) y tabla comparable | **Hecho** con `tests/bench-browser.mjs` (conduce el botón de la demo) y `tests/BENCH.md` |
| Perfilar el bucle y proponer 3 optimizaciones con ganancia medida | **Hecho** (Fase 9b, §7): gancho test-only `debugProfile` con reparto por tramos y 3 optimizaciones JS medidas con conmutador test-only (`debugOpt`); resumen en `tests/BENCH.md` §6 |
| Decidir los hilos 3D con datos | **Hecho**: se mantienen activados; sin política automática (§6). Medido en escena 3D real (`nmap.nds`) y en SoulSilver |
| Decisión 0.0 #4: `audioDynamicRate: "always"` por defecto con suelo 0,8 a 1x | **Implementado y validado** con unitarias deterministas y medidas reales (§4) |
| `tests/BENCH.md` con línea base y explicación del cuello de botella | **Hecho** |
| Todas las pruebas en verde | `tests/audio-playback.test.mjs` 22/22; suite completa **136 pruebas: 113 pasan, 0 fallan, 23 omitidas**; determinismo del fotograma 300 intacto |

---

## 2. Qué se ha implementado

### 2.1 Control dinámico de velocidad del audio (DRC) también a 1x

Cadena completa, de la opción pública al `AudioWorklet`:

- **`js/audio-ring.js`**
  - `CTRL.DRC_MODE` (19): `0` off, `1` solo avance rápido, `2` siempre. Lo escribe el worker.
  - `CTRL.DRC_MILLI` (20): factor actual x1000 que deja el consumidor en cada cuanto (1000 = sin ralentizar).
  - `AudioRingWriter.setDrcMode(mode)` y `get drcMode`.
  - `readRingStats()` expone `playRate`, `drcMode` y `drc` (0 en `DRC_MILLI` se interpreta como 1, es decir «aún no
    informado»).
- **`js/audio-playback.js`**
  - Nuevas constantes: `DRC_MIN_1X = 0.8` (suelo a 1x), `DRC_OFF/DRC_FF/DRC_ALWAYS`, y se mantiene `DRC_MIN = 0.5`
    para avance rápido.
  - El control corre si `DRC_MODE === 2` **o** (`DRC_MODE === 1` y `playRate > 1`). Suelo: `playRate > 1 ? 0.5 : 0.8`.
  - Fórmula intacta (`want = clamp(fill / (target·0.9), suelo, 1)` con suavizado de 0,01 por cuanto); si el control
    no aplica, `drc = 1`. Con pausa también se fuerza 1 (no hay reproducción que ralentizar).
  - El factor se publica en `CTRL.DRC_MILLI` en **cada** cuanto, para que tests, demo y estadísticas lo lean.
- **`js/emu-worker.js`**
  - Estado `audioDynamicRate` (por defecto `"always"`), mapa `off→0, ff→1, always→2`, `applyDynamicRate()`.
  - Se inicializa desde el mensaje `init` (antes de que exista el anillo se recuerda) y se aplica en cuanto el
    `AudioRingWriter` existe; nuevo manejador `audioDynamicRate` que valida el modo (error
    `AUDIO_DYNAMIC_RATE_INVALID`) y lo aplica **antes o después de `loadRom`**.
- **`js/player.js`**
  - `VideoPlayer.create({ …, audioDynamicRate = "always" })` valida/normaliza con
    `normalizeAudioDynamicRate()` (`off|ff|always`, lanza `AUDIO_DYNAMIC_RATE_INVALID`) y lo manda en el mensaje
    `init`.
  - `VideoPlayer.setAudioDynamicRate(mode)` (mensaje `{type:"audioDynamicRate", mode}`) para cambiarlo en caliente.
- **`js/melonds.js`**
  - Pasa `audioDynamicRate` de `create()` a `VideoPlayer.create` (también tras un `reset()`), y
    `MelonDS.setAudioDynamicRate(mode)` valida y delega. Cabecera del archivo actualizada con el defecto **"always"**
    y su semántica.

**El defecto sin argumentos es `"always"` en `MelonDS`, `VideoPlayer` y el worker.** `"ff"` reproduce el
comportamiento anterior (solo actúa con `playRate > 1`) y `"off"` lo desactiva por completo.

### 2.2 Error elegante de ROM demasiado grande (hallazgo del test de biblioteca)

El build actual (1 GiB de memoria máxima) **aborta** al cargar Negra 2 (512 MB) porque melonDS mantiene ~3 copias del
ROM en el heap (`mds_load_rom` + `NDSCart::ParseROM` + `CartRetail`). `js/emu-worker.js` `loadRom()` ahora:

- envuelve `malloc` + `mds_load_rom` en `try/catch` (incluida la limpieza del puntero);
- si el traps es de Emscripten (`RuntimeError: unreachable` / `Aborted`) relanza
  `Error("mds_load_rom aborted: the ROM does not fit in the wasm heap (MAXIMUM_MEMORY). Rebuild the host with -sMAXIMUM_MEMORY=2147483648 (2 GiB) - see scripts/build-host.sh")`
  con `code: "ROM_TOO_LARGE"`;
- los códigos de retorno documentados de `mds_load_rom` siguen siendo `ROM_INVALID`.

**Verificado en Chromium real** (demo, `?autoplay=1&threads=1`, `page.setInputFiles` con Negra 2 512 MB):

```
elapsed=2.2s
msg="ROM_TOO_LARGE: mds_load_rom aborted: the ROM does not fit in the wasm heap (MAXIMUM_MEMORY)..."
pageerrors=[]
```

Es decir: antes la página se quedaba colgada; ahora el worker postea un `error` con código y `loadRom` **rechaza en 2,2 s**.
En la demo no hay `pageerror` suelto; en la web app `?engine=wasm` el motivo se muestra en la barra de estado y se deja en
`window.__wasmLoadError` (tampoco hay pageerror) para que las pruebas fallen rápido. Con ese build el mismo ROM debería
cargar, pero **eso no se ha podido probar aquí** (no hay Docker/emsdk).

### 2.3 Perfilador del bucle y tres optimizaciones JS (Fase 9b)

Todo en `js/emu-worker.js`, sin tocar el emulado ni necesitar rebuild:

- **Gancho de perfilado test-only** `{type:"debugProfile", on}` (patrón de `debugStall`/`debugBurst`): acumula por
  ventana de `stats` los ms de `core` (`applyInput` + `mds_run_frame`), `publish` (copia del fotograma + `postMessage`),
  `audio` (`drainAudio`), `saves` (detector de SRAM), `yield` (`await yieldToEvents`, incluye la espera de mensajes) y
  `wait` (`Atomics.wait` del bucle), y los publica como `prof` en el mensaje `stats` **solo con el perfilador activo**.
  Se añade `{type:"debugPing"}` para medir la latencia de ida y vuelta de un mensaje de control.
- **Conmutador A/B test-only** `{type:"debugOpt", set:{publishDecimation,savesCadence,yieldEvery2}}`: las tres
  optimizaciones están **activas por defecto**; el switch permite forzar el comportamiento viejo en el mismo build.
- **(a) Decimación de la publicación en avance rápido/sin límite**: `publishFrame` copia y publica como máximo 1
  fotograma cada `FRAME_PUBLISH_MS`. La lógica de serial duplicado no se toca y `publishFrame(true)` fuerza la
  publicación del último fotograma al pausar/parar (verificado en Chromium). **Desviación medida**: el umbral de
  ~16,7 ms de la guía deja el dibujado en ~40 fps cuando el emulador va a 60–120 fps (cuantización a 2 fotogramas);
  con **8,3 ms (120/s)** la decimación solo actúa por encima de ~120 fps, donde es un ahorro real (ver §7).
- **(b) Cadencia del detector de SRAM**: `saves.tick()` se llama cada frame a 1x (igual que antes) y **cada 3 frames** en
  avance rápido/sin límite (→ un poll del núcleo cada 30 en vez de cada 10; latencia de autoguardado ~100–170 ms de
  tiempo de juego). El tick forzado al pausar se mantiene.
- **(c) `yield` cada 2 fotogramas en avance rápido/sin límite**: un salto de macrotarea menos por fotograma, con una
  guarda de 40 ms para que los mensajes no mueran de hambre cuando el bucle pasa tiempo esperando. A 1x se sigue
  cediendo en cada fotograma. **Coste medido**: la latencia de un mensaje de control en FF sube ~12 ms (≈1 fotograma).

A 1x las tres son **no-ops exactas** (ramas condicionadas a `speed !== 1`). El banco manual `tests/bench.html`/`js/bench.js`
gana las casillas «forzar comportamiento antiguo» y «perfilar el bucle», y `tests/bench-browser.mjs` los entornos
`OPT_VARIANTS=off,all,a,b,c,ab,ac`, `PROF=1`, `PROFILE_VARIANTS`/`PROFILE_SPEED` y `SKIP_IDENT`.

---

## 3. Pruebas

| Comando | Resultado |
|---|---|
| `node --test --test-force-exit tests/audio-playback.test.mjs` | **22/22** (18 existentes + 4 nuevas) |
| `node --test --test-force-exit tests/melonds-api.test.mjs tests/webapp-adapter.test.mjs` | **22/22** |
| `node --test --test-force-exit tests/audio-ring.test.mjs` (sola) | **5/5** |
| `node --check` de los 5 JS tocados + `js/bench.js` + `tests/bench-browser.mjs` | OK |
| `node --test --test-force-exit tests/` (suite completa, con `nmap.nds` presente) | **136 pruebas: 113 pasan, 0 fallan, 23 omitidas** (el intermitente preexistente de `audio-ring.test.mjs` no apareció en esta pasada; con él son 112/1/23) |
| Determinismo `node tests/headless.mjs tests/artifacts/nmap.nds 300 --threads=0|1` | fotograma 300 = `a0d4f91c…890bf` en **ambos**; coincide con la línea base de las fases 2–8 |

Las 4 pruebas nuevas de `tests/audio-playback.test.mjs`:

1. `always` a 1x con productor limitado a 0,9x: 0 underruns, tono de salida 0,8–1,0 del nominal (≈0,9) y el anillo
   nunca se seca; el factor queda ≈0,90 y el llenado ≈0,81 del objetivo.
2. `always` a 1x con productor a tiempo: tono exacto 1 kHz, amplitud 0,5, factor 1,000, sin underruns (no cambia nada).
3. `off` a 1x con el mismo productor 0,9x: factor 1 y el anillo se seca (underruns > 0), el contraste del defecto.
4. `ff` a 1x con productor 0,9x: no actúa (factor 1); las pruebas existentes de avance rápido se han hecho explícitas
   con `setDrcMode(1)` y se comprueba que a 2x el control sigue bajando el factor a ≈0,8 cuando el productor da 1,6x.

Nota: `tests/audio-ring.test.mjs` («two threads: 3 million frames…») es el fallo intermitente preexistente bajo carga
documentado en `PROGRESO.md` §10.5; en esta sesión falló una vez con el test de biblioteca del Lead ocupando la CPU y
pasó sola (5/5). No se ha tocado.

`tests/artifacts/nmap.nds` (homebrew CC0 de `rmn20/normalmappingds`, commit `6fb2d425`, 266 240 B, SHA-256
`b21f5889…19132`) se ha descargado esta sesión para el determinismo y la comparación 3D. Es CC0, no es contenido de
Nintendo y `tests/artifacts/` está ignorado por git: **no entra en el repositorio**.

---

## 4. Validación del DRC a 1x con números

Detalle completo en `tests/BENCH.md` §4. Resumen:

- **Determinista (unitaria)**: productor al 90 % de 1x → `always` no corta (0 underruns, tono ≈900 Hz), `off` se seca.
  Productor a tiempo → factor 1 exacto, tono y amplitud intactos. Esta es la prueba que manda para el caso «CPU corta»
  porque no depende de la escena ni del navegador.
- **Máquina real (headless, SoulSilver)**: a 1x el equipo da 57,2–58,3 fps de 59,83 (marginal). `always` mantuvo
  **0 underruns en 6 medidas de 20 s** (factor medio ≈0,96: baja el tono 2–4 % en vez de cortar); `off` dio 0 underruns
  en 2 de 3 medidas y **4 underruns** (17 278 muestras de silencio) en la tercera. Coherente con el comportamiento
  pedido.
- **Lo que no se pudo fabricar**: una «CPU justa» reproducible con el *CPU throttling* de DevTools. A 4x el worker de
  emulación apenas se frena (101 % de fps respecto a sin throttle) y la serie de sondas no es monótona: el throttling
  de CDP no llega de forma fiable al worker (hilo aparte) y lo que se ve es deriva de escena. Queda documentado; el
  arnés tiene además una escasez sintética (`debugStall`) que a 1x se queda corta porque el worker tiene holgura.
- **Matiz medido vs estimado**: la guía asumía que «con la CPU a tiempo el factor vale 1 y no cambia nada». En esta
  máquina headless el caso «a tiempo» no se da a 1x (57–58 fps), y el DRC actúa ≈0,96 de media. La unitaria confirma
  que con un productor que llega, el factor es 1,000; en el equipo del usuario (medido antes en 59,8 fps) debería
  quedarse en 1. **Verificación pendiente del usuario**: oír a 1x en su escena pesada; si notara el tono algo bajo,
  `player.setAudioDynamicRate("ff")` o `"off"` está disponible sin recompilar (y en `MelonDS`, ídem).

---

## 5. Medición: herramientas creadas

- **`tests/bench-browser.mjs`** (arnés principal): sirve el repo con `scripts/serve.mjs` en **127.0.0.1:8090** (el hub
  de :8080 no se toca), abre `demo/index.html?autoplay=1&threads=1|0`, carga la ROM con `setInputFiles("#rom", …)`
  (archivo local, nunca se sube), conduce el botón **«Medir rendimiento»** de la demo (mismo protocolo que el usuario),
  hace la matriz de velocidades e hilos, la comparación DRC y escribe JSON crudo en `tests/artifacts/`.
  - Acepta subconjuntos por entorno para que el verificador no repita 13 minutos: `SPEEDS=1,2`, `THREADS=1`,
    `DRC=always`, `SECS=10`, `REPS=1` (también `BENCH_*`), `SKIP_MATRIX`, `CPU_SHORTAGE=none|synthetic|throttle`,
    `SYNTH_DUTY`/`SYNTH_STALL`, `HEADED=1` (GPU real), `SWIFTSHADER=1`.
  - Por defecto: 20 s por medida y **3 repeticiones con mediana** (documentado en `BENCH.md`).
- **`tests/bench.html` + `js/bench.js`**: banco manual equivalente al botón de la demo, con tabla y descarga JSON;
  incluye un botón «Comparar DRC a 1x (always vs off)» con escasez sintética opcional. `js/bench.js` es una **copia**
  del bloque «benchmark» de `demo/demo.js` (no se refactoriza el demo porque lleva los cambios sin commit del
  usuario; ver `DEVIATIONS.md`).
- `js/bench.js` importa `VideoPlayer` y exporta `measureConfig`, `formatReport`, `stat`, `verdict`, `gpuInfo`,
  `startSyntheticLoad`/`stopSyntheticLoad` y `attachBenchPage` (cableado DOM), todo con `node --check` OK.

---

## 6. Hilos 3D: decisión

- **`nmap.nds`** (homebrew 3D real, escena determinista, sin navegador), 300 fotogramas: con hilos **41,6 fps** de
  mediana (39,7 / 42,4 / 41,6) frente a **32,8 fps** sin hilos (32,5 / 37,8 / 32,8) → **+19–28 % con hilos**.
- **SoulSilver** (arranque/título, headless): con hilos 57,2 fps a 1x vs 58,3 sin hilos (ruido); a 2x 87,3 vs 72,6 y
  sin límite 79,2 vs 67,5 (+17–20 % con hilos).
- **Decisión: se mantiene `threaded_renderer` activado por defecto** (lo que ya hacía el port). No se implementa
  política automática por `navigator.hardwareConcurrency`: los datos no muestran ningún caso en que «sin hilos» sea
  mejor. Si en el futuro se replantea, el criterio debe salir de una medida en la escena de juego real y en un equipo de
  4 hilos; con `?threads=0` y el botón de la demo se compara en dos clics.

---

## 7. Perfilado y optimizaciones del bucle: hecho (Fase 9b)

### 7.1 Reparto medido por tramos

Con el gancho `debugProfile` (mensaje de prueba, comportamiento emulado intacto) y `bench-browser.mjs`:

- **SoulSilver 2x, comportamiento viejo (`off`) vs nuevo (`all`)** — misma página, medidas seguidas; ms por fotograma:

  | Variante | cadencia real | core | publish | audio | saves | yield | wait | resto |
  |---|---|---|---|---|---|---|---|---|
  | `off` | 13,49 | 11,71 | 0,129 | 0,012 | **0,0212** | **0,277** | 1,32 | 0,025 |
  | `all` | 12,59 | 9,94\* | 0,092 | 0,010 | **0,0068** | **0,053** | 2,46 | 0,021 |

  \* el `core` cambió entre pasadas por deriva de escena (el juego avanza), así que la diferencia de cadencia no es
  atribuible entera a las optimizaciones. Pero las secciones sí responden al mecanismo: **(b)** `saves` cae a ≈1/3
  exacto (poll cada 30 en vez de cada 10) = **−0,014 ms/fotograma (≈0,1 %)**; **(c)** `yield` cae de 0,277 a 0,053 ms
  (esa pasada estaba térmicamente limitada; en la de nmap, más limpia, el ahorro es de 0,006 ms/fotograma).

- **`nmap.nds` «sin límite»** (régimen dominado por el bucle, >250 000 fotogramas por pasada; variantes con decimación
  activa para no saturar el hilo principal): `a` (solo decimación) cadencia 0,074 ms, `core` 0,052, `yield` 0,015;
  `ac` (a + yield cada 2) cadencia **0,068** ms, **mismo `core` 0,052**, `yield` 0,009 → **(c) ahorra ~8 % de tiempo
  por fotograma** (14 700 vs 13 500 fps) en este régimen extremo. Las pasadas `ab`/`all` salieron con `core` más alto
  por deriva de la máquina y no son comparables entre sí.

- **`emuMs` vs ritmo real** (medida anterior): en «sin límite» `emuMs` 12,58 ms y 80,3 fps reales (12,45 ms/fotograma);
  el sobrecoste estimado de 1,3–1,7 ms de la guía no se reproduce en esta escena (queda por debajo del ruido), pero con
  el perfilador ya se puede ver dónde va cada milisegundo.

### 7.2 Las tres optimizaciones: ganancia y coste

| Optimización | Ganancia medida | Coste / riesgo | Decisión |
|---|---|---|---|
| (a) decimar `publishFrame` en FF/sin límite | **No-op a ≤120 fps.** Por encima: evita la saturación del hilo principal a miles de fps. Medido en `nmap.nds` sin límite, 5 s: `off` 2 735 fps / dibujo 37,1 fps / ping de control 92 ms vs `all` **11 872 fps / dibujo 60,0 fps / ping 0,3 ms** (JSON reproducible `tests/artifacts/bench-opt-2026-11-15T08-52-55-063Z.json`; la primera pasada de la campaña dio 6 375/9,5/23,6 s vs 15 733/59,7/0,2 y el mecanismo se reprodujo en la verificación) | Con el umbral de 16,7 ms de la guía el dibujado caía a ~40 fps entre 60 y 120 fps; corregido con 8,3 ms. La publicación forzada al pausar está verificada de forma reproducible por `tests/decimation-browser.mjs` (verde, también en `tests/artifacts/decimation-evidence.json`) | **Activa** |
| (b) detector de SRAM cada 30 frames en FF | −0,014 ms/fotograma en la pasada de SoulSilver 2x (≈0,1 % de 13 ms); no se ve en fps | Autoguardado detectado con ~100–170 ms de retraso de juego en FF; tick forzado al pausar conservado | **Activa** |
| (c) `yield` cada 2 fotogramas en FF | −0,006 ms/fotograma y **−8 % de cadencia** en el régimen dominado por el bucle (nmap >13 000 fps); en juego real ~0,03–0,07 ms/fotograma (≈0,3 %) | Latencia de mensajes de control en FF +~12 ms (≈1 fotograma de 2x; ping 12,7→25,7 ms): imperceptible para pausa/velocidad | **Activa** |

**A/B de fps en SoulSilver 2x** (`off` vs `all`, 3×20 s): 50,5 vs 48,6 fps (−3,8 %) — **no atribuible**: el `core`
difiere por deriva de escena y la máquina estaba térmicamente limitada en esa fase (las mismas medidas de 2x daban
88–92 fps al principio de la sesión y 48–50 al final). En juego real la ganancia estimada por el perfil es **0,1–0,4 %**,
por debajo del ruido de una escena de juego; lo que justifica las optimizaciones es el régimen de avance rápido
extremo y el que sean no-ops a 1x (identidad 1x medida: 57,0 vs 57,3 fps).

### 7.3 Lo que sigue pendiente

- Repetir el A/B de fps **con la máquina en frío** y en una escena de juego controlada (batalla), idealmente con GPU
  real (`HEADED=1`) para separar el coste del hilo principal.
- Optimizaciones que exigen **recompilar**: `-O3`/LTO, `-msimd128`, `-sMAXIMUM_MEMORY` (2 GiB ya puesto por el Lead,
  pendiente de build), tamaño de lote del renderizador por software. Nada de eso se puede medir aquí.
- El perfilador es test-only: si se quiere mantener para el futuro, moverlo a un módulo de diagnóstico y documentarlo
  en `API_CONTRACT.md` como no-API.

---

## 8. Pendiente / para el usuario

1. **Recompilar** con `scripts/build-host.sh` (2 GiB ya puesto por el Lead) y repetir la carga de Negra 2 (512 MB):
   debería funcionar sin `ROM_TOO_LARGE`; si no, `ROM_TOO_LARGE` es el límite documentado.
2. **Oír el audio a 1x** en su escena pesada con `"always"` (defecto): si nota el tono bajo, `setAudioDynamicRate("ff")`
   o `"off"`. En esta máquina headless el DRC actuó al 0,96 porque el port daba 57 fps, no 59,8; en su equipo la
   medida previa fue 59,8 fps.
3. **Medir con el botón de la demo** (o `tests/bench.html`) en una escena de juego real y con su GPU: los números de
   `BENCH.md` son de arranque/título en headless con WebGL de software; sirven para comparar configuraciones entre sí,
   no como techo absoluto.
4. Repetir el A/B de optimizaciones (§7.3) **con la máquina en frío** y en una escena de juego controlada; las de C++
   (`-O3`/LTO, SIMD) siguen esperando al rebuild.
5. Lo de siempre: probar en móvil y con mando real (no cambia con esta fase).

---

## 9. Archivos tocados en esta fase

**Implementación:** `js/audio-ring.js`, `js/audio-playback.js`, `js/player.js`, `js/emu-worker.js` (además de la Fase
9b: `debugProfile`/`debugOpt`/`debugPing` y las tres optimizaciones del bucle), `js/melonds.js`, `js/bench.js` (nuevo).

**Pruebas y documentación:** `tests/audio-playback.test.mjs` (4 pruebas nuevas + modo `ff` explícito),
`tests/bench-browser.mjs` (nuevo), `tests/bench.html` (nuevo), `tests/BENCH.md` (nuevo), `tests/PHASE9_REPORT.md`
(este archivo), `tests/DEVIATIONS.md` (sección «Fase 9»).

**Permisos/estado:** `tests/artifacts/` gana el JSON crudo de las medidas, las capturas y `nmap.nds` (CC0; todo
ignorado por git). Nada se ha commiteado ni subido. `third_party/melonds-ds` no se ha tocado.

---

## 10. Cómo repetir la verificación (comandos exactos)

```powershell
cd "<repo>"
node --check js/audio-ring.js; node --check js/audio-playback.js; node --check js/player.js
node --check js/emu-worker.js; node --check js/melonds.js; node --check js/bench.js

node --test --test-force-exit tests/audio-playback.test.mjs          # 22/22
node --test --test-force-exit tests/audio-ring.test.mjs              # 5/5 (sola; bajo carga puede fallar la de 3 M de fotogramas, preexistente)
node --test --test-force-exit tests/melonds-api.test.mjs tests/webapp-adapter.test.mjs

node tests/headless.mjs tests/artifacts/nmap.nds 300 --threads=1     # hash del fotograma 300 = a0d4f91c…890bf
node tests/headless.mjs tests/artifacts/nmap.nds 300 --threads=0     # idéntico + comparación 3D

node tests/bench-browser.mjs                                        # matriz completa (~13 min, CPU libre)

# Fase 9b: A/B de las tres optimizaciones (mismo build, switch debugOpt) e identidad a 1x
OPT_VARIANTS=off,all SPEEDS=2,0 REPS=3 THREADS=1 SKIP_MATRIX=1 SKIP_DRC=1 node tests/bench-browser.mjs
OPT_VARIANTS=a,ab,ac,all SPEEDS=0 REPS=2 THREADS=1 SKIP_MATRIX=1 SKIP_DRC=1 node tests/bench-browser.mjs

# Fase 9b: perfil del bucle por tramos (repetición exacta de la campaña)
SKIP_MATRIX=1 SKIP_DRC=1 PROF=1 PROFILE_VARIANTS=off,all PROFILE_SPEED=2 node tests/bench-browser.mjs
BENCH_ROM=tests\artifacts\nmap.nds SKIP_MATRIX=1 SKIP_DRC=1 SKIP_IDENT=1 PROF=1 PROFILE_VARIANTS=a,ac,ab,all PROFILE_SPEED=0 node tests/bench-browser.mjs
```

Sesgos conocidos de las medidas: escena de arranque/título (no batalla), WebGL de software en headless, esta máquina
(AMD Ryzen 5 3500U, 8 hilos), variabilidad de escena entre repeticiones y **throttling térmico** (al final de la sesión
las medidas de 2x bajaron de ~90 a ~50 fps). Por eso se usa mediana de 3 cuando el estado de la máquina lo permite, se
comparan configuraciones medidas seguidas en la misma campaña y, para las optimizaciones, la evidencia principal es el
**perfil por secciones** (§7.1), no el fps absoluto frente a la línea base de EmulatorJS (48 fps, dato del usuario).
