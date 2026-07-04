"use strict";
/* End-to-end test: real WebSocket clients against the running server. */
const srv = require("./server.js");
const WebSocket = require("ws");
const fs = require("fs");

/* use the exact decoder shipped in the client */
const html = fs.readFileSync("./public/index.html", "utf8");
const dm = html.match(/\/\* === BINARY PROTOCOL DECODER[\s\S]*?END BINARY PROTOCOL DECODER === \*\//);
const decodeSnapshot = (new Function(dm[0] + "; return decodeSnapshot;"))();

let seqCounter = 0;
function packCmds(cmds) {
  const b = Buffer.alloc(2 + cmds.length * 6);
  b.writeUInt8(2, 0);
  b.writeUInt8(cmds.length, 1);
  let off = 2;
  for (let i = 0; i < cmds.length; i++) {
    const c = cmds[i];
    b.writeUInt16LE(c.seq, off);
    b.writeInt8(Math.round(c.tu * 100), off + 2);
    b.writeInt8(Math.round(c.th * 100), off + 3);
    b.writeUInt8(c.f ? 1 : 0, off + 4);
    b.writeUInt8(c.dt, off + 5);
    off += 6;
  }
  return b;
}
function cmd(tu, th, f, dtMs) {
  seqCounter = (seqCounter + 1) & 0xffff;
  return { seq: seqCounter, tu: tu, th: th, f: f, dt: dtMs };
}
let lastFrameBytes = 0;

const PORT = 3100;

function fail(msg) {
  console.error("E2E FAILED: " + msg);
  process.exit(1);
}
setTimeout(function () { fail("overall timeout"); }, 25000);

/* small test-client wrapper: queues messages, lets us await one matching a predicate */
function makeClient(label) {
  const c = { label: label, ws: new WebSocket("ws://localhost:" + PORT), queue: [], waiters: [] };
  c.ws.on("message", function (raw, isBinary) {
    let msg = null;
    if (isBinary) {
      lastFrameBytes = raw.length;
      msg = decodeSnapshot(new DataView(raw.buffer, raw.byteOffset, raw.length));
      if (!msg) return;
    } else {
      msg = JSON.parse(raw);
    }
    for (let i = 0; i < c.waiters.length; i++) {
      if (c.waiters[i].pred(msg)) {
        const w = c.waiters.splice(i, 1)[0];
        clearTimeout(w.timer);
        w.resolve(msg);
        return;
      }
    }
    c.queue.push(msg);
    if (c.queue.length > 60) c.queue.shift();
  });
  c.send = function (obj) { c.ws.send(JSON.stringify(obj)); };
  c.waitFor = function (pred, what, ms) {
    // check backlog first
    for (let i = 0; i < c.queue.length; i++) {
      if (pred(c.queue[i])) return Promise.resolve(c.queue.splice(i, 1)[0]);
    }
    return new Promise(function (resolve) {
      const w = { pred: pred, resolve: resolve };
      w.timer = setTimeout(function () { fail(label + " timed out waiting for " + what); }, ms || 5000);
      c.waiters.push(w);
    });
  };
  c.drain = function () { c.queue.length = 0; };
  c.open = new Promise(function (resolve) { c.ws.on("open", resolve); });
  return c;
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function isRoom(m) { return m.t === "room"; }
function isSnap(m) { return m.t === "snap"; }

async function run() {
  /* --- lobby: create, three joins, full-room and bad-code rejections --- */
  const alice = makeClient("Alice");
  await alice.open;
  alice.send({ t: "create", name: "Alice" });
  const roomMsg = await alice.waitFor(isRoom, "room after create");
  const code = roomMsg.code;
  if (roomMsg.you !== 0 || !roomMsg.host) fail("creator should be slot 0 host");
  console.log("room created:", code, "- Alice is host, slot 0");

  const bob = makeClient("Bob");
  const cara = makeClient("Cara");
  const dan = makeClient("Dan");
  await bob.open; bob.send({ t: "join", code: code, name: "Bob" });
  await bob.waitFor(isRoom, "Bob join");
  await cara.open; cara.send({ t: "join", code: code, name: "Cara" });
  await cara.waitFor(isRoom, "Cara join");
  await dan.open; dan.send({ t: "join", code: code, name: "Dan" });
  await dan.waitFor(isRoom, "Dan join");
  const full = await alice.waitFor(function (m) { return isRoom(m) && m.players.length === 4; }, "4-player roster");
  console.log("4 players in the waiting room:", full.players.map(function (p) { return p.name; }).join(", "));

  const eve = makeClient("Eve");
  await eve.open;
  eve.send({ t: "join", code: code, name: "Eve" });
  const rej = await eve.waitFor(function (m) { return m.t === "error"; }, "full-room rejection");
  if (rej.msg.indexOf("full") === -1) fail("expected full-room error, got: " + rej.msg);
  console.log("5th player correctly rejected:", rej.msg);

  eve.send({ t: "join", code: "ZZZZ", name: "Eve" });
  const rej2 = await eve.waitFor(function (m) { return m.t === "error"; }, "bad-code rejection");
  console.log("bad code correctly rejected:", rej2.msg);

  /* --- non-host cannot start; host setup + start reaches everyone --- */
  bob.send({ t: "start" });
  await sleep(300);
  alice.send({ t: "setup", modeKey: "classic", pts: 3 });
  await alice.waitFor(function (m) { return isRoom(m) && m.modeKey === "classic" && m.pts === 3; }, "setup echo");
  alice.send({ t: "start" });
  const round = await dan.waitFor(function (m) { return m.t === "round"; }, "round msg");
  if (round.players.length !== 4) fail("round should list 4 players");
  console.log("match started by host (Bob's rogue start ignored) - round 1 in arena", round.arenaName);

  /* --- snapshots flow; input moves the right tank the right way --- */
  const snap0 = await alice.waitFor(isSnap, "first snapshot");
  if (snap0.tk.length !== 4) fail("snapshot should carry 4 tanks");
  await sleep(1700); // ride out the round intro freeze
  let before = null;
  alice.drain(); // stale snapshots queued during the sleep - sample a fresh one
  const s1 = await alice.waitFor(isSnap, "pre-move snapshot");
  for (let i = 0; i < s1.tk.length; i++) if (s1.tk[i].s === 0) before = s1.tk[i].x;
  for (let i = 0; i < 30; i++) {              // ~1 s of forward commands, 33 ms each
    alice.ws.send(packCmds([cmd(0, 1, false, 33)]));
    await sleep(33);
  }
  const drivenSeq = seqCounter;
  alice.drain();
  const s2 = await alice.waitFor(isSnap, "post-move snapshot");
  let after = null;
  for (let i = 0; i < s2.tk.length; i++) if (s2.tk[i].s === 0) after = s2.tk[i].x;
  if (after - before < 80) fail("throttle input did not move slot 0 (+x expected), moved " + (after - before));
  console.log("input drives the sim: slot 0 advanced", Math.round(after - before), "px in ~1s of commands");

  /* the server must acknowledge the last applied command in snapshots */
  const acked = await alice.waitFor(function (m) {
    if (!isSnap(m)) return false;
    for (let i = 0; i < m.tk.length; i++) {
      if (m.tk[i].s === 0 && m.tk[i].ack === drivenSeq) return true;
    }
    return false;
  }, "command acknowledgement");
  console.log("server acknowledged command #" + drivenSeq + " in the snapshot stream");

  /* --- firing produces a bullet in snapshots --- */
  bob.ws.send(packCmds([cmd(0, 0, true, 16)]));
  await alice.waitFor(function (m) { return isSnap(m) && m.bl.length > 0; }, "bullet in snapshot");
  console.log("Bob's fire command produced a shell in the broadcast state");
  console.log("live snapshot frames are running at ~" + lastFrameBytes + " bytes each");

  /* --- joining mid-match is refused --- */
  eve.send({ t: "join", code: code, name: "Eve" });
  const rej3 = await eve.waitFor(function (m) { return m.t === "error"; }, "mid-match rejection");
  if (rej3.msg.indexOf("progress") === -1) fail("expected in-progress error, got: " + rej3.msg);
  console.log("mid-match join correctly refused:", rej3.msg);

  /* --- disconnect mid-game: roster shrinks, game continues --- */
  dan.ws.close();
  await alice.waitFor(function (m) { return isRoom(m) && m.players.length === 3; }, "roster after disconnect");
  const s3 = await alice.waitFor(isSnap, "snapshot after disconnect");
  let danTank = null;
  for (let i = 0; i < s3.tk.length; i++) if (s3.tk[i].s === 3) danTank = s3.tk[i];
  if (!danTank || danTank.al !== 0) fail("disconnected player's tank should be destroyed");
  console.log("Dan disconnected: roster is 3, his tank exploded, snapshots still flowing");

  alice.ws.close(); bob.ws.close(); cara.ws.close(); eve.ws.close();
  console.log("\nALL E2E TESTS PASSED");
  process.exit(0);
}

srv.start(PORT, function () {
  run().catch(function (err) { fail(err.stack || String(err)); });
});
