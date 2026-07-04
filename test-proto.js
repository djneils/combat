"use strict";
/* Protocol round-trip: the server's packSnapshot vs the client's
   decodeSnapshot (extracted verbatim from public/index.html). */
const fs = require("fs");
const T = require("./server.js")._test;

const html = fs.readFileSync("./public/index.html", "utf8");
const m = html.match(/\/\* === BINARY PROTOCOL DECODER[\s\S]*?END BINARY PROTOCOL DECODER === \*\//);
if (!m) { console.error("decoder block not found in client"); process.exit(1); }
const decodeSnapshot = (new Function(m[0] + "; return decodeSnapshot;"))();

function fakeWs() { return { readyState: 3, send: function () {} }; }
function close(a, b, tol, what) {
  if (Math.abs(a - b) > tol) throw new Error(what + ": " + a + " vs " + b);
}

/* build a busy room: 4 tanks, bullets, a mine, powerups, mixed events */
const room = T.makeRoom();
for (let i = 0; i < 4; i++) T.addPlayer(room, fakeWs(), "P" + i);
room.modeKey = "arsenal"; room.mode = T.MODES.arsenal;
T.startMatch(room);
room.introTimer = 0;
const t0 = room.tanks[0];
t0.x = 123.44; t0.y = 456.78; t0.angle = -2.5; t0.visibleTimer = 0.5;
t0.shieldHP = 2; t0.boostTime = 3;
T.applyPowerup(room, t0, T.POWERUPS[0]); // spread x8
T.fire(room, t0);                        // 3 shells + fire event
room.tanks[1].weapon = "mine"; room.tanks[1].ammo = 1; room.tanks[1].fireCooldown = 0;
T.fire(room, room.tanks[1]);             // mine + clink event
T.trySpawnPowerup(room);
T.damageTank(room, room.tanks[2], 1);    // boom event, flash
room.suddenDeath = true;
room.roundTime = 61.4;
room.scores = [3, 1, 0, 2];
room.players[0].lastSeq = 777; // command ack should survive the round trip

const snap = T.buildSnapshot(room);
const buf = T.packSnapshot(snap);
const dv = new DataView(buf.buffer, buf.byteOffset, buf.length);
const dec = decodeSnapshot(dv);
if (!dec) throw new Error("decoder rejected the frame");

if (dec.st !== snap.st) throw new Error("state mismatch");
if (dec.sd !== 1) throw new Error("sudden death flag lost");
if (dec.rt !== snap.rt) throw new Error("round time mismatch");
if (dec.in !== 0) throw new Error("intro flag should be clear");
for (let i = 0; i < 4; i++) if (dec.sc[i] !== snap.sc[i]) throw new Error("scores mismatch");

if (dec.tk.length !== snap.tk.length) throw new Error("tank count");
for (let i = 0; i < snap.tk.length; i++) {
  const a = snap.tk[i], b = dec.tk[i];
  if (a.s !== b.s || a.al !== b.al || a.hp !== b.hp) throw new Error("tank identity/hp");
  close(a.x, b.x, 0.06, "tank x");
  close(a.y, b.y, 0.06, "tank y");
  // angles are equal modulo 2*pi
  const da = Math.abs(((a.a - b.a) % (Math.PI * 2) + Math.PI * 3) % (Math.PI * 2) - Math.PI);
  if (da > 0.001) throw new Error("tank angle: " + a.a + " vs " + b.a);
  close(a.vis, b.vis, 0.005, "tank vis");
  if (a.w !== b.w || a.am !== b.am) throw new Error("weapon/ammo");
  if (a.ack !== b.ack) throw new Error("command ack lost: " + a.ack + " vs " + b.ack);
  if ((a.sh > 0) !== (b.sh > 0) || a.bo !== b.bo || a.fl !== b.fl) throw new Error("tank flags");
}
if (dec.bl.length !== snap.bl.length) throw new Error("bullet count");
for (let i = 0; i < snap.bl.length; i++) {
  const a = snap.bl[i], b = dec.bl[i];
  if ((a.id & 0xffff) !== b.id || a.h !== b.h || a.o !== b.o) throw new Error("bullet identity");
  close(a.x, b.x, 0.06, "bullet x");
  close(a.y, b.y, 0.06, "bullet y");
}
if (dec.mn.length !== 1 || dec.mn[0].ar !== 0) throw new Error("mine record");
close(snap.mn[0].x, dec.mn[0].x, 0.06, "mine x");
if (dec.pu.length !== snap.pu.length) throw new Error("powerup count");
for (let i = 0; i < snap.pu.length; i++) {
  if (snap.pu[i].g !== dec.pu[i].g) throw new Error("powerup glyph");
}
if (dec.ev.length !== snap.ev.length) throw new Error("event count: " + snap.ev.length + " vs " + dec.ev.length);
for (let i = 0; i < snap.ev.length; i++) {
  if (snap.ev[i].e !== dec.ev[i].e) throw new Error("event kind order");
}

if (dec.tk[0].ack !== 777) throw new Error("player 0 ack should be 777");

/* intro flag round-trips too */
room.introTimer = 1.0;
const dec2 = (function () {
  const b2 = T.packSnapshot(T.buildSnapshot(room));
  return decodeSnapshot(new DataView(b2.buffer, b2.byteOffset, b2.length));
})();
if (dec2.in !== 1) throw new Error("intro flag lost");
room.introTimer = 0;

const jsonSize = JSON.stringify(snap).length;
console.log("round trip exact for", dec.tk.length, "tanks,", dec.bl.length, "bullets,",
            dec.mn.length, "mine,", dec.pu.length, "powerups,", dec.ev.length, "events");
console.log("frame size:", buf.length, "bytes binary vs", jsonSize, "bytes JSON  (" +
            (jsonSize / buf.length).toFixed(1) + "x smaller)");
console.log("\nPROTOCOL TESTS PASSED");
process.exit(0);
