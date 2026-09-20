# Architecture

How Friend Golf runs a synchronised multiplayer game with no server of any kind.

---

## 1. Overview: three layers that do not know about each other

```
┌──────────────────────────────────────────────┐
│ UI                src/components, src/app    │  React 19 + framer-motion
├──────────────────────────────────────────────┤
│ GAME ENGINE       src/game, src/state        │  deterministic, pure, no network
├──────────────────────────────────────────────┤
│ MULTIPLAYER       src/multiplayer            │  game-agnostic transport
└──────────────────────────────────────────────┘
```

The **multiplayer layer moves opaque payloads and knows nothing about golf.** It handles peer
connections, signalling, sequence numbers, membership and host election. To reuse it in another game you
take `src/multiplayer/**` plus `src/types/multiplayer.ts` and swap the message union in
`protocol/messages.ts` — nothing else in that folder mentions balls, holes or strokes.

The **game engine is pure**: `simulateShot()` and `generateLevel()` are functions with no clock, no
randomness and no I/O, and `gameReducer` is a pure `(state, message) → state`. That purity is what makes
the whole multiplayer model testable headlessly — the network tests run in Node with no browser.

The **UI only reads state and emits intents.**

---

## 2. Folder structure

```
src/
  app/                     Next.js routes. `/` (home) and `/room` (query-param room code).
  components/
    ui/                    Button, Dialog, Toast, … design system
    home/  lobby/  game/   screen-level components
    brand/                 original procedural logo
  game/
    config.ts              ★ EVERY tunable: physics, scoring, limits, timing, tiers
    physics/               vec, collision, simulate — pure, deterministic
    levels/                prng, generator, themes — pure, deterministic
    rules/                 scoring, friendship (co-op), competitive
    rendering/
      three/               3D presentation (lazy-loaded)
      mini/                cheap 2D canvas boards for opponents
      quality.ts           device tier detection
    input/                 useAimControls — pointer + touch slingshot
  modes/                   friendship / competitive descriptors
  multiplayer/
    webrtc/                iceConfig, peerLink (1 connection), mesh (N connections)
    signaling/             the swappable seam: nostr, broadcastChannel, composite, manual
    protocol/              messages (wire union), codec, sequencer, version
    room/                  roomSession, hostElection, heartbeat
    transport/             loopback transport with fault injection, for tests
  state/                   gameReducer (pure), store (zustand), useGameSession (React binding)
  types/                   shared type contracts
  utils/                   names, roomCode, share, resultImage, storage, sound, haptics
```

---

## 3. Key design decisions

### Deterministic 2D simulation, 3D presentation

Gameplay is simulated on a flat 2D plane in "course units". three.js renders that state but never
influences it. This buys two things at once: a premium 3D look, and a simulation cheap and deterministic
enough to replay identically on every peer.

**Physics and level generation use only `+ − × ÷` and `sqrt`.** No `Math.sin`, `Math.cos`, `Math.atan2`,
`Math.random`, `Date.now` or `performance.now`. Trig is not bit-identical across JS engines, so a single
`Math.cos` in the simulation would desync players on different browsers. Aim is stored as a normalised
vector, never an angle. A test greps these files and fails the build if a banned call appears.

### The room code *is* the seed

`roomSeedFromCode("AB7K9P")` → a uint32. Levels come from `generateLevel(seed, roundIndex, variantIndex)`.
Every peer generates byte-identical courses from the code alone, so **no level data is ever transmitted
and there is no level database.** In Friend Battle each player's `variantIndex` gives them their own
course from the same seed.

### Full mesh transport, host authority on top

Transport is a full mesh — every peer connects to every other (≤8 players, 28 connections). Host
authority is a *logic* layer above it. A star topology would have been simpler, but host migration would
then require rebuilding every connection. With a mesh, the survivors are already connected.

### Opponents render in 2D

In Friend Battle your own course is three.js; the other seven are lightweight 2D canvas `MiniBoard`s.
Eight WebGL scenes would destroy frame rate on a phone for information that only needs to be glanceable.

---

## 4. The WebRTC protocol

One reliable, ordered DataChannel per peer. Every message carries a common envelope:

```ts
{ v: PROTOCOL_VERSION, seq: number, from: PlayerId, ts: number, type: ... }
```

| Message | Sender | Receivers must |
| --- | --- | --- |
| `HELLO` | joiner | host admits them and replies `WELCOME`; others note the peer |
| `WELCOME` | host only | adopt the full state snapshot; may carry a rejection + reason |
| `PLAYER_JOINED` / `PLAYER_LEFT` | host | update the roster |
| `PLAYER_SHOT` | the shooting player | replay the shot locally from the input |
| `SHOT_RESOLVED` | host | overwrite with the authoritative resting position |
| `PLAYER_REACHED_GOAL` | host | record hole-out order |
| `ROUND_STARTED` / `ROUND_COMPLETED` | host | advance round; ignore if stale |
| `SETTINGS_CHANGED` | host | apply settings |
| `GAME_ENDED` | host | show final results |
| `HOST_CHANGED` | new host | accept only if its election term is newer |
| `STATE_SYNC` | host | converge to the snapshot |
| `REQUEST_STATE` | any peer | host replies with a snapshot (rate-limited) |
| `HEARTBEAT` | host | refresh host-liveness watchdog |
| `PING` / `PONG` | any | measure link quality |

`codec.ts` validates on decode — unknown type, wrong protocol version or a malformed body returns an
error rather than throwing. Nothing off the wire is trusted.

---

## 5. State synchronisation: lockstep input replay

**Positions are never streamed.** A shot is broadcast as its *input*:

```ts
{ type: 'PLAYER_SHOT', roundIndex, strokeNumber, aim: {x,y}, power, seq }
```

Around 80 bytes, once per shot. Every peer feeds that input into the same deterministic `simulateShot()`
and animates the identical trajectory. The host then sends `SHOT_RESOLVED` with the authoritative
resting position to repair any drift.

Three independent guards make this converge:

1. **`sequencer.ts`** — a per-sender sliding window. Every inbound message is `accept`, `duplicate` or
   `stale`. A duplicate is dropped; an out-of-order frame is never re-applied.
2. **The reducer is idempotent.** Applying the same message twice is a no-op, and transitions are guarded
   on `roundIndex` / `strokeNumber`, so a late `ROUND_STARTED` cannot reopen a finished round. Tested.
3. **`STATE_SYNC` snapshots.** Periodically during play the host broadcasts the full state, so any peer
   that diverged converges without a reload.

---

## 6. Host authority — and why it is not cheat-proof

The room creator is host. The host starts rounds, validates shot events, decides round transitions and
ends the game. Guests apply host decisions.

**This is explicitly not secure.** The host runs on a player's machine. A determined player could patch
their client to award themselves points, and nothing here would stop them. For a game you play with
friends over a shared room code, that is an acceptable trade-off, and it is the reason there is no cost
to run this.

**The seam for a real server:** a dedicated server replaces the host by becoming a peer that is always
elected — it speaks the exact same message union. `roomSession.ts` already routes every authoritative
decision through `isHostNow()`. No protocol change is required; see §11.

---

## 7. How the no-server architecture works end to end

```
Player A                         Player B
   │ create room (code = seed)      │
   │ ── code shared out of band ──▶ │
   │                                │
   │ ◀── signalling relay (SDP/ICE) ─┤   free, public, ephemeral
   │                                │
   ├══════ WebRTC DataChannel ══════┤   all gameplay, direct P2P
```

The site is static files. Both players generate the same courses from the room code. The relay is used
only for the handshake and never sees gameplay. After connection, the relay could vanish entirely and the
game would continue.

---

## 8. Signalling

Peers need to exchange SDP offers/answers and ICE candidates *before* a direct connection exists. That
is the one thing a pure browser-to-browser app cannot do alone, so it is isolated behind a single
interface in `signaling/types.ts`:

```ts
interface SignalingChannel {
  open(room, self): Promise<Result<void, string>>
  publish(envelope): Promise<Result<void, string>>
  onEnvelope(cb): Unsubscribe
  status: SignalingStatus
  close(): void
}
```

Four implementations ship:

- **`nostrSignaling`** (default network path) — connects to several free public Nostr relays at once
  using *ephemeral* event kinds, which relays do not store. Publishes to all, subscribes to all,
  dedupes by event id. A throwaway keypair is generated per session and never persisted.
- **`broadcastChannelSignaling`** — same-browser tabs. Instant, offline, and what makes local multi-tab
  testing pleasant.
- **`compositeSignaling`** — runs several channels at once and dedupes.
- **`manualSignaling`** — copy/paste the handshake by hand. Zero infrastructure at all.

The default is `composite([broadcastChannel, nostr])`.

> **Implementation note worth keeping.** `composite.open()` resolves as soon as the **first** backend is
> usable and lets the slower ones finish in the background. It must never be `Promise.all`/`allSettled`:
> a public relay that accepts a TCP connection and then never completes the WebSocket handshake would
> otherwise hang the join forever, even though `BroadcastChannel` was ready in a millisecond. This was a
> real bug — it made joining a room silently impossible whenever a relay was having a bad day.

Signalling payloads are AES-GCM encrypted with a key derived from the room code, so relays never see raw
SDP or local IPs. A six-character code is low entropy, so treat this as privacy, not security.

**Swapping relays:** implement `SignalingChannel` and pass it to the composite. Nothing else changes.

---

## 9. Host disconnect and migration

1. The host broadcasts `HEARTBEAT` on a timer.
2. Every peer runs a watchdog on last-seen-host. Silence past `TIMING.HOST_TIMEOUT_MS` triggers an
   election.
3. **`electHost(players)` is pure and order-independent**: among connected players, lowest `joinSeq`
   wins, ties broken by comparing ids. Every peer computes the *same* answer with no messages exchanged,
   which is what prevents split-brain. This is unit-tested against shuffled rosters.
4. The winner claims the seat, broadcasts `HOST_CHANGED` with an incrementing election term, and follows
   with a `STATE_SYNC` snapshot. A stale `HOST_CHANGED` with an older term is rejected.

A guest that has not yet been welcomed never runs an election — a peer that was never admitted must not
crown itself host of a room it is not in.

**Known gap:** the new host's snapshot is authoritative, so a shot in flight at the instant of migration
can be lost and may need retaking.

---

## 10. Testing

Unit tests run in Node with no browser (`npm test`):

- **Determinism** — identical shots produce byte-identical results, survive a JSON round trip, the ball
  can never escape the course under fuzzing, simulation always terminates, no NaN ever, and a source
  grep proves no banned non-deterministic call reached the replay path.
- **Levels** — same seed → identical course; different players → different courses; every generated
  course is playable with a clear route.
- **Protocol** — duplicates rejected, stale frames rejected, per-peer windows independent, a flood of
  50×20 duplicates accepts exactly 20.
- **Host election** — order-independent, skips disconnected players, exactly one claimant.
- **Scoring** — hit-efficiency is strictly decreasing in strokes; co-op mode returns a single shared rank
  so no winner can be rendered.

`multiplayer/transport/loopback.ts` is an in-memory transport with configurable latency, jitter,
duplication, reordering, drops and partitions, driven by an injectable clock — so multi-peer scenarios
run deterministically with no real timers.

Browser-level checks live in `e2e/` and drive real Chromium (see README).

---

## 11. Migration path to a dedicated server

Staged so nothing has to be rewritten:

**Stage 1 — keep P2P, add TURN.** Set `NEXT_PUBLIC_TURN_URL`. Fixes symmetric-NAT users. No code change.

**Stage 2 — a headless authoritative peer.** Run the existing `roomSession` in Node with a transport that
speaks WebSocket instead of WebRTC. Force it to win elections by giving it `joinSeq = -1`. It speaks the
same message union, so **clients need no change at all** and cheating becomes impossible because the
authority no longer runs on a player's machine.

**Stage 3 — server-side simulation.** The server already has `simulateShot()`; it is pure and has no
browser dependency. Have it re-simulate every `PLAYER_SHOT` and treat `SHOT_RESOLVED` as the only truth.

**Stage 4 — persistence.** Only now does a database make sense. The reducer's state snapshot is already a
serialisable value.

Each stage is independently shippable, and stage 1 costs nothing until you need it.
