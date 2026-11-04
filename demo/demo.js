import { VideoPlayer, SCANLINES, LAYOUT_LABELS } from "../js/player.js";

const $ = (id) => document.getElementById(id);
const canvas = $("screen"), msg = $("msg");
const params = new URLSearchParams(location.search);
let player = null;

$("s-coi").textContent = String(self.crossOriginIsolated);
for (const label of LAYOUT_LABELS) $("layout").add(new Option(label, label));
if (params.get("backend") === "canvas2d") $("canvas2d").checked = true;
if (params.get("threads") === "0") $("threaded").checked = false;

const say = (text, error = false) => { msg.textContent = text; msg.classList.toggle("err", error); };
if (!self.crossOriginIsolated) say("Esta página no está aislada (COOP/COEP). Sírvela con `npm run serve` y abre http://127.0.0.1:8080/demo/", true);

async function loadRom(file) {
  say("Cargando…");
  if (player) { await player.dispose(); player = null; }
  const rom = new Uint8Array(await file.arrayBuffer()); // stays in this tab: no upload, no network
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
    await player.loadRom(rom);
    player.start();
    $("pause").disabled = $("shot").disabled = false;
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
}, 500);

// Test hook (read-only helpers for tests/phase3-browser.mjs).
window.__demo = { player: null, canvas };
$("s-coi").title = "audio: ?autoplay=1 ignora la política de autoplay (solo pruebas); ?capture=1 activa el anillo de captura del worklet (solo pruebas)";
