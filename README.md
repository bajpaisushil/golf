# 🏌️ Friend Golf

Multiplayer mini golf you play with friends in a browser. Open the site, pick a mode, share a
six-character room code, putt. No account, no install, no server.

**Play it: https://golf-flax-six.vercel.app**

Gameplay traffic is **peer-to-peer over WebRTC DataChannels**. There is no backend, no database and no
game server — the whole app is static files.

---

## Quick start

```bash
npm install
npm run dev        # http://localhost:3000
```

| Script | What it does |
| --- | --- |
| `npm run dev` | Dev server |
| `npm run build` | Production build + static export into `out/` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Vitest suite (physics determinism, protocol, scoring, host election) |
| `npm run serve:static` | Serve the exported `out/` on :4000, exactly as production runs |

---

## Playing locally with several players

Two browser tabs on the same machine connect **instantly and completely offline**. The signalling layer
runs a `BroadcastChannel` adapter alongside the network one, and same-browser tabs find each other
through it without touching the internet.

1. `npm run build && npm run serve:static`
2. Tab A → open `http://localhost:4000` → choose a mode → you land in a room with a code.
3. Tab B → `http://localhost:4000/room/?code=XXXXXX` → Join the room.
4. Tab A (the host) presses **Start**.

Add more tabs for 3–8 players. To test **host migration**, close the host's tab: the remaining peers
deterministically elect the earliest joiner and play continues.

Across real devices, deploy (below) and open the URL on each phone — that path uses the public
signalling relays instead of `BroadcastChannel`.

### Automated browser tests

```bash
npm run build && npm run serve:static      # in one terminal
node e2e/play.mjs                          # two tabs create + join a room
node e2e/shot.mjs                          # putts, asserts the stroke syncs to the peer
node e2e/drag.mjs                          # drags from mid-course, checks aim feedback + shot
URL=https://golf-flax-six.vercel.app node e2e/live.mjs
```

All drive real Chromium via Playwright and screenshot each stage.

`live.mjs` is the important one: it uses two **separate browser profiles**, which do not share a
`BroadcastChannel`, so the handshake is forced through the public Nostr relays — the same path two
people on different devices take. Last run connected in ~13s and synced a putt between peers.

---

## Infrastructure

### Required

- **Static file hosting.** Anything that serves a folder.
- **Free public STUN** to discover each peer's address. Google's public STUN servers are used by default.
- **A free public signalling relay** to exchange the initial WebRTC handshake. Several public Nostr
  relays are used at once; if any one of them is reachable, joining works.

That is the entire list. Nothing is paid, nothing needs an account, nothing stores your data.

### Optional

- `NEXT_PUBLIC_SIGNALING_RELAYS` — use your own relays instead of the public ones.
- `NEXT_PUBLIC_STUN_URLS` — additional STUN servers.
- Graphics quality override (the game auto-detects a tier from the device).

### Future — deliberately NOT part of this MVP

- **TURN relay.** Roughly 5–10% of users behind symmetric NAT cannot establish a direct peer connection.
  Fixing that requires a TURN server, which costs money, so it is left unconfigured. The code reads
  `NEXT_PUBLIC_TURN_URL` if you ever set it, and ignores TURN entirely when unset.
- **A dedicated authoritative server**, if the game ever outgrows trusting the host.
- **Persistence** of any kind — profiles, history, leaderboards.

None of these are needed to play, and none are wired in.

---

## Deploying free

The build emits a plain static site into `out/` (`output: 'export'`), so every provider below runs it on
a free tier with no server runtime and no serverless functions.

**Vercel** — `vercel.json` is committed. Import the repo at [vercel.com/new](https://vercel.com/new) and
deploy; no settings to change. Or `npx vercel --prod`.

**Netlify** — build `npm run build`, publish directory `out`.

**Cloudflare Pages** — build `npm run build`, output directory `out`.

**GitHub Pages** — push `out/` to a `gh-pages` branch. For a *project* site served from
`/<repo>/`, set `basePath` and `assetPrefix` to `'/<repo>'` in `next.config.mjs` first, or asset URLs
will 404.

---

## Changing the scoring

Everything lives in one object: `SCORING` in [`src/game/config.ts`](src/game/config.ts).

Competitive rounds award **placement points** (1st = 3, 2nd = 2, 3rd = 1, with a flatter two-player
table) **plus hit-efficiency points, where fewer hits always scores higher**:

```
efficiencyPoints = max(min, base − (strokes − par) × perStrokeOverPar)
```

with a bonus for beating par. A unit test asserts this is strictly decreasing in stroke count, so the
"fewer hits wins" rule cannot regress silently.

---

## Known limitations

Stated plainly, because they are real:

- **The host is trusted. This is not cheat-proof.** One peer holds the canonical state and validates
  events. A determined player could modify their client. That is an accepted trade-off for a game you
  play with friends; see `docs/ARCHITECTURE.md` for the seam where a real server would slot in.
- **No TURN means some people cannot connect.** Symmetric NAT (some corporate and mobile networks)
  breaks direct peer connections. Affected users see a connection failure.
- **Public signalling relays are best-effort.** They go down and rate-limit. Joining resolves as soon as
  the first relay responds and the others keep trying in the background, but a bad relay day means a
  slower join.
- **Eight players is the practical ceiling.** The mesh is full — every peer connects to every other.
- **Nothing persists.** Close the tab and the game is gone. That is by design.
- **A shot in flight during host migration can be lost.** The new host's snapshot is authoritative, so an
  unconfirmed stroke may need retaking.

---

## Privacy

- No account, no email, no analytics, no tracking, no cookies.
- Game state lives in memory. `sessionStorage` holds a per-tab reconnect identity (a random id, your
  display name and the room code); `localStorage` holds preferences (sound, haptics, quality, last name).
  Both are wiped by clearing site data and neither leaves your browser.
- Signalling payloads are encrypted with a key derived from the room code, so relays do not see your SDP
  or local IPs in the clear. **Caveat:** a six-character room code is low entropy — this is casual
  privacy, not security. Anyone who has your room code can join your game.

---

## Architecture

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full picture: the deterministic-simulation /
3D-presentation split, the lockstep replay protocol, host authority and migration, the signalling seam,
and the migration path to a dedicated server.
