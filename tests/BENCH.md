# BENCH — Fase 9: rendimiento y ritmo (2026-11-15)

Tabla de medidas del port de melonDS DS v1.4.0 a WebAssembly. **Todo lo de aquí está medido en esta máquina**, salvo
donde se indique «estimado» o «dato del usuario». Las medidas son reproducibles con los comandos de la sección 2; el
JSON crudo de cada ejecución queda en `tests/artifacts/` (ignorado por git, nunca sale de la máquina).

> **Aviso de escena y de GPU:** el arnés automático mide la **secuencia de arranque/título de SoulSilver** (la conduce
> por tiempo de juego, no por reloj: `driveScene()` espera fotogramas y pulsa START/START/A), no una batalla. Además
> Chromium va en **modo headless con WebGL de software (SwiftShader)**: los números del emulador (CPU) valen, pero el
> coste de dibujado y el techo de «sin límite» no son representativos de la GPU real del usuario. Para una escena
> dirigida por el usuario y con su GPU, usar el botón «Medir rendimiento» de la demo o `tests/bench.html`.

## 1. Equipo y entorno

| Dato | Valor |
|---|---|
| Fecha de medida | 2026-11-15 (madrugada, hora local `America/Bogota`) |
| CPU | AMD Ryzen 5 3500U with Radeon Vega Mobile Gfx (4 núcleos / **8 hilos lógicos**) |
| RAM | 10 GiB |
| SO | Windows 11 (kernel `win32 10.0.26300`) |
| Node | 26.13.0 |
| Navegador | Chromium 153 (`HeadlessChrome/153.0.8010.12`, Playwright 1.63) |
| GPU declarada por la página | `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)` — **software** |
| Backend del port | `webgl2` |
| ROM | `4833 - Pokemon - Edicion Plata SoulSilver (Spain).nds`, 128 MB (128 MiB), archivo local `roms/nds/` pasado al `<input type=file>` del demo; **no se sube ni se copia** |
| Escena | arranque + logotipos + título de SoulSilver, tras `driveScene()` (≈460 fotogramas de juego); sin partida guardada |
| Hilos 3D | `melonds_threaded_renderer` enabled (`?threads=1`, 1 worker pthread) y disabled (`?threads=0`, 0 workers) |
| Protocolo del botón | `#benchSecs=20` s por medida, una muestra por ventana del worker (~500 ms); **3 repeticiones**, orden alterno, mediana |

## 2. Cómo se reproduce

```powershell
cd "<repo>"

# Matriz completa (12 medidas x 20 s, ~13 min): velocidad 1 / 1,5 / 2 / sin límite, hilos 3D on/off, 3 repeticiones
node tests/bench-browser.mjs

# Subconjuntos para el verificador (no hace falta repetir todo)
SPEEDS=1,2 THREADS=1 SECS=10 REPS=1 node tests/bench-browser.mjs
DRC=always,off THREADS=0 node tests/bench-browser.mjs

# Comparación DRC a 1x (always vs off), sin repetir la matriz
SKIP_MATRIX=1 CPU_SHORTAGE=none      REPS=3 THREADS=1 SPEEDS=1 node tests/bench-browser.mjs   # máquina real
SKIP_MATRIX=1 CPU_SHORTAGE=synthetic REPS=3 THREADS=1 SPEEDS=1 node tests/bench-browser.mjs   # escasez sintética

# Determinismo y comparación de hilos 3D en una escena 3D real (homebrew CC0, sin navegador)
node tests/headless.mjs tests/artifacts/nmap.nds 300 --threads=1
node tests/headless.mjs tests/artifacts/nmap.nds 300 --threads=0
```

`tests/bench-browser.mjs` sirve el repo con `scripts/serve.mjs` en **127.0.0.1:8090** (el hub de :8080 no se toca),
abre `demo/index.html?autoplay=1&threads=1|0` y conduce **el botón «Medir rendimiento» de la demo**, que es el mismo
protocolo que usa el usuario. La ROM se pasa con `page.setInputFiles("#rom", …)`; nunca se sube. Escribe JSON crudo con
fecha y datos de máquina en `tests/artifacts/bench-*-latest.json`.

Artefactos de esta campaña:

- `tests/artifacts/bench-matrix-latest.json` (y `bench-matrix-2026-11-15T07-00-33-985Z.json`): matriz de velocidad/hilos.
- `tests/artifacts/bench-drc-2026-11-15T07-06-53-309Z.json`: comparación DRC a 1x en la máquina real.
- `tests/artifacts/bench-drc-2026-11-15T07-03-37-939Z.json`: comparación DRC a 1x con escasez sintética (`debugStall`).
- `tests/artifacts/bench-threads-on.png`, `bench-threads-off.png`: capturas de la escena medida.
- `tests/artifacts/bench-2026-11-15T06-47-37-083Z.json`: pasada de humo (`--quick`, 6 s, 1 repetición).

## 3. Matriz principal — SoulSilver, 20 s × 3 repeticiones (mediana)

`fps` = fotogramas emulados por segundo medidos por el worker; `ms/foto` = media de `stepFrame`; `dibujo` = fps de
`requestAnimationFrame` con fotograma nuevo; `búfer` = buffer de audio mínimo/medio/máximo; `DRC` = factor dinámico al
final de la medida (1,000 = velocidad nominal).

| Hilos 3D | Velocidad | fps media | fps mín | fps máx | ms/foto media | ms/foto peor | dibujo fps | búfer mín/med/máx (ms) | underruns | DRC |
|---|---|---|---|---|---|---|---|---|---|---|
| on | 1x | **57,2** | 54,9 | 59,9 | 10,98 | 14,47 | 57,1 | 56 / 70 / 86 | 0 | 0,958 |
| on | 1,5x | **82,4** | 67,8 | 88,7 | 8,07 | 14,00 | 60,0 | 55 / 101 / 129 | 0 | 0,874 |
| on | 2x | **87,3** | 57,8 | 117,8 | 10,72 | 16,65 | 60,0 | 36 / 111 / 167 | 3 (21 614 muestras) | 0,650 |
| on | sin límite | **79,2** | 70,0 | 85,1 | 12,58 | 14,22 | 60,0 | — (mudo) | 0 | 1,000 |
| off | 1x | **58,3** | 55,4 | 61,2 | 7,03 | 15,00 | 58,4 | 59 / 72 / 86 | 0 | 0,978 |
| off | 1,5x | **78,6** | 58,5 | 89,4 | 9,75 | 17,02 | 59,8 | 32 / 96 / 133 | 1 (4 339 muestras) | 0,912 |
| off | 2x | **72,6** | 53,7 | 109,6 | 13,54 | 18,15 | 59,7 | 35 / 81 / 149 | 2 (13 557 muestras) | 0,630 |
| off | sin límite | **67,5** | 58,1 | 73,9 | 14,77 | 17,13 | 59,7 | — (mudo) | 0 | 1,000 |

Lectura:

- **A 1x esta máquina es marginal en headless**: 57,2–58,3 fps de los 59,83 pedidos (el usuario midió 59,8 fps en su
  equipo con una escena de juego; aquí el «título» y el WebGL de software dejan menos margen). Por eso el DRC a 1x
  actúa un poco (0,958–0,978) en vez de quedarse en 1: es justo el comportamiento pedido (baja el tono 2–4 % en vez de
  cortar) y los **underruns son 0** en las 6 medidas de 1x.
- **Hilos 3D on es igual o mejor** en todas las velocidades (ver sección 5 para la decisión).
- A 2x la escena sube de exigencia y el emulador no sostiene 120 fps: el DRC baja a 0,65 y aun así hay algunos
  underruns (3 en 20 s). A 1,5x va bien (0 underruns, 0,87). El avance rápido nunca llega a 2x de forma sostenida en
  esta escena headless; en el equipo del usuario daba 99,6 fps (≈1,67x).
- `draw()` en CPU: 0,15–0,22 ms por fotograma y 60 Hz de `requestAnimationFrame` en todas las configuraciones (la
  cola de fotogramas de la Fase 3 sigue funcionando); el dibujado no es el cuello de botella aquí.
- **Línea base EmulatorJS**: ~48 fps (dato del usuario, no medido hoy). El port da 57–58 fps a 1x en esta escena
  headless y 59,8 fps en la medida previa del usuario; la comparación 1:1 requiere la misma escena y GPU real.

## 4. DRC a 1x (`audioDynamicRate: "always"`) — validación

Decisión del usuario 0.0 #4: suelo **0,8** a 1x y **0,5** en avance rápido; con CPU a tiempo el factor debe quedar en 1.

### 4.1 Prueba determinista (la que manda para el caso «CPU corta»)

`node --test --test-force-exit tests/audio-playback.test.mjs` → **22/22**. Las 4 pruebas nuevas:

| Caso | Resultado |
|---|---|
| `always` + productor 0,9x (playRate 1) | 0 underruns; tono de salida ≈893 Hz (0,9x de 1 kHz, dentro de 0,8..1,0); anillo nunca se seca; factor ≈0,90 |
| `always` + productor a tiempo | tono exacto 1 kHz, amplitud 0,5, factor 1,000, 0 underruns (no cambia nada) |
| `off` + productor 0,9x | factor 1; el anillo se seca (underruns > 0): el contraste |
| `ff` a 1x + productor 0,9x | factor 1, no actúa (solo en avance rápido); con 2x sigue actuando como antes (test existente ampliado) |

### 4.2 Medida real a 1x en esta máquina (sin carga artificial)

| Modo | fps media (3×20 s) | underruns (20 s) | búfer mín/med/máx | factor DRC medio |
|---|---|---|---|---|
| `always` (defecto) | 57,4 | **0, 0, 0** | 50 / 74 / 96 ms | 0,941–0,965 (≈0,95) |
| `off` | 59,8 | **0, 0, 4** (17 278 muestras de silencio en una repetición) | 59 / 75 / 97 ms | 1,000 |

Nota: las celdas de underruns con tres valores son las tres repeticiones individuales; el JSON crudo de
`tests/artifacts/` guarda la mediana (0 en `off`, porque 2 de 3 salieron limpias), no la lista.

Lectura: con la CPU justa (57–58 fps de 59,83), `always` mantiene el audio sin cortes bajando el tono ~2–5 %; `off`
llega a la velocidad nominal pero en una de tres repeticiones cortó el audio (4 underruns). Es la validación real del
caso «CPU justa», aunque el margen de esta máquina en headless es pequeño. En el muestreo de 3 s del mismo pase el
factor medio fue 0,981 (búfer 59–86 ms).

### 4.3 Lo que NO se pudo reproducir: CPU throttling de DevTools

Se probó `Emulation.setCPUThrottlingRate` por CDP con sondas de 5 s. Resultados (mediana de fps emulados):

| Rate | fps emulados | % de la velocidad sin throttle |
|---|---|---|
| 4x | 57,5 | 101 % |
| 2x | 55,8 | 98 % |
| 1,5x | 55,3 | 97 % |
| 1,25x | 49,3 | 86 % |

La serie **no es monótona** (4x «frena» menos que 1,25x): el throttling de DevTools no frena de forma fiable al
**worker de emulación** (hilo aparte) y lo que se ve es deriva de la escena, no CPU. En consecuencia no sirve para
fabricar una «CPU justa» reproducible en headless. Se dejó como intento documentado y el arnés usa una escasez
sintética con el gancho de prueba `debugStall` (7 ms bloqueados cada 50 ms ≈ 14 % del tiempo del worker):

| Escasez sintética | fps media | underruns (20 s) | factor DRC |
|---|---|---|---|
| `always` | 52,3 | 0, 6, 3 | 0,825–0,890 |
| `off` | 58,5 | 5,10,1 | 1,000 |

Tampoco da un contraste limpio: a 1x el worker tiene holgura (~40 %) y absorbe el bloqueo del 14 %; cuando un pico
de bloqueo vacía el búfer, ambos modos cortan. **Conclusión honesta:** el throttling de CDP no es un método válido
para esta pila; la validación fiable del caso 0,9x es la unitaria (4.1) y la comparación real (4.2). Los parámetros
`SYNTH_DUTY`/`SYNTH_STALL` quedan para que el verificador pruebe una escasez más fuerte si quiere.

## 5. Hilos 3D: decisión con datos

### 5.1 Escena 3D real, sin navegador: `nmap.nds` (homebrew CC0 de normal mapping, 256×384, 300 fotogramas)

`node tests/headless.mjs tests/artifacts/nmap.nds 300 --threads=1|0`, 3 ejecuciones de cada uno:

| Hilos 3D | fps (300 fotogramas) | mediana |
|---|---|---|
| on (`threaded_renderer=enabled`) | 39,7 · 42,4 · 41,6 | **41,6 fps** |
| off (`threaded_renderer=disabled`) | 32,5 · 37,8 · 32,8 | **32,8 fps** |

→ El renderizador 3D con hilos es **~19–28 % más rápido** en contenido 3D real. (En el arranque/título de SoulSilver
la diferencia es ruido a 1x y +17–20 % a 2x/sin límite; ver sección 3.)

### 5.2 Determinismo

Con `nmap.nds`, el hash SHA-256 del fotograma 300 es **idéntico con y sin hilos** y coincide con la línea base
documentada:

```
frame 300  256x384 stride=1024  a0d4f91c80973e4d619f7f8aab1cafe18607f06cc22c56f3b26d9ec9b62890bf
```

Los cambios de esta fase son solo de audio/JS y **no alteran el emulado**.

### 5.3 Decisión

**Se mantiene el renderizador 3D con hilos activado por defecto** (lo que ya hacía el port). No se implementa política
automática por `navigator.hardwareConcurrency`: no hay datos que la justifiquen (con hilos siempre va igual o mejor, y
en 3D real gana claramente). Criterio si alguna vez se replantea: activarlo salvo que una medición en la **escena
pesada del usuario** muestre lo contrario en equipos de 4 hilos; el botón «Medir rendimiento» de la demo permite
compararlo en 2 clics (`?threads=0`).

## 6. Perfilado del bucle y optimizaciones JS (Fase 9b)

### 6.1 Gancho de perfilado (test-only)

`js/emu-worker.js` acepta `{type:"debugProfile", on}` (mismo patrón que `debugStall`/`debugBurst`, no es API pública).
Mientras está activo acumula, **por ventana de `stats` (~500 ms)**, los ms de estas secciones y los publica como `prof`
en el propio mensaje `stats` (con el perfilador apagado no se publica nada):

| Sección | Qué mide |
|---|---|
| `core` | `applyInput()` + `mds_run_frame()` (núcleo) |
| `publish` | copia del fotograma al anillo + `postMessage("frame")` (con decimación, solo los publicados) |
| `audio` | `drainAudio()` (copia del PCM al anillo) |
| `saves` | detector de cambios de SRAM (`saves.tick`, con su cadencia) |
| `yield` | `await yieldToEvents()` (salto de macrotarea, incluye la espera de mensajes) |
| `wait` | `Atomics.wait()` del bucle (ritmo por reloj de audio o por temporizador) |

```powershell
# Reparto por tramos, 20 s, «sin límite» (nmap.nds para el régimen dominado por el bucle):
BENCH_ROM=tests\artifacts\nmap.nds SKIP_MATRIX=1 SKIP_DRC=1 SKIP_IDENT=1 PROF=1 PROFILE_VARIANTS=a,ac,ab,all PROFILE_SPEED=0 node tests/bench-browser.mjs
# Caso real de juego (SoulSilver 2x), comportamiento viejo vs nuevo:
SKIP_MATRIX=1 SKIP_DRC=1 PROF=1 PROFILE_VARIANTS=off,all PROFILE_SPEED=2 node tests/bench-browser.mjs
```

### 6.2 Perfil medido (ms por fotograma emulado)

**`nmap.nds` «sin límite»** (homebrew 3D trivial: el bucle domina; >250 000 fotogramas por pasada; variantes con
decimación de publicación activa para que el hilo principal no se sature):

| Variante | Cadencia real | core | publish | audio | saves | yield | sin medir | Fotogramas |
|---|---|---|---|---|---|---|---|---|
| `a` (solo decimación) | 0,074 | 0,052 | 0,002 | 0,000 | 0,0006 | **0,015** | 0,004 | 269 400 |
| `ac` (a + yield cada 2) | **0,068** | 0,052 | 0,002 | 0,000 | 0,0006 | **0,009** | 0,004 | 294 774 |
| `ab` (a + cadencia SRAM) | 0,129 | 0,084 | 0,007 | 0,001 | 0,0008 | 0,029 | 0,007 | 154 821 |
| `all` (las tres) | 0,095 | 0,070 | 0,004 | 0,001 | 0,0006 | 0,015 | 0,005 | 209 671 |

`a` y `ac` tienen el **mismo `core`** (0,052), así que su diferencia es atribuible a (c): **−8,1 % de tiempo por
fotograma** (14 700 vs 13 500 fps) y el `yield` cae de 0,015 a 0,009 ms. `ab` y `all` salieron con `core` más alto por
deriva de la máquina (no son comparables entre sí; ver 6.4).

**SoulSilver 2x** (caso real, misma página, medidas seguidas; `off` = comportamiento viejo forzado con `debugOpt`):

| Variante | Cadencia | core | publish | audio | saves | yield | wait | sin medir |
|---|---|---|---|---|---|---|---|---|
| `off` | 13,49 | 11,71 | 0,129 | 0,012 | **0,0212** | **0,277** | 1,32 | 0,025 |
| `all` | 12,59 | 9,94\* | 0,092 | 0,010 | **0,0068** | **0,053** | 2,46 | 0,021 |

\* el `core` cambió entre las dos pasadas (deriva de escena: el juego avanza); por eso la diferencia de cadencia **no**
es atribuible entera a las optimizaciones. Lo que sí es consistente con el mecanismo:

- **(b) cadencia de SRAM**: `saves` baja de 0,0212 a 0,0068 ms/fotograma (≈1/3 exacto: de llamar cada frame a cada 3 →
  un poll cada 30 en vez de cada 10). Ahorro ≈0,014 ms/fotograma (≈0,1 % de un fotograma de 13 ms): **no se mide en fps**.
- **(c) yield cada 2**: `yield` baja de 0,277 a 0,053 ms en esa pasada (la máquina ya estaba térmicamente limitada y el
  coste del salto de macrotarea era alto); en la pasada de nmap, más limpia, el ahorro es 0,006 ms/fotograma ≈ −8 % de
  la cadencia en el régimen dominado por el bucle. **Coste**: la latencia de un mensaje de control en FF sube de
  ~12,7 ms a ~25,7 ms (`debugPing`, ≈1 fotograma de 2x); para pausa/cambio de velocidad es imperceptible.
- **(a) decimación de publicación**: **no-op a ≤120 fps** por diseño (ver 6.3), así que en esta escena (`~60-90 fps`)
  no se ve en el perfil.

### 6.3 Decisión sobre la decimación de publicación (desviación medida)

La guía sugería publicar «solo si han pasado ≥ ~16,7 ms». Medido: con umbral de 16,7 ms y el emulador a 60–120 fps el
periodo de publicación se cuantiza a 2 fotogramas (22–27 ms), el hilo principal recibe ~40-45 mensajes/s y el
**dibujado cae de ~60 a ~40 fps** en avance rápido (medido en 2x con SoulSilver: `off` 59,6 fps de dibujo vs `all`
40,6). Se cambió el umbral a **8,3 ms (120 publicaciones/s)**: así la decimación solo actúa por encima de ~120 fps,
donde la pantalla ya no puede mostrar los fotogramas de más, y el ahorro/coste de la copia y del `postMessage` sí es
real. A ≤120 fps se publica **cada fotograma, exactamente como antes**. Desviación anotada en `DEVIATIONS.md`.

### 6.4 Extremo: sin decimación el hilo principal se satura

`nmap.nds` «sin límite» (miles de fps de emulación) con `off` (sin decimación) y `all` (con decimación), 5 s.
**Evidencia cruda reproducible** (JSON guardado): `tests/artifacts/bench-opt-2026-11-15T08-52-55-063Z.json`, generada con
`BENCH_ROM=tests/artifacts/nmap.nds SKIP_MATRIX=1 SKIP_DRC=1 SKIP_IDENT=1 OPT_VARIANTS=off,all SPEEDS=0 SECS=5 REPS=1 node tests/bench-browser.mjs`
en una pasada con la máquina más caliente que la campaña original:

| Variante | fps emulados | dibujo | ping de control |
|---|---|---|---|
| `off` (comportamiento viejo) | 2 735 | **37,1 fps** | **92,0 ms** |
| `all` (decimación, resto igual) | **11 872** | **60,0 fps** | **0,3 ms** |

En la primera pasada de la campaña (el JSON de esa ejecución no se conservó) se midió `off` 6 375 fps / dibujo 9,5 fps /
ping 23 631 ms vs `all` 15 733 / 59,7 / 0,2 ms; el verificador independiente reprodujo el mismo fenómeno y la pasada de
arriba lo deja con artefacto. Sin decimación, a miles de fps el worker copia un fotograma de 393 KB por fotograma y el
hilo principal pasa el 100 % del tiempo copiando y descartando de la cola: el dibujado se hunde y hasta un mensaje de
control tarda decenas de segundos. Con decimación el dibujado va a ~60 fps, la latencia de control es de 0,3 ms y el
worker emula **varias veces más rápido** (compite menos con el hilo principal). No es un régimen de juego normal, pero es
exactamente el caso para el que se pidió la optimización (avance rápido muy por encima de la pantalla).

### 6.5 A/B de fps en SoulSilver 2x y límites de la medida

`OPT_VARIANTS=off,all SPEEDS=2 REPS=3` (20 s): `off` 50,5 fps / 44,3 ms por fotograma vs `all` 48,6 fps / 47,1 ms
(−3,8 %, dentro del ruido). **No es atribuible**: el `core` medio difiere entre brazos por deriva de escena y, sobre
todo, la máquina estaba **térmicamente limitada** en esa fase de la campaña (las mismas medidas de 2x habían dado
88–92 fps al principio, y 48–50 fps al final). La ganancia en juego real estimada por el perfil es **0,1–0,4 %** por
las secciones medidas: cae por debajo del ruido de una escena de juego. La comprobación de identidad a 1x (el código
solo aplica las tres optimizaciones cuando `speed !== 1`) dio 57,0 vs 57,3 fps (sin diferencia).

### 6.6 Comprobaciones de comportamiento de la decimación

**Reproducible con `node tests/decimation-browser.mjs`** (Chromium + `nmap.nds`; escribe
`tests/artifacts/decimation-evidence.json`): con las optimizaciones ON la vuelta de control se mantiene baja a velocidad
sin límite, y **al pausar se publica el último fotograma y se dibuja sin que la emulación avance**, tanto a 2x como a
«sin límite» (comprobaciones en verde: `published +1/+2`, `drawn` aumenta, `frameCount` congelado). En una máquina
**térmicamente limitada** (worker <200 fps incluso sin límite) el arnés marca **SKIP solo en la comprobación del ping**
porque el escenario de saturación no se puede reproducir; las comprobaciones de pausa siguen ejecutándose y pasando. El arnés
`tests/bench-browser.mjs` registra además el `ping` de control en cada medida. La lógica de serial duplicado no se tocó.

**Decisión:** las tres optimizaciones quedan **activas por defecto** (`OPT` = true), con el conmutador de prueba
`{type:"debugOpt", set:{...}}` para medir el antes. A 1x son no-ops exactas.

## 7. Pendiente por falta de rebuild del wasm (no medido)

Docker Desktop está parado y no hay emsdk en esta máquina; todo lo de esta fase es JavaScript. Quedan sin hacer y sin
medir:

1. `-O3` / LTO en el enlace (`scripts/build-host.sh`).
2. Memoria: el host ya está cambiado a `-sMAXIMUM_MEMORY=2147483648` (**2 GiB**) por el Lead, pendiente de recompilar;
   el fallo elegante `ROM_TOO_LARGE` ya está implementado y verificado con Negra 2 (512 MB): rechazo en **2,2 s** con
   mensaje claro, sin `pageerror` (ver `tests/PHASE9_REPORT.md`).
3. SIMD (`-msimd128`), si el navegador objetivo lo soporta.
4. Variante sin hilos `dist/st` (decisión 0.0 #1: no se hace salvo que el usuario la pida).

La decimación de la publicación de vídeo en avance rápido (antes candidata) **ya está implementada y medida** (§6):
decima por encima de ~120 fps. También están hechas y medidas la cadencia del detector de SRAM en FF y el `yield`
cada 2 fotogramas en FF. Ninguna necesita rebuild.

> **Aviso de estado térmico de la campaña:** al final de la sesión la máquina (Ryzen 5 3500U, 15 W) estaba claramente
> limitada por temperatura: las medidas de 2x pasaron de 88–92 fps al principio a 48–50 fps al final. Por eso el A/B de
> fps «antes/después» de §6.5 no es concluyente y la evidencia robusta son los **perfiles por sección** (§6.2), que se
> comparan dentro del mismo estado de la máquina. Números absolutos de §3 tomados al principio de la sesión.
