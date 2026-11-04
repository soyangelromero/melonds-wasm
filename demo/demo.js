import { VideoPlayer, SCANLINES, LAYOUT_LABELS } from "../js/player.js";
import { BUTTON_MASK } from "../js/input.js";

const $ = (id) => document.getElementById(id);
const canvas = $("screen"), msg = $("msg");
const params = new URLSearchParams(location.search);
let player = null;
let detachInput = [];   // Phase 5: keyboard / gamepad / pointer listeners of the current player

$("s-coi").textContent = String(self.crossOriginIsolated);
for (const label of LAYOUT_LABELS) $("layout").add(new Option(label, label));
if (params.get("backend") === "canvas2d") $("canvas2d").checked = true;
if (params.get("threads") === "0") $("threaded").checked = false;

let romKey = null, quick = null, saveEvents = 0;

// --- tiny IndexedDB key/value store (demo convenience only; the library itself never stores anything). Same DB as demo/saves.html ---
const db = () => new Promise((resolve, reject) => { const r = indexedDB.open("melonds-wasm-demo", 1); r.onupgradeneeded = () => r.result.createObjectStore("saves"); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
async function idb(mode, fn) { const d = await db(); return new Promise((resolve, reject) => { const t = d.transaction("saves", mode); const req = fn(t.objectStore("saves")); t.oncomplete = () => resolve(req?.result); t.onerror = () => reject(t.error); }); }
const storeGet = (k) => idb("readonly", (st) => st.get(k)).catch(() => undefined);
const storePut = (k, v) => idb("readwrite", (st) => st.put(v, k));
const storeDel = (k) => idb("readwrite", (st) => st.delete(k));
const download = (bytes, name) => { const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([bytes])), download: name }); a.click(); URL.revokeObjectURL(a.href); };
const romKeyOf = (rom) => `${new TextDecoder().decode(rom.subarray(0x0c, 0x10))}:${new TextDecoder().decode(rom.subarray(0, 12)).replace(/\0/g, "").trim()}`;
const fail = (e) => { say(`${e.code ?? "error"}: ${e.message}`, true); console.error(e); };
const setEnabled = (on, hasSave) => {
  for (const id of ["qsave", "qload", "dlState", "loadState", "cheatOn", "cheatOff", "cheatClear"]) $(id).disabled = !on;
  for (const id of ["dlSave", "loadSave", "clearStore"]) $(id).disabled = !(on && hasSave);
};

const say = (text, error = false) => { msg.textContent = text; msg.classList.toggle("err", error); };
if (!self.crossOriginIsolated) say("Esta página no está aislada (COOP/COEP). Sírvela con `npm run serve` y abre http://127.0.0.1:8080/demo/", true);

async function loadRom(file) {
  say("Cargando…");
  detachInput.forEach((f) => f()); detachInput = [];
  if (player) { await player.dispose(); player = null; }
  setEnabled(false);
  const rom = new Uint8Array(await file.arrayBuffer()); // stays in this tab: no upload, no network
  romKey = romKeyOf(rom); quick = null; saveEvents = 0;
  let save = null, origin = "ninguno (partida nueva)";
  const picked = $("sav").files[0];
  if (picked) { save = new Uint8Array(await picked.arrayBuffer()); origin = `archivo ${picked.name} (${save.length} bytes)`; }
  else if ($("persist").checked) { const stored = await storeGet(romKey); if (stored) { save = new Uint8Array(stored); origin = `IndexedDB: «Continuar» (${save.length} bytes)`; } }
  try {
    player = await VideoPlayer.create({
      canvas, container: $("stage"), moduleUrl: new URL("../dist/melonds.js", import.meta.url),
      backend: $("canvas2d").checked ? "canvas2d" : "auto", threadedRenderer: $("threaded").checked,
      audioLatencyMs: +$("latency").value, audioIgnoreActivation: params.get("autoplay") === "1",
      audioCapture: params.get("capture") === "1", audioSampleRate: params.get("audiorate") ? +params.get("audiorate") : undefined,
      onStatus: (m) => { if (m.level === "err" && /error|abort/i.test(m.text)) console.warn(m.text); },
    });
    player.on("error", (e) => say(`${e.code ?? "error"}: ${e.message}`, true));
    // Re-apply the controls that were chosen before the ROM existed.
    player.setLayout($("layout").value); player.setScreenGap(+$("gap").value); player.setHybridSmallScreen($("hybrid").value);
    applyFilter(); player.setScaling({ integer: $("integer").checked, smooth: $("smooth").checked });
    player.setSpeed(+$("speed").value);
    player.setVolume(+$("volume").value / 100); player.setMuted($("mute").checked);
    let loaded = null;
    player.on("loaded", (m) => { loaded = m; });
    await player.loadRom(rom, { save });
    $("s-savetype").textContent = loaded ? `${loaded.saveType}${loaded.saveLen ? ` · ${loaded.saveLen} bytes` : ""}${loaded.saveStatus === 1 ? " · el .sav tenía otra longitud (rellenado/truncado)" : ""}` : "—";
    $("s-origin").textContent = origin;
    $("s-save").textContent = "— (todavía no ha escrito el juego)";
    $("s-cheats").textContent = "ninguno"; cheatState.clear();
    player.saves.onSave(async (bytes) => {
      saveEvents++;
      $("s-save").textContent = `#${saveEvents} ${new Date().toLocaleTimeString()} · ${bytes.length} bytes`;
      if ($("persist").checked) await storePut(romKey, bytes);
    }, 500);
    detachInput = [player.attachKeyboard(), player.attachGamepad(), player.attachPointer()]; // arrows/Space no longer scroll
    player.start();
    $("pause").disabled = $("shot").disabled = false;
    setEnabled(true, !!loaded?.saveLen);
    say("");
    window.__demo.player = player;
  } catch (error) { say(`${error.code ?? "error"}: ${error.message}`, true); console.error(error); }
}

function applyFilter() {
  const v = $("filter").value;
  $("glsl").hidden = $("applyGlsl").hidden = v !== "custom";
  if (!player) return;
  const r = player.setPostProcess(v === "none" ? null : v === "scanlines" ? SCANLINES : { glsl: $("glsl").value });
  say(r.ok ? "" : `GLSL: ${r.error}`, !r.ok);
}

$("rom").addEventListener("change", (e) => { const f = e.target.files[0]; if (f) loadRom(f); });
// Controls keep focus after a change; blur them so the arrow keys / Space go to the game, not to the <select>.
for (const el of document.querySelectorAll("aside select")) el.addEventListener("change", () => el.blur());
$("layout").addEventListener("change", () => player?.setLayout($("layout").value));
$("gap").addEventListener("input", () => { $("gapOut").textContent = $("gap").value; player?.setScreenGap(+$("gap").value); });
$("hybrid").addEventListener("change", () => player?.setHybridSmallScreen($("hybrid").value));
$("filter").addEventListener("change", applyFilter);
$("applyGlsl").addEventListener("click", applyFilter);
const scaling = () => player?.setScaling({ integer: $("integer").checked, smooth: $("smooth").checked });
$("integer").addEventListener("change", scaling); $("smooth").addEventListener("change", scaling);
$("volume").addEventListener("input", () => { $("volOut").textContent = $("volume").value; player?.setVolume(+$("volume").value / 100); });
$("mute").addEventListener("change", () => player?.setMuted($("mute").checked));
$("latency").addEventListener("input", () => { $("latOut").textContent = $("latency").value; });
$("audioBtn").addEventListener("click", () => player?.unlockAudio());
$("speed").addEventListener("change", () => player?.setSpeed(+$("speed").value));
$("pause").addEventListener("click", () => {
  const paused = $("pause").dataset.paused === "1";
  paused ? player.resume() : player.pause();
  $("pause").dataset.paused = paused ? "0" : "1"; $("pause").textContent = paused ? "Pausa" : "Reanudar";
});
$("shot").addEventListener("click", () => canvas.toBlob((b) => { const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(b), download: "melonds.png" }); a.click(); URL.revokeObjectURL(a.href); }));

// --- saves / states / cheats (phases 6 and 8) ---
$("dlSave").addEventListener("click", async () => { const b = await player.saves.getSaveNow(); if (b) download(b, "game.sav"); });
$("loadSave").addEventListener("change", async (e) => { const f = e.target.files[0]; if (!f) return; try { const r = await player.saves.loadSave(new Uint8Array(await f.arrayBuffer())); say(r.resized ? "Guardado aplicado (tamaño distinto: rellenado/truncado) y juego reiniciado." : "Guardado aplicado y juego reiniciado."); } catch (err) { fail(err); } });
$("clearStore").addEventListener("click", async () => { await storeDel(romKey); say("Guardado almacenado borrado (el juego en curso no cambia)."); });
$("qsave").addEventListener("click", async () => { try { quick = await player.saves.saveState(); say(`Estado rápido guardado (${(quick.length / 1048576).toFixed(1)} MiB).`); } catch (err) { fail(err); } });
$("qload").addEventListener("click", async () => { if (!quick) return say("No hay estado rápido.", true); try { await player.saves.loadState(quick); say("Estado rápido cargado."); } catch (err) { fail(err); } });
$("dlState").addEventListener("click", async () => { try { download(await player.saves.saveState(), "game.mdsstate"); } catch (err) { fail(err); } });
$("loadState").addEventListener("change", async (e) => { const f = e.target.files[0]; if (!f) return; try { await player.saves.loadState(new Uint8Array(await f.arrayBuffer())); say("Estado cargado."); } catch (err) { fail(err); } });
const cheatState = new Map();
const cheatSummary = () => { $("s-cheats").textContent = cheatState.size ? [...cheatState].map(([id, on]) => `#${id} ${on ? "ON" : "off"}`).join(" · ") : "ninguno"; };
async function setCheat(on) {
  try { const id = +$("cheatId").value; await player.setCheat(id, on, $("cheatCode").value); cheatState.set(id, on); cheatSummary(); say(`Truco #${id} ${on ? "activado" : "desactivado"}.`); }
  catch (err) { fail(err); }
}
$("cheatOn").addEventListener("click", () => setCheat(true));
$("cheatOff").addEventListener("click", () => setCheat(false));
$("cheatClear").addEventListener("click", async () => { try { await player.clearCheats(); cheatState.clear(); cheatSummary(); say("Trucos quitados."); } catch (err) { fail(err); } });
window.addEventListener("pagehide", () => { player?.saves.flush(); });

setInterval(() => {
  if (!player) return;
  const s = player.getStats();
  $("s-backend").textContent = s.backend;
  $("s-frame").textContent = `${canvas.width}x${canvas.height} (backing store) · CSS ${canvas.style.width} × ${canvas.style.height} · redimensionados ${s.canvasResizes}`;
  $("s-emu").textContent = `${s.emuFps.toFixed(1)} fps · ${s.emuMs.toFixed(2)} ms/fotograma · ${s.frameCount} fotogramas · duplicados ${s.duplicated}`;
  $("s-draw").textContent = `${s.drawFps.toFixed(1)} fps · ${s.drawnFrames} dibujados`;
  $("s-ring").textContent = `publicados ${s.ring.published} · consumidos ${s.ring.consumed} · descartados ${s.ring.dropped}`;
  $("s-workers").textContent = String(s.workers);
  const a = s.audio;
  if (a) {
    $("s-actx").textContent = `${a.contextState} · ${a.contextRate || "—"} Hz (núcleo ${a.sourceRate.toFixed(1)} Hz) · salida ≈${a.outputLatencyMs.toFixed(0)} ms · ${s.audioFeeding ? "reloj de audio = metrónomo" : "ritmo por temporizador (audio descartado)"}`;
    $("s-abuf").textContent = `${a.bufferMs.toFixed(1)} ms (objetivo ${(a.targetFrames / a.sourceRate * 1000).toFixed(0)} ms) · estado ${["cebando", "sonando", "sin datos"][a.mode]}`;
    $("s-aerr").textContent = `underruns ${a.underrunEvents} (${a.underrunFrames} muestras de silencio) · overruns ${a.overrunFrames} (descartadas) + ${a.trimmedFrames} (recortadas) · acelerado ${a.catchupFrames}`;
    const lvl = a.framesOut ? Math.sqrt(a.sumSq / a.framesOut) : 0;
    $("s-alevel").textContent = `RMS acumulado ${lvl.toFixed(4)} · pico ${a.peak.toFixed(3)} · máx. salto ${a.maxJump.toFixed(3)}`;
  }
  const p = player.input.pointer, names = Object.entries(BUTTON_MASK).filter(([, m]) => (player.input.mask & m) === m).map(([n]) => n);
  $("s-input").textContent = `${names.join("+") || "—"} · puntero ${p.pressed ? "PULSADO" : "libre"} (${p.x}, ${p.y})`;
}, 500);

// Test hook (read-only helpers for tests/phase3-browser.mjs).
window.__demo = { player: null, canvas };
$("s-coi").title = "audio: ?autoplay=1 ignora la política de autoplay (solo pruebas); ?capture=1 activa el anillo de captura del worklet (solo pruebas)";
