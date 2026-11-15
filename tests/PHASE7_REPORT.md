# PHASE 7 — Firmware y BIOS: informe (2026-11-15)

Estado: **lado JS hecho y verificado**; la parte en C++ (validación en el anfitrión, micrófono) queda **pendiente de
recompilar el wasm**. Sin commit.

## 1. Qué se entrega (JS, sin recompilar)

La build actual ya exporta `mds_write_system_file`, así que el firmware/BIOS se puede inyectar desde JS:

- **`js/melonds.js`**:
  - `setFirmware(bytes|null, settings?)`: si `null`, el núcleo usa su **firmware integrado** (incluso con
    `melonds_firmware_nds_path` vacío; verificado en `config/console.cpp`: `SysfileMode::Native` con firmware ausente
    cae a Built-In). Si se aporta un dump, valida los tamaños `FIRMWARE_SIZES` (131072/262144/524288 B), lo escribe como
    `firmware.bin` en `/system` y fija `melonds_firmware_nds_path` + `melonds_sysfile_mode=native`. `settings` rellena
    los ajustes del firmware (`melonds_override_fw_settings`, idioma, apodo, cumpleaños, color) cuando el usuario no
    trae un firmware propio.
  - `setBios({arm7, arm9}|null)`: valida `BIOS_SIZES` (16 384 / 4 096 B) y escribe `bios7.bin`/`bios9.bin` en `/system`;
    `null` deja FreeBIOS (BIOS libre de Normmatt, parte de melonDS).
  - Los archivos se encolan si se llaman antes de `create()` y se escriben antes de `loadRom()`: el núcleo los lee
    durante `retro_load_game`.
- **`js/player.js`**: `systemFile(name, bytes)` (llamada al worker).
- **`js/emu-worker.js`**: manejador `systemFile` → `mds_write_system_file` con errores
  `SYSTEM_FILE_UNSUPPORTED`/`SYSTEM_FILE_FAILED`.
- **`adapters/webapp-adapter.js`**: con `?fw=real` descarga `bios7.bin`, `bios9.bin` y `firmware.bin` de
  `/nds/api/bios/*` (los dumps del usuario, servidos por el hub local) y los aplica antes de `loadRom`; por defecto
  (`fw=none`) no se pasa nada.
- **Nada de Nintendo en el repositorio**: los archivos viven en la carpeta del usuario y se sirven solo en local.

## 2. Verificación

| Comprobación | Resultado |
|---|---|
| Pruebas unitarias de validación (`tests/melonds-api.test.mjs`) | 16/16: `FIRMWARE_INVALID` por tamaño, `BIOS_INVALID`, `setFirmware(null)`/`setBios(null)` = built-in, superficie del contrato |
| Arranque **sin ningún archivo** de Nintendo (FreeBIOS + firmware integrado) | ✅ biblioteca NDS: Platino, SoulSilver y Negra arrancan y guardan (524 288 B Flash 512 KiB); es la razón de ser del port (`node tests/library-browser.mjs`) |
| Arranque con **firmware/BIOS reales** del usuario por JS (`?fw=real`) | `node tests/phase7-browser.mjs` → **8/8** (2026-11-15): los tres dumps se descargan con los tamaños que el núcleo acepta (`bios7.bin`=16384, `bios9.bin`=4096, `firmware.bin`=262144), arranca en **2,3 s** con **51 fps**, guardado de **524 288 B** legible y sin errores; y en la misma pasada, el camino por defecto (sin archivos) arranca sin descargar ninguno (40 fps) |
| Firmware generado en el navegador | No aplica al port: el generador `nds/firmware.js` era para el núcleo viejo de EmulatorJS; el port usa su firmware integrado / dumps reales |

## 3. Pendiente por recompilar

- `mds_set_firmware`/`mds_set_bios` en `core/host` para validar y seleccionar el firmware en C++ (hoy se hace por
  opciones de núcleo y archivos en `/system`; funciona, pero no está expuesto como API C).
- **Micrófono** (decisión 3 del usuario): `RETRO_ENVIRONMENT_GET_MICROPHONE_INTERFACE` + `AudioWorklet` de captura y
  anillo hacia el anfitrión con modos `blow`/`noise`/`silence`; hoy `MelonDS.setMicInput()` lanza `MIC_UNSUPPORTED`.
- `retro_reset` para un `reset()` barato (hoy se recrea el worker, ~1 s).
- La prueba manual clave (partida nueva → guardar → cerrar → continuar **sin firmware ni BIOS**) sigue siendo del
  usuario (`tests/MANUAL.md`).

## 4. Cómo reproducir

```powershell
cd "<repo>"
node --test --test-force-exit tests/melonds-api.test.mjs
node tests/library-browser.mjs        # sin firmware/BIOS (camino por defecto)
node tests/phase7-browser.mjs         # con los dumps del usuario (?fw=real) y otra vez sin nada
```
