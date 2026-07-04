"use strict";
/* Synchronous unit tests of the authoritative simulation. */
const T = require("./server.js")._test;

function fakeWs() { return { readyState: 3, send: function () {} }; }
function tickFor(room, seconds) {
  const dt = 1 / 60;
  const steps = Math.ceil(seconds / dt);
  for (let i = 0; i < steps; i++) T.tickRoom(room, dt);
}
function tank(room, slot) {
  for (let i = 0; i < room.tanks.length; i++) if (room.tanks[i].slot === slot) return room.tanks[i];
  return null;
}

/* --- two players, classic, full kill -> round -> match flow --- */
let room = T.makeRoom();
const alice = T.addPlayer(room, fakeWs(), "Alice");
const bob = T.addPlayer(room, fakeWs(), "Bob");
room.modeKey = "classic"; room.mode = T.MODES.classic; room.pointsToWin = 2;
T.startMatch(room);
if (room.state !== "playing" || room.tanks.length !== 2) throw new Error("match start failed");
console.log("match started:", room.tanks.length, "tanks, arena", room.arena.name);

function stageDuel() {
  room.introTimer = 0;
  const t0 = tank(room, 0), t1 = tank(room, 1);
  t0.x = 180; t0.y = 540; t0.angle = 0; t0.fireCooldown = 0;
  t1.x = 400; t1.y = 540; t1.angle = Math.PI; // short lane, clear in all four arenas
}
stageDuel();
alice.pending.push({ seq: 1, tu: 0, th: 0, f: true, dt: 0.016 });
tickFor(room, 0.1);
if (room.bullets.length !== 1) throw new Error("shell not fired");
tickFor(room, 1.5);
if (tank(room, 1).alive) throw new Error("shell failed to connect");
if (room.state !== "roundover" || room.scores[0] !== 1) throw new Error("round scoring failed");
console.log("clean kill: Alice 1 - 0 Bob, state", room.state);

tickFor(room, 2.5);
if (room.state !== "playing" || room.roundNumber !== 2) throw new Error("next round failed");
console.log("round 2 started in", room.arena.name);

stageDuel();
alice.pending.push({ seq: 2, tu: 0, th: 0, f: true, dt: 0.016 });
tickFor(room, 0.1);
if (alice.lastSeq !== 2) throw new Error("command not acknowledged");
tickFor(room, 2.5);
tickFor(room, 2.5); // ride out roundover
if (room.state !== "matchover") throw new Error("match over not reached, state=" + room.state);
console.log("match over at 2 points, matchover timer running");
tickFor(room, 10.2);
if (room.state !== "lobby") throw new Error("auto-return to lobby failed");
console.log("auto-returned to waiting room");

/* --- four players, arsenal, last-tank-standing --- */
room = T.makeRoom();
const names = ["Ann", "Ben", "Cat", "Dan"];
const players = [];
for (let i = 0; i < 4; i++) players.push(T.addPlayer(room, fakeWs(), names[i]));
room.modeKey = "arsenal"; room.mode = T.MODES.arsenal; room.pointsToWin = 5;
T.startMatch(room);
room.introTimer = 0;
if (room.tanks.length !== 4) throw new Error("expected 4 tanks");
if (tank(room, 0).hp !== 3) throw new Error("arsenal should give 3 hp");
T.damageTank(room, tank(room, 1), 99);
T.damageTank(room, tank(room, 2), 99);
tickFor(room, 0.05);
if (room.state !== "playing") throw new Error("round should continue with 2 alive");
T.damageTank(room, tank(room, 3), 99);
tickFor(room, 0.05);
if (room.state !== "roundover" || room.scores[0] !== 1) throw new Error("last-standing scoring failed");
console.log("4-player last-tank-standing: survivor scores, state", room.state);

/* --- homing missile seeks the nearest enemy --- */
tickFor(room, 2.5); // next round
room.introTimer = 0;
const shooter = tank(room, 0);
const victim = tank(room, 1);
shooter.x = 200; shooter.y = 540; shooter.angle = 0; shooter.fireCooldown = 0;
victim.x = 420; victim.y = 540;
tank(room, 2).x = 480; tank(room, 2).y = 70;   // park the others far away
tank(room, 3).x = 480; tank(room, 3).y = 530;
T.applyPowerup(room, shooter, T.POWERUPS[2]); // homing
T.fire(room, shooter);
if (room.bullets.length !== 1 || !room.bullets[0].homing) throw new Error("homing not fired");
tickFor(room, 2.0);
if (victim.hp >= 3) throw new Error("homing missile missed a stationary target");
console.log("homing missile connected, victim hp:", victim.hp);

/* --- mine arms, then triggers with splash damage --- */
shooter.weapon = "mine"; shooter.ammo = 1; shooter.fireCooldown = 0;
T.fire(room, shooter);
if (room.mines.length !== 1) throw new Error("mine not laid");
tickFor(room, 1.2); // arm it
if (room.mines.length !== 1) throw new Error("mine self-triggered while stationary");
victim.x = room.mines[0].x + 5; victim.y = room.mines[0].y;
victim.hp = 3; victim.alive = true;
tickFor(room, 0.1);
if (room.mines.length !== 0) throw new Error("mine did not trigger");
if (victim.hp >= 3) throw new Error("mine dealt no damage");
console.log("mine armed safely and triggered, victim hp:", victim.hp);

/* --- powerup spawning + snapshot shape --- */
T.trySpawnPowerup(room);
if (room.powerups.length < 1) throw new Error("no powerup spawned");
const snap = T.buildSnapshot(room);
if (snap.t !== "snap" || !snap.tk || !snap.bl || !snap.pu || !snap.sc) throw new Error("snapshot malformed");
if (room.events.length !== 0) throw new Error("events not drained by snapshot");
console.log("snapshot ok:", snap.tk.length, "tanks,", snap.pu.length, "powerups, events drained");

/* --- solo practice never scores --- */
room = T.makeRoom();
T.addPlayer(room, fakeWs(), "Solo");
room.modeKey = "classic"; room.mode = T.MODES.classic;
T.startMatch(room);
room.introTimer = 0;
tickFor(room, 5);
if (room.state !== "playing") throw new Error("solo round should never end");
console.log("solo practice runs without scoring");

console.log("\nALL SIM TESTS PASSED");
process.exit(0);
