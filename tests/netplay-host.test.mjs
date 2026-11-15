// Phase 12: unit tests for the WebRTC netplay host, with fake socket.io / RTCPeerConnection / MediaStream.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createNetplayHost, PAD_INDEX_TO_BUTTON, DEFAULT_STUN } from "../adapters/netplay-host.js";

class FakeDataChannel {
  constructor(label, options) {
    this.label = label;
    this.options = options;
    this.sent = [];
    this.readyState = "open";
    this.onmessage = null;
  }
  send(message) {
    this.sent.push(message);
  }
  close() {
    this.readyState = "closed";
  }
  /** Simulates a message coming from the guest. */
  receive(object) {
    this.onmessage?.({ data: JSON.stringify(object) });
  }
}

class FakePeerConnection {
  static instances = [];
  constructor(config) {
    this.config = config;
    this.tracks = [];
    this.channels = [];
    this.localDescription = null;
    this.remoteDescription = null;
    this.candidates = [];
    this.connectionState = "new";
    FakePeerConnection.instances.push(this);
  }
  addTrack(track, stream) {
    this.tracks.push([track, stream]);
  }
  createDataChannel(label, options) {
    const channel = new FakeDataChannel(label, options);
    this.channels.push(channel);
    return channel;
  }
  async createOffer() {
    return { type: "offer", sdp: "fake-offer" };
  }
  async setLocalDescription(description) {
    this.localDescription = description;
  }
  async setRemoteDescription(description) {
    this.remoteDescription = description;
  }
  async addIceCandidate(candidate) {
    this.candidates.push(candidate);
  }
  close() {
    this.connectionState = "closed";
  }
}

class FakeSocket {
  constructor() {
    this.id = "host-socket";
    this.handlers = new Map();
    this.emitted = [];
    this.disconnected = false;
  }
  on(event, callback) {
    if (!this.handlers.has(event)) this.handlers.set(event, []);
    this.handlers.get(event).push(callback);
  }
  emit(event, data, callback) {
    this.emitted.push([event, data]);
    if (event === "open-room") callback?.(null);
  }
  trigger(event, data) {
    for (const callback of this.handlers.get(event) ?? []) callback(data);
  }
  disconnect() {
    this.disconnected = true;
  }
}

function makeHarness() {
  FakePeerConnection.instances = [];
  globalThis.RTCPeerConnection = FakePeerConnection;
  const socket = new FakeSocket();
  const buttons = [];
  const touches = [];
  const ds = {
    captureStream: () => ({ getTracks: () => [{ kind: "video" }, { kind: "audio" }] }),
    button: (name, down, player) => buttons.push([name, !!down, player]),
    touchFromCanvas: (x, y, state) => touches.push([x, y, state]),
  };
  const events = { joined: [], left: [], players: [], errors: [] };
  return {
    socket,
    buttons,
    touches,
    events,
    ioFactory: () => socket,
    make: (overrides = {}) =>
      createNetplayHost({
        ds,
        io: () => socket,
        serverUrl: "http://127.0.0.1:8080",
        roomName: "Sala de prueba",
        playerName: "Anfitrión",
        maxPlayers: 4,
        gameId: 42,
        gameName: "Platino",
        onGuestJoined: (id) => events.joined.push(id),
        onGuestLeft: (id) => events.left.push(id),
        onPlayers: (map) => events.players.push(map),
        onError: (error) => events.errors.push(error),
        ...overrides,
      }),
  };
}

test("PAD_INDEX_TO_BUTTON matches the libretro table of API_CONTRACT section 5", () => {
  assert.equal(PAD_INDEX_TO_BUTTON.length, 12);
  assert.equal(PAD_INDEX_TO_BUTTON[0], "B");
  assert.equal(PAD_INDEX_TO_BUTTON[3], "START");
  assert.equal(PAD_INDEX_TO_BUTTON[8], "A");
  assert.equal(PAD_INDEX_TO_BUTTON[11], "R");
  assert.ok(DEFAULT_STUN.length >= 1);
});

test("opening a room sends the EmulatorJS-compatible open-room payload", async () => {
  const harness = makeHarness();
  const host = await harness.make();
  const [event, payload] = harness.socket.emitted.find(([name]) => name === "open-room");
  assert.equal(event, "open-room");
  assert.equal(payload.extra.room_name, "Sala de prueba");
  assert.equal(payload.extra.game_id, 42);
  assert.equal(payload.extra.player_name, "Anfitrión");
  assert.equal(payload.maxPlayers, 4);
  assert.ok(payload.extra.sessionid, "sessionid is generated");
  assert.ok(payload.extra.userid, "userid is generated");
  assert.match(host.inviteUrl(), /\/nds\/join\.html\?room=[0-9a-f-]{8,}/i);
  await host.leave();
});

test("a joining guest gets a peer connection with the captureStream tracks and the inputs channel", async () => {
  const harness = makeHarness();
  const host = await harness.make();
  // users map: the host itself (socketId === socket.id) plus one guest.
  harness.socket.trigger("users-updated", {
    hostUser: { socketId: "host-socket", player_name: "Anfitrión" },
    guestUser: { socketId: "guest-1", player_name: "Invitado" },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(FakePeerConnection.instances.length, 1, "only the guest gets a peer connection");
  const pc = FakePeerConnection.instances[0];
  assert.equal(pc.tracks.length, 2);
  assert.equal(pc.tracks[0][0].kind, "video");
  assert.equal(pc.channels.length, 1);
  assert.equal(pc.channels[0].label, "inputs");
  assert.deepEqual(pc.channels[0].options, { ordered: true });
  assert.equal(pc.localDescription.type, "offer");

  const signal = harness.socket.emitted.find(([name, data]) => name === "webrtc-signal" && data.offer);
  assert.equal(signal[1].target, "guest-1");
  assert.deepEqual(harness.events.joined, ["guest-1"]);
  await host.leave();
});

test("data channel messages become libretro button presses", async () => {
  const harness = makeHarness();
  const host = await harness.make();
  harness.socket.trigger("users-updated", { guest: { socketId: "guest-1" } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const channel = FakePeerConnection.instances[0].channels[0];

  channel.receive({ player: 0, index: 8, value: 1 }); // A down
  channel.receive({ player: 0, index: 8, value: 0 }); // A up
  channel.receive({ player: 0, index: 3, value: 1 }); // START down
  channel.receive({ player: 0, index: 99, value: 1 }); // unknown index: ignored
  channel.receive({ type: "host-left" }); // ignored

  assert.deepEqual(harness.buttons, [
    ["A", true, 0],
    ["A", false, 0],
    ["START", true, 0],
  ]);
  await host.leave();
});

test("guest touch events over the socket are clamped and forwarded", async () => {
  const harness = makeHarness();
  const host = await harness.make();
  harness.socket.trigger("data-message", { touch: { x: 0.5, y: 1.4, s: "down" } });
  harness.socket.trigger("data-message", { touch: { x: -0.2, y: 0.25, s: "up" } });
  harness.socket.trigger("data-message", { something: "else" });
  assert.deepEqual(harness.touches, [
    [0.5, 1, "down"],
    [0, 0.25, "up"],
  ]);
  await host.leave();
});

test("the guest answer is applied and queued ICE candidates are flushed", async () => {
  const harness = makeHarness();
  const host = await harness.make();
  harness.socket.trigger("users-updated", { guest: { socketId: "guest-1" } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const pc = FakePeerConnection.instances[0];

  harness.socket.trigger("webrtc-signal", { sender: "guest-1", candidate: { candidate: "c1" } });
  harness.socket.trigger("webrtc-signal", { sender: "guest-1", answer: { type: "answer", sdp: "fake-answer" } });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(pc.remoteDescription.type, "answer");
  assert.deepEqual(pc.candidates, [{ candidate: "c1" }]);
  await host.leave();
});

test("a guest that leaves is dropped and the event fires", async () => {
  const harness = makeHarness();
  const host = await harness.make();
  harness.socket.trigger("users-updated", { guest: { socketId: "guest-1" } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const pc = FakePeerConnection.instances[0];

  harness.socket.trigger("users-updated", {});
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.deepEqual(harness.events.left, ["guest-1"]);
  assert.equal(pc.connectionState, "closed");
  assert.equal(host.playerCount(), 0);
  await host.leave();
});

test("leave() tells the guests and disconnects the socket", async () => {
  const harness = makeHarness();
  const host = await harness.make();
  harness.socket.trigger("users-updated", { guest: { socketId: "guest-1" } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const channel = FakePeerConnection.instances[0].channels[0];

  await host.leave();

  assert.deepEqual(channel.sent, [JSON.stringify({ type: "host-left" })]);
  assert.equal(channel.readyState, "closed");
  assert.ok(harness.socket.emitted.some(([name]) => name === "leave-room"));
  assert.equal(harness.socket.disconnected, true);
});

test("createNetplayHost refuses to start without a device", async () => {
  await assert.rejects(() => createNetplayHost({ roomName: "x" }), (error) => error.code === "NO_DEVICE");
});
