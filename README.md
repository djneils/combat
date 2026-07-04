# Combat: Redux — Network Edition

A network-multiplayer reinterpretation of Atari's *Combat* (1977).
Up to **4 players**, each on their own machine, with a waiting-room lobby.

## Quick start

```
npm install
npm start
```

Then open **http://localhost:3000** in a browser.

To play across a LAN (e.g. a classroom), other players browse to
`http://<host-machine-IP>:3000` — find your IP with `ipconfig` (Windows)
or `ip a` (Linux/Mac). Allow Node through the firewall if prompted.
`PORT=4000 npm start` changes the port.

## How to play

1. One player enters a name and clicks **Create room** — they get a 4-letter code and become host.
2. Up to three more players enter the code and click **Join**.
3. The host picks a mode (Classic 1977 / Ricochet / Invisible / Arsenal)
   and the points target, then starts the match.
4. Rounds are last-tank-standing; the survivor scores. First to the target wins.
   Sudden death opens the arena walls at 60 seconds.

**Controls (each player):** W/A/S/D *or* arrow keys to drive and turn,
**F** or **Space** to fire. A connected gamepad also works
(left stick or d-pad, **A** or right trigger to fire). **M** mutes.

**Camera views (in play):** **1** classic top-down · **2** battlefield ·
**3** orbit · **4** chase camera behind your own tank (spectates a surviving
tank once you're destroyed) · **V** cycles. The 3D views are a hand-rolled
perspective projection of the same top-down state — no libraries.

## Architecture (for the curious / for teaching)

- `server.js` — the **authoritative simulation**. The whole game runs here at
  60 Hz; clients cannot cheat because they only ever send *inputs*
  (turn, throttle, fire). Snapshots go out at 30 Hz over plain WebSockets
  (the `ws` package — no client library needed).
- **Binary protocol (v3)**: the 30 Hz hot path is hand-packed binary rather
  than JSON — a typical 4-player snapshot is ~80–120 bytes instead of ~1 KB
  (7–10× smaller), and inputs are 6-byte commands sent in small batches. That
  keeps bandwidth around 3 KB/s per player, which holds up on the open
  internet. Rare control messages (lobby, round, match results, banners) stay
  as JSON for readability. The byte layout is documented at the top of the
  encoder in `server.js` and mirrored by the marked decoder block in the
  client; a version byte in the room handshake catches stale cached clients.
- **Client-side prediction & reconciliation**: your own tank's movement runs
  locally, so controls feel instant regardless of latency. Every frame becomes
  a command `{seq, turn, throttle, fire, dt}` that is applied to a local
  predicted state and sent to the server; the server applies each command
  exactly once (a per-player time budget stops speed hacks and sheds stale
  backlogs after long stalls) and acknowledges the last sequence in each
  snapshot. On every snapshot the client replays its unacknowledged commands
  on top of the authoritative state and folds any difference into a visual
  offset that decays over ~0.3 s, so corrections are invisible. Movement is
  quantised to the wire format before simulation, making client and server
  arithmetic identical — the test suite proves they land on the same spot to
  within 1e-6. Firing and all combat remain fully server-authoritative.
- `public/index.html` — the client. It buffers snapshots and renders an
  **interpolated view 120 ms in the past**, lerping tank positions/angles and
  matching bullets by id, so movement looks smooth despite 30 Hz updates.
  Cosmetics (particles, tread marks, screen shake, sound) are generated
  locally from a small event stream (`boom`, `fire`, `bounce`, `pickup`…),
  delayed by the same 120 ms so effects line up with what's on screen.
- Rooms are 4-letter codes; the first player is host and can be re-elected
  if they disconnect. Disconnecting mid-round destroys your tank.

No databases, no build step, two dependencies (`express`, `ws`).

## Publishing on the internet

Any Node host works (a small VPS, Render, Railway, Fly.io…). The server
respects the `PORT` environment variable. Put it behind HTTPS (the client
automatically switches to `wss://` on secure pages) and make sure the host
supports WebSockets. One Node process comfortably runs many rooms.

## Tests

- `node test-sim.js` — synchronous unit tests of the simulation
- `node test-proto.js` — binary encode/decode round trip (uses the exact
  decoder shipped in the client)
- `node test-net.js` — end-to-end over real sockets: lobby, rejections,
  binary inputs moving tanks, disconnects
- `node smoke-client.js` — runs the shipped client against a stubbed DOM,
  renders all four views from genuine binary snapshots, verifies prediction
  generates well-formed command batches, and proves the client's predicted
  movement is bit-for-bit identical to the server's
