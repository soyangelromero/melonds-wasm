# Aceptación final — evidencia automática (2026-11-15T12:08:09.089Z)

Esta es la batería que se puede verificar **sin cuentas** en este entorno. La ejecutó el Lead y la revisó un verificador
independiente; esta pasada se hace con la **build canónica recompilada de 2 GiB** (2026-11-15).

- Máquina: win32 x64 · Node v26.13.0 · 8 vCPU
- Repo: `port melonds`, rama `feat/integration`, HEAD `64a0ebb`, **0/0 vs origin** (sin commit/push), todo sin commitear.
- Versión: 1.0.0 · paquete: release preparado.
- Tope de memoria wasm: **2 GiB canónico**, build recompilada el **2026-11-15** con Docker Desktop 4.74.0 +
  `emscripten/emsdk:6.0.13` (sin parche de artefactos; `raise-memory-limit --check` = 0).
- Hub de pruebas: :8080 (abierto, sin túnel estable).
- Resultado global: **TODO EN VERDE** (10/10).
- `check-clean`: 0 errores (los avisos son rutas de test documentadas). Suite: **138 pruebas, 135 pasan, 0 fallan, 3 omitidas** (el antiguo flake `audio-ring` quedó estabilizado con `Atomics.wait`).

## Build canónico (2026-11-15)

Docker Desktop 4.74.0 (cliente/servidor 29.4.3) + `emscripten/emsdk:6.0.13`; se ejecutó dentro del contenedor
`bash scripts/build-core.sh && bash scripts/build-host.sh`. Resultado: `dist/melonds.wasm` **2 456 726 B** (memoria
importada **max 32768 páginas = 2 GiB**, `raise-memory-limit --check` = 0 sin parche) y `dist/melonds.js` 84 894 B. La
batería de abajo se ejecutó con esa build; Negra 2 arranca sin parche.

## Resultados

| # | Comprobación | Resultado | Tiempo | Log |
|---|---|---|---|---|
| 1 | suite (unitarias, 138 pruebas) | ✅ OK | 17.0 s | `tests/artifacts/acceptance-suite.log` |
| 2 | check-clean (higiene y contenido de Nintendo) | ✅ OK | 0.5 s | `tests/artifacts/acceptance-check-clean.log` |
| 3 | package.test (paquete estático servible) | ✅ OK | 5.4 s | `tests/artifacts/acceptance-package-test.log` |
| 4 | release.test (bundle ZIP/SHA/metadata/notas) | ✅ OK | 2.6 s | `tests/artifacts/acceptance-release-test.log` |
| 5 | third-party (release aislado + servidor plano + ?coi=1) | ✅ OK | 4.7 s | `tests/artifacts/acceptance-third-party.log` |
| 6 | phase11 (web app: 35 comprobaciones, móvil incluido) | ✅ OK | 10.1 s | `tests/artifacts/acceptance-phase11.log` |
| 7 | phase12 (multijugador WebRTC) | ✅ OK | 5.8 s | `tests/artifacts/acceptance-phase12.log` |
| 8 | cross-browser (Chromium/Firefox/WebKit, demo + web app) | ✅ OK | 30.1 s | `tests/artifacts/acceptance-cross-browser.log` |
| 9 | library (NDS 4/4 + GBA 4/4 con el port) | ✅ OK | 50.9 s | `tests/artifacts/acceptance-library.log` |
| 10 | remote-tunnel (HTTPS público con ACCESS_KEY) | ✅ OK | 42.4 s | `tests/artifacts/acceptance-remote-tunnel.log` |

## Artefactos y hashes

- `dist/melonds.wasm`: 2456726 B · SHA-256 2176d537f885bcb5…
- `dist/melonds.js`: 84894 B · SHA-256 c79942cb8a37f555…
- Logs completos de esta pasada en `tests/artifacts/acceptance-*.log` (ignorados por git).
- Capturas: `third-party-release-demo.png`, `cross-browser-*.png`, `remote-tunnel-boot.png`, `library-*.png`.
- Release: `release/melonds-wasm-1.0.0.zip` + `SHA256SUMS` (ignorado por git; se sube como artefacto del GitHub release).

## Lo que NO cubre esta batería (requiere al usuario)

1. **Opcional (ya no bloquea jugar)**: `-O3`/LTO/SIMD o `dist/st`, Fase 7-C++ (validación de firmware, `retro_reset`
   barato) y micrófono; la build canónica de 2 GiB y Negra 2 ya están hechas y verificadas.
2. **Publicar**: tag `v1.0.0` y subir `release/melonds-wasm-1.0.0.zip` + `SHA256SUMS` al release de GitHub (la prueba de
   tercero ya está hecha; falta la cuenta).
3. **Despliegue estable** (túnel con nombre, Tailscale o VPS) con credenciales; el camino remoto está verificado con el
   túnel rápido.
4. **Pruebas manuales** de `tests/MANUAL.md`: guardar→cerrar→«Continuar» sin firmware en los 4 juegos, mando/táctil
   reales, trucos reales y audio a 1x escuchado.
5. Safari real (el motor WebKit sí se probó) y hardware móvil real.

## Otras suites de navegador con la build canónica (2026-11-15)

| Suite | Resultado |
|---|---|
| `node tests/phase7-browser.mjs` (firmware/BIOS reales) | **8/8**, exit 0 |
| `node tests/coi-sw-browser.mjs` | **9/9**, exit 0 |
| `node tests/fsa-saves-browser.mjs` | **8/8**, exit 0 |
| `node tests/demo-host-browser.mjs` | **6/6**, exit 0 |
| `node tests/library-fallback-browser.mjs` | exit 0, SKIP (Negra 2 ya arranca con el port) |
| `node tests/decimation-browser.mjs` | exit 0, 4 pasan + 1 SKIP de entorno si el worker <200 fps (throttling térmico; pausa/control verdes) |
| `node tests/phase3-browser.mjs tests/artifacts/nmap.nds` | **44/44 + 2 SKIP de entorno** (GPU software) |

Nota: tras encadenar muchas suites, la máquina puede entrar en *thermal throttling* y bajar a ~35 fps; en frío vuelve a
~55-60 fps. La batería de arriba se completó en verde; si un test pesado falla por fps, repetirlo aislado en frío.

## Reproducir

```powershell
cd "<repo>"
npm test
node scripts/check-clean.mjs
node tests/package.test.mjs
node --test --test-force-exit tests/release.test.mjs
node tests/third-party-release.mjs
node tests/cross-browser-smoke.mjs
node tests/library-browser.mjs
node tests/phase11-browser.mjs
node tests/phase12-browser.mjs
node tests/remote-tunnel-browser.mjs   # opcional: cloudflared + internet
```
