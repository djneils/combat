"use strict";
/* Client smoke test: run the shipped client script against a
   stubbed DOM/canvas/WebSocket, feed it real binary snapshots
   from the server encoder, and render frames in all four views. */
const fs = require("fs");
const T = require("./server.js")._test;

const html = fs.readFileSync("./public/index.html", "utf8");
const src = html.match(/<script>([\s\S]*)<\/script>/)[1].replace('"use strict";', "");

/* ---- stub environment ---- */
let ctxCalls = 0;
const ctxProxy = new Proxy({}, {
  get: function (t, k) {
    if (k === "canvas") return {};
    return function () { ctxCalls++; };
  },
  set: function () { return true; }
});

function leafEl() {
  return {
    style: {}, textContent: "", innerHTML: "", value: "Tester",
    classList: { toggle: function () { return false; }, add: function () {}, remove: function () {} },
    setAttribute: function () {}, getAttribute: function () { return ""; },
    addEventListener: function () {}, appendChild: function () {}, blur: function () {}
  };
}
const clickHandlers = {};
const elements = {};
function getEl(id) {
  if (!elements[id]) {
    const e = leafEl();
    e.children = [leafEl(), leafEl(), leafEl()];
    e.addEventListener = function (type, fn) { if (type === "click") clickHandlers[id] = fn; };
    if (id === "gameCanvas") {
      e.getContext = function () { return ctxProxy; };
      e.width = 960; e.height = 600;
    }
    elements[id] = e;
  }
  return elements[id];
}
const docHandlers = {};
const documentStub = {
  getElementById: getEl,
  createElement: function () { const e = leafEl(); e.children = [leafEl(), leafEl(), leafEl()]; return e; },
  querySelectorAll: function () { return []; },
  addEventListener: function (type, fn) { docHandlers[type] = fn; },
  body: { classList: { toggle: function () { return false; } } }
};

let simNow = 10000;
const performanceStub = { now: function () { return simNow; } };
let rafCb = null;
function raf(cb) { rafCb = cb; }
const intervals = [];
function fakeSetInterval(fn, ms) { intervals.push(fn); return intervals.length; }

let wsInstance = null;
const sentFrames = [];
function FakeWebSocket() {
  this.readyState = 1;
  this.binaryType = "blob";
  wsInstance = this;
}
FakeWebSocket.prototype.send = function (data) { sentFrames.push(data); };

const windowStub = { AudioContext: undefined, webkitAudioContext: undefined };
const locationStub = { protocol: "http:", host: "test" };
const navigatorStub = { getGamepads: function () { return []; } };

/* ---- boot the client ---- */
const boot = new Function(
  "document", "window", "location", "navigator", "performance",
  "requestAnimationFrame", "setInterval", "setTimeout", "clearTimeout",
  "WebSocket",
  src + ';\nglobalThis.__pred = { step: stepTankLocal, setCtx: function (l, ai, u) { latest = l; arenaIdx = ai; you = u; } };'
);
const timeouts = [];
function fakeSetTimeout(fn, ms) { timeouts.push(fn); return timeouts.length; }
boot(documentStub, windowStub, locationStub, navigatorStub, performanceStub,
     raf, fakeSetInterval, fakeSetTimeout, function () {}, FakeWebSocket);
if (!rafCb) throw new Error("client did not start its render loop");
console.log("client booted against the stub DOM");

function frames(n) {
  for (let i = 0; i < n; i++) {
    simNow += 16;
    const cb = rafCb;
    rafCb = null;
    cb(simNow);
    if (!rafCb) throw new Error("render loop stopped re-registering");
  }
}
function runTimeouts() {
  while (timeouts.length) timeouts.shift()();
}
function key(code) {
  docHandlers.keydown({ code: code, target: null, preventDefault: function () {} });
  docHandlers.keyup({ code: code, target: null, preventDefault: function () {} });
}

/* ---- connect -> lobby -> round, mirroring the real server messages ---- */
clickHandlers.createBtn();          // connect() + create
wsInstance.onopen();
if (wsInstance.binaryType !== "arraybuffer") throw new Error("client did not request arraybuffer frames");
const rosterMsg = [{ slot: 0, name: "Tester", host: true }, { slot: 1, name: "Rival", host: false }];
wsInstance.onmessage({ data: JSON.stringify({
  t: "room", v: 3, code: "TEST", you: 0, host: true,
  players: rosterMsg, modeKey: "arsenal", pts: 5, state: "lobby"
}) });
wsInstance.onmessage({ data: JSON.stringify({
  t: "round", n: 1, arena: 0, arenaName: "Open Ground", mode: "arsenal",
  players: rosterMsg, scores: [0, 0, 0, 0]
}) });
wsInstance.onmessage({ data: JSON.stringify({ t: "banner", txt: "Round 1", sec: 1.4 }) });
console.log("connect -> waiting room -> round accepted");

/* ---- feed genuine binary snapshots from the server encoder ---- */
const room = T.makeRoom();
function fakeWs() { return { readyState: 3, send: function () {} }; }
T.addPlayer(room, fakeWs(), "Tester");
T.addPlayer(room, fakeWs(), "Rival");
room.modeKey = "arsenal"; room.mode = T.MODES.arsenal;
T.startMatch(room);
room.introTimer = 0;
let srvSeq = 0;
T.applyPowerup(room, room.tanks[1], T.POWERUPS[3]);   // rival carries mines
room.tanks[1].fireCooldown = 0;
T.fire(room, room.tanks[1]);
T.trySpawnPowerup(room);

function feedSnap() {
  simNow += 33;
  srvSeq++;
  room.players[0].pending.push({ seq: srvSeq, tu: 0.3, th: 1, f: true, dt: 0.033 });
  for (let i = 0; i < 2; i++) T.tickRoom(room, 1 / 60);
  const buf = T.packSnapshot(T.buildSnapshot(room));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
  wsInstance.onmessage({ data: ab });
}
for (let i = 0; i < 10; i++) feedSnap();
runTimeouts(); // delayed effects (booms, muzzle flashes)
console.log("binary snapshots decoded and buffered; delayed effects ran");

/* ---- render frames in every view, driving with W held ---- */
docHandlers.keydown({ code: "KeyW", target: null, preventDefault: function () {} });
const before = ctxCalls;
frames(20); // view 0: top-down 2D, prediction stepping each frame
for (let v = 1; v <= 3; v++) {
  key("Digit" + (v + 1));
  for (let f = 0; f < 6; f++) { feedSnap(); frames(4); }
  console.log("view", v + 1, "rendered without errors");
}
key("KeyV"); // cycles back to top-down
frames(10);
if (ctxCalls - before < 4000) throw new Error("suspiciously little canvas activity: " + (ctxCalls - before));
console.log("all four views drew", ctxCalls - before, "canvas ops with live state");

/* the batched command sender produced well-formed frames */
let batches = 0, cmds = 0;
for (let r = 0; r < 30; r++) for (let i = 0; i < intervals.length; i++) intervals[i]();
for (let i = 0; i < sentFrames.length; i++) {
  const f = sentFrames[i];
  if (f instanceof ArrayBuffer) {
    const dv = new DataView(f);
    if (dv.getUint8(0) === 2) {
      const n = dv.getUint8(1);
      if (f.byteLength !== 2 + n * 6) throw new Error("malformed command batch");
      batches++;
      cmds += n;
    }
  }
}
if (batches < 1 || cmds < 10) throw new Error("prediction did not generate command traffic: " + batches + "/" + cmds);
console.log("prediction generated", cmds, "movement commands across", batches, "well-formed batches");
console.log("reconciliation ran against", 10 + 18, "authoritative snapshots without errors");

/* ---- prediction determinism: the client's stepTankLocal must land
   exactly where the server's applyCommand does for the same commands ---- */
const dRoom = T.makeRoom();
T.addPlayer(dRoom, fakeWs(), "Solo");
dRoom.modeKey = "classic"; dRoom.mode = T.MODES.classic;
T.startMatch(dRoom);
dRoom.introTimer = 0;
const dTank = dRoom.tanks[0];
dTank.x = 300; dTank.y = 300; dTank.angle = 0;

const cmdSeq = [];
for (let i = 0; i < 60; i++) {
  cmdSeq.push({
    seq: i + 1,
    tu: Math.round((((i % 7) - 3) / 3) * 100) / 100, // pre-quantised like the wire format
    th: 1, f: false, dt: 0.033
  });
}
/* pace commands like the real client (a few per tick), so the
   runaway-queue guard - which drops bulk backlogs by design - never trips */
for (let i = 0; i < cmdSeq.length; i++) {
  dRoom.players[0].pending.push(cmdSeq[i]);
  T.tickRoom(dRoom, 1 / 60);
  T.tickRoom(dRoom, 1 / 60);
}
for (let i = 0; i < 30; i++) T.tickRoom(dRoom, 1 / 60); // drain any remainder
if (dRoom.players[0].lastSeq !== 60) throw new Error("not all commands were applied");

// same arena, same emptiness, same starting state on the client side
let dArena = 0;
for (let i = 0; i < T.ARENAS.length; i++) if (T.ARENAS[i] === dRoom.arena) dArena = i;
globalThis.__pred.setCtx({ sd: 0, tk: [] }, dArena, 0);
const local = { x: 300, y: 300, a: 0 };
for (let i = 0; i < cmdSeq.length; i++) globalThis.__pred.step(local, cmdSeq[i], [], false);

const errX = Math.abs(local.x - dTank.x);
const errY = Math.abs(local.y - dTank.y);
const errA = Math.abs(local.a - dTank.angle);
if (errX > 1e-6 || errY > 1e-6 || errA > 1e-6) {
  throw new Error("prediction diverged from the server: (" + errX + ", " + errY + ", " + errA + ")");
}
console.log("determinism: 60 mixed commands, client and server landed on the identical spot",
            "(" + local.x.toFixed(3) + ", " + local.y.toFixed(3) + ") in " + dRoom.arena.name);

console.log("\nCLIENT SMOKE TESTS PASSED");
process.exit(0);
