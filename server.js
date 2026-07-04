"use strict";
/* ================================================================
   COMBAT: REDUX — NETWORK EDITION · server
   Authoritative simulation. Clients send inputs; the server runs
   the game at 60 Hz and broadcasts snapshots at 30 Hz.
   Sections: web server · constants · arenas · rooms & lobby ·
             simulation · snapshots · socket protocol
   ================================================================ */

const path = require("path");
const http = require("http");
const express = require("express");
const { WebSocketServer } = require("ws");

const app = express();
app.use(express.static(path.join(__dirname, "public")));
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

/* ---------------- constants (mirrored in the client) ---------------- */
const W = 960;
const H = 600;
const BORDER = 14;
const TANK_R = 15;
const BULLET_R = 4;
const BULLET_SPEED = 430;
const TANK_SPEED = 175;
const TANK_REVERSE = 115;
const TANK_TURN = 3.3;
const SUDDEN_DEATH_AT = 60;
const MAX_PLAYERS = 4;

const MODES = {
  classic:   { label: "Classic 1977", bounces: 0, hp: 1, powerups: false, oneShell: true,  invisible: false },
  ricochet:  { label: "Ricochet",     bounces: 3, hp: 1, powerups: false, oneShell: true,  invisible: false },
  invisible: { label: "Invisible",    bounces: 0, hp: 1, powerups: false, oneShell: true,  invisible: true  },
  arsenal:   { label: "Arsenal",      bounces: 1, hp: 3, powerups: true,  oneShell: false, invisible: false }
};

const POWERUPS = [
  { id: "spread", glyph: "S" },
  { id: "rapid",  glyph: "R" },
  { id: "homing", glyph: "H" },
  { id: "mine",   glyph: "M" },
  { id: "shield", glyph: "D" },
  { id: "boost",  glyph: "B" }
];

/* one spawn per slot, all facing the centre of the arena */
const SPAWNS = [
  { x: 90,     y: H / 2,  a: 0 },
  { x: W - 90, y: H / 2,  a: Math.PI },
  { x: W / 2,  y: 70,     a: Math.PI / 2 },
  { x: W / 2,  y: H - 70, a: -Math.PI / 2 }
];

/* ---------------- utilities ---------------- */
function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
function rand(lo, hi) { return lo + Math.random() * (hi - lo); }
function dist2(ax, ay, bx, by) { const dx = ax - bx, dy = ay - by; return dx * dx + dy * dy; }
function angleDiff(a, b) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}
function circleRectHit(cx, cy, r, rect) {
  const nx = clamp(cx, rect.x, rect.x + rect.w);
  const ny = clamp(cy, rect.y, rect.y + rect.h);
  return dist2(cx, cy, nx, ny) < r * r;
}

/* ---------------- arenas (identical to the client) ---------------- */
function mirror180(r) { return { x: W - r.x - r.w, y: H - r.y - r.h, w: r.w, h: r.h }; }
function pair(list, r) { list.push(r); list.push(mirror180(r)); }

function buildArenas() {
  const arenas = [];
  let a = { name: "Open Ground", obstacles: [] };
  a.obstacles.push({ x: 430, y: 250, w: 100, h: 100 });
  pair(a.obstacles, { x: 200, y: 140, w: 150, h: 26 });
  pair(a.obstacles, { x: 120, y: 420, w: 26, h: 120 });
  arenas.push(a);

  a = { name: "The Bunkers", obstacles: [] };
  pair(a.obstacles, { x: 180, y: 120, w: 130, h: 26 });
  pair(a.obstacles, { x: 180, y: 120, w: 26, h: 110 });
  pair(a.obstacles, { x: 300, y: 440, w: 130, h: 26 });
  pair(a.obstacles, { x: 404, y: 356, w: 26, h: 110 });
  a.obstacles.push({ x: 444, y: 264, w: 72, h: 72 });
  arenas.push(a);

  a = { name: "The Maze", obstacles: [] };
  pair(a.obstacles, { x: 250, y: 60, w: 26, h: 170 });
  pair(a.obstacles, { x: 250, y: 300, w: 26, h: 120 });
  pair(a.obstacles, { x: 420, y: 60, w: 26, h: 110 });
  a.obstacles.push({ x: 400, y: 270, w: 160, h: 26 });
  pair(a.obstacles, { x: 560, y: 130, w: 110, h: 26 });
  arenas.push(a);

  a = { name: "Crossfire", obstacles: [] };
  a.obstacles.push({ x: 447, y: 200, w: 66, h: 200 });
  a.obstacles.push({ x: 380, y: 267, w: 200, h: 66 });
  pair(a.obstacles, { x: 190, y: 150, w: 56, h: 56 });
  pair(a.obstacles, { x: 190, y: 394, w: 56, h: 56 });
  arenas.push(a);
  return arenas;
}
const ARENAS = buildArenas();

const BORDER_RECTS = [
  { x: 0, y: 0, w: W, h: BORDER },
  { x: 0, y: H - BORDER, w: W, h: BORDER },
  { x: 0, y: 0, w: BORDER, h: H },
  { x: W - BORDER, y: 0, w: BORDER, h: H }
];

/* ---------------- rooms ---------------- */
const rooms = {};
let nextPlayerId = 1;

function makeCode() {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I or O
  let code = "";
  do {
    code = "";
    for (let i = 0; i < 4; i++) code += letters.charAt(Math.floor(Math.random() * letters.length));
  } while (rooms[code]);
  return code;
}

function makeRoom() {
  const room = {
    code: makeCode(),
    players: [],           // { id, ws, name, slot, host, input:{tu,th,f} }
    state: "lobby",        // lobby | playing | roundover | matchover
    modeKey: "classic",
    mode: MODES.classic,
    pointsToWin: 5,
    scores: [0, 0, 0, 0],
    tanks: [],
    bullets: [],
    mines: [],
    powerups: [],
    events: [],
    arenaIndex: 0,
    arena: ARENAS[0],
    roundNumber: 0,
    roundTime: 0,
    introTimer: 0,
    roundOverTimer: 0,
    matchOverTimer: 0,
    suddenDeath: false,
    powerupTimer: 0,
    nextId: 1
  };
  rooms[room.code] = room;
  return room;
}

function cleanName(name) {
  let n = String(name || "").replace(/[<>&"]/g, "").trim();
  if (n.length === 0) n = "Tank";
  return n.substr(0, 12);
}

function freeSlot(room) {
  for (let s = 0; s < MAX_PLAYERS; s++) {
    let taken = false;
    for (let i = 0; i < room.players.length; i++) if (room.players[i].slot === s) taken = true;
    if (!taken) return s;
  }
  return -1;
}

function addPlayer(room, ws, name) {
  const p = {
    id: nextPlayerId++,
    ws: ws,
    name: cleanName(name),
    slot: freeSlot(room),
    host: room.players.length === 0,
    pending: [],   // unprocessed movement commands from the client
    lastSeq: 0,    // last command sequence applied (acked in snapshots)
    budget: 0      // anti-speed-hack time budget in seconds
  };
  room.players.push(p);
  return p;
}

function playerBySlot(room, slot) {
  for (let i = 0; i < room.players.length; i++) {
    if (room.players[i].slot === slot) return room.players[i];
  }
  return null;
}

function playerName(room, slot) {
  for (let i = 0; i < room.players.length; i++) {
    if (room.players[i].slot === slot) return room.players[i].name;
  }
  return "Player " + (slot + 1);
}

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function broadcast(room, obj) {
  const str = JSON.stringify(obj);
  for (let i = 0; i < room.players.length; i++) {
    const ws = room.players[i].ws;
    if (ws && ws.readyState === 1) ws.send(str);
  }
}

function roster(room) {
  const list = [];
  for (let i = 0; i < room.players.length; i++) {
    const p = room.players[i];
    list.push({ slot: p.slot, name: p.name, host: p.host });
  }
  return list;
}

function sendRoomState(room) {
  for (let i = 0; i < room.players.length; i++) {
    const p = room.players[i];
    send(p.ws, {
      t: "room", v: PROTOCOL_VERSION, code: room.code, you: p.slot, host: p.host,
      players: roster(room), modeKey: room.modeKey,
      pts: room.pointsToWin, state: room.state
    });
  }
}

function bannerAll(room, txt, sec) {
  broadcast(room, { t: "banner", txt: txt, sec: sec });
}

/* ---------------- simulation ---------------- */
function solids(room) {
  return room.suddenDeath ? BORDER_RECTS : BORDER_RECTS.concat(room.arena.obstacles);
}

function tankCollides(room, x, y, self) {
  const rects = solids(room);
  for (let i = 0; i < rects.length; i++) {
    if (circleRectHit(x, y, TANK_R, rects[i])) return true;
  }
  for (let i = 0; i < room.tanks.length; i++) {
    const other = room.tanks[i];
    if (other === self || !other.alive) continue;
    if (dist2(x, y, other.x, other.y) < (TANK_R * 2) * (TANK_R * 2)) return true;
  }
  return false;
}

function makeTank(room, slot) {
  const sp = SPAWNS[slot];
  return {
    slot: slot,
    x: sp.x, y: sp.y, angle: sp.a,
    moveSpeed: 0,
    hp: room.mode.hp,
    alive: true,
    fireCooldown: 0,
    weapon: "basic",
    ammo: 0,
    shieldHP: 0, shieldTime: 0,
    boostTime: 0,
    visibleTimer: room.mode.invisible ? 1.6 : 0,
    flash: 0
  };
}

function nearestEnemy(room, tank) {
  let best = null, bestD = Infinity;
  for (let i = 0; i < room.tanks.length; i++) {
    const other = room.tanks[i];
    if (other.slot === tank.slot || !other.alive) continue;
    const d = dist2(tank.x, tank.y, other.x, other.y);
    if (d < bestD) { bestD = d; best = other; }
  }
  return best;
}

function shellsInFlight(room, slot) {
  let n = 0;
  for (let i = 0; i < room.bullets.length; i++) if (room.bullets[i].owner === slot) n++;
  return n;
}

function spawnBullet(room, tank, x, y, angle, homing) {
  room.bullets.push({
    id: room.nextId++,
    owner: tank.slot,
    x: x, y: y,
    vx: Math.cos(angle) * (homing ? 300 : BULLET_SPEED),
    vy: Math.sin(angle) * (homing ? 300 : BULLET_SPEED),
    homing: homing,
    bounces: homing ? 0 : room.mode.bounces,
    bounced: false,
    life: homing ? 4.5 : (room.mode.bounces > 0 ? 4.0 : 2.5)
  });
}

function fire(room, tank) {
  if (tank.fireCooldown > 0 || !tank.alive) return;
  if (room.mode.oneShell && shellsInFlight(room, tank.slot) > 0) return;

  const bx = tank.x + Math.cos(tank.angle) * (TANK_R + 10);
  const by = tank.y + Math.sin(tank.angle) * (TANK_R + 10);

  if (tank.weapon === "mine" && tank.ammo > 0) {
    room.mines.push({
      id: room.nextId++,
      x: tank.x - Math.cos(tank.angle) * (TANK_R + 22),
      y: tank.y - Math.sin(tank.angle) * (TANK_R + 22),
      owner: tank.slot, armTime: 1.0
    });
    tank.ammo--;
    tank.fireCooldown = 0.5;
    room.events.push({ e: "clink" });
  } else if (tank.weapon === "spread" && tank.ammo > 0) {
    for (let k = -1; k <= 1; k++) spawnBullet(room, tank, bx, by, tank.angle + k * 0.22, false);
    tank.ammo--;
    tank.fireCooldown = 0.55;
    room.events.push({ e: "fire", x: bx, y: by, a: tank.angle });
  } else if (tank.weapon === "rapid" && tank.ammo > 0) {
    spawnBullet(room, tank, bx, by, tank.angle + rand(-0.04, 0.04), false);
    tank.ammo--;
    tank.fireCooldown = 0.13;
    room.events.push({ e: "fire", x: bx, y: by, a: tank.angle });
  } else if (tank.weapon === "homing" && tank.ammo > 0) {
    spawnBullet(room, tank, bx, by, tank.angle, true);
    tank.ammo--;
    tank.fireCooldown = 0.8;
    room.events.push({ e: "missile", x: bx, y: by, a: tank.angle });
  } else {
    spawnBullet(room, tank, bx, by, tank.angle, false);
    tank.fireCooldown = room.mode.oneShell ? 0.25 : 0.45;
    room.events.push({ e: "fire", x: bx, y: by, a: tank.angle });
  }

  if (tank.ammo <= 0 && tank.weapon !== "basic") { tank.weapon = "basic"; tank.ammo = 0; }
  if (room.mode.invisible) tank.visibleTimer = Math.max(tank.visibleTimer, 1.2);
}

function explodeAt(room, x, y, radius, dmg, big) {
  room.events.push({ e: "boom", x: Math.round(x), y: Math.round(y), big: big ? 1 : 0 });
  if (dmg > 0) {
    for (let i = 0; i < room.tanks.length; i++) {
      const tk = room.tanks[i];
      if (!tk.alive) continue;
      if (dist2(tk.x, tk.y, x, y) < (radius + TANK_R) * (radius + TANK_R)) {
        damageTank(room, tk, dmg);
      }
    }
  }
}

function damageTank(room, tank, dmg) {
  if (!tank.alive) return;
  if (tank.shieldHP > 0) {
    tank.shieldHP -= dmg;
    tank.flash = 0.2;
    room.events.push({ e: "clink" });
    if (tank.shieldHP <= 0) { tank.shieldHP = 0; tank.shieldTime = 0; }
    return;
  }
  tank.hp -= dmg;
  tank.flash = 0.25;
  if (room.mode.invisible) tank.visibleTimer = Math.max(tank.visibleTimer, 1.0);
  if (tank.hp <= 0) {
    tank.alive = false;
    room.events.push({ e: "boom", x: Math.round(tank.x), y: Math.round(tank.y), big: 1 });
  } else {
    room.events.push({ e: "boom", x: Math.round(tank.x), y: Math.round(tank.y), big: 0 });
  }
}

function trySpawnPowerup(room) {
  if (room.powerups.length >= 3) return;
  for (let attempt = 0; attempt < 60; attempt++) {
    const x = rand(BORDER + 40, W - BORDER - 40);
    const y = rand(BORDER + 40, H - BORDER - 40);
    let ok = true;
    const rects = solids(room);
    for (let i = 0; i < rects.length; i++) {
      if (circleRectHit(x, y, 24, rects[i])) { ok = false; break; }
    }
    if (ok) {
      for (let i = 0; i < room.tanks.length; i++) {
        if (dist2(x, y, room.tanks[i].x, room.tanks[i].y) < 110 * 110) { ok = false; break; }
      }
    }
    if (ok) {
      for (let i = 0; i < room.powerups.length; i++) {
        if (dist2(x, y, room.powerups[i].x, room.powerups[i].y) < 90 * 90) { ok = false; break; }
      }
    }
    if (ok) {
      const def = POWERUPS[Math.floor(Math.random() * POWERUPS.length)];
      room.powerups.push({ id: room.nextId++, x: x, y: y, def: def, age: 0 });
      return;
    }
  }
}

function applyPowerup(room, tank, def) {
  room.events.push({ e: "pickup" });
  if (def.id === "shield")      { tank.shieldHP = 2; tank.shieldTime = 9; }
  else if (def.id === "boost")  { tank.boostTime = 6; }
  else if (def.id === "spread") { tank.weapon = "spread"; tank.ammo = 8; }
  else if (def.id === "rapid")  { tank.weapon = "rapid";  tank.ammo = 26; }
  else if (def.id === "homing") { tank.weapon = "homing"; tank.ammo = 3; }
  else if (def.id === "mine")   { tank.weapon = "mine";   tank.ammo = 3; }
}

/* ---------------- round / match flow ---------------- */
function startMatch(room) {
  room.scores = [0, 0, 0, 0];
  room.roundNumber = 0;
  room.arenaIndex = Math.floor(Math.random() * ARENAS.length);
  startRound(room);
}

function startRound(room) {
  room.roundNumber++;
  room.arena = ARENAS[(room.arenaIndex + room.roundNumber - 1) % ARENAS.length];
  room.bullets = [];
  room.mines = [];
  room.powerups = [];
  room.events = [];
  room.suddenDeath = false;
  room.roundTime = 0;
  room.powerupTimer = 2.5;
  room.introTimer = 1.5;
  room.tanks = [];
  for (let i = 0; i < room.players.length; i++) {
    room.tanks.push(makeTank(room, room.players[i].slot));
  }
  room.state = "playing";
  broadcast(room, {
    t: "round", n: room.roundNumber, arena: (room.arenaIndex + room.roundNumber - 1) % ARENAS.length,
    arenaName: room.arena.name, mode: room.modeKey, players: roster(room), scores: room.scores
  });
  bannerAll(room, "Round " + room.roundNumber + " · " + room.arena.name, 1.4);
}

function endRoundCheck(room) {
  if (room.tanks.length < 2) return; // solo practice never scores
  const alive = [];
  for (let i = 0; i < room.tanks.length; i++) if (room.tanks[i].alive) alive.push(room.tanks[i]);
  if (alive.length > 1) return;

  if (alive.length === 1) {
    room.scores[alive[0].slot]++;
    bannerAll(room, playerName(room, alive[0].slot) + " takes the round", 2.0);
  } else {
    bannerAll(room, "Mutual destruction — no point", 2.0);
  }
  room.state = "roundover";
  room.roundOverTimer = 2.3;
}

function checkMatchOver(room) {
  let bestSlot = -1, best = -1, tie = false;
  for (let s = 0; s < MAX_PLAYERS; s++) {
    if (room.scores[s] > best) { best = room.scores[s]; bestSlot = s; tie = false; }
    else if (room.scores[s] === best) tie = true;
  }
  if (best < room.pointsToWin || tie) return false;
  room.state = "matchover";
  room.matchOverTimer = 10;
  broadcast(room, {
    t: "match", winner: bestSlot, winnerName: playerName(room, bestSlot),
    scores: room.scores, players: roster(room), mode: room.mode.label
  });
  return true;
}

function toLobby(room) {
  room.state = "lobby";
  room.tanks = [];
  room.bullets = [];
  room.mines = [];
  room.powerups = [];
  broadcast(room, { t: "tolobby" });
  sendRoomState(room);
}

/* ---------------- per-tick updates ----------------
   Movement is command-driven for client-side prediction: each
   command carries its own duration and is applied exactly once,
   so the client can replay unacknowledged commands and land on
   the same result. A per-player time budget (topped up by real
   elapsed time) stops a hacked client sending extra seconds. */
function applyCommand(room, tank, cmd) {
  tank.angle += clamp(cmd.tu, -1, 1) * TANK_TURN * cmd.dt;

  const boost = tank.boostTime > 0 ? 1.45 : 1;
  const th = clamp(cmd.th, -1, 1);
  const speed = th >= 0 ? TANK_SPEED * th : TANK_REVERSE * th;
  tank.moveSpeed = speed * boost;

  const stepX = Math.cos(tank.angle) * tank.moveSpeed * cmd.dt;
  const stepY = Math.sin(tank.angle) * tank.moveSpeed * cmd.dt;
  let bumped = false;
  if (!tankCollides(room, tank.x + stepX, tank.y, tank)) tank.x += stepX; else bumped = true;
  if (!tankCollides(room, tank.x, tank.y + stepY, tank)) tank.y += stepY; else bumped = true;
  if (bumped && room.mode.invisible && Math.abs(tank.moveSpeed) > 10) {
    tank.visibleTimer = Math.max(tank.visibleTimer, 0.45);
  }

  if (cmd.f) fire(room, tank);
}

function updateTank(room, tank, dt) {
  if (!tank.alive) return;
  const p = playerBySlot(room, tank.slot);
  if (p) {
    p.budget = Math.min(0.3, p.budget + dt);
    while (p.pending.length > 40) { // runaway queue: drop but still ack
      p.lastSeq = p.pending.shift().seq;
    }
    while (p.pending.length > 0) {
      const cmd = p.pending[0];
      if (cmd.dt > p.budget) break; // out of budget - wait for real time
      p.pending.shift();
      p.budget -= cmd.dt;
      p.lastSeq = cmd.seq;
      if (room.introTimer <= 0) applyCommand(room, tank, cmd);
    }
  }

  if (tank.fireCooldown > 0) tank.fireCooldown -= dt;
  if (tank.flash > 0) tank.flash -= dt;
  if (tank.visibleTimer > 0) tank.visibleTimer -= dt;
  if (tank.boostTime > 0) tank.boostTime -= dt;
  if (tank.shieldTime > 0) { tank.shieldTime -= dt; if (tank.shieldTime <= 0) tank.shieldHP = 0; }
}

function updateBullets(room, dt) {
  const rects = solids(room);
  for (let i = room.bullets.length - 1; i >= 0; i--) {
    const b = room.bullets[i];
    b.life -= dt;
    if (b.life <= 0) { room.bullets.splice(i, 1); continue; }

    if (b.homing) {
      let target = null, bestD = Infinity;
      for (let t = 0; t < room.tanks.length; t++) {
        const tk = room.tanks[t];
        if (tk.slot === b.owner || !tk.alive) continue;
        const d = dist2(b.x, b.y, tk.x, tk.y);
        if (d < bestD) { bestD = d; target = tk; }
      }
      if (target) {
        const cur = Math.atan2(b.vy, b.vx);
        const want = Math.atan2(target.y - b.y, target.x - b.x);
        const d = angleDiff(cur, want);
        const maxTurn = 2.7 * dt;
        const na = cur + clamp(d, -maxTurn, maxTurn);
        const sp = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
        b.vx = Math.cos(na) * sp;
        b.vy = Math.sin(na) * sp;
      }
    }

    let removed = false;

    let nx = b.x + b.vx * dt;
    let hit = false;
    for (let r = 0; r < rects.length; r++) {
      if (circleRectHit(nx, b.y, BULLET_R, rects[r])) { hit = true; break; }
    }
    if (hit) {
      if (b.homing) { explodeAt(room, b.x, b.y, 42, 1, false); room.bullets.splice(i, 1); removed = true; }
      else if (b.bounces > 0) { b.vx = -b.vx; b.bounces--; b.bounced = true; room.events.push({ e: "bounce" }); }
      else { room.events.push({ e: "impact", x: Math.round(b.x), y: Math.round(b.y) }); room.bullets.splice(i, 1); removed = true; }
    } else b.x = nx;
    if (removed) continue;

    let ny = b.y + b.vy * dt;
    hit = false;
    for (let r = 0; r < rects.length; r++) {
      if (circleRectHit(b.x, ny, BULLET_R, rects[r])) { hit = true; break; }
    }
    if (hit) {
      if (b.homing) { explodeAt(room, b.x, b.y, 42, 1, false); room.bullets.splice(i, 1); removed = true; }
      else if (b.bounces > 0) { b.vy = -b.vy; b.bounces--; b.bounced = true; room.events.push({ e: "bounce" }); }
      else { room.events.push({ e: "impact", x: Math.round(b.x), y: Math.round(b.y) }); room.bullets.splice(i, 1); removed = true; }
    } else b.y = ny;
    if (removed) continue;

    for (let t = 0; t < room.tanks.length; t++) {
      const tk = room.tanks[t];
      if (!tk.alive) continue;
      const own = tk.slot === b.owner;
      if (own && !(room.mode.bounces > 0 && b.bounced)) continue;
      const rr = TANK_R + BULLET_R + (tk.shieldHP > 0 ? 8 : 0);
      if (dist2(b.x, b.y, tk.x, tk.y) < rr * rr) {
        if (b.homing) explodeAt(room, b.x, b.y, 42, 1, false);
        else damageTank(room, tk, 1);
        room.bullets.splice(i, 1);
        removed = true;
        break;
      }
    }
  }
}

function updateMines(room, dt) {
  for (let i = room.mines.length - 1; i >= 0; i--) {
    const m = room.mines[i];
    if (m.armTime > 0) { m.armTime -= dt; continue; }
    for (let t = 0; t < room.tanks.length; t++) {
      const tk = room.tanks[t];
      if (!tk.alive) continue;
      if (dist2(m.x, m.y, tk.x, tk.y) < (TANK_R + 14) * (TANK_R + 14)) {
        room.mines.splice(i, 1);
        explodeAt(room, m.x, m.y, 74, 2, true);
        break;
      }
    }
  }
}

function updatePowerups(room, dt) {
  if (!room.mode.powerups || room.state !== "playing") return;
  room.powerupTimer -= dt;
  if (room.powerupTimer <= 0) {
    room.powerupTimer = room.suddenDeath ? rand(3, 5) : rand(5.5, 8.5);
    trySpawnPowerup(room);
  }
  for (let i = room.powerups.length - 1; i >= 0; i--) {
    const p = room.powerups[i];
    p.age += dt;
    for (let t = 0; t < room.tanks.length; t++) {
      const tk = room.tanks[t];
      if (!tk.alive) continue;
      if (dist2(p.x, p.y, tk.x, tk.y) < (TANK_R + 16) * (TANK_R + 16)) {
        applyPowerup(room, tk, p.def);
        room.powerups.splice(i, 1);
        break;
      }
    }
  }
}

function tickRoom(room, dt) {
  if (room.state === "lobby") return;

  if (room.state === "matchover") {
    room.matchOverTimer -= dt;
    if (room.matchOverTimer <= 0) toLobby(room);
    return;
  }

  if (room.state === "roundover") {
    updateBullets(room, dt);
    room.roundOverTimer -= dt;
    if (room.roundOverTimer <= 0) {
      if (!checkMatchOver(room)) startRound(room);
    }
    return;
  }

  /* playing */
  if (room.introTimer > 0) room.introTimer -= dt;
  else {
    room.roundTime += dt;
    if (!room.suddenDeath && room.roundTime >= SUDDEN_DEATH_AT) {
      room.suddenDeath = true;
      bannerAll(room, "Sudden death · walls open", 1.8);
      room.events.push({ e: "boom", x: W / 2, y: H / 2, big: 0 });
    }
  }

  for (let i = 0; i < room.tanks.length; i++) updateTank(room, room.tanks[i], dt);
  updateBullets(room, dt);
  updateMines(room, dt);
  updatePowerups(room, dt);
  endRoundCheck(room);
}

/* ---------------- snapshots ---------------- */
function r1(v) { return Math.round(v * 10) / 10; }

function buildSnapshot(room) {
  const tk = [];
  for (let i = 0; i < room.tanks.length; i++) {
    const t = room.tanks[i];
    tk.push({
      s: t.slot, x: r1(t.x), y: r1(t.y), a: Math.round(t.angle * 1000) / 1000,
      hp: t.hp, al: t.alive ? 1 : 0,
      ack: (function () { const p = playerBySlot(room, t.slot); return p ? p.lastSeq : 0; })(),
      vis: room.mode.invisible ? Math.round(clamp(t.visibleTimer, 0, 1) * 100) / 100 : 1,
      sh: t.shieldHP, bo: t.boostTime > 0 ? 1 : 0, fl: t.flash > 0 ? 1 : 0,
      w: t.weapon, am: t.ammo
    });
  }
  const bl = [];
  for (let i = 0; i < room.bullets.length; i++) {
    const b = room.bullets[i];
    bl.push({ id: b.id, x: r1(b.x), y: r1(b.y), h: b.homing ? 1 : 0, o: b.owner });
  }
  const mn = [];
  for (let i = 0; i < room.mines.length; i++) {
    const m = room.mines[i];
    mn.push({ id: m.id, x: r1(m.x), y: r1(m.y), ar: m.armTime <= 0 ? 1 : 0 });
  }
  const pu = [];
  for (let i = 0; i < room.powerups.length; i++) {
    const p = room.powerups[i];
    pu.push({ id: p.id, x: r1(p.x), y: r1(p.y), g: p.def.glyph });
  }
  const snap = {
    t: "snap", st: room.state, rt: Math.round(room.roundTime),
    sd: room.suddenDeath ? 1 : 0, in: room.introTimer > 0 ? 1 : 0,
    tk: tk, bl: bl, mn: mn, pu: pu, sc: room.scores, ev: room.events
  };
  room.events = [];
  return snap;
}


/* ================================================================
   Binary snapshot protocol (v2)
   JSON stays for the rare control messages (lobby, round, match,
   banners). The 30 Hz hot path is hand-packed binary - roughly a
   tenth of the JSON size, which matters on the open internet.
   Layout (little-endian), mirrored by the decoder in the client:
   header: u8 type(1) - u8 state -
           u8 flags(bit0 sudden death, bit1 round intro) -
           u16 roundTime - u8 scores x4 -
           u8 counts: tanks, bullets, mines, powerups, events
   tank(14B):   u8 slot - u16 x*10 - u16 y*10 - u16 angle(0..2pi)
                u8 hp - u8 flags(alive|boost<<1|flash<<2|shield<<3)
                u8 vis*255 - u8 weapon - u8 ammo - u16 ack
   input:       u8 type(2) - u8 count - per command:
                u16 seq - i8 turn*100 - i8 throttle*100 - u8 fire -
                u8 duration in ms (1..50)
   bullet(7B):  u16 id - u16 x*10 - u16 y*10 - u8 (homing|owner<<1)
   mine(7B):    u16 id - u16 x*10 - u16 y*10 - u8 armed
   powerup(7B): u16 id - u16 x*10 - u16 y*10 - u8 glyph
   events:      u8 kind, then: boom u16 x, u16 y, u8 big -
                fire/missile u16 x, u16 y, u16 angle -
                impact u16 x, u16 y - others no payload
   ================================================================ */
const PROTOCOL_VERSION = 3;
const MSG_SNAPSHOT = 1;
const MSG_INPUT = 2;
const WEAPON_IDS = { basic: 0, spread: 1, rapid: 2, homing: 3, mine: 4 };
const GLYPH_IDS = { S: 0, R: 1, H: 2, M: 3, D: 4, B: 5 };
const EV_IDS = { boom: 1, fire: 2, missile: 3, impact: 4, bounce: 5, pickup: 6, clink: 7 };
const STATE_IDS = { playing: 0, roundover: 1, matchover: 2, lobby: 3 };
const scratch = Buffer.alloc(16384);

function angle16(a) {
  let n = a % (Math.PI * 2);
  if (n < 0) n += Math.PI * 2;
  return Math.round(n / (Math.PI * 2) * 65535) & 0xffff;
}
function coord16(v) { return Math.round(clamp(v, 0, 6553) * 10); }

function packSnapshot(snap) {
  let o = 0;
  scratch.writeUInt8(MSG_SNAPSHOT, o); o += 1;
  const st = STATE_IDS[snap.st];
  scratch.writeUInt8(st === undefined ? 0 : st, o); o += 1;
  scratch.writeUInt8((snap.sd ? 1 : 0) | (snap.in ? 2 : 0), o); o += 1;
  scratch.writeUInt16LE(Math.min(65535, snap.rt), o); o += 2;
  for (let i = 0; i < 4; i++) { scratch.writeUInt8(Math.min(255, snap.sc[i]), o); o += 1; }

  const evs = [];
  for (let i = 0; i < snap.ev.length; i++) {
    if (EV_IDS[snap.ev[i].e] && evs.length < 255) evs.push(snap.ev[i]);
  }
  const nBl = Math.min(255, snap.bl.length);
  scratch.writeUInt8(snap.tk.length, o); o += 1;
  scratch.writeUInt8(nBl, o); o += 1;
  scratch.writeUInt8(snap.mn.length, o); o += 1;
  scratch.writeUInt8(snap.pu.length, o); o += 1;
  scratch.writeUInt8(evs.length, o); o += 1;

  for (let i = 0; i < snap.tk.length; i++) {
    const t = snap.tk[i];
    scratch.writeUInt8(t.s, o); o += 1;
    scratch.writeUInt16LE(coord16(t.x), o); o += 2;
    scratch.writeUInt16LE(coord16(t.y), o); o += 2;
    scratch.writeUInt16LE(angle16(t.a), o); o += 2;
    scratch.writeUInt8(Math.max(0, Math.min(255, t.hp)), o); o += 1;
    const fl = (t.al ? 1 : 0) | (t.bo ? 2 : 0) | (t.fl ? 4 : 0) |
               (Math.min(3, Math.max(0, t.sh)) << 3);
    scratch.writeUInt8(fl, o); o += 1;
    scratch.writeUInt8(Math.round(clamp(t.vis, 0, 1) * 255), o); o += 1;
    scratch.writeUInt8(WEAPON_IDS[t.w] || 0, o); o += 1;
    scratch.writeUInt8(Math.min(255, t.am), o); o += 1;
    scratch.writeUInt16LE(t.ack & 0xffff, o); o += 2;
  }
  for (let i = 0; i < nBl; i++) {
    const b = snap.bl[i];
    scratch.writeUInt16LE(b.id & 0xffff, o); o += 2;
    scratch.writeUInt16LE(coord16(b.x), o); o += 2;
    scratch.writeUInt16LE(coord16(b.y), o); o += 2;
    scratch.writeUInt8((b.h ? 1 : 0) | (b.o << 1), o); o += 1;
  }
  for (let i = 0; i < snap.mn.length; i++) {
    const m = snap.mn[i];
    scratch.writeUInt16LE(m.id & 0xffff, o); o += 2;
    scratch.writeUInt16LE(coord16(m.x), o); o += 2;
    scratch.writeUInt16LE(coord16(m.y), o); o += 2;
    scratch.writeUInt8(m.ar, o); o += 1;
  }
  for (let i = 0; i < snap.pu.length; i++) {
    const p = snap.pu[i];
    scratch.writeUInt16LE(p.id & 0xffff, o); o += 2;
    scratch.writeUInt16LE(coord16(p.x), o); o += 2;
    scratch.writeUInt16LE(coord16(p.y), o); o += 2;
    scratch.writeUInt8(GLYPH_IDS[p.g] || 0, o); o += 1;
  }
  for (let i = 0; i < evs.length; i++) {
    const ev = evs[i];
    scratch.writeUInt8(EV_IDS[ev.e], o); o += 1;
    if (ev.e === "boom") {
      scratch.writeUInt16LE(Math.max(0, Math.min(65535, ev.x)), o); o += 2;
      scratch.writeUInt16LE(Math.max(0, Math.min(65535, ev.y)), o); o += 2;
      scratch.writeUInt8(ev.big ? 1 : 0, o); o += 1;
    } else if (ev.e === "fire" || ev.e === "missile") {
      scratch.writeUInt16LE(Math.max(0, Math.min(65535, Math.round(ev.x))), o); o += 2;
      scratch.writeUInt16LE(Math.max(0, Math.min(65535, Math.round(ev.y))), o); o += 2;
      scratch.writeUInt16LE(angle16(ev.a), o); o += 2;
    } else if (ev.e === "impact") {
      scratch.writeUInt16LE(Math.max(0, Math.min(65535, ev.x)), o); o += 2;
      scratch.writeUInt16LE(Math.max(0, Math.min(65535, ev.y)), o); o += 2;
    }
  }
  return Buffer.from(scratch.subarray(0, o));
}

function broadcastBuf(room, buf) {
  for (let i = 0; i < room.players.length; i++) {
    const ws = room.players[i].ws;
    if (ws && ws.readyState === 1) ws.send(buf);
  }
}

/* ---------------- master loop: 60 Hz sim, 30 Hz snapshots ---------------- */
let tickCount = 0;
let lastTick = Date.now();

function masterTick() {
  const now = Date.now();
  const dt = Math.min(0.05, (now - lastTick) / 1000);
  lastTick = now;
  tickCount++;
  const codes = Object.keys(rooms);
  for (let i = 0; i < codes.length; i++) {
    const room = rooms[codes[i]];
    tickRoom(room, dt);
    if (tickCount % 2 === 0 && room.state !== "lobby") {
      broadcastBuf(room, packSnapshot(buildSnapshot(room)));
    }
  }
}
const loopHandle = setInterval(masterTick, 1000 / 60);
loopHandle.unref();

/* ---------------- socket protocol ---------------- */
wss.on("connection", function (ws) {
  ws.roomCode = null;
  ws.playerId = null;

  ws.on("message", function (raw, isBinary) {
    const room = ws.roomCode ? rooms[ws.roomCode] : null;
    let me = null;
    if (room) {
      for (let i = 0; i < room.players.length; i++) {
        if (room.players[i].id === ws.playerId) me = room.players[i];
      }
    }

    /* hot path: batched binary movement commands */
    if (isBinary) {
      if (room && me && raw.length >= 2 && raw.readUInt8(0) === MSG_INPUT) {
        const n = Math.min(raw.readUInt8(1), 8);
        let off = 2;
        for (let i = 0; i < n && off + 6 <= raw.length; i++) {
          me.pending.push({
            seq: raw.readUInt16LE(off),
            tu: clamp(raw.readInt8(off + 2) / 100, -1, 1),
            th: clamp(raw.readInt8(off + 3) / 100, -1, 1),
            f: raw.readUInt8(off + 4) === 1,
            dt: Math.max(1, Math.min(50, raw.readUInt8(off + 5))) / 1000
          });
          off += 6;
        }
      }
      return;
    }

    let msg = null;
    try { msg = JSON.parse(raw); } catch (err) { return; }
    if (!msg || typeof msg.t !== "string") return;

    if (msg.t === "create" && !room) {
      const newRoom = makeRoom();
      const p = addPlayer(newRoom, ws, msg.name);
      ws.roomCode = newRoom.code;
      ws.playerId = p.id;
      sendRoomState(newRoom);

    } else if (msg.t === "join" && !room) {
      const code = String(msg.code || "").toUpperCase().trim();
      const target = rooms[code];
      if (!target) { send(ws, { t: "error", msg: "No room with code " + code }); return; }
      if (target.state !== "lobby") { send(ws, { t: "error", msg: "That match is in progress — try again shortly" }); return; }
      if (target.players.length >= MAX_PLAYERS) { send(ws, { t: "error", msg: "Room " + code + " is full (4 players)" }); return; }
      const p = addPlayer(target, ws, msg.name);
      ws.roomCode = target.code;
      ws.playerId = p.id;
      sendRoomState(target);

    } else if (msg.t === "setup" && room && me && me.host && room.state === "lobby") {
      if (MODES[msg.modeKey]) { room.modeKey = msg.modeKey; room.mode = MODES[msg.modeKey]; }
      const pts = Number(msg.pts);
      if (pts === 3 || pts === 5 || pts === 10) room.pointsToWin = pts;
      sendRoomState(room);

    } else if (msg.t === "start" && room && me && me.host && room.state === "lobby") {
      if (room.players.length < 1) return;
      startMatch(room);

    } else if (msg.t === "lobby" && room && me && me.host && room.state === "matchover") {
      toLobby(room);
    }
  });

  ws.on("close", function () {
    const room = ws.roomCode ? rooms[ws.roomCode] : null;
    if (!room) return;
    let leaver = null;
    for (let i = room.players.length - 1; i >= 0; i--) {
      if (room.players[i].id === ws.playerId) {
        leaver = room.players[i];
        room.players.splice(i, 1);
      }
    }
    if (!leaver) return;

    if (room.players.length === 0) {
      delete rooms[room.code];
      return;
    }
    // promote a new host if needed
    let hasHost = false;
    for (let i = 0; i < room.players.length; i++) if (room.players[i].host) hasHost = true;
    if (!hasHost) room.players[0].host = true;

    if (room.state === "lobby") {
      sendRoomState(room);
    } else {
      // their tank explodes; the round resolves naturally
      for (let i = 0; i < room.tanks.length; i++) {
        const tk = room.tanks[i];
        if (tk.slot === leaver.slot && tk.alive) {
          tk.alive = false;
          room.events.push({ e: "boom", x: Math.round(tk.x), y: Math.round(tk.y), big: 1 });
        }
      }
      bannerAll(room, leaver.name + " disconnected", 1.6);
      sendRoomState(room);
      if (room.players.length < 2 && room.state !== "matchover") {
        bannerAll(room, "Not enough players — returning to the waiting room", 2.0);
        setTimeout(function () {
          if (rooms[room.code] && room.players.length >= 1) toLobby(room);
        }, 2200);
      }
    }
  });
});

/* ---------------- start ---------------- */
const PORT = process.env.PORT || 3000;

function start(port, cb) {
  server.listen(port, function () {
    console.log("Combat: Redux network server running");
    console.log("  Local:   http://localhost:" + port);
    console.log("  Network: http://<this-machine's-IP>:" + port + "  (share this on your LAN)");
    if (cb) cb();
  });
}

if (require.main === module) start(PORT);

/* exports for testing */
module.exports = {
  start: start,
  server: server,
  _test: {
    rooms: rooms, makeRoom: makeRoom, addPlayer: addPlayer, MODES: MODES,
    startMatch: startMatch, tickRoom: tickRoom, buildSnapshot: buildSnapshot,
    trySpawnPowerup: trySpawnPowerup, applyPowerup: applyPowerup, POWERUPS: POWERUPS,
    fire: fire, damageTank: damageTank, ARENAS: ARENAS, W: W, H: H,
    packSnapshot: packSnapshot, PROTOCOL_VERSION: PROTOCOL_VERSION
  }
};
