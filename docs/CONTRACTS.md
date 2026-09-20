# Friend Golf — Module Contracts

**This file is authoritative.** Every agent implements exactly these signatures. If something here
is wrong, implement the sensible thing and note it in your report — do not edit another agent's files.

## Golden rules (apply everywhere)

1. **Simulation is deterministic 2D. Rendering is 3D presentation that only READS state.**
2. Inside `src/game/physics/**` and `src/game/levels/**` the ONLY maths allowed is
   `+ - * /`, `Math.sqrt`, `Math.abs`, `Math.min`, `Math.max`, `Math.floor`
   (plus integer bitwise ops and `Math.imul` **in `levels/prng.ts` only** — they are exact).
   **Never** `Math.random`, `Math.sin/cos/tan/atan2`, `Date.now()`, `performance.now()`.
   Aim is always a **normalised {x,y} vector**, never an angle.
3. Renderer, UI, network timing may freely use trig / random / `Date.now` — presentation only.
4. Everything imports shared types from `@/types` and every tunable from `@/game/config`.
   No magic numbers anywhere else.
5. Static export: no server, no API routes, no `fs`, no Node built-ins in app code.
6. Anything touching `window`, `document`, `navigator`, `RTCPeerConnection`, `crypto.subtle`
   must be guarded (`typeof window === 'undefined'` early-out) or live in a
   `next/dynamic({ ssr: false })` component.
7. `noUncheckedIndexedAccess` is ON: `arr[i]` is `T | undefined`. Handle it; never `!`.
8. Prefer `readonly` arrays and `interface` for object types. No `any`, no non-null assertions.

---

## Already implemented (do not edit)

| File | Contents |
|---|---|
| `src/types/core.ts` | `Vec2`, `MutableVec2`, `Rect`, `Circle`, `Brand`, `PlayerId`, `RoomCode`, `PeerId`, `ThemeId`, `asPlayerId/asPeerId/asRoomCode/asThemeId`, `Timestamp`, `Millis`, `Seconds`, `Hex`, `QualityTier`, `Result`/`Ok`/`Err`/`ok`/`err`/`isOk`/`isErr`/`unwrapOr`/`mapResult`, `DeepReadonly`, `PlayerMap<T>`, `Unsubscribe`, `Listener<T>` |
| `src/types/game.ts` | `GameMode`, `GameStatus`, `RankBy`, `ObstacleKind`, `WallRect`, `BumperCircle`, `SandRect`, `WaterRect`, `BoostRect`, `Obstacle`, `ObstacleOfKind`, `Hole`, `LevelSpec`, `ShotInput`, `ShotEvent`, `ShotEndReason`, `ShotResult`, `PlayerState`, `TogetherRoundState`, `BattleRoundState`, `RoundState`, `PlayerRoundResult`, `RoundSummary`, `FinalStanding`, `GameEndReason`, `GameResults`, `FriendshipTier`, `GameSettings`, `GameState`, `PlayerVariant`, `RoundSnapshot`, `GameSnapshot` |
| `src/types/multiplayer.ts` | `ConnectionState`, `isLiveConnection`, `PeerInfo`, `SignalingKind`, `SignalingEnvelope`, `SignalingStatus`, `RoomIdentity`, `MeshStats` |
| `src/types/index.ts` | barrel — **always import from `@/types`** |
| `src/multiplayer/protocol/version.ts` | `PROTOCOL_VERSION`, `MIN_COMPATIBLE_PROTOCOL_VERSION`, `SIGNALING_VERSION`, `isCompatibleVersion(v)` |
| `src/multiplayer/protocol/messages.ts` | full `NetMessage` union + `isNetMessage` + per-type guards (see below) |
| `src/game/config.ts` | `PHYSICS`, `LEVEL`, `LIMITS`, `ROOM_CODE_ALPHABET`, `TIMING`, `SCORING`, `placementPointsFor`, `efficiencyPointsFor`, `FRIENDSHIP_TIERS`, `FRIENDSHIP_CYCLE_FROM`, `PLAYER_COLORS`, `playerColorFor`, `EMOTES`, `QUALITY`, `DEFAULT_QUALITY_TIER`, `ROUND_OPTIONS`, `DEFAULT_SETTINGS`, `DEFAULT_BATTLE_ROUNDS`, `STORAGE_KEYS` |

### Scoring rule (the user's headline requirement)

`roundScore = placementPointsFor(rank, playerCount) + efficiencyPointsFor(strokes, par)`
— **fewer hits always scores at least as much, usually strictly more.** Both knobs live only in
`SCORING` in `src/game/config.ts`. Never recompute points anywhere else; call the two helpers.

### Message union (already written)

`HELLO, WELCOME, PLAYER_JOINED, PLAYER_LEFT, PLAYER_SHOT, SHOT_RESOLVED, PLAYER_REACHED_GOAL,
ROUND_STARTED, ROUND_COMPLETED, GAME_ENDED, HOST_CHANGED, HEARTBEAT, PING, PONG, STATE_SYNC,
SETTINGS_CHANGED, REQUEST_STATE, EMOTE`

Also exported: `NetMessageBase`, `NetMessage`, `NetMessageType`, `MessageOf<K>`, `NetMessageBody<K>`,
`NetMessageHandler`, `ALWAYS_ACCEPT`, `HOST_ONLY`, `NET_MESSAGE_TYPES`, `isNetMessageType`,
`isNetMessage`, `isMessageOfType`, `isUnauthorizedHostMessage`, and `isHello`/`isWelcome`/… guards.

**Never send `LevelSpec` or per-frame positions.** `ROUND_STARTED` carries `{roomSeed, roundIndex,
variants}`; every peer regenerates geometry locally.

---

## 1 — `src/game/physics/vec.ts`

```ts
import type { Vec2 } from '@/types';

export const ZERO: Vec2;
export function vec(x: number, y: number): Vec2;
export function add(a: Vec2, b: Vec2): Vec2;
export function sub(a: Vec2, b: Vec2): Vec2;
export function scale(a: Vec2, k: number): Vec2;
export function dot(a: Vec2, b: Vec2): number;
export function lengthSq(a: Vec2): number;
export function length(a: Vec2): number;              // Math.sqrt only
export function distanceSq(a: Vec2, b: Vec2): number;
export function distance(a: Vec2, b: Vec2): number;
/** Zero-length input returns ZERO — callers must treat that as "no shot". */
export function normalize(a: Vec2): Vec2;
export function clampLength(a: Vec2, max: number): Vec2;
/** v - 2*(v·n)*n. `n` must already be unit length. */
export function reflect(v: Vec2, n: Vec2): Vec2;
export function negate(a: Vec2): Vec2;
export function lerp(a: Vec2, b: Vec2, t: number): Vec2;     // presentation use
export function equalsApprox(a: Vec2, b: Vec2, eps?: number): boolean;
```

Pure, allocation-light, no trig. Every function returns a fresh frozen-by-convention `Vec2`.

## 2 — `src/game/physics/collision.ts`

```ts
import type { Vec2, Rect } from '@/types';

/** Normal points FROM the obstacle TOWARD the ball. `penetration` >= 0. */
export interface Contact { readonly normal: Vec2; readonly penetration: number }

export function pointInRect(px: number, py: number, r: Rect): boolean;
export function closestPointOnRect(px: number, py: number, r: Rect): Vec2;
export function circleIntersectsRect(cx: number, cy: number, radius: number, r: Rect): boolean;
export function circleRectContact(cx: number, cy: number, radius: number, r: Rect): Contact | null;
export function circleCircleContact(
  ax: number, ay: number, ar: number, bx: number, by: number, br: number,
): Contact | null;
/** Reflected velocity after a bounce, energy scaled by `restitution`. */
export function bounceVelocity(vx: number, vy: number, n: Vec2, restitution: number): Vec2;
/** Axis-aligned overlap test used by the generator to keep spawn/hole areas clear. */
export function rectOverlapsCircle(r: Rect, cx: number, cy: number, radius: number): boolean;
export function rectOverlapsRect(a: Rect, b: Rect): boolean;
```

Corner case: when the ball centre is exactly inside a rect, return the axis of least penetration as
the normal (deterministic tie-break order: `-x, +x, -y, +y`).

## 3 — `src/game/physics/simulate.ts`

```ts
import type { LevelSpec, ShotInput, ShotResult, Vec2 } from '@/types';

export interface SimOptions {
  readonly maxSeconds?: number;      // default PHYSICS.MAX_SIM_SECONDS
  readonly sampleEvery?: number;     // default PHYSICS.PATH_SAMPLE_EVERY
  readonly collectEvents?: boolean;  // default true
}

/** THE deterministic core. Same inputs => byte-identical output on every device. */
export function simulateShot(
  level: LevelSpec, from: Vec2, aim: Vec2, power: number, options?: SimOptions,
): ShotResult;

/** Convenience wrapper used by the network layer when replaying a peer's PLAYER_SHOT. */
export function replayShot(level: LevelSpec, from: Vec2, shot: ShotInput, options?: SimOptions): ShotResult;

export function shotSpeedFor(power: number): number;        // clamp(power,0,1) * PHYSICS.MAX_SHOT_SPEED
export function powerFromDrag(dragLengthCu: number): number; // clamp(len / PHYSICS.MAX_DRAG_CU, 0, 1)
/** Shot direction = OPPOSITE of the drag, normalised. Returns ZERO for a zero drag. */
export function aimFromDrag(drag: Vec2): Vec2;
```

Loop order per step (must be identical everywhere):
boost pads → friction (sand-aware) → integrate → outer walls → wall rects → bumpers →
water check → hole capture → rest check. Sample the path every `sampleEvery` steps and always push
the final position. `durationMs = steps * DT * 1000` (renderer may scale it, sim does not).
Water: reset to the shot's start position, `penaltyStrokes = PHYSICS.WATER_PENALTY_STROKES`, end the
shot with `reason: 'water-reset'`.

## 4 — `src/game/levels/prng.ts`

```ts
export interface Prng {
  /** Raw 32-bit unsigned integer. */
  nextUint(): number;
  /** [0,1) with 2^-32 resolution. */
  next(): number;
  /** Integer in [min, max). */
  nextInt(min: number, max: number): number;
  /** Float in [min, max). */
  nextRange(min: number, max: number): number;
  /** True with probability p. */
  chance(p: number): boolean;
  /** Independent stream derived from this one; never advances the parent. */
  fork(salt: number): Prng;
}

export function createPrng(seed: number): Prng;                    // mulberry32, integer ops only
export function hashSeed(...values: readonly number[]): number;    // 32-bit mix, always >>> 0
export function seedFor(roomSeed: number, roundIndex: number, variantIndex: number): number;
/** Crypto-quality room seed. UI/host only — NEVER called inside generation. */
export function randomRoomSeed(): number;
```

## 5 — `src/game/levels/generator.ts`

```ts
import type { LevelSpec } from '@/types';

/** Fully deterministic. `seed` is the ROOM seed; it is mixed with round + variant internally. */
export function generateLevel(seed: number, roundIndex: number, variantIndex: number): LevelSpec;

export function obstacleCountFor(roundIndex: number, difficultyBias?: number): number;
/** par from start↔hole distance and obstacle density, clamped to LEVEL.PAR_MIN..PAR_MAX. */
export function parFor(distance: number, obstacleCount: number): number;
/** Guards: spawn clear, hole clear, min separation, nothing outside the walls, no obstacle overlap. */
export function isLevelPlayable(level: LevelSpec): boolean;
```

Generation contract: obstacle ids are `0..n-1` in creation order. Rejection-sample each obstacle up
to `LEVEL.MAX_GEN_ATTEMPTS`; skip it if it never fits (fewer obstacles is fine, an unplayable level
is not). `isLevelPlayable(generateLevel(anySeed, r, v))` must be `true` for all inputs — cover it
with a vitest loop over ~200 seeds.

## 6 — `src/game/levels/themes.ts`

```ts
import type { Hex, ThemeId } from '@/types';

export interface Theme {
  readonly id: ThemeId; readonly name: string;
  readonly felt: Hex; readonly feltEdge: Hex; readonly rough: Hex;
  readonly wall: Hex; readonly wallTop: Hex;
  readonly sand: Hex; readonly water: Hex; readonly boost: Hex; readonly bumper: Hex;
  readonly hole: Hex; readonly sky: Hex; readonly fog: Hex; readonly accent: Hex;
  readonly lightIntensity: number;
}

export const THEMES: readonly Theme[];            // >= 5, all original, procedural colours only
export function themeForRound(roundIndex: number): Theme;   // THEMES[roundIndex % THEMES.length]
export function getTheme(id: ThemeId): Theme;               // falls back to THEMES[0]
```

Course felt must stay a **deep desaturated teal/charcoal** so all eight `PLAYER_COLORS` read on it.

## 7 — `src/game/rendering/three/*` (client-only)

`src/game/rendering/three/types.ts`
```ts
import type { Hex, PlayerId, Vec2, LevelSpec, QualityTier } from '@/types';

export interface BallView {
  readonly playerId: PlayerId; readonly color: Hex; readonly pos: Vec2;
  readonly isSelf: boolean; readonly holed: boolean; readonly label: string;
}
/** A shot being animated. `startedAt` is performance.now() at playback start. */
export interface ShotPlayback {
  readonly playerId: PlayerId; readonly path: readonly Vec2[];
  readonly durationMs: number; readonly holed: boolean; readonly startedAt: number;
}
export interface AimPreview {
  readonly origin: Vec2; readonly aim: Vec2; readonly power: number; readonly color: Hex;
}
export interface CourseViewProps {
  readonly level: LevelSpec;
  readonly balls: readonly BallView[];
  readonly playback: ShotPlayback | null;
  readonly aim: AimPreview | null;
  readonly quality: QualityTier;
  readonly reducedMotion: boolean;
  readonly onPlaybackEnd?: () => void;
  readonly className?: string;
}
```

| File | Export | Notes |
|---|---|---|
| `CourseCanvas.tsx` | `export default function CourseCanvas(props: CourseViewProps): JSX.Element` | Owns `<Canvas>`, dpr cap, camera. **This is the only module the app may `next/dynamic(..., { ssr:false })`.** |
| `CourseScene.tsx` | `export function CourseScene(props: CourseViewProps)` | Scene graph; no `<Canvas>`. |
| `CourseGround.tsx` | `export function CourseGround({ level, theme }: { level: LevelSpec; theme: Theme })` | One plane + extruded border walls, shared geometry via `useMemo`. |
| `Obstacles.tsx` | `export function Obstacles({ level, theme, quality }: ObstaclesProps)` | One `InstancedMesh` per obstacle kind. Never one mesh per obstacle. |
| `Ball.tsx` | `export function Ball({ view, quality }: { view: BallView; quality: QualityTier })` | Sphere with shared geometry; colour per instance. |
| `HoleMarker.tsx` | `export function HoleMarker({ hole, theme }: { hole: Hole; theme: Theme })` | Ring + cup, procedural. |
| `AimIndicator.tsx` | `export function AimIndicator({ aim }: { aim: AimPreview })` | Dotted arc/arrow; hidden when `power < PHYSICS.MIN_POWER`. |
| `ShotAnimator.tsx` | `export function ShotAnimator({ playback, onEnd }: { playback: ShotPlayback \| null; onEnd?: () => void })` | Samples `path` by elapsed time in `useFrame`. **Zero allocations per frame** — hoist scratch `THREE.Vector3` to module scope. |
| `Lighting.tsx` | `export function Lighting({ theme, quality }: { theme: Theme; quality: QualityTier })` | Hemisphere + one directional light; shadows only on `high`. |

Course→world mapping (fixed, everyone uses it): `world.x = cu.x - level.width / 2`,
`world.z = cu.y - level.height / 2`, `world.y` is up. Export that as
`export function toWorld(p: Vec2, level: LevelSpec): [number, number, number]` from `types.ts`.

## 8 — `src/game/rendering/mini/*` (no three.js — used on the summary screen, in the lobby preview and as the WebGL-less fallback)

```ts
// mini/miniDraw.ts — pure, testable, no DOM
export function courseViewBox(level: LevelSpec): string;                   // "0 0 w h"
export function obstacleSvgPath(o: Obstacle): string;                      // SVG `d`
export function obstacleFill(o: Obstacle, theme: Theme): Hex;
export function pathPolyline(path: readonly Vec2[]): string;               // "x,y x,y ..."

// mini/MiniCourse.tsx
export interface MiniCourseProps {
  readonly level: LevelSpec; readonly balls: readonly BallView[];
  readonly trail?: readonly Vec2[]; readonly className?: string;
}
export function MiniCourse(props: MiniCourseProps): JSX.Element;           // pure inline SVG
```

## 9 — `src/game/rendering/quality.ts`

```ts
import type { QualityTier } from '@/types';
import type { QualityProfile } from '@/game/config';

/** Probes deviceMemory / hardwareConcurrency / screen size / WebGL2. SSR-safe (returns the default). */
export function detectQualityTier(): QualityTier;
export function resolveQuality(tier: QualityTier): QualityProfile;
/** min(window.devicePixelRatio, profile.maxDpr); 1 during SSR. */
export function cappedDpr(profile: QualityProfile): number;
export function prefersReducedMotion(): boolean;
export function supportsWebGL(): boolean;
/** React hook: persisted tier from localStorage (STORAGE_KEYS.prefs) + setter. */
export function useQuality(): {
  readonly tier: QualityTier; readonly profile: QualityProfile;
  readonly reducedMotion: boolean; readonly setTier: (t: QualityTier) => void;
};
```

## 10 — `src/game/rendering/palette.ts`

```ts
import type { Hex } from '@/types';

/** App chrome tokens (not course colours — those come from a Theme). */
export const UI: {
  readonly bg: Hex; readonly surface: Hex; readonly surfaceAlt: Hex; readonly border: Hex;
  readonly text: Hex; readonly textMuted: Hex; readonly accent: Hex; readonly accentAlt: Hex;
  readonly good: Hex; readonly warn: Hex; readonly bad: Hex;
};
export function hexToRgb(hex: Hex): { readonly r: number; readonly g: number; readonly b: number };
export function rgbToHex(r: number, g: number, b: number): Hex;
export function mixHex(a: Hex, b: Hex, t: number): Hex;
export function shadeHex(hex: Hex, amount: number): Hex;      // -1 darken .. +1 lighten
export function withAlpha(hex: Hex, alpha: number): string;   // "rgba(...)"
export function contrastTextFor(bg: Hex): Hex;                // UI.text or UI.bg
```

## 11 — `src/game/input/useAimControls.ts`

```ts
import type { Vec2 } from '@/types';

export interface AimState {
  readonly active: boolean; readonly origin: Vec2; readonly drag: Vec2;
  readonly aim: Vec2;        // normalised, already opposite to the drag
  readonly power: number;    // 0..1
  readonly valid: boolean;   // power >= PHYSICS.MIN_POWER
}

export interface UseAimControlsOptions {
  readonly ballPos: Vec2;
  readonly enabled: boolean;
  /** Screen → course units. Provided by the renderer (it owns the camera). */
  readonly toCourse: (clientX: number, clientY: number) => Vec2;
  readonly onShoot: (aim: Vec2, power: number) => void;
  /** Pointer must start within this many cu of the ball. Default 12. */
  readonly grabRadius?: number;
}

export interface UseAimControlsResult {
  readonly aim: AimState | null;
  readonly handlers: {
    readonly onPointerDown: (e: React.PointerEvent) => void;
    readonly onPointerMove: (e: React.PointerEvent) => void;
    readonly onPointerUp: (e: React.PointerEvent) => void;
    readonly onPointerCancel: (e: React.PointerEvent) => void;
  };
  readonly cancel: () => void;
}

export function useAimControls(options: UseAimControlsOptions): UseAimControlsResult;
```

Pointer Events only (mouse + touch + pen), `setPointerCapture` on down, `touch-action: none` on the
host element. Releasing with `power < PHYSICS.MIN_POWER` cancels instead of firing.

## 12 — `src/multiplayer/webrtc/iceConfig.ts`

```ts
export const DEFAULT_STUN_URLS: readonly string[];   // free public STUN only
/** TURN is OPTIONAL: included only when NEXT_PUBLIC_TURN_URL is a non-empty string. */
export function getIceServers(): RTCIceServer[];
export function getRtcConfiguration(): RTCConfiguration;   // + bundlePolicy:'max-bundle', iceCandidatePoolSize:2
export function hasTurn(): boolean;
```

Read `process.env.NEXT_PUBLIC_STUN_URLS`, `NEXT_PUBLIC_TURN_URL`, `NEXT_PUBLIC_TURN_USERNAME`,
`NEXT_PUBLIC_TURN_CREDENTIAL` as full literals (static export inlines them; never build the name dynamically).

## 13 — `src/multiplayer/webrtc/peerLink.ts`

```ts
import type { PeerId, PeerInfo, SignalingKind, Unsubscribe } from '@/types';

export interface PeerLinkOptions {
  readonly selfPeerId: PeerId;
  readonly remotePeerId: PeerId;
  /** Deterministic glare rule: initiator === (selfPeerId < remotePeerId). */
  readonly initiator: boolean;
  readonly onSignal: (kind: SignalingKind, payload: string) => void;
  readonly onMessage: (data: string) => void;
  readonly onStateChange: (state: ConnectionState, error?: string) => void;
}

export interface PeerLink {
  readonly remotePeerId: PeerId;
  readonly initiator: boolean;
  readonly state: ConnectionState;
  /** Creates the RTCPeerConnection; the initiator also creates the DataChannel + offer. */
  start(): Promise<void>;
  /** Feed a received offer/answer/ice payload (JSON string). */
  acceptSignal(kind: SignalingKind, payload: string): Promise<void>;
  /** false when the channel is not open. */
  send(data: string): boolean;
  info(): PeerInfo;
  close(reason?: string): void;
}

export function createPeerLink(options: PeerLinkOptions): PeerLink;
```

DataChannel: label `'fg'`, `{ ordered: true }` (lockstep needs order; the payloads are tiny).
Fail the link after `TIMING.CONNECT_TIMEOUT_MS`.

## 14 — `src/multiplayer/webrtc/mesh.ts`

```ts
import type { MeshStats, PeerId, PeerInfo, RoomIdentity, Unsubscribe } from '@/types';
import type { SignalingChannel } from '@/multiplayer/signaling/types';

export interface MeshOptions {
  readonly identity: RoomIdentity;
  readonly signaling: SignalingChannel;
  readonly maxPeers?: number;                       // default LIMITS.MAX_PLAYERS - 1
}

export interface Mesh {
  start(): Promise<Result<void, string>>;
  broadcast(data: string): void;
  sendTo(peerId: PeerId, data: string): boolean;
  peers(): readonly PeerInfo[];
  stats(): MeshStats;
  onMessage(listener: (data: string, from: PeerId) => void): Unsubscribe;
  onPeers(listener: (peers: readonly PeerInfo[]) => void): Unsubscribe;
  close(): void;
}

export function createMesh(options: MeshOptions): Mesh;
```

Full mesh: on `announce` from an unknown peer, create a `PeerLink` with
`initiator = selfPeerId < remotePeerId` (both sides agree, so no glare). Re-announce every
`TIMING.SIGNALING_ANNOUNCE_MS` until connected.

## 15 — `src/multiplayer/signaling/types.ts`

Re-export the envelope types from `@/types` and declare **this interface verbatim**:

```ts
import type {
  PeerId, Result, RoomCode, SignalingEnvelope, SignalingStatus, Unsubscribe,
} from '@/types';

export type { SignalingEnvelope, SignalingKind, SignalingStatus } from '@/types';

export interface SignalingChannel {
  /** Stable name for diagnostics: 'nostr' | 'broadcast' | 'manual' | 'composite'. */
  readonly name: string;
  /** Current health; also pushed through onStatus. */
  readonly status: SignalingStatus;
  /** Join the room's signaling topic. Resolves once the channel is usable (or errors). */
  open(room: RoomCode, self: PeerId): Promise<Result<void, string>>;
  /** Fire-and-forget publish. Resolves err when the envelope could not be sent at all. */
  send(envelope: SignalingEnvelope): Promise<Result<void, string>>;
  /** Envelopes addressed to us or broadcast. Implementations MUST drop our own echoes and dedupe by nonce. */
  onEnvelope(listener: (envelope: SignalingEnvelope) => void): Unsubscribe;
  onStatus(listener: (status: SignalingStatus) => void): Unsubscribe;
  close(): void;
}

export type SignalingFactory = () => SignalingChannel;
```

## 16 — `src/multiplayer/signaling/crypto.ts`

```ts
import type { Result, RoomCode, SignalingEnvelope } from '@/types';

/** SHA-256 of a fixed prefix + room code, hex. Relays only ever see this, never the code. */
export function roomTopic(roomCode: RoomCode): Promise<string>;
/** PBKDF2(roomCode, fixed salt, 100k, SHA-256) → AES-GCM key. */
export function deriveRoomKey(roomCode: RoomCode): Promise<CryptoKey>;
/** base64url( iv(12) || ciphertext ). */
export function encryptEnvelope(key: CryptoKey, envelope: SignalingEnvelope): Promise<string>;
export function decryptEnvelope(key: CryptoKey, blob: string): Promise<Result<SignalingEnvelope, string>>;
export function randomNonce(): string;     // crypto.getRandomValues, 16 hex chars
```

Everything here is browser-only (`crypto.subtle`); guard for SSR and return `err(...)` if missing.

## 17 — `src/multiplayer/signaling/nostrSignaling.ts`

```ts
export interface NostrSignalingOptions {
  /** Defaults to NEXT_PUBLIC_SIGNALING_RELAYS, else a built-in free public relay list. */
  readonly relays?: readonly string[];
}
export function createNostrSignaling(options?: NostrSignalingOptions): SignalingChannel;
export const DEFAULT_RELAYS: readonly string[];
```

Ephemeral events (kind `20042`), `#d` tag = `roomTopic()`, content = `encryptEnvelope()` output,
throwaway keypair per session (`generateSecretKey()` — never persisted, not an account).
Status `degraded` when at least one relay is up but fewer than half.

## 18 — `src/multiplayer/signaling/broadcastChannelSignaling.ts`

```ts
export function createBroadcastChannelSignaling(): SignalingChannel;
export function isBroadcastChannelSupported(): boolean;
```

`new BroadcastChannel('fg:' + roomTopic)`. Same-browser tabs only — this is what makes local
multi-tab testing instant. No encryption needed (same origin, same browser) but keep the envelope shape.

## 19 — `src/multiplayer/signaling/compositeSignaling.ts`

```ts
export function createCompositeSignaling(channels: readonly SignalingChannel[]): SignalingChannel;
```

Opens all children (ok if some fail — err only when ALL fail), sends to all, merges inbound and
dedupes by `envelope.nonce` (keep a bounded LRU of ~512). `status` = best child status.
**Default room signaling = `createCompositeSignaling([broadcastChannel, nostr])`.**

## 20 — `src/multiplayer/signaling/manualSignaling.ts`

```ts
export interface ManualSignaling extends SignalingChannel {
  /** Envelopes waiting to be copied out, as one compact base64url blob. */
  outbox(): string;
  /** Paste a blob from the other player. */
  ingest(blob: string): Result<number, string>;   // ok(count of envelopes accepted)
  onOutboxChange(listener: (blob: string) => void): Unsubscribe;
}
export function createManualSignaling(): ManualSignaling;
```

Last-resort, zero-infrastructure fallback (copy/paste a code into a chat app). No network at all.

## 21 — `src/multiplayer/transport/types.ts`

Declare **this interface verbatim**:

```ts
import type { PeerId, PeerInfo, PlayerId, Result, Unsubscribe } from '@/types';
import type { NetMessage } from '@/multiplayer/protocol/messages';

export interface Transport {
  readonly kind: 'mesh' | 'loopback';
  readonly selfId: PlayerId;
  /** Connects. Resolves ok once the transport is usable (peers may still be joining). */
  start(): Promise<Result<void, string>>;
  /** Send to every connected peer. Never throws; silently skips dead links. */
  broadcast(message: NetMessage): void;
  /** Send to one player. Returns false when that player is not reachable. */
  sendTo(target: PlayerId, message: NetMessage): boolean;
  /** Only messages that already passed isNetMessage() are delivered. */
  onMessage(listener: (message: NetMessage, from: PeerId) => void): Unsubscribe;
  onPeers(listener: (peers: readonly PeerInfo[]) => void): Unsubscribe;
  peers(): readonly PeerInfo[];
  close(): void;
}
```

Also export the mesh-backed factory here or in `transport/meshTransport.ts`:
```ts
export function createMeshTransport(opts: {
  readonly identity: RoomIdentity; readonly signaling: SignalingChannel;
}): Transport;
```

## 22 — `src/multiplayer/transport/loopback.ts`

```ts
export interface LoopbackHub {
  transportFor(playerId: PlayerId): Transport;
  /** Deterministic test helper: deliver everything queued. */
  flush(): void;
  /** Simulated one-way latency in ms (default 0). */
  setLatency(ms: number): void;
  close(): void;
}
export function createLoopbackHub(): LoopbackHub;
export function createLoopbackTransport(selfId: PlayerId, hub?: LoopbackHub): Transport;
```

In-memory transport for vitest and single-tab development. No WebRTC, no timers unless latency > 0.

## 23 — `src/multiplayer/protocol/codec.ts`

```ts
import type { Result } from '@/types';
import type { NetMessage } from './messages';

export function encode(message: NetMessage): string;
/** JSON.parse + isNetMessage + size check against LIMITS.MAX_MESSAGE_BYTES. */
export function decode(raw: string): Result<NetMessage, string>;
export function byteLength(raw: string): number;
```

## 24 — `src/multiplayer/protocol/sequencer.ts`

```ts
import type { PlayerId } from '@/types';
import type { MessageOf, NetMessage, NetMessageBody, NetMessageType } from './messages';

export interface Sequencer {
  /** Stamps {v: PROTOCOL_VERSION, seq: ++n, from: self, ts: now()}. */
  stamp<K extends NetMessageType>(body: NetMessageBody<K>): MessageOf<K>;
  /** Duplicate/replay gate: false = drop. Types in ALWAYS_ACCEPT bypass ordering. */
  accept(message: NetMessage): boolean;
  lastSeqFrom(player: PlayerId): number;
  /** Call on reconnect so a peer restarting at seq 1 is not rejected forever. */
  reset(player?: PlayerId): void;
}

export function createSequencer(self: PlayerId, now?: () => number): Sequencer;
```

## 25 — `src/multiplayer/room/roomSession.ts`

The orchestrator: owns the transport, the sequencer, host authority and the reducer.

```ts
import type {
  GameMode, GameSettings, GameState, PlayerId, Result, RoomIdentity, ShotResult, Unsubscribe, Vec2,
} from '@/types';
import type { Transport } from '@/multiplayer/transport/types';

export type SessionEvent =
  | { readonly type: 'shot-playback'; readonly playerId: PlayerId; readonly result: ShotResult }
  | { readonly type: 'holed'; readonly playerId: PlayerId; readonly strokes: number }
  | { readonly type: 'round-started'; readonly roundIndex: number }
  | { readonly type: 'round-completed'; readonly roundIndex: number }
  | { readonly type: 'game-ended' }
  | { readonly type: 'emote'; readonly playerId: PlayerId; readonly emoji: string }
  | { readonly type: 'host-changed'; readonly hostPlayerId: PlayerId }
  | { readonly type: 'error'; readonly message: string };

export interface RoomSessionOptions {
  readonly identity: RoomIdentity;
  readonly transport: Transport;
  readonly mode: GameMode;
  readonly isHost: boolean;
  readonly settings?: Partial<GameSettings>;
}

export interface RoomSession {
  getState(): GameState;
  subscribe(listener: (state: GameState) => void): Unsubscribe;
  onEvent(listener: (event: SessionEvent) => void): Unsubscribe;
  start(): Promise<Result<void, string>>;
  /** Host only; no-ops (returns err) for guests. */
  startGame(): Result<void, string>;
  startNextRound(): Result<void, string>;
  changeSettings(patch: Partial<GameSettings>): Result<void, string>;
  endGame(): Result<void, string>;
  /** Any player, on their own turn / their own course. Broadcasts PLAYER_SHOT and plays it locally. */
  submitShot(aim: Vec2, power: number): Result<void, string>;
  sendEmote(emoji: string): void;
  leave(): void;
}

export function createRoomSession(options: RoomSessionOptions): RoomSession;
```

Flow for one shot: `submitShot` → validate locally → `PLAYER_SHOT` broadcast → **every** peer
(sender included) runs `simulateShot` and emits `shot-playback` → the host applies the authoritative
result and broadcasts `SHOT_RESOLVED` (+ `PLAYER_REACHED_GOAL`) → peers reconcile.

## 26 — `src/multiplayer/room/hostElection.ts`

```ts
import type { PlayerId, PlayerState } from '@/types';

/** Deterministic: lowest joinSeq among CONNECTED players. null when nobody is connected. */
export function electHost(players: readonly PlayerState[]): PlayerId | null;
/** True when `self` should claim the host role right now. */
export function shouldClaimHost(players: readonly PlayerState[], self: PlayerId): boolean;

export interface HostWatchdog {
  noteHostSeen(at: number): void;
  /** 'elect' once TIMING.HOST_TIMEOUT_MS has elapsed with no host traffic. */
  tick(now: number): 'ok' | 'elect';
  reset(now: number): void;
}
export function createHostWatchdog(): HostWatchdog;
```

## 27 — `src/multiplayer/room/heartbeat.ts`

```ts
import type { PlayerId, Millis, Timestamp, Unsubscribe } from '@/types';
import type { NetMessage } from '@/multiplayer/protocol/messages';

export interface HeartbeatService {
  start(): void;
  stop(): void;
  /** Feed every inbound message; updates lastSeen and answers PING with PONG. */
  handle(message: NetMessage): void;
  lastSeen(player: PlayerId): Timestamp | null;
  rtt(player: PlayerId): Millis | null;
  /** Players silent for longer than TIMING.RECONNECT_GRACE_MS. */
  staleSince(now: Timestamp, thresholdMs: number): readonly PlayerId[];
  onTick(listener: () => void): Unsubscribe;
}

export interface HeartbeatOptions {
  readonly send: (message: NetMessage) => void;
  readonly stamp: Sequencer['stamp'];
  readonly self: PlayerId;
  readonly getStatus: () => GameStatus;
  readonly getStateVersion: () => number;
  readonly isHost: () => boolean;
}
export function createHeartbeat(options: HeartbeatOptions): HeartbeatService;
```

## 28 — `src/game/rules/scoring.ts`

```ts
import type {
  GameMode, GameState, GameResults, GameEndReason, PlayerId, PlayerRoundResult, RankBy, RoundSummary,
} from '@/types';

export interface RoundEntry {
  readonly playerId: PlayerId; readonly strokes: number; readonly par: number;
  readonly holed: boolean; readonly holeOutOrder: number | null; readonly totalBefore: number;
}

export interface ScoreOptions {
  readonly mode: GameMode;
  readonly playerCount: number;
  readonly rankBy: RankBy;          // default SCORING.rankBy
  readonly maxStrokes: number;      // LIMITS.MAX_STROKES
}

/** Sorts by (strokes asc, holeOutOrder asc) or pure time; DNF always last, sharing the last rank. */
export function rankRound(entries: readonly RoundEntry[], options: ScoreOptions): readonly PlayerRoundResult[];
/** Builds the whole summary, including collective totals. In 'together' mode every rank is 0
 *  and placementPoints is 0 — co-op never ranks players. */
export function summariseRound(state: GameState, roundIndex: number): RoundSummary;
export function finalStandings(state: GameState, reason: GameEndReason): GameResults;
/** Convenience used by the HUD: what this player would score if they holed out right now. */
export function projectedScore(strokes: number, par: number): number;
```

Points come ONLY from `placementPointsFor` / `efficiencyPointsFor` in `@/game/config`.

## 29 — `src/game/rules/friendship.ts`

```ts
import type { FriendshipTier, GameState, PlayerId, RoundSummary } from '@/types';

/** Implements the cycling rule documented in config.FRIENDSHIP_TIERS. roundsCompleted is 1-based. */
export function friendshipTierFor(roundsCompleted: number): FriendshipTier;
export function collectiveStrokes(summaries: readonly RoundSummary[]): number;
/** One warm sentence for the summary screen. Never competitive, never a ranking. */
export function friendshipHeadline(summary: RoundSummary): string;
/** Co-op turn rotation: next connected, not-holed, not-DNF player after the cursor. null when the round is done. */
export function nextTurn(state: GameState): PlayerId | null;
export function isTogetherRoundOver(state: GameState): boolean;
```

## 30 — `src/game/rules/competitive.ts`

```ts
import type { GameMode, GameState, PlayerId, PlayerState } from '@/types';

/** Battle: player N gets variantIndex = joinSeq + 1; together: always 0. */
export function variantIndexFor(player: PlayerState, mode: GameMode): number;
export function isBattleRoundOver(state: GameState): boolean;
export function playersStillPlaying(state: GameState): readonly PlayerId[];
export function isDnf(strokes: number, holed: boolean, maxStrokes: number): boolean;
/** True when currentRoundIndex + 1 >= totalRounds (never for endless co-op rooms). */
export function shouldEndGame(state: GameState): boolean;
export function canShoot(state: GameState, playerId: PlayerId): boolean;
```

## 31 — `src/state/gameReducer.ts`

```ts
import type { GameState, GameMode, GameSettings, PlayerId, RoomIdentity, Timestamp } from '@/types';
import type { NetMessage } from '@/multiplayer/protocol/messages';

export type GameAction =
  | { readonly type: 'net'; readonly message: NetMessage; readonly now: Timestamp }
  | { readonly type: 'local/player-joined'; readonly player: PlayerState }
  | { readonly type: 'local/peer-state'; readonly playerId: PlayerId; readonly connected: boolean }
  | { readonly type: 'local/shot-applied'; readonly playerId: PlayerId; readonly restPos: Vec2;
      readonly strokes: number; readonly holed: boolean; readonly holeOutOrder: number | null }
  | { readonly type: 'local/settings'; readonly settings: GameSettings }
  | { readonly type: 'local/host'; readonly hostPlayerId: PlayerId }
  | { readonly type: 'local/status'; readonly status: GameStatus };

export function createInitialState(args: {
  readonly identity: RoomIdentity; readonly mode: GameMode;
  readonly roomSeed: number; readonly settings: GameSettings; readonly isHost: boolean;
}): GameState;

/** PURE. No Date.now, no randomness, no I/O — every timestamp arrives in the action. */
export function gameReducer(state: GameState, action: GameAction): GameState;
```

## 32 — `src/state/store.ts`

```ts
import { create } from 'zustand';

export interface GameStore {
  readonly identity: RoomIdentity | null;
  readonly game: GameState | null;
  readonly peers: readonly PeerInfo[];
  readonly connection: ConnectionState;
  readonly signaling: SignalingStatus;
  readonly lastError: string | null;
  readonly playback: ShotPlayback | null;
  setIdentity(identity: RoomIdentity | null): void;
  setGame(state: GameState | null): void;
  setPeers(peers: readonly PeerInfo[]): void;
  setConnection(state: ConnectionState): void;
  setSignaling(status: SignalingStatus): void;
  setError(message: string | null): void;
  setPlayback(playback: ShotPlayback | null): void;
  reset(): void;
}
export const useGameStore: UseBoundStore<StoreApi<GameStore>>;
```

Keep the store dumb: it mirrors what `RoomSession` emits. All rules live in `game/rules/**`.

## 33 — `src/state/selectors.ts`

```ts
export function selectSelf(state: GameState, self: PlayerId): PlayerState | null;
export function selectOrderedPlayers(state: GameState): readonly PlayerState[];
export function selectActivePlayer(state: GameState): PlayerState | null;
export function selectMyLevel(state: GameState, self: PlayerId): LevelSpec | null;
export function selectBallViews(state: GameState, self: PlayerId): readonly BallView[];
export function selectIsMyTurn(state: GameState, self: PlayerId): boolean;
export function selectLeaderboard(state: GameState): readonly FinalStanding[];
export function selectCollectiveStrokes(state: GameState): number;
export function selectCanStart(state: GameState, self: PlayerId): boolean;
```

Pure functions of `GameState` — no hooks, so they are directly unit-testable.

## 34 — `src/state/useGameSession.ts`

```ts
export interface UseGameSession {
  readonly game: GameState | null;
  readonly identity: RoomIdentity | null;
  readonly peers: readonly PeerInfo[];
  readonly connection: ConnectionState;
  readonly error: string | null;
  readonly isHost: boolean;
  createRoom(args: { name: string; mode: GameMode; totalRounds: number | null }): Promise<Result<RoomCode, string>>;
  joinRoom(args: { name: string; code: RoomCode }): Promise<Result<void, string>>;
  submitShot(aim: Vec2, power: number): void;
  startGame(): void;
  startNextRound(): void;
  endGame(): void;
  sendEmote(emoji: string): void;
  leave(): void;
}
export function useGameSession(): UseGameSession;
```

Owns session lifecycle + `sessionStorage` reconnect identity (`STORAGE_KEYS.identity`). The only
module allowed to construct signaling + transport + `RoomSession`.

## 35 — `src/modes/*`

| File | Export |
|---|---|
| `src/modes/GameScreen.tsx` | `export function GameScreen(): JSX.Element` — picks the mode component, owns `const CourseCanvas = dynamic(() => import('@/game/rendering/three/CourseCanvas'), { ssr: false, loading: … })`. **This is the only place three.js may be imported.** |
| `src/modes/friendship/FriendshipMode.tsx` | `export function FriendshipMode(props: { state: GameState; self: PlayerId }): JSX.Element` — shared course, turn banner, no ranking anywhere. |
| `src/modes/friendship/FriendshipSummary.tsx` | `export function FriendshipSummary(props: { summary: RoundSummary }): JSX.Element` — collective strokes + tier, "Keep going" / "Finish" buttons. |
| `src/modes/competitive/BattleMode.tsx` | `export function BattleMode(props: { state: GameState; self: PlayerId }): JSX.Element` — own course, live opponent progress strip. |
| `src/modes/competitive/BattleSummary.tsx` | `export function BattleSummary(props: { summary: RoundSummary }): JSX.Element` — rank, placement + efficiency points shown SEPARATELY so "fewer hits = more points" is visible. |

## 36 — `src/components/*`

All presentational, typed props, no direct network access (they read the store / take props).

`Button.tsx` `Card.tsx` `ConfirmDialog.tsx` `Toast.tsx` `ConnectionPill.tsx` `PlayerChip.tsx`
`PlayerList.tsx` `ModeCard.tsx` `HomeScreen.tsx` `CreateRoomPanel.tsx` `JoinRoomPanel.tsx`
`Lobby.tsx` `Hud.tsx` `PowerMeter.tsx` `ScoreTable.tsx` `FinalResults.tsx` `ShareResults.tsx`
`QualityToggle.tsx` `EmoteBar.tsx`

`HomeScreen.tsx` must not import anything from `@/game/rendering/three/**` (keeps three.js out of
the first bundle — use `MiniCourse` for any decorative preview).

## 37 — `src/utils/*`

```ts
// utils/id.ts
export function newPlayerId(): PlayerId;      // crypto.randomUUID with a Math.random fallback
export function newPeerId(): PeerId;
export function shortId(): string;

// utils/roomCode.ts
export function generateRoomCode(): RoomCode;         // ROOM_CODE_ALPHABET, LIMITS.ROOM_CODE_LENGTH
export function isRoomCode(value: string): boolean;
export function normaliseRoomCode(value: string): RoomCode;
export function roomSeedFromCode(code: RoomCode): number;   // deterministic 32-bit, so peers agree

// utils/storage.ts  (the ONLY module allowed to touch web storage)
export function loadIdentity(): RoomIdentity | null;        // sessionStorage
export function saveIdentity(identity: RoomIdentity): void;
export function clearIdentity(): void;
export interface Prefs { readonly sound: boolean; readonly quality: QualityTier }
export function loadPrefs(): Prefs;                        // localStorage
export function savePrefs(prefs: Prefs): void;

// utils/format.ts
export function strokeLabel(n: number): string;            // "1 hit" / "4 hits"
export function relativeToPar(strokes: number, par: number): string;   // "-1", "E", "+2"
export function ordinal(n: number): string;                // 1st, 2nd…
export function clampName(name: string): string;           // trims to LIMITS.MAX_NAME_LENGTH

// utils/math.ts   (UI-side maths — NOT used by the simulation)
export function clamp(v: number, min: number, max: number): number;
export function lerp(a: number, b: number, t: number): number;
export function easeOutCubic(t: number): number;

// utils/share.ts
export function buildResultText(results: GameResults, players: readonly PlayerState[]): string;
export function copyToClipboard(text: string): Promise<boolean>;
export function shareResults(text: string): Promise<boolean>;   // navigator.share, falls back to copy
export function buildJoinUrl(code: RoomCode): string;           // location.origin + '/?room=CODE'

// utils/sound.ts   (procedural WebAudio only — zero audio files)
export function initAudio(): void;
export function playPutt(power: number): void;
export function playBounce(speed: number): void;
export function playHoled(): void;
export function setSoundEnabled(on: boolean): void;

// utils/cn.ts
export { default as cn } from 'clsx';   // or: export const cn = clsx;
```

## 38 — `src/app/*` (UI agent)

`layout.tsx` (metadata, fonts = system stack only, no downloaded fonts), `page.tsx`
(`'use client'`, renders `HomeScreen` / `Lobby` / `GameScreen` from store status),
`globals.css` (`@import "tailwindcss";` + `@theme` tokens mirroring `palette.UI`,
`prefers-reduced-motion` handling, `touch-action: none` on the course surface).

---

## Test expectations (vitest, `src/**/*.test.ts`)

- `physics/simulate.test.ts` — identical inputs give identical `restPos` across 1000 runs; ball
  always comes to rest within `MAX_SIM_SECONDS`; water resets and adds exactly one stroke.
- `levels/generator.test.ts` — `isLevelPlayable` for 200 seeds × 5 rounds × 8 variants; same seed
  gives a deep-equal level.
- `rules/scoring.test.ts` — **fewer strokes never scores less**: for every par 2..6 and strokes
  1..12, `efficiencyPointsFor(s, par) >= efficiencyPointsFor(s + 1, par)`.
- `protocol/codec.test.ts` — round-trip every message type; malformed JSON and NaN fields rejected.
