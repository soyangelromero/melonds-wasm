# PHASE 12 — Multijugador WebRTC: informe (2026-11-15)

Estado: **hecha y verificada con anfitrión e invitado reales** en Chromium (dos páginas). Sin commit.

## 1. Qué se entrega

- **`adapters/netplay-host.js`**: `createNetplayHost({ds, canvas, stream?, io?, serverUrl, roomName, password,
  maxPlayers, gameId, gameName, key, iceServers, onPlayers, onGuestJoined, onGuestLeft, onError})`.
  - Abre la sala con el protocolo socket.io del hub (`open-room` con `extra`, ack/error).
  - Por invitado crea un `RTCPeerConnection`, envía la **oferta** con las pistas de `ds.captureStream(60)` y abre el
    `RTCDataChannel("inputs", {ordered:true})`. Si el audio aún no está desbloqueado, cae a **vídeo solo** con
    `canvas.captureStream(fps)` (un invitado puede ver la partida antes del primer gesto del anfitrión).
  - Entradas del canal `{player, index, value}` → `ds.button(button, down, player)` (tabla de `API_CONTRACT.md` §5);
    `{type:"host-left"}` al cerrar. Toques por socket `{touch:{x,y,s}}` → `ds.touchFromCanvas(x,y,s)`.
  - Limpieza: `leave()` cierra peers/channels, suelta botones y emite `leave-room`; `destroy` es alias.
  - `io` y `RTCPeerConnection` son inyectables: se prueba en Node con dobles.
- **Web app con `?engine=wasm`**: la pestaña Online usa `setupOnlineWasm()`, construye el enlace de invitación con
  `/nds/api/public` (solo si el túnel es reciente) y reutiliza `nds/join.html` **sin tocarlo**.
- **Demo independiente `demo/host.html` + `demo/host.js`**: carga una ROM propia, crea la sala contra un hub
  configurable y muestra el enlace de invitación y la lista de jugadores (Fase 12, paso 7).

## 2. Pruebas

| Comando | Resultado |
|---|---|
| `node --test --test-force-exit tests/netplay-host.test.mjs` | **9/9** unitarias con dobles (sala, oferta, canal, botones, toques, ICE, salida) |
| `node tests/phase12-browser.mjs` | **11/11** (incluida la comprobación de latencia de entrada): sala abierta y enlace, invitado dentro, **vídeo 256×384 recibido y reproduciéndose**, los dos jugadores listados, **START del invitado llega al anfitrión** (pulsación y suelta), **latencia de entrada 7-14 ms (según la pasada) en local**, **toque del invitado como coordenada normalizada**, cerrar la sala desconecta al invitado, sin errores en ninguna página |
| `node tests/demo-host-browser.mjs` | **6/6**: la demo independiente `demo/host.html` (servida por el hub en `/nds/wasm/demo/host.html` para que socket.io sea del mismo origen) carga una ROM, crea la sala, muestra el enlace de invitación y la lista de jugadores, sale sin errores |

## 3. Latencias y limitaciones

- **Latencia de entrada guest→host (medida en local por la prueba)**: se mide desde la pulsación en la página del
  invitado hasta la llamada a `ds.button()` en el anfitrión, con relojes de la misma máquina. Incluye el despacho de
  Playwright y el sondeo, así que es una cota superior local, no una medida de red. Resultado: **14 ms** (comprobación
  `guest input latency is reasonable (< 500 ms local)`, 2026-11-15, Playwright + Chromium en la misma máquina).
- **Toques del invitado**: llegan al anfitrión como coordenada normalizada (0..1) y estado `down`/`up`; medido en la
  misma pasada.
- **Vídeo**: `captureStream` del canvas visible (WebGPU/WebGL2 en el hilo principal); Chrome emite fotograma cuando el
  canvas cambia. En local el invitado recibe el vídeo en ~1-2 s tras entrar (tiempo de ICE + primer fotograma).
- **Sin TURN**: solo STUN público (`stun.l.google.com:19302`). Redes con NAT simétrico o cortafuegos restrictivo pueden
  no conectar. Es una limitación documentada y aceptada (una solución requiere un TURN propio).
- **Una consola**: el DS es de un solo jugador; todos los mandos se funden en el jugador 0 (los índices >0 se mapean a
  0 o se ignoran, documentado en el módulo).
- **Audio del invitado**: requiere que el anfitrión haya desbloqueado el audio (primer gesto). Si no, vídeo solo.
- **Salas**: compatibles con el protocolo de EmulatorJS (`/list`, `open-room`, `join-room`, `webrtc-signal`,
  `data-message`); el servidor de señalización es el `server.mjs` de la web app.
