import { DEFAULT_TEAM_COUNT, autoAssignTeams, interleaveByTeam } from '@/game/rules/teams';
/**
 * ROOM SESSION - the orchestrator that turns a pile of DataChannels into a game.
 *
 * It owns, and is the only thing that owns:
 *   transport (mesh or loopback)  x  sequencer (dedupe + logical clock)
 *   x  heartbeat (liveness)  x  host election  x  the reducer (game state)
 *
 * Everything above it (React, the store, the screens) only ever sees
 * `getState()`, `subscribe()` and `onEvent()`. Everything below it only ever
 * sees `NetMessage`s. That is the seam that makes this testable with the
 * in-memory loopback transport and no browser at all.
 *
 * ---------------------------------------------------------------------------
 * THE TRUST MODEL - read this before extending anything here.
 * ---------------------------------------------------------------------------
 * This is a CASUAL, HOST-AUTHORITATIVE, FRIENDS-ONLY game.
 *
 * One peer is the host. It resolves every shot, assigns hole-out order, computes
 * scores and hands out state snapshots; everybody else takes its word for it.
 * The host is TRUSTED. A modified client running as host could award itself a
 * hole-in-one, and a modified guest could send a shot out of turn that the host
 * would reject but that other guests will still briefly animate.
 *
 * That is an ACCEPTED TRADE-OFF, not an oversight. The alternatives are a
 * server (the user ruled one out: no backend, no VPS, no paid service) or
 * cryptographic lockstep with commit-reveal, which would add a round trip to
 * every putt in a game whose whole appeal is that it is instant. We validate
 * everything structurally (`isNetMessage`), we reject host-only messages from
 * non-hosts (`isUnauthorizedHostMessage`), we gate duplicates and replays
 * (`sequencer`), and we stop there.
 *
 * THE SERVER SEAM: if this ever needs to be cheat-proof, nothing in the protocol
 * has to change. A dedicated authoritative server becomes simply "the peer that
 * always wins the host election": point the transport at it, make `electHost`
 * prefer it, and every message on the wire keeps its exact current meaning.
 * That is why host authority is a LOGIC layer on top of a full mesh rather than
 * a star topology - the topology already supports any peer being the authority.
 *
 * ---------------------------------------------------------------------------
 * HOW ONE SHOT FLOWS (lockstep input replay, not state replication)
 * ---------------------------------------------------------------------------
 *   1. `submitShot(aim, power)` validates locally and broadcasts ONE
 *      `PLAYER_SHOT` of about 120 bytes: {playerId, roundIndex, strokeNumber,
 *      aim:{x,y}, power}. No positions, ever.
 *   2. EVERY peer - the sender included, through the identical code path - feeds
 *      that input to the deterministic simulation and emits `shot-playback`.
 *      Same inputs, same physics, same trajectory on every device.
 *   3. The host applies the authoritative outcome and broadcasts
 *      `SHOT_RESOLVED` (plus `PLAYER_REACHED_GOAL`), which repairs any drift.
 *   4. Guests reconcile. The shooter had already applied its own result
 *      optimistically so its UI never waits for the round trip.
 */

import {
  DEFAULT_BATTLE_ROUNDS,
  DEFAULT_SETTINGS,
  EMOTES,
  LIMITS,
  PHYSICS,
  TIMING,
  playerColorFor,
} from '@/game/config';
import { replayShot } from '@/game/physics/simulate';
import {
  canShoot,
  isBattleRoundOver,
  shouldEndGame,
  variantIndexFor,
} from '@/game/rules/competitive';
import { isTogetherRoundOver, nextTurn } from '@/game/rules/friendship';
import { finalStandings, summariseRound } from '@/game/rules/scoring';
import {
  ALWAYS_ACCEPT,
  isUnauthorizedHostMessage,
  type MessageOf,
  type NetMessage,
  type NetMessageBody,
  type NetMessageType,
} from '@/multiplayer/protocol/messages';
import { createSequencer, type Sequencer } from '@/multiplayer/protocol/sequencer';
import { PROTOCOL_VERSION, isCompatibleVersion } from '@/multiplayer/protocol/version';
import type { Transport } from '@/multiplayer/transport/types';
import { createInitialState, gameReducer, type GameAction } from '@/state/gameReducer';
import {
  err,
  isLiveConnection,
  ok,
  type GameMode,
  type GameSettings,
  type GameSnapshot,
  type GameState,
  type LevelSpec,
  type PeerInfo,
  type PlayerId,
  type PlayerState,
  type Result,
  type RoomIdentity,
  type RoundSnapshot,
  type RoundState,
  type ShotInput,
  type ShotResult,
  type TeamId,
  type Timestamp,
  type Unsubscribe,
  type Vec2,
} from '@/types';
import { roomSeedFromCode } from '@/utils/roomCode';

import { createHeartbeat, systemClock, type HeartbeatClock } from './heartbeat';
import { createHostWatchdog, electHost, playersOf } from './hostElection';

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * Things that HAPPEN, as opposed to state that IS.
 *
 * State lives in `GameState` and arrives through `subscribe()`. This channel is
 * for one-shot things a screen wants to react to: play this trajectory, fire the
 * confetti, the host changed under you.
 */
export type SessionEvent =
  | { readonly type: 'shot-playback'; readonly playerId: PlayerId; readonly result: ShotResult }
  | { readonly type: 'holed'; readonly playerId: PlayerId; readonly strokes: number }
  | { readonly type: 'round-started'; readonly roundIndex: number }
  | { readonly type: 'round-completed'; readonly roundIndex: number }
  | { readonly type: 'game-ended' }
  | { readonly type: 'emote'; readonly playerId: PlayerId; readonly emoji: string }
  | { readonly type: 'host-changed'; readonly hostPlayerId: PlayerId }
  /** Membership change. Not in the original contract; added because the room UI needs it. */
  | { readonly type: 'player-joined'; readonly playerId: PlayerId; readonly displayName: string }
  /** `removed: false` means the seat is held for `TIMING.RECONNECT_GRACE_MS`. */
  | { readonly type: 'player-left'; readonly playerId: PlayerId; readonly removed: boolean }
  | { readonly type: 'error'; readonly message: string };

export interface RoomSessionOptions {
  readonly identity: RoomIdentity;
  readonly transport: Transport;
  readonly mode: GameMode;
  readonly isHost: boolean;
  readonly settings?: Partial<GameSettings>;
  /** True when rejoining a room we were already in (same playerId). Default false. */
  readonly reconnect?: boolean;
  /**
   * True when this player originally created the room. Lets them take an EMPTY
   * room back after a reload, instead of waiting forever for a WELCOME from a
   * host that is no longer there.
   */
  readonly reclaimHost?: boolean;
  /** Injectable clock; tests pass a manual one and never touch real timers. */
  readonly clock?: HeartbeatClock;
}

export interface RoomSession {
  getState(): GameState;
  subscribe(listener: (state: GameState) => void): Unsubscribe;
  onEvent(listener: (event: SessionEvent) => void): Unsubscribe;
  start(): Promise<Result<void, string>>;
  /** Host only; returns `err` for guests. */
  startGame(): Result<void, string>;
  startNextRound(): Result<void, string>;
  changeSettings(patch: Partial<GameSettings>): Result<void, string>;
  endGame(): Result<void, string>;
  /** Any player, on their own turn / their own course. */
  submitShot(aim: Vec2, power: number): Result<void, string>;
  sendEmote(emoji: string): void;
  leave(): void;
  /** True when this peer currently holds host authority. */
  isHost(): boolean;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const ORIGIN: Vec2 = { x: 0, y: 0 };

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function clampName(raw: string): string {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  const cut = trimmed.slice(0, LIMITS.MAX_NAME_LENGTH);
  return cut.length === 0 ? 'Player' : cut;
}

function normaliseRounds(value: number | null): number | null {
  if (value === null) return null;
  if (!Number.isFinite(value)) return null;
  const rounded = Math.floor(value);
  if (rounded < 1) return 1;
  if (rounded > LIMITS.MAX_ROUNDS) return LIMITS.MAX_ROUNDS;
  return rounded;
}

/**
 * Field-by-field merge that ignores `undefined`, so a partial patch can never
 * blank a setting by spreading an absent key over a good value.
 */
function mergeSettings(base: GameSettings, patch?: Partial<GameSettings>): GameSettings {
  if (patch === undefined) return base;
  return {
    totalRounds:
      patch.totalRounds !== undefined ? normaliseRounds(patch.totalRounds) : base.totalRounds,
    maxStrokes:
      typeof patch.maxStrokes === 'number' && Number.isFinite(patch.maxStrokes)
        ? Math.max(1, Math.floor(patch.maxStrokes))
        : base.maxStrokes,
    rankBy: patch.rankBy !== undefined ? patch.rankBy : base.rankBy,
    difficultyBias:
      typeof patch.difficultyBias === 'number' ? clamp01(patch.difficultyBias) : base.difficultyBias,
    allowLateJoin:
      typeof patch.allowLateJoin === 'boolean' ? patch.allowLateJoin : base.allowLateJoin,
  };
}

/** Dedupe key for a stroke: one shot per (player, round, stroke number), ever. */
function shotKey(shot: ShotInput): string {
  return `${shot.playerId}|${shot.roundIndex}|${shot.strokeNumber}`;
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

/**
 * `RoundState` -> the wire-safe `RoundSnapshot`.
 *
 * Note what is NOT here: `LevelSpec`. Courses are never transmitted. The
 * snapshot carries `variants` and every peer calls
 * `generateLevel(roomSeed, roundIndex, variantIndex)` to rebuild identical
 * geometry locally, which is what keeps a join message under a kilobyte.
 */
function roundSnapshotOf(round: RoundState, players: readonly PlayerState[]): RoundSnapshot {
  if (round.mode !== 'battle') {
    return {
      mode: round.mode,
      roundIndex: round.roundIndex,
      startedAt: round.startedAt,
      turnOrder: round.turnOrder,
      turnCursor: round.turnCursor,
      activePlayerId: round.activePlayerId,
      // Co-op: one shared course, so everybody is on variant 0.
      variants: players.map((player) => ({ playerId: player.id, variantIndex: 0 })),
      holeOutCounter: round.holeOutCounter,
      completed: round.completed,
      // The shared ball is group state, so it has to travel with the snapshot;
      // without it a late joiner would rebuild the round with the ball on the tee.
      balls: round.balls,
      ballsHoled: round.ballsHoled,
    };
  }
  return {
    mode: 'battle',
    roundIndex: round.roundIndex,
    startedAt: round.startedAt,
    // Battle takes turns now, so its real rotation must travel too.
    turnOrder: round.turnOrder.length > 0 ? round.turnOrder : players.map((player) => player.id),
    turnCursor: round.turnCursor,
    activePlayerId: round.activePlayerId,
    variants: players.map((player) => ({
      playerId: player.id,
      variantIndex: player.levelSeedVariant,
    })),
    holeOutCounter: round.holeOutCounter,
    completed: round.completed,
  };
}

/**
 * The whole room, flattened for `WELCOME` / `STATE_SYNC`.
 * Exported because it is the canonical definition of "what a joiner is told".
 */
export function buildSnapshot(state: GameState): GameSnapshot {
  const players = playersOf(state);
  return {
    roomCode: state.roomCode,
    mode: state.mode,
    hostPlayerId: state.hostPlayerId,
    status: state.status,
    roomSeed: state.roomSeed,
    currentRoundIndex: state.currentRoundIndex,
    totalRounds: state.totalRounds,
    settings: state.settings,
    players,
    round: state.roundState === null ? null : roundSnapshotOf(state.roundState, players),
    stateVersion: state.stateVersion,
    results: state.results,
  };
}

// ---------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------

/** Heartbeats a room's creator waits, alone, before taking its room back. */
const RECLAIM_AFTER_TICKS = 4;

export function createRoomSession(options: RoomSessionOptions): RoomSession {
  const { identity, transport, mode } = options;
  const clock = options.clock ?? systemClock;
  const now = (): Timestamp => clock.now();

  const settings = mergeSettings(
    {
      ...DEFAULT_SETTINGS,
      // A battle without a round limit never ends, so give it the default count.
      totalRounds: mode === 'battle' ? DEFAULT_BATTLE_ROUNDS : DEFAULT_SETTINGS.totalRounds,
    },
    options.settings,
  );

  const sequencer: Sequencer = createSequencer(identity.playerId, { now });
  const watchdog = createHostWatchdog();

  // The room seed is DERIVED from the room code, not transmitted, so every peer
  // agrees on it the instant it knows the code - even before the handshake.
  let state: GameState = createInitialState({
    identity,
    mode,
    roomSeed: roomSeedFromCode(identity.roomCode),
    settings,
    isHost: options.isHost,
  });

  const stateListeners = new Set<(next: GameState) => void>();
  const eventListeners = new Set<(event: SessionEvent) => void>();

  /** Strokes already simulated locally, so a retransmit never animates twice. */
  const appliedShots = new Set<string>();
  /** Players we have already announced as permanently gone. */
  const removedPlayers = new Set<PlayerId>();
  /** Host-side rate limiting for REQUEST_STATE replies. */
  const lastStateReplyAt = new Map<PlayerId, Timestamp>();
  /** Peers we have already complained about, so a version mismatch logs once. */
  const versionWarned = new Set<PlayerId>();

  /** Highest election term seen. Guards against a stale HOST_CHANGED winning. */
  let lastTerm = 0;
  let lastSyncAt = 0;
  let started = false;
  let closed = false;
  /** Guests: true once the host has answered our HELLO. */
  let welcomed = options.isHost;
  /** Heartbeats spent waiting for a WELCOME that never came. */
  let unwelcomedTicks = 0;
  /** playerId -> when the turn was handed to them. Host-side only. */
  const turnStartedAt = new Map<PlayerId, Timestamp>();

  let unsubMessages: Unsubscribe | null = null;
  let unsubPeers: Unsubscribe | null = null;
  let unsubTick: Unsubscribe | null = null;
  let detachUnload: (() => void) | null = null;

  // -- plumbing ------------------------------------------------------------

  function emit(event: SessionEvent): void {
    for (const listener of Array.from(eventListeners)) {
      try {
        listener(event);
      } catch {
        // A broken subscriber must not take the room down with it.
      }
    }
  }

  function setState(next: GameState): void {
    if (next === state) return;
    state = next;
    for (const listener of Array.from(stateListeners)) {
      try {
        listener(next);
      } catch {
        // As above: presentation failures never break the session.
      }
    }
  }

  function dispatch(action: GameAction): void {
    setState(gameReducer(state, action));
  }

  function fail(message: string): Result<void, string> {
    emit({ type: 'error', message });
    return err(message);
  }

  function isHostNow(): boolean {
    return state.hostPlayerId === identity.playerId;
  }

  function self(): PlayerState | null {
    const player = state.players[identity.playerId];
    return player === undefined ? null : player;
  }

  /** Stamp + broadcast. Returns the stamped message so the caller can apply it. */
  function broadcast<K extends NetMessageType>(body: NetMessageBody<K>): MessageOf<K> {
    const message = sequencer.stamp<K>(body);
    if (!closed) transport.broadcast(message);
    return message;
  }

  function sendTo<K extends NetMessageType>(target: PlayerId, body: NetMessageBody<K>): void {
    if (closed) return;
    transport.sendTo(target, sequencer.stamp<K>(body));
  }

  /**
   * Apply a message to our own state and emit whatever the UI derives from it.
   * The host calls this on messages it has just broadcast, so host and guests
   * run the EXACT same reducer path - there is no privileged local mutation.
   */
  function applyNet(message: NetMessage): void {
    dispatch({ type: 'net', message, now: now() });

    switch (message.type) {
      case 'ROUND_STARTED':
        appliedShots.clear();
        emit({ type: 'round-started', roundIndex: message.roundIndex });
        break;
      case 'ROUND_COMPLETED':
        emit({ type: 'round-completed', roundIndex: message.summary.roundIndex });
        break;
      case 'GAME_ENDED':
        emit({ type: 'game-ended' });
        break;
      case 'PLAYER_REACHED_GOAL':
        emit({ type: 'holed', playerId: message.playerId, strokes: message.strokes });
        break;
      case 'PLAYER_JOINED':
        emit({
          type: 'player-joined',
          playerId: message.player.id,
          displayName: message.player.displayName,
        });
        break;
      case 'PLAYER_LEFT':
        emit({ type: 'player-left', playerId: message.playerId, removed: message.removed });
        break;
      default:
        break;
    }
  }

  /** Broadcast an authoritative message AND apply it locally. Host only. */
  function hostEmit<K extends NetMessageType>(body: NetMessageBody<K>): void {
    applyNet(broadcast<K>(body));
  }

  // -- membership ----------------------------------------------------------

  function nextJoinSeq(): number {
    let highest = -1;
    for (const player of playersOf(state)) {
      if (player.joinSeq > highest) highest = player.joinSeq;
    }
    return highest + 1;
  }

  function spawnPosFor(playerId: PlayerId): Vec2 {
    const level = levelFor(playerId);
    return level === null ? ORIGIN : level.ballStart;
  }

  function buildPlayer(id: PlayerId, displayName: string, joinSeq: number): PlayerState {
    const draft: PlayerState = {
      id,
      displayName: clampName(displayName),
      // Colour comes from join order, not from the joiner's request: that is the
      // only way to guarantee eight distinguishable balls with no negotiation.
      color: playerColorFor(joinSeq),
      joinSeq,
      connected: true,
      isHost: false,
      currentPos: spawnPosFor(id),
      strokes: 0,
      holed: false,
      holeOutOrder: null,
      roundScore: 0,
      totalScore: 0,
      roundWins: 0,
      levelSeedVariant: 0,
      teamId: null,
      thinkTimeMs: 0,
      penaltyStrokes: 0,
    };
    return { ...draft, levelSeedVariant: variantIndexFor(draft, state.mode) };
  }

  /** The host must exist in its own player list before anyone can join it. */
  function ensureSelfPlayer(): void {
    if (state.players[identity.playerId] !== undefined) return;
    if (!isHostNow()) return; // Guests receive their seat from the host's WELCOME.
    const player = buildPlayer(identity.playerId, identity.displayName, nextJoinSeq());
    dispatch({ type: 'local/player-joined', player: { ...player, isHost: true } });
  }

  // -- levels --------------------------------------------------------------

  function levelFor(playerId: PlayerId): LevelSpec | null {
    const round = state.roundState;
    if (round === null) return null;
    if (round.mode !== 'battle') return round.level;
    const level = round.levels[playerId];
    return level === undefined ? null : level;
  }

  // -- handshake -----------------------------------------------------------

  function sendHello(): void {
    broadcast<'HELLO'>({
      type: 'HELLO',
      protocol: PROTOCOL_VERSION,
      displayName: identity.displayName,
      color: identity.color,
      roomCode: identity.roomCode,
      reconnect: options.reconnect === true,
    });
  }

  function rejectJoin(target: PlayerId, reason: string): void {
    sendTo<'WELCOME'>(target, {
      type: 'WELCOME',
      snapshot: buildSnapshot(state),
      youAre: target,
      hostPlayerId: state.hostPlayerId,
      rejected: true,
      rejectReason: reason,
    });
  }

  function handleHello(message: MessageOf<'HELLO'>): void {
    const joiner = message.from;
    if (!isHostNow()) return; // Only the host answers; guests just noted the peer.

    if (!isCompatibleVersion(message.protocol)) {
      rejectJoin(joiner, 'That player is on a different version of the game.');
      return;
    }
    if (message.roomCode !== identity.roomCode) {
      rejectJoin(joiner, 'Wrong room code.');
      return;
    }

    const existing = state.players[joiner];
    if (existing === undefined) {
      const count = playersOf(state).length;
      if (count >= LIMITS.MAX_PLAYERS) {
        rejectJoin(joiner, `This room is full (${LIMITS.MAX_PLAYERS} players).`);
        return;
      }
      if (state.status !== 'lobby' && !state.settings.allowLateJoin) {
        rejectJoin(joiner, 'This game has already started.');
        return;
      }
      hostEmit<'PLAYER_JOINED'>({
        type: 'PLAYER_JOINED',
        player: buildPlayer(joiner, message.displayName, nextJoinSeq()),
      });
    } else {
      // RECONNECT: the same playerId reclaims its seat, keeping joinSeq, colour,
      // strokes and score. This is the whole reason PlayerId survives a page
      // reload in sessionStorage while PeerId does not.
      removedPlayers.delete(joiner);
      hostEmit<'PLAYER_JOINED'>({
        type: 'PLAYER_JOINED',
        player: {
          ...existing,
          connected: true,
          displayName: clampName(message.displayName),
        },
      });
    }

    // WELCOME is sent AFTER PLAYER_JOINED was applied, so the snapshot the
    // joiner adopts already contains the joiner.
    sendTo<'WELCOME'>(joiner, {
      type: 'WELCOME',
      snapshot: buildSnapshot(state),
      youAre: joiner,
      hostPlayerId: state.hostPlayerId,
      rejected: false,
      rejectReason: null,
    });
  }

  function handleWelcome(message: MessageOf<'WELCOME'>): void {
    if (message.youAre !== identity.playerId) return; // Somebody else's welcome.
    welcomed = true;

    if (message.rejected) {
      emit({
        type: 'error',
        message: message.rejectReason ?? 'The host declined your join request.',
      });
      return;
    }

    applyNet(message);
    // Belt and braces: adopt the host the snapshot names, so subsequent
    // host-only messages pass the authorisation gate even if the reducer's
    // snapshot handling ever changes.
    dispatch({ type: 'local/host', hostPlayerId: message.hostPlayerId });
    watchdog.reset(now());
  }

  function handleRequestState(message: MessageOf<'REQUEST_STATE'>): void {
    if (!isHostNow()) return;
    const at = now();
    const last = lastStateReplyAt.get(message.from);
    if (last !== undefined && at - last < TIMING.STATE_REPLY_COOLDOWN_MS) return;
    lastStateReplyAt.set(message.from, at);
    sendTo<'STATE_SYNC'>(message.from, { type: 'STATE_SYNC', snapshot: buildSnapshot(state) });
  }

  // -- host migration ------------------------------------------------------

  function claimHost(at: Timestamp): void {
    // The election term comes from the logical clock, so it is strictly greater
    // than any term this peer has seen - two simultaneous claims resolve on term
    // first, and identically everywhere.
    const term = sequencer.tick();
    lastTerm = Math.max(lastTerm, term);

    dispatch({ type: 'local/host', hostPlayerId: identity.playerId });
    broadcast<'HOST_CHANGED'>({
      type: 'HOST_CHANGED',
      newHostPlayerId: identity.playerId,
      term,
    });
    emit({ type: 'host-changed', hostPlayerId: identity.playerId });

    // Everyone converges on our copy of the room immediately, rather than
    // waiting for the next periodic sync.
    broadcast<'STATE_SYNC'>({ type: 'STATE_SYNC', snapshot: buildSnapshot(state) });
    watchdog.reset(at);
    lastSyncAt = at;
  }

  function handleHostChanged(message: MessageOf<'HOST_CHANGED'>): void {
    sequencer.observe(message.term);
    if (message.term <= lastTerm) return; // A late claim from a losing election.
    lastTerm = message.term;

    const newHost = message.newHostPlayerId;
    dispatch({ type: 'local/host', hostPlayerId: newHost });
    emit({ type: 'host-changed', hostPlayerId: newHost });
    watchdog.reset(now());

    if (newHost !== identity.playerId) {
      sendTo<'REQUEST_STATE'>(newHost, { type: 'REQUEST_STATE', reason: 'host-change' });
    }
  }

  function runElection(at: Timestamp): void {
    // The host has gone quiet: take it out of the candidate list locally so the
    // election result matches what every other peer is computing right now.
    const silentHost = state.hostPlayerId;
    if (silentHost !== identity.playerId) {
      dispatch({ type: 'local/peer-state', playerId: silentHost, connected: false });
    }

    const winner = electHost(playersOf(state));
    if (winner === null) {
      emit({ type: 'error', message: 'Everyone else has left this room.' });
      return;
    }
    // Every peer computed the same winner with no coordination. If it is not us,
    // simply wait for their HOST_CHANGED; the watchdog will fire again if they
    // never announce, and the next-best candidate takes over.
    if (winner !== identity.playerId) {
      watchdog.reset(at);
      return;
    }
    claimHost(at);
  }

  // -- shots ---------------------------------------------------------------

  /**
   * Host authority for one stroke.
   *
   * `nextPlayerId` is the awkward bit: it belongs in `SHOT_RESOLVED`, but it can
   * only be computed from the state AFTER the shot lands. `gameReducer` is pure,
   * so we run it once as a dry run purely to ask `nextTurn()` who is up, then
   * send and apply the finished message exactly ONCE. The dry-run result is
   * thrown away; the real state transition happens below it.
   */
  function resolveShot(shooter: PlayerState, shot: ShotInput, result: ShotResult): void {
    const round = state.roundState;
    if (round === null) return;

    const strokesAfter = shooter.strokes + 1 + result.penaltyStrokes;

    // Deliberation time: from the moment this player was handed the turn until
    // their shot resolved. Deliberately NOT wall-clock since the round began —
    // that would just measure how far down the rotation you sit.
    const startedAt = turnStartedAt.get(shooter.id);
    const spent = startedAt === undefined ? 0 : Math.max(0, now() - startedAt);
    turnStartedAt.delete(shooter.id);
    const holeOutOrder = result.holed ? round.holeOutCounter + 1 : null;

    const draft = sequencer.stamp<'SHOT_RESOLVED'>({
      type: 'SHOT_RESOLVED',
      playerId: shooter.id,
      roundIndex: shot.roundIndex,
      strokeNumber: shot.strokeNumber,
      restPos: result.restPos,
      holed: result.holed,
      penaltyStrokes: result.penaltyStrokes,
      strokesAfter,
      thinkTimeMsAfter: shooter.thinkTimeMs + spent,
      penaltyStrokesAfter: shooter.penaltyStrokes + result.penaltyStrokes,
      nextPlayerId: null,
    });

    // Hand the turn on in BOTH modes. Simulating the shot first means the next
    // player is chosen from post-shot eligibility, so someone who just holed out
    // is skipped rather than being handed a turn they cannot take.
    let resolved = draft;
    {
      const provisional = gameReducer(state, { type: 'net', message: draft, now: now() });
      const upNext = nextTurn(provisional);
      if (upNext !== null) {
        resolved = { ...draft, nextPlayerId: upNext };
        // Their clock starts the instant the turn is theirs.
        turnStartedAt.set(upNext, now());
      }
    }

    transport.broadcast(resolved);
    applyNet(resolved);

    if (result.holed && holeOutOrder !== null) {
      // Sent alongside SHOT_RESOLVED so a dropped frame still converges.
      hostEmit<'PLAYER_REACHED_GOAL'>({
        type: 'PLAYER_REACHED_GOAL',
        playerId: shooter.id,
        roundIndex: shot.roundIndex,
        strokes: strokesAfter,
        holeOutOrder,
      });
    }

    maybeCompleteRound();
  }

  /**
   * One code path for every shot, local or remote. The sender runs this on its
   * own message too, so there is no "local shot" special case to drift.
   */
  function handlePlayerShot(message: MessageOf<'PLAYER_SHOT'>): void {
    const shot = message.shot;

    // You may only shoot for yourself. Cheap, and it blocks the one forgery that
    // would actually be disruptive in a friendly room.
    if (message.from !== shot.playerId) return;

    const key = shotKey(shot);
    if (appliedShots.has(key)) return;

    if (state.status !== 'playing' || state.roundState === null) return;
    if (shot.roundIndex !== state.currentRoundIndex) return;

    const shooter = state.players[shot.playerId];
    if (shooter === undefined || shooter.holed) return;
    if (!canShoot(state, shooter.id)) return;
    // Reject a stroke number we have already counted (a replay). We deliberately
    // ACCEPT one that runs ahead of us: a guest that missed a SHOT_RESOLVED
    // would otherwise freeze out that player until the next STATE_SYNC, and the
    // host's `strokesAfter` is authoritative either way.
    if (shot.strokeNumber <= shooter.strokes) return;

    const level = levelFor(shooter.id);
    if (level === null) return;

    appliedShots.add(key);

    // THE DETERMINISTIC REPLAY. Identical inputs, identical trajectory, on every
    // device - which is exactly why only the input crosses the wire.
    const result = replayShot(level, shooter.currentPos, shot);
    emit({ type: 'shot-playback', playerId: shooter.id, result });

    if (isHostNow()) {
      resolveShot(shooter, shot, result);
      return;
    }

    if (shooter.id === identity.playerId) {
      // Optimistic local application so our own UI never waits for the host.
      // SHOT_RESOLVED repairs whatever this got wrong (holeOutOrder in
      // particular is the host's to assign).
      dispatch({
        type: 'local/shot-applied',
        playerId: shooter.id,
        restPos: result.restPos,
        strokes: shooter.strokes + 1 + result.penaltyStrokes,
        holed: result.holed,
        holeOutOrder: null,
      });
    }
  }

  // -- rounds --------------------------------------------------------------

  function startRound(roundIndex: number): void {
    const players = playersOf(state).filter((player) => player.connected);

    // Anyone without a team gets one, balanced round-robin by join order.
    const assigned =
      state.mode === 'teams'
        ? autoAssignTeams(players, state.settings.teamCount ?? DEFAULT_TEAM_COUNT)
        : ({} as Record<PlayerId, TeamId>);

    // Interleave the rotation so teams alternate instead of one team playing out
    // its whole roster first — that is what makes it feel like a contest.
    const turnOrder =
      state.mode === 'teams'
        ? interleaveByTeam(players, assigned)
        : players.map((player) => player.id);

    // Fresh round, fresh clocks. The first player's deliberation starts now.
    turnStartedAt.clear();
    // Both modes take turns, so both need a first player.
    const first = turnOrder[0] ?? null;
    if (first !== null) turnStartedAt.set(first, now());

    appliedShots.clear();
    hostEmit<'ROUND_STARTED'>({
      type: 'ROUND_STARTED',
      roundIndex,
      mode: state.mode,
      roomSeed: state.roomSeed,
      // Only the variant INDEX travels; geometry is regenerated on each peer.
      // Team play: the HOST decides the teams and ships them with the round, so
      // every peer rebuilds the same groups without a second round trip.
      variants: players.map((player) => ({
        playerId: player.id,
        variantIndex: variantIndexFor(player, state.mode),
        teamId: state.mode === 'teams' ? (player.teamId ?? assigned[player.id] ?? null) : null,
      })),
      turnOrder,
      activePlayerId: first,
      startedAt: now(),
    });
  }

  function maybeCompleteRound(): void {
    if (!isHostNow()) return;
    if (state.status !== 'playing') return;
    const round = state.roundState;
    if (round === null || round.completed) return;

    const over = state.mode === 'together' ? isTogetherRoundOver(state) : isBattleRoundOver(state);
    if (!over) return;

    // Scores come from `game/rules/scoring`, which is the only module allowed to
    // call `placementPointsFor` / `efficiencyPointsFor`. Fewer hits => more
    // points is decided there and in `game/config`, never here.
    hostEmit<'ROUND_COMPLETED'>({ type: 'ROUND_COMPLETED', summary: summariseRound(state, round.roundIndex) });

    if (shouldEndGame(state)) {
      hostEmit<'GAME_ENDED'>({
        type: 'GAME_ENDED',
        reason: 'rounds-complete',
        results: finalStandings(state, 'rounds-complete'),
      });
    }
  }

  // -- periodic work -------------------------------------------------------

  function sweepMembership(at: Timestamp): void {
    // Soft drop: the seat is held, the score is kept, the pill goes grey.
    for (const playerId of heartbeat.staleSince(at, TIMING.HOST_TIMEOUT_MS)) {
      if (playerId === identity.playerId) continue;
      const player = state.players[playerId];
      if (player === undefined || !player.connected) continue;
      hostEmit<'PLAYER_LEFT'>({
        type: 'PLAYER_LEFT',
        playerId,
        reason: 'timeout',
        removed: false,
      });
    }

    // Hard drop: the grace window expired, the seat is released.
    for (const playerId of heartbeat.staleSince(at, TIMING.RECONNECT_GRACE_MS)) {
      if (playerId === identity.playerId) continue;
      if (removedPlayers.has(playerId)) continue;
      const player = state.players[playerId];
      if (player === undefined) continue;
      removedPlayers.add(playerId);
      heartbeat.forget(playerId);
      hostEmit<'PLAYER_LEFT'>({
        type: 'PLAYER_LEFT',
        playerId,
        reason: 'timeout',
        removed: true,
      });
    }
  }

  function onHeartbeatTick(): void {
    if (closed) return;
    const at = now();

    if (isHostNow()) {
      watchdog.reset(at);
      sweepMembership(at);
      if (state.status === 'playing' && at - lastSyncAt >= TIMING.STATE_SYNC_MS) {
        lastSyncAt = at;
        broadcast<'STATE_SYNC'>({ type: 'STATE_SYNC', snapshot: buildSnapshot(state) });
      }
      return;
    }

    // Guests: keep asking to be let in until the host answers. While the
    // handshake is unfinished we deliberately do NOT run elections - a peer that
    // has never been admitted must not crown itself host of a room it is not in.
    if (!welcomed) {
      unwelcomedTicks += 1;
      sendHello();
      watchdog.reset(at);

      // ...with one exception: the person who CREATED this room, reloading into
      // an empty room. Nobody is left to welcome them, so without this they sit
      // on "joining" forever and come back as a plain player in their own room.
      // Requiring zero connected peers keeps this from ever racing a real host.
      const alone = transport.peers().every((peer) => peer.state !== 'connected');
      if (options.reclaimHost === true && alone && unwelcomedTicks >= RECLAIM_AFTER_TICKS) {
        claimHost(at);
        welcomed = true;
      }
      return;
    }
    unwelcomedTicks = 0;

    const seen = heartbeat.lastSeen(state.hostPlayerId);
    if (seen !== null) watchdog.noteHostSeen(seen);
    if (watchdog.tick(at) === 'elect') runElection(at);
  }

  const heartbeat = createHeartbeat({
    send: (message) => {
      if (!closed) transport.broadcast(message);
    },
    stamp: sequencer.stamp,
    self: identity.playerId,
    getStatus: () => state.status,
    getStateVersion: () => state.stateVersion,
    isHost: isHostNow,
    clock,
  });

  // -- inbound -------------------------------------------------------------

  function route(message: NetMessage): void {
    switch (message.type) {
      case 'HELLO':
        handleHello(message);
        return;
      case 'WELCOME':
        handleWelcome(message);
        return;
      case 'PLAYER_SHOT':
        handlePlayerShot(message);
        return;
      case 'REQUEST_STATE':
        handleRequestState(message);
        return;
      case 'HOST_CHANGED':
        handleHostChanged(message);
        return;
      case 'EMOTE':
        if (EMOTES.includes(message.emoji)) {
          emit({ type: 'emote', playerId: message.from, emoji: message.emoji });
        }
        return;
      case 'PING':
      case 'PONG':
      case 'HEARTBEAT':
        // Fully handled by the heartbeat service; they carry no game state.
        return;
      default:
        applyNet(message);
        if (message.type === 'SHOT_RESOLVED') maybeCompleteRound();
        return;
    }
  }

  function onTransportMessage(message: NetMessage): void {
    if (closed) return;

    // Our own traffic never round-trips into our own reducer.
    if (message.from === identity.playerId) return;

    if (!isCompatibleVersion(message.v)) {
      if (!versionWarned.has(message.from)) {
        versionWarned.add(message.from);
        emit({
          type: 'error',
          message: 'A player is on a different version of the game - both of you should refresh.',
        });
      }
      return;
    }

    // THE DUPLICATE / OUT-OF-ORDER GATE. Everything past this line is guaranteed
    // to be newer than anything we have already applied from this sender.
    const verdict = sequencer.classify(message.from, message.seq);
    if (verdict !== 'accept' && !ALWAYS_ACCEPT.has(message.type)) return;

    // A HELLO whose counter went backwards means that peer reloaded and restarted
    // at seq 1. Forget its history or every one of its messages would look stale
    // for the rest of the room's life.
    if (message.type === 'HELLO' && verdict !== 'accept') sequencer.reset(message.from);

    heartbeat.handle(message);

    // Host-only messages from a non-host are dropped. The one exception is the
    // WELCOME that ends our own handshake: until it arrives we do not reliably
    // know who the host is, so we would otherwise reject the very message that
    // tells us.
    const bootstrapWelcome = message.type === 'WELCOME' && !welcomed && !isHostNow();
    if (!bootstrapWelcome && isUnauthorizedHostMessage(message, state.hostPlayerId)) return;

    route(message);
  }

  function onPeers(peers: readonly PeerInfo[]): void {
    if (closed) return;
    const at = now();
    for (const peer of peers) {
      if (peer.playerId === null) continue;
      const connected = isLiveConnection(peer.state);
      if (connected) heartbeat.noteSeen(peer.playerId, at);
      const player = state.players[peer.playerId];
      if (player === undefined || player.connected === connected) continue;
      dispatch({ type: 'local/peer-state', playerId: peer.playerId, connected });
    }
  }

  // -- teardown ------------------------------------------------------------

  function attachUnload(): void {
    if (typeof window === 'undefined') return;
    const handler = (): void => {
      leave();
    };
    // `pagehide` is the reliable one on iOS Safari; `beforeunload` covers desktop
    // navigations that `pagehide` misses in older engines.
    window.addEventListener('pagehide', handler);
    window.addEventListener('beforeunload', handler);
    detachUnload = () => {
      window.removeEventListener('pagehide', handler);
      window.removeEventListener('beforeunload', handler);
    };
  }

  function leave(): void {
    if (closed) return;
    closed = true;

    try {
      if (isHostNow()) {
        // Hand over cleanly instead of making everyone wait out HOST_TIMEOUT_MS.
        const successor = electHost(
          playersOf(state).filter((player) => player.id !== identity.playerId),
        );
        transport.broadcast(
          sequencer.stamp<'PLAYER_LEFT'>({
            type: 'PLAYER_LEFT',
            playerId: identity.playerId,
            reason: 'left',
            removed: true,
          }),
        );
        if (successor !== null) {
          const term = sequencer.tick();
          lastTerm = Math.max(lastTerm, term);
          transport.broadcast(
            sequencer.stamp<'HOST_CHANGED'>({
              type: 'HOST_CHANGED',
              newHostPlayerId: successor,
              term,
            }),
          );
        }
      }
      // A guest cannot announce its own departure: PLAYER_LEFT is host-only and
      // every peer would reject it. The host notices the dead link instead.
    } catch {
      // Leaving must never throw - it runs from `pagehide`.
    }

    heartbeat.stop();
    if (unsubTick !== null) unsubTick();
    if (unsubMessages !== null) unsubMessages();
    if (unsubPeers !== null) unsubPeers();
    if (detachUnload !== null) detachUnload();
    unsubTick = null;
    unsubMessages = null;
    unsubPeers = null;
    detachUnload = null;

    try {
      transport.close();
    } catch {
      // Ditto.
    }

    stateListeners.clear();
    eventListeners.clear();
  }

  // -- public --------------------------------------------------------------

  async function start(): Promise<Result<void, string>> {
    if (closed) return err('This session has already been left.');
    if (started) return ok(undefined);
    started = true;

    unsubMessages = transport.onMessage(onTransportMessage);
    unsubPeers = transport.onPeers(onPeers);

    const opened = await transport.start();
    if (!opened.ok) {
      started = false;
      emit({ type: 'error', message: opened.error });
      return opened;
    }
    if (closed) return err('This session has already been left.');

    ensureSelfPlayer();
    attachUnload();

    heartbeat.start();
    unsubTick = heartbeat.onTick(onHeartbeatTick);

    const at = now();
    watchdog.reset(at);
    lastSyncAt = at;

    if (!isHostNow()) sendHello();

    return ok(undefined);
  }

  function startGame(): Result<void, string> {
    if (!isHostNow()) return fail('Only the host can start the game.');
    if (state.status !== 'lobby') return fail('The game has already started.');
    const connected = playersOf(state).filter((player) => player.connected).length;
    if (connected < LIMITS.MIN_PLAYERS) {
      return fail(`You need at least ${LIMITS.MIN_PLAYERS} players to start.`);
    }
    startRound(0);
    return ok(undefined);
  }

  function startNextRound(): Result<void, string> {
    if (!isHostNow()) return fail('Only the host can start the next round.');
    if (state.status === 'finished') return fail('This game is over.');
    if (state.status === 'playing') return fail('A round is already in progress.');
    if (state.status === 'lobby') return startGame();
    if (shouldEndGame(state)) return endGame();
    startRound(state.currentRoundIndex + 1);
    return ok(undefined);
  }

  function changeSettings(patch: Partial<GameSettings>): Result<void, string> {
    if (!isHostNow()) return fail('Only the host can change the settings.');
    if (state.status === 'playing') return fail('Settings cannot change mid-round.');
    if (state.status === 'finished') return fail('This game is over.');
    hostEmit<'SETTINGS_CHANGED'>({
      type: 'SETTINGS_CHANGED',
      settings: mergeSettings(state.settings, patch),
    });
    return ok(undefined);
  }

  function endGame(): Result<void, string> {
    if (!isHostNow()) return fail('Only the host can end the game.');
    if (state.status === 'finished') return ok(undefined);
    hostEmit<'GAME_ENDED'>({
      type: 'GAME_ENDED',
      reason: 'host-ended',
      results: finalStandings(state, 'host-ended'),
    });
    return ok(undefined);
  }

  function submitShot(aim: Vec2, power: number): Result<void, string> {
    if (closed) return err('You have left this room.');
    if (state.status !== 'playing' || state.roundState === null) {
      return fail('No round is in progress.');
    }

    const me = self();
    if (me === null) return fail('You are not seated in this room yet.');
    if (me.holed) return fail('You already holed out this round.');
    if (!canShoot(state, me.id)) {
      return fail(
        state.mode === 'together' ? 'It is not your turn yet.' : 'You are done with this course.',
      );
    }

    // The aim is re-normalised here rather than trusted: it is the only geometry
    // that crosses the wire, and `isNetMessage` only checks it is roughly unit
    // length. Normalising with sqrt keeps it bit-identical for every peer.
    const lengthSq = aim.x * aim.x + aim.y * aim.y;
    if (!Number.isFinite(lengthSq) || lengthSq <= 0) return fail('Aim direction is invalid.');
    const length = Math.sqrt(lengthSq);
    const unitAim: Vec2 = { x: aim.x / length, y: aim.y / length };

    const clamped = clamp01(power);
    if (clamped < PHYSICS.MIN_POWER) return fail('That shot is too gentle - drag further.');

    const shot: ShotInput = {
      playerId: me.id,
      roundIndex: state.currentRoundIndex,
      strokeNumber: me.strokes + 1,
      aim: unitAim,
      power: clamped,
    };

    // ~120 bytes on the wire. Every peer replays it; nobody streams positions.
    const message = broadcast<'PLAYER_SHOT'>({ type: 'PLAYER_SHOT', shot });
    handlePlayerShot(message);
    return ok(undefined);
  }

  function sendEmote(emoji: string): void {
    if (closed) return;
    if (!EMOTES.includes(emoji)) return;
    broadcast<'EMOTE'>({ type: 'EMOTE', emoji });
    emit({ type: 'emote', playerId: identity.playerId, emoji });
  }

  return {
    getState: () => state,
    subscribe(listener: (next: GameState) => void): Unsubscribe {
      stateListeners.add(listener);
      return () => {
        stateListeners.delete(listener);
      };
    },
    onEvent(listener: (event: SessionEvent) => void): Unsubscribe {
      eventListeners.add(listener);
      return () => {
        eventListeners.delete(listener);
      };
    },
    start,
    startGame,
    startNextRound,
    changeSettings,
    endGame,
    submitShot,
    sendEmote,
    leave,
    isHost: isHostNow,
  };
}

/**
 * Convenience wrapper: create a room as its initial host.
 * The room code and identity are minted by `useGameSession` (the only module
 * allowed to touch storage), so all this adds is the `isHost` flag.
 */
export function createRoom(
  identity: RoomIdentity,
  mode: GameMode,
  transport: Transport,
  settings?: Partial<GameSettings>,
): RoomSession {
  return createRoomSession({ identity, transport, mode, isHost: true, settings });
}

/** Convenience wrapper: join an existing room as a guest. */
export function joinRoom(
  identity: RoomIdentity,
  mode: GameMode,
  transport: Transport,
  reconnect = false,
): RoomSession {
  return createRoomSession({ identity, transport, mode, isHost: false, reconnect });
}
