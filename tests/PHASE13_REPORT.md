# PHASE 13 — Paquete, licencias y publicación: informe (2026-11-15)

Estado: **hecha en lo que no depende de cuentas del usuario**; el release/tag de GitHub y la prueba de "tercero" con
un clon limpio quedan pendientes de que el usuario lo pida. Todo sin commit.

## 1. Licencias y avisos

| Archivo | Contenido |
|---|---|
| `LICENSE` | GPL-3.0 íntegro (35 149 B). El motor (melonDS y melonDS DS) es GPL-3.0, así que distribuir el `.wasm` obliga a publicar el código correspondiente |
| `THIRD_PARTY.md` | Procedencia y licencia de todo lo enlazado en `dist/melonds.wasm` (melonDS DS, melonDS, libretro-common, FreeBIOS, date, fmt, glm, span-lite, yamc, pntr, zlib, teakra, blip-buf, libslirp, embed-binaries, Emscripten) + material de pruebas y `coi-sw.js` |
| `README.md` | Aviso legal (aficionados, sin relación con Nintendo/Game Freak/The Pokémon Company; solo copias legítimas), requisitos, compilación, diseño, API, adaptador, multijugador, rendimiento, paquete y despliegue |
| `CHANGELOG.md` | Histórico: `1.0.0` (2026-11-15) con API, fases 7-JS/9/10/11/12/13 y límites conocidos; `0.1.0` (2026-11-04) con las fases 0-6 y 8 integradas |

**Ningún archivo de Nintendo en el repositorio**: el barrido de `scripts/check-clean.mjs` (abajo) y la auditoría manual
lo confirman. Los `.wasm`/`.js` de `dist/` y el paquete son artefactos ignorados por git; los binarios de un release
deben ir al **release de GitHub, no a git**.

## 2. Paquete estático (`scripts/package.mjs`)

```
node scripts/package.mjs          # -> package/  (o --out <dir>)
ROOT=package PORT=8090 node scripts/serve.mjs
```

- `package/`: **35 archivos, 2,69 MiB** + `manifest.json` con **32 entradas** y `totalBytes`.
- Incluye: `dist/melonds.js` + `dist/melonds.wasm`, `js/`, `adapters/` (incluido `INTEGRATION.md`), `demo/index.html` +
  `demo/demo.js`, `demo/host.html` + `demo/host.js` (multijugador independiente), `coi-sw.js`, `index.html` de
  redirección, `LICENSE`, `THIRD_PARTY.md`, `CHANGELOG.md`, `README.md`, `package.json` y `manifest.json`.
- **No** incluye pruebas, `third_party/`, `build/` ni el repo.
- Falla a propósito si falta `dist/melonds.js`/`.wasm` (no se versionan).
- Prueba: `node tests/package.test.mjs` → **1/1**: construye el paquete, lo sirve con `scripts/serve.mjs` en aislado y
  lo abre en Chromium (200/MIME/COOP, `crossOriginIsolated`, cero 404, cero errores, UI de la demo).

## 3. `coi-sw.js` (hostings sin cabeceras)

Decisión 0.0 #1: soporte opcional para servidores que no permiten añadir COOP/COEP (GitHub Pages, `http.server`,
almacenamiento de objetos). Es un service worker propio (técnica `coi-serviceworker`, MIT, atribuida en
`THIRD_PARTY.md`) que re-sirve las respuestas del mismo origen añadiendo:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Resource-Policy: same-origin
```

`demo/index.html` lo registra **solo si la página no está aislada** (con un marcador en `sessionStorage` para no entrar
en bucle de recargas), así que en el servidor Node/`serve.mjs`/nginx no se usa. Prueba:
`node tests/coi-sw-browser.mjs` sirve el repo por HTTP **sin** cabeceras y comprueba que tras la recarga
`crossOriginIsolated === true`, hay `SharedArrayBuffer`, el service worker controla la página y no hay bucle de
recargas.

## 4. Higiene: `scripts/check-clean.mjs`

```
node scripts/check-clean.mjs            # errores fallan; avisa de rutas absolutas
node scripts/check-clean.mjs --strict   # cualquier ruta absoluta de Windows también falla
```

- Revisa 143 archivos (excluye `.git`, `dist`, `build`, `third_party`, `package`, `node_modules`, `tests/artifacts`).
- **Error** si hay ROM/BIOS/firmware/partidas (`.nds .dsi .srl .gba .sav .bin .rom .firmware .fw .cia`), claves privadas,
  credenciales hardcodeadas o rutas del perfil del autor (la carpeta personal de Windows).
- **Aviso** (no bloquea) por rutas absolutas: hoy son comandos de prueba documentados (`roms...` en
  `bench-browser.mjs`/docs) y la mención a la web app hermana; `--strict` las lista para un release.
- Resultado 2026-11-15: **0 errores** (los avisos son rutas absolutas de comandos de prueba documentados; `--strict` las lista) → OK.
- Script añadido a `package.json` como `npm run check:clean`.

## 5. Bundle de release y prueba de "tercero"

```powershell
node scripts/release.mjs          # -> release/melonds-wasm-1.0.0/ + .zip + SHA256SUMS + release-1.0.0.json + RELEASE_NOTES.md
node --test --test-force-exit tests/release.test.mjs   # 1/1: ZIP completo, SHA256SUMS, metadata y notas
```

- `release/` está en `.gitignore` y **no se versiona**; el ZIP es el artefacto que se sube al release de GitHub (no a git).
- `release-1.0.0.json` incluye hashes SHA-256 de `dist/melonds.wasm`/`.js`, el commit git y si el tope de memoria es 2 GiB.
- `RELEASE_NOTES.md` explica instalación (cabeceras COOP/COEP o `?coi=1`), contenido, verificación y límites conocidos.
- **Bundle regenerado tras la recompilación canónica de 2 GiB del 2026-11-15**: el ZIP actual contiene el wasm nuevo
  (2 456 726 B, SHA-256 `2176d537…`) y `third-party-release` volvió a dar 9/9. Si se vuelve a recompilar, hay que
  regenerar el bundle (`node scripts/release.mjs`).
- **Prueba de «tercero» hecha** (`node tests/third-party-release.mjs`, **9/9**): copia solo `release/melonds-wasm-1.0.0/`
  fuera del repo, la sirve con un servidor HTTP plano **sin cabeceras COOP/COEP**, comprueba MIME y SHA-256 del `.wasm`, y
  que con `?coi=1` `coi-sw.js` aísla la página y la demo arranca y juega `nmap.nds` (más de 30 frames (31-32 según la pasada), 256×384, sin errores/404).
  También se comprueba que sin `?coi=1` la demo avisa de que falta el aislamiento.
- Pendiente del usuario: crear la etiqueta `v1.0.0` y subir el ZIP + `SHA256SUMS` al release de GitHub (no a git), y el
  despliegue estable en dos servidores (`deploy/README.md`, requiere cuenta/servidor).

## 6. Cómo reproducir

```powershell
cd "<repo>"
node scripts/check-clean.mjs
node scripts/package.mjs
node tests/package.test.mjs
node tests/coi-sw-browser.mjs
```
