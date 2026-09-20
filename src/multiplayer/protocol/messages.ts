/**
 * THE WIRE PROTOCOL.
 *
 * Everything that crosses a WebRTC DataChannel is exactly one {@link NetMessage},
 * JSON-encoded by `protocol/codec.ts`. Rules that the whole codebase depends on:
 *
 *  1. NEVER send per-frame positions. A stroke is one PLAYER_SHOT of ~80 bytes and
 *     every peer replays the identical deterministic simulation locally.
 *  2. NEVER send LevelSpec. Levels are regenerated from (roomSeed, roundIndex,
 *     variantIndex), which ROUND_STARTED carries.
 *  3. The HOST is the authority. Peers apply their own optimistic result
 *     immediately for responsiveness, then reconcile with SHOT_RESOLVED.
 *  4. Every message carries {v, seq, from, ts}. `seq` is per-sender and strictly
 *     increasing; `protocol/sequencer.ts` drops duplicates and out-of-order
 *     messages (except PING/PONG/HEARTBEAT, which are exempt - see ALWAYS_ACCEPT).
 *  5. Messages arrive from untrusted peers. Validate with {@link isNetMessage}
 *     BEFORE touching game state; never feed unvalidated numbers to the simulation.
 */

import type {
  GameEndReason,
  GameResults,
  GameSettings,
  GameSnapshot,
  GameStatus,
  PlayerId,
  PlayerState,
  PlayerVariant,
  RoundSummary,
  ShotInput,
  Timestamp,
  Vec2,
} from '@/types';

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

/** Fields present on EVERY message. */
export interface NetMessageBase {
  /** PROTOCOL_VERSION of the sender. */
  readonly v: number;
  /** Per-sender counter, starts at 1, strictly increasing. */
  readonly seq: number;
  /** Sender's PlayerId (NOT PeerId - it survives reconnects). */
  readonly from: PlayerId;
  /** Sender wall clock (Date.now()). Presentation + latency only, never simulation input. */
  readonly ts: Timestamp;
}

// ---------------------------------------------------------------------------
// Handshake
// ---------------------------------------------------------------------------

/**
 * SENDER: any peer, as the first message on a freshly opened DataChannel.
 * RECEIVER: binds peerId -> playerId for this link. The HOST additionally replies
 * with WELCOME and broadcasts PLAYER_JOINED to everyone else. Non-hosts only
 * record the peer; they must not invent player slots.
 * A HELLO whose `protocol` fails isCompatibleVersion() is answered with nothing
 * and the link is closed with a user-visible version error.
 */
export interface HelloMessage extends NetMessageBase {
  readonly type: 'HELLO';
  readonly protocol: number;
  readonly displayName: string;
  /** Preferred colour; the host may override it if taken. */
  readonly color: string;
  readonly roomCode: string;
  /** True when rejoining with a playerId this room has seen before. */
  readonly reconnect: boolean;
}

/**
 * SENDER: host only, in reply to HELLO.
 * RECEIVER: replaces its entire local state with `snapshot` and adopts `youAre`.
 * This is the only message that may overwrite state wholesale on join.
 */
export interface WelcomeMessage extends NetMessageBase {
  readonly type: 'WELCOME';
  readonly snapshot: GameSnapshot;
  /** The id the host assigned us (equals our requested id unless it collided). */
  readonly youAre: PlayerId;
  readonly hostPlayerId: PlayerId;
  /** Rejected because the room is full / already started / version mismatch. */
  readonly rejected: boolean;
  readonly rejectReason: string | null;
}

/**
 * SENDER: host only.
 * RECEIVER: inserts the player (idempotent by id) and re-sorts playerOrder by joinSeq.
 */
export interface PlayerJoinedMessage extends NetMessageBase {
  readonly type: 'PLAYER_JOINED';
  readonly player: PlayerState;
}

/**
 * SENDER: host only (peers report link loss locally; only the host decides someone left).
 * RECEIVER: marks the player disconnected, or removes them when `removed` is true.
 * In 'together' mode the host also advances the turn if it was that player's turn.
 */
export interface PlayerLeftMessage extends NetMessageBase {
  readonly type: 'PLAYER_LEFT';
  readonly playerId: PlayerId;
  readonly reason: 'left' | 'timeout' | 'kicked';
  /** false = slot kept for TIMING.RECONNECT_GRACE_MS, true = gone for good. */
  readonly removed: boolean;
}

// ---------------------------------------------------------------------------
// Gameplay
// ---------------------------------------------------------------------------

/**
 * SENDER: the player taking the shot, broadcast to the full mesh (host included).
 * RECEIVER: validates it is that player's turn (together) / that they are still
 * playing (battle), then replays the shot through the deterministic simulation to
 * animate it. Peers do NOT change scores from this message - they wait for
 * SHOT_RESOLVED. Duplicate (roundIndex, strokeNumber) pairs are ignored.
 */
export interface PlayerShotMessage extends NetMessageBase {
  readonly type: 'PLAYER_SHOT';
  readonly shot: ShotInput;
}

/**
 * SENDER: host only, after running the same simulation.
 * RECEIVER: snaps the ball to `restPos` and takes `strokesAfter` as authoritative
 * (this is the drift repair). In 'together' mode `nextPlayerId` is whose turn it is now.
 */
export interface ShotResolvedMessage extends NetMessageBase {
  readonly type: 'SHOT_RESOLVED';
  readonly playerId: PlayerId;
  readonly roundIndex: number;
  readonly strokeNumber: number;
  readonly restPos: Vec2;
  readonly holed: boolean;
  readonly penaltyStrokes: number;
  /** Authoritative stroke count for this player after the shot (penalties included). */
  readonly strokesAfter: number;
  /** 'together' mode: whose turn it is now. null in 'battle' or when the round ended. */
  readonly nextPlayerId: PlayerId | null;
}

/**
 * SENDER: host only.
 * RECEIVER: marks the player holed with the given order and plays the celebration.
 * Emitted alongside SHOT_RESOLVED so late/dropped messages still converge.
 */
export interface PlayerReachedGoalMessage extends NetMessageBase {
  readonly type: 'PLAYER_REACHED_GOAL';
  readonly playerId: PlayerId;
  readonly roundIndex: number;
  /** Final stroke count for the round, penalties included. */
  readonly strokes: number;
  /** 1-based finishing order within the round. */
  readonly holeOutOrder: number;
}

/**
 * SENDER: host only.
 * RECEIVER: regenerates levels locally via generateLevel(roomSeed, roundIndex,
 * variantIndex) for every entry in `variants`, resets per-round player fields and
 * switches status to 'playing'. Nothing about the geometry is transmitted.
 */
export interface RoundStartedMessage extends NetMessageBase {
  readonly type: 'ROUND_STARTED';
  readonly roundIndex: number;
  readonly mode: 'together' | 'battle';
  readonly roomSeed: number;
  /** In 'together' every entry carries the SAME variantIndex (0). */
  readonly variants: readonly PlayerVariant[];
  readonly turnOrder: readonly PlayerId[];
  readonly activePlayerId: PlayerId | null;
  readonly startedAt: Timestamp;
}

/**
 * SENDER: host only.
 * RECEIVER: replaces round/total scores with the authoritative summary and shows
 * the round-summary screen. Scores are NEVER computed independently by peers.
 */
export interface RoundCompletedMessage extends NetMessageBase {
  readonly type: 'ROUND_COMPLETED';
  readonly summary: RoundSummary;
}

/**
 * SENDER: host only (round limit reached, or the host pressed End Game).
 * RECEIVER: shows final results. Nothing is persisted anywhere.
 */
export interface GameEndedMessage extends NetMessageBase {
  readonly type: 'GAME_ENDED';
  readonly reason: GameEndReason;
  readonly results: GameResults;
}

// ---------------------------------------------------------------------------
// Room management
// ---------------------------------------------------------------------------

/**
 * SENDER: the peer that just won the host election (it announces itself).
 * RECEIVER: accepts only when `term` is strictly greater than the term it has
 * seen; then it sets hostPlayerId and sends REQUEST_STATE to the new host.
 * Ties are impossible because the election is deterministic (lowest joinSeq among
 * connected players wins) and the term is monotonic.
 */
export interface HostChangedMessage extends NetMessageBase {
  readonly type: 'HOST_CHANGED';
  readonly newHostPlayerId: PlayerId;
  /** Monotonic election term; higher wins. */
  readonly term: number;
}

/**
 * SENDER: everyone, every TIMING.HEARTBEAT_MS.
 * RECEIVER: refreshes lastSeenAt. Missing HOST heartbeats for TIMING.HOST_TIMEOUT_MS
 * triggers host election. `stateVersion` mismatch against the host makes a peer
 * send REQUEST_STATE.
 */
export interface HeartbeatMessage extends NetMessageBase {
  readonly type: 'HEARTBEAT';
  readonly status: GameStatus;
  readonly stateVersion: number;
  readonly isHost: boolean;
}

/**
 * SENDER: any peer, on a timer.
 * RECEIVER: must reply with PONG carrying the same nonce immediately.
 */
export interface PingMessage extends NetMessageBase {
  readonly type: 'PING';
  readonly nonce: string;
}

/**
 * SENDER: the peer that received PING.
 * RECEIVER: rtt = Date.now() - pingTs. Used only for the latency pill.
 */
export interface PongMessage extends NetMessageBase {
  readonly type: 'PONG';
  readonly nonce: string;
  /** Echo of the PING's ts. */
  readonly pingTs: Timestamp;
}

/**
 * SENDER: host only, periodically and after any repair.
 * RECEIVER: applies the snapshot when snapshot.stateVersion > local stateVersion.
 * Never applied while a local shot animation is mid-flight; queue it until rest.
 */
export interface StateSyncMessage extends NetMessageBase {
  readonly type: 'STATE_SYNC';
  readonly snapshot: GameSnapshot;
}

/**
 * SENDER: host only, and only while status === 'lobby' or 'round-summary'.
 * RECEIVER: replaces settings wholesale.
 */
export interface SettingsChangedMessage extends NetMessageBase {
  readonly type: 'SETTINGS_CHANGED';
  readonly settings: GameSettings;
}

/**
 * SENDER: any peer, directed at the host.
 * RECEIVER (host): replies with STATE_SYNC. Rate-limited to one reply per peer per second.
 */
export interface RequestStateMessage extends NetMessageBase {
  readonly type: 'REQUEST_STATE';
  readonly reason: 'joined' | 'drift' | 'reconnect' | 'host-change' | 'manual';
}

/**
 * SENDER: any peer. Purely cosmetic reaction.
 * RECEIVER: may show a floating emoji; safe to ignore entirely.
 */
export interface EmoteMessage extends NetMessageBase {
  readonly type: 'EMOTE';
  /** One of the curated emoji in `config.EMOTES`; anything else is ignored. */
  readonly emoji: string;
}

// ---------------------------------------------------------------------------
// Union + helpers
// ---------------------------------------------------------------------------

export type NetMessage =
  | HelloMessage
  | WelcomeMessage
  | PlayerJoinedMessage
  | PlayerLeftMessage
  | PlayerShotMessage
  | ShotResolvedMessage
  | PlayerReachedGoalMessage
  | RoundStartedMessage
  | RoundCompletedMessage
  | GameEndedMessage
  | HostChangedMessage
  | HeartbeatMessage
  | PingMessage
  | PongMessage
  | StateSyncMessage
  | SettingsChangedMessage
  | RequestStateMessage
  | EmoteMessage;

export type NetMessageType = NetMessage['type'];

/** The message interface for one `type`. */
export type MessageOf<K extends NetMessageType> = Extract<NetMessage, { type: K }>;

/**
 * A message without its envelope. `sequencer.send()` takes this and stamps
 * {v, seq, from, ts} itself, so call sites can never desync the counter.
 */
export type NetMessageBody<K extends NetMessageType = NetMessageType> = Omit<
  MessageOf<K>,
  keyof NetMessageBase
>;

/** Handler signature used by roomSession's dispatch table. */
export type NetMessageHandler = (msg: NetMessage) => void;

/**
 * Messages exempt from sequence-gap rejection: they are stateless and must work
 * even when an older message is still in flight.
 */
export const ALWAYS_ACCEPT: ReadonlySet<NetMessageType> = new Set<NetMessageType>([
  'PING',
  'PONG',
  'HEARTBEAT',
  'HELLO',
]);

/** Messages only the host may legitimately send; reject them from anyone else. */
export const HOST_ONLY: ReadonlySet<NetMessageType> = new Set<NetMessageType>([
  'WELCOME',
  'PLAYER_JOINED',
  'PLAYER_LEFT',
  'SHOT_RESOLVED',
  'PLAYER_REACHED_GOAL',
  'ROUND_STARTED',
  'ROUND_COMPLETED',
  'GAME_ENDED',
  'STATE_SYNC',
  'SETTINGS_CHANGED',
]);

// ---------------------------------------------------------------------------
// Runtime validation (input from untrusted peers)
// ---------------------------------------------------------------------------

type UnknownRecord = Record<string, unknown>;

const isRecord = (x: unknown): x is UnknownRecord => typeof x === 'object' && x !== null;
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isInt = (x: unknown): x is number => isNum(x) && Number.isInteger(x);
const isStr = (x: unknown): x is string => typeof x === 'string';
const isBool = (x: unknown): x is boolean => typeof x === 'boolean';
const isNullOr = <T>(x: unknown, check: (v: unknown) => v is T): x is T | null =>
  x === null || check(x);
const isVec2 = (x: unknown): x is Vec2 => isRecord(x) && isNum(x.x) && isNum(x.y);
const isArrayOf = <T>(x: unknown, check: (v: unknown) => v is T): x is readonly T[] =>
  Array.isArray(x) && x.every((item) => check(item));
const isVariant = (x: unknown): x is PlayerVariant =>
  isRecord(x) && isStr(x.playerId) && isInt(x.variantIndex);

const isShotInput = (x: unknown): x is ShotInput => {
  if (!isRecord(x)) return false;
  if (!isStr(x.playerId) || !isInt(x.roundIndex) || !isInt(x.strokeNumber)) return false;
  if (!isNum(x.power) || x.power < 0 || x.power > 1) return false;
  if (!isVec2(x.aim)) return false;
  // Reject a degenerate or absurd aim vector before it can poison the simulation.
  const len = Math.sqrt(x.aim.x * x.aim.x + x.aim.y * x.aim.y);
  return len > 0.5 && len < 1.5;
};

type PayloadValidator = (m: UnknownRecord) => boolean;

/**
 * One validator per message type. Declared as a full Record so the compiler
 * fails the build if a new message type is added without a validator.
 */
const PAYLOAD_VALIDATORS: Readonly<Record<NetMessageType, PayloadValidator>> = {
  HELLO: (m) =>
    isInt(m.protocol) && isStr(m.displayName) && isStr(m.color) && isStr(m.roomCode) && isBool(m.reconnect),
  WELCOME: (m) =>
    isRecord(m.snapshot) &&
    isStr(m.youAre) &&
    isStr(m.hostPlayerId) &&
    isBool(m.rejected) &&
    isNullOr(m.rejectReason, isStr),
  PLAYER_JOINED: (m) => isRecord(m.player) && isStr(m.player.id),
  PLAYER_LEFT: (m) =>
    isStr(m.playerId) &&
    isStr(m.reason) &&
    (m.reason === 'left' || m.reason === 'timeout' || m.reason === 'kicked') &&
    isBool(m.removed),
  PLAYER_SHOT: (m) => isShotInput(m.shot),
  SHOT_RESOLVED: (m) =>
    isStr(m.playerId) &&
    isInt(m.roundIndex) &&
    isInt(m.strokeNumber) &&
    isVec2(m.restPos) &&
    isBool(m.holed) &&
    isInt(m.penaltyStrokes) &&
    isInt(m.strokesAfter) &&
    isNullOr(m.nextPlayerId, isStr),
  PLAYER_REACHED_GOAL: (m) =>
    isStr(m.playerId) && isInt(m.roundIndex) && isInt(m.strokes) && isInt(m.holeOutOrder),
  ROUND_STARTED: (m) =>
    isInt(m.roundIndex) &&
    (m.mode === 'together' || m.mode === 'battle') &&
    isInt(m.roomSeed) &&
    isArrayOf(m.variants, isVariant) &&
    isArrayOf(m.turnOrder, isStr) &&
    isNullOr(m.activePlayerId, isStr) &&
    isNum(m.startedAt),
  ROUND_COMPLETED: (m) => isRecord(m.summary) && isArrayOf((m.summary as UnknownRecord).results, isRecord),
  GAME_ENDED: (m) => isStr(m.reason) && isRecord(m.results),
  HOST_CHANGED: (m) => isStr(m.newHostPlayerId) && isInt(m.term),
  HEARTBEAT: (m) => isStr(m.status) && isInt(m.stateVersion) && isBool(m.isHost),
  PING: (m) => isStr(m.nonce),
  PONG: (m) => isStr(m.nonce) && isNum(m.pingTs),
  STATE_SYNC: (m) => isRecord(m.snapshot) && isInt((m.snapshot as UnknownRecord).stateVersion),
  SETTINGS_CHANGED: (m) => isRecord(m.settings),
  REQUEST_STATE: (m) => isStr(m.reason),
  EMOTE: (m) => isStr(m.emoji) && m.emoji.length <= 8,
};

/** Every valid message type, derived from the validator table so it can never drift. */
export const NET_MESSAGE_TYPES: readonly NetMessageType[] = Object.keys(
  PAYLOAD_VALIDATORS,
) as NetMessageType[];

const TYPE_SET: ReadonlySet<string> = new Set<string>(NET_MESSAGE_TYPES);

export function isNetMessageType(x: unknown): x is NetMessageType {
  return isStr(x) && TYPE_SET.has(x);
}

/**
 * Full structural validation of anything arriving off the network.
 * Call this on EVERY decoded payload before it reaches game state.
 */
export function isNetMessage(x: unknown): x is NetMessage {
  if (!isRecord(x)) return false;
  if (!isInt(x.v) || !isInt(x.seq) || x.seq < 0) return false;
  if (!isStr(x.from) || x.from.length === 0) return false;
  if (!isNum(x.ts)) return false;
  if (!isNetMessageType(x.type)) return false;
  return PAYLOAD_VALIDATORS[x.type](x);
}

/** Generic narrowing: `if (isMessageOfType(msg, 'PLAYER_SHOT')) { msg.shot ... }` */
export function isMessageOfType<K extends NetMessageType>(
  msg: NetMessage,
  type: K,
): msg is MessageOf<K> {
  return msg.type === type;
}

// Per-type narrowing helpers (tree-shakeable, nicer at call sites than string compares).
export const isHello = (m: NetMessage): m is HelloMessage => m.type === 'HELLO';
export const isWelcome = (m: NetMessage): m is WelcomeMessage => m.type === 'WELCOME';
export const isPlayerJoined = (m: NetMessage): m is PlayerJoinedMessage => m.type === 'PLAYER_JOINED';
export const isPlayerLeft = (m: NetMessage): m is PlayerLeftMessage => m.type === 'PLAYER_LEFT';
export const isPlayerShot = (m: NetMessage): m is PlayerShotMessage => m.type === 'PLAYER_SHOT';
export const isShotResolved = (m: NetMessage): m is ShotResolvedMessage => m.type === 'SHOT_RESOLVED';
export const isPlayerReachedGoal = (m: NetMessage): m is PlayerReachedGoalMessage =>
  m.type === 'PLAYER_REACHED_GOAL';
export const isRoundStarted = (m: NetMessage): m is RoundStartedMessage => m.type === 'ROUND_STARTED';
export const isRoundCompleted = (m: NetMessage): m is RoundCompletedMessage => m.type === 'ROUND_COMPLETED';
export const isGameEnded = (m: NetMessage): m is GameEndedMessage => m.type === 'GAME_ENDED';
export const isHostChanged = (m: NetMessage): m is HostChangedMessage => m.type === 'HOST_CHANGED';
export const isHeartbeat = (m: NetMessage): m is HeartbeatMessage => m.type === 'HEARTBEAT';
export const isPing = (m: NetMessage): m is PingMessage => m.type === 'PING';
export const isPong = (m: NetMessage): m is PongMessage => m.type === 'PONG';
export const isStateSync = (m: NetMessage): m is StateSyncMessage => m.type === 'STATE_SYNC';
export const isSettingsChanged = (m: NetMessage): m is SettingsChangedMessage =>
  m.type === 'SETTINGS_CHANGED';
export const isRequestState = (m: NetMessage): m is RequestStateMessage => m.type === 'REQUEST_STATE';
export const isEmote = (m: NetMessage): m is EmoteMessage => m.type === 'EMOTE';

/** True when `msg` may only come from the host and `from` is not the host. */
export function isUnauthorizedHostMessage(msg: NetMessage, hostPlayerId: PlayerId): boolean {
  return HOST_ONLY.has(msg.type) && msg.from !== hostPlayerId;
}
