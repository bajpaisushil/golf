/**
 * THE PURE GAME REDUCER.
 *
 * `(GameState, GameAction) -> GameState`. No React, no timers, no randomness, no
 * `Date.now()`, no I/O - every timestamp arrives inside the action. That purity
 * is what makes the whole multiplayer game testable headlessly: drive two
 * reducers with the same message stream and they MUST end up byte-identical.
 *
 * Two properties every handler below maintains:
 *
 *  1. IDEMPOTENT - replaying a message that was already applied returns the
 *     SAME state object. Lockstep peers legitimately see duplicates (the mesh
 *     re-broadcasts, a reconnecting peer replays), so "apply twice" must never
 *     double a score or advance a turn twice.
 *  2. MONOTONIC - stale transitions are ignored. Everything round-scoped is
 *     guarded on `roundIndex`, every stroke on `strokeNumber` / `strokesAfter`,
 *     every snapshot on `stateVersion`.
 *
 * Authority: the host's copy is the source of truth. Peers may apply their own
 * shot optimistically (`local/shot-applied`) for responsiveness, then the host's
 * SHOT_RESOLVED overwrites it with absolute values - that is the drift repair.
 */

import { LIMITS, playerColorFor } from '@/game/config';
import { generateLevel } from '@/game/levels/generator';
import {
  isEligibleForTurn,
  mergeRoundResult,
  nextTurn,
  turnCursorFor,
} from '@/game/rules';
import { HOST_ONLY } from '@/multiplayer/protocol/messages';
import { SOLO_GROUP, TEAM_IDS } from '@/types';
import { groupIdFor } from '@/game/rules/teams';
import type { NetMessage, NetMessageType } from '@/multiplayer/protocol/messages';
import type {
  BattleRoundState,
  GameMode,
  GameSettings,
  GameSnapshot,
  GameState,
  GameStatus,
  GroupId,
  LevelSpec,
  PlayerId,
  PlayerMap,
  PlayerState,
  PlayerVariant,
  RoomIdentity,
  RoundSnapshot,
  RoundState,
  TeamId,
  Timestamp,
  TogetherRoundState,
  Vec2,
} from '@/types';

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export type GameAction =
  /** Anything that arrived over the wire (already validated by `isNetMessage`). */
  | { readonly type: 'net'; readonly message: NetMessage; readonly now: Timestamp }
  | { readonly type: 'local/player-joined'; readonly player: PlayerState }
  | { readonly type: 'local/peer-state'; readonly playerId: PlayerId; readonly connected: boolean }
  /** Optimistic local application of a shot, before the host confirms it. */
  | {
      readonly type: 'local/shot-applied';
      readonly playerId: PlayerId;
      readonly restPos: Vec2;
      readonly strokes: number;
      readonly holed: boolean;
      readonly holeOutOrder: number | null;
    }
  | { readonly type: 'local/settings'; readonly settings: GameSettings }
  | { readonly type: 'local/host'; readonly hostPlayerId: PlayerId }
  | { readonly type: 'local/status'; readonly status: GameStatus };

// ---------------------------------------------------------------------------
// Tiny pure helpers
// ---------------------------------------------------------------------------

const ORIGIN: Vec2 = { x: 0, y: 0 };

function safeInt(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.floor(value) : fallback;
}

function safeVec(value: Vec2 | undefined, fallback: Vec2): Vec2 {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value.x) || !Number.isFinite(value.y)) return fallback;
  return { x: value.x, y: value.y };
}

function playerOf(state: GameState, id: PlayerId): PlayerState | null {
  const player = state.players[id];
  return player === undefined ? null : player;
}

function withPlayer(players: PlayerMap<PlayerState>, player: PlayerState): PlayerMap<PlayerState> {
  return { ...players, [player.id]: player };
}

function withoutPlayer(players: PlayerMap<PlayerState>, id: PlayerId): PlayerMap<PlayerState> {
  const next: Record<string, PlayerState> = {};
  for (const key of Object.keys(players)) {
    if (key === id) continue;
    const player = players[key as PlayerId];
    if (player !== undefined) next[key] = player;
  }
  return next;
}

function mapFromList(list: readonly PlayerState[]): PlayerMap<PlayerState> {
  const next: Record<string, PlayerState> = {};
  for (const player of list) next[player.id] = player;
  return next;
}

/** Canonical order: joinSeq ascending, playerId as the deterministic tie-break. */
function orderOf(players: PlayerMap<PlayerState>): readonly PlayerId[] {
  const list: PlayerState[] = [];
  for (const key of Object.keys(players)) {
    const player = players[key as PlayerId];
    if (player !== undefined) list.push(player);
  }
  list.sort((a, b) => (a.joinSeq === b.joinSeq ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.joinSeq - b.joinSeq));
  return list.map((player) => player.id);
}

function withRound(state: GameState, round: RoundState | null): GameState {
  return { ...state, roundState: round };
}

/**
 * Keeps the co-op turn cursor pointing at somebody who can actually swing.
 * Called after anything that can change eligibility (leave, disconnect, hole-out).
 */
function ensureTurn(state: GameState): GameState {
  const round = state.roundState;
  if (round === null || round.completed) return state;
  const active = round.activePlayerId;
  if (active !== null && isEligibleForTurn(state, active)) return state;
  const next = nextTurn(state);
  if (next === active) return state;
  return withRound(state, {
    ...round,
    activePlayerId: next,
    turnCursor: next === null ? round.turnCursor : turnCursorFor(state, next),
  });
}

// ---------------------------------------------------------------------------
// Level (re)generation - geometry NEVER travels over the wire
// ---------------------------------------------------------------------------

function levelsFor(
  roomSeed: number,
  roundIndex: number,
  variants: readonly PlayerVariant[],
): PlayerMap<LevelSpec> {
  const levels: Record<string, LevelSpec> = {};
  for (const variant of variants) {
    levels[variant.playerId] = generateLevel(roomSeed, roundIndex, safeInt(variant.variantIndex, 0));
  }
  return levels;
}

function buildRound(args: {
  readonly mode: GameMode;
  readonly roomSeed: number;
  readonly roundIndex: number;
  readonly variants: readonly PlayerVariant[];
  readonly turnOrder: readonly PlayerId[];
  readonly activePlayerId: PlayerId | null;
  readonly turnCursor: number;
  readonly startedAt: Timestamp;
  readonly holeOutCounter: number;
  readonly completed: boolean;
  /** Shared-ball modes: where each group's ball sits. Defaults to the tee. */
  readonly balls?: Readonly<Record<GroupId, Vec2>>;
  readonly ballsHoled?: Readonly<Record<GroupId, boolean>>;
}): RoundState {
  if (args.mode !== 'battle') {
    const first = args.variants[0];
    const level = generateLevel(args.roomSeed, args.roundIndex, safeInt(first?.variantIndex ?? 0, 0));
    // One ball per GROUP. 'together' has exactly one group (the whole room);
    // 'teams' has one per team that actually has players in it.
    const groups: GroupId[] =
      args.mode === 'teams'
        ? Array.from(
            new Set(
              args.variants
                .map((variant) => variant.teamId)
                .filter((id): id is TeamId => id !== null && id !== undefined),
            ),
          )
        : [SOLO_GROUP];
    if (groups.length === 0) groups.push(TEAM_IDS[0]!);

    const balls: Record<GroupId, Vec2> = {};
    const ballsHoled: Record<GroupId, boolean> = {};
    for (const group of groups) {
      balls[group] = args.balls?.[group] ?? level.ballStart;
      ballsHoled[group] = args.ballsHoled?.[group] ?? false;
    }

    const together: TogetherRoundState = {
      mode: args.mode === 'teams' ? 'teams' : 'together',
      roundIndex: args.roundIndex,
      level,
      balls,
      ballsHoled,
      turnOrder: args.turnOrder,
      turnCursor: args.turnCursor,
      activePlayerId: args.activePlayerId,
      startedAt: args.startedAt,
      holeOutCounter: args.holeOutCounter,
      completed: args.completed,
    };
    return together;
  }
  const battle: BattleRoundState = {
    mode: 'battle',
    roundIndex: args.roundIndex,
    levels: levelsFor(args.roomSeed, args.roundIndex, args.variants),
    // Battle takes turns too. Playing simultaneously made the room feel like
    // several people playing solo in the same tab.
    turnOrder: args.turnOrder,
    turnCursor: args.turnCursor,
    activePlayerId: args.activePlayerId,
    startedAt: args.startedAt,
    holeOutCounter: args.holeOutCounter,
    completed: args.completed,
  };
  return battle;
}

/** The ball spawn for one player in a freshly built round. */
function spawnFor(round: RoundState, playerId: PlayerId): Vec2 {
  if (round.mode !== 'battle') return round.level.ballStart;
  const level = round.levels[playerId];
  return level === undefined ? ORIGIN : level.ballStart;
}

/** Wipes every per-round field. Scores carried across rounds (`totalScore`, `roundWins`) survive. */
function resetPlayersForRound(
  players: PlayerMap<PlayerState>,
  round: RoundState,
  variants: readonly PlayerVariant[],
): PlayerMap<PlayerState> {
  const variantById = new Map<string, number>();
  const teamById = new Map<string, TeamId | null>();
  for (const variant of variants) {
    variantById.set(variant.playerId, safeInt(variant.variantIndex, 0));
    teamById.set(variant.playerId, variant.teamId ?? null);
  }

  const next: Record<string, PlayerState> = {};
  for (const key of Object.keys(players)) {
    const player = players[key as PlayerId];
    if (player === undefined) continue;
    next[key] = {
      ...player,
      currentPos: spawnFor(round, player.id),
      strokes: 0,
      holed: false,
      holeOutOrder: null,
      roundScore: 0,
      levelSeedVariant: variantById.get(player.id) ?? player.levelSeedVariant,
      // Teams persist across rounds; a round reset must not dissolve them.
      teamId: teamById.get(player.id) ?? player.teamId,
    };
  }
  return next;
}

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

export function createInitialState(args: {
  readonly identity: RoomIdentity;
  readonly mode: GameMode;
  readonly roomSeed: number;
  readonly settings: GameSettings;
  readonly isHost: boolean;
}): GameState {
  const self: PlayerState = {
    id: args.identity.playerId,
    displayName: args.identity.displayName,
    color: args.identity.color.length > 0 ? args.identity.color : playerColorFor(0),
    joinSeq: 0,
    connected: true,
    isHost: args.isHost,
    currentPos: ORIGIN,
    strokes: 0,
    holed: false,
    holeOutOrder: null,
    roundScore: 0,
    totalScore: 0,
    roundWins: 0,
    levelSeedVariant: 0,
    teamId: null,
  };

  return {
    roomCode: args.identity.roomCode,
    mode: args.mode,
    // A guest does not know the host until WELCOME arrives; an empty id means
    // "unknown" and must never be treated as an authorised sender.
    hostPlayerId: args.isHost ? args.identity.playerId : ('' as PlayerId),
    players: { [self.id]: self },
    playerOrder: [self.id],
    currentRoundIndex: -1,
    totalRounds: args.settings.totalRounds,
    roundState: null,
    status: 'lobby',
    roomSeed: args.roomSeed >>> 0,
    settings: args.settings,
    stateVersion: 0,
    results: null,
  };
}

// ---------------------------------------------------------------------------
// Snapshot application (WELCOME / STATE_SYNC)
// ---------------------------------------------------------------------------

function roundFromSnapshot(snapshot: RoundSnapshot | null, roomSeed: number): RoundState | null {
  if (snapshot === null) return null;
  return buildRound({
    mode: snapshot.mode,
    roomSeed,
    roundIndex: safeInt(snapshot.roundIndex, 0),
    variants: snapshot.variants,
    turnOrder: snapshot.turnOrder,
    activePlayerId: snapshot.activePlayerId,
    turnCursor: Math.max(0, safeInt(snapshot.turnCursor, 0)),
    startedAt: snapshot.startedAt,
    holeOutCounter: Math.max(0, safeInt(snapshot.holeOutCounter, 0)),
    completed: snapshot.completed,
    balls: snapshot.balls,
    ballsHoled: snapshot.ballsHoled,
  });
}

/** Replaces local state wholesale. The ONLY path allowed to do that. */
function applySnapshot(state: GameState, snapshot: GameSnapshot): GameState {
  const roomSeed = safeInt(snapshot.roomSeed, state.roomSeed) >>> 0;
  const players = mapFromList(snapshot.players);
  return {
    roomCode: snapshot.roomCode,
    mode: snapshot.mode,
    hostPlayerId: snapshot.hostPlayerId,
    players,
    playerOrder: orderOf(players),
    currentRoundIndex: safeInt(snapshot.currentRoundIndex, -1),
    totalRounds: snapshot.totalRounds,
    roundState: roundFromSnapshot(snapshot.round, roomSeed),
    status: snapshot.status,
    roomSeed,
    settings: snapshot.settings,
    stateVersion: Math.max(0, safeInt(snapshot.stateVersion, 0)),
    results: snapshot.results,
  };
}

// ---------------------------------------------------------------------------
// Player bookkeeping
// ---------------------------------------------------------------------------

/**
 * Inserts or refreshes a player.
 *
 * Idempotent on purpose: when the player is already known we take only the
 * IDENTITY fields from the message and keep local progress, so a replayed
 * PLAYER_JOINED can never wipe somebody's strokes mid-round.
 */
function upsertPlayer(state: GameState, incoming: PlayerState): GameState {
  if (typeof incoming.id !== 'string' || incoming.id.length === 0) return state;
  const existing = playerOf(state, incoming.id);

  if (existing !== null) {
    const merged: PlayerState = {
      ...existing,
      displayName: incoming.displayName,
      color: incoming.color,
      joinSeq: safeInt(incoming.joinSeq, existing.joinSeq),
      connected: incoming.connected,
      isHost: incoming.isHost,
    };
    if (
      merged.displayName === existing.displayName &&
      merged.color === existing.color &&
      merged.joinSeq === existing.joinSeq &&
      merged.connected === existing.connected &&
      merged.isHost === existing.isHost
    ) {
      return state;
    }
    const players = withPlayer(state.players, merged);
    return ensureTurn({ ...state, players, playerOrder: orderOf(players) });
  }

  const sanitised: PlayerState = {
    ...incoming,
    joinSeq: Math.max(0, safeInt(incoming.joinSeq, state.playerOrder.length)),
    currentPos: safeVec(incoming.currentPos, ORIGIN),
    strokes: Math.max(0, safeInt(incoming.strokes, 0)),
    holeOutOrder: incoming.holeOutOrder === null ? null : safeInt(incoming.holeOutOrder, 1),
    roundScore: safeInt(incoming.roundScore, 0),
    totalScore: safeInt(incoming.totalScore, 0),
    roundWins: Math.max(0, safeInt(incoming.roundWins, 0)),
    levelSeedVariant: Math.max(0, safeInt(incoming.levelSeedVariant, 0)),
    // Team comes off the wire: the host assigns it, peers must not invent one.
    teamId: incoming.teamId ?? null,
  };
  const players = withPlayer(state.players, sanitised);
  return ensureTurn({ ...state, players, playerOrder: orderOf(players) });
}

function setConnected(state: GameState, playerId: PlayerId, connected: boolean): GameState {
  const player = playerOf(state, playerId);
  if (player === null || player.connected === connected) return state;
  const players = withPlayer(state.players, { ...player, connected });
  return ensureTurn({ ...state, players });
}

function removePlayer(state: GameState, playerId: PlayerId): GameState {
  if (playerOf(state, playerId) === null) return state;
  const players = withoutPlayer(state.players, playerId);
  const next: GameState = { ...state, players, playerOrder: orderOf(players) };
  return ensureTurn(next);
}

// ---------------------------------------------------------------------------
// Shot application
// ---------------------------------------------------------------------------

interface ShotOutcome {
  readonly playerId: PlayerId;
  readonly restPos: Vec2;
  readonly strokes: number;
  readonly holed: boolean;
  readonly holeOutOrder: number | null;
}

/**
 * Folds one shot outcome into a player.
 *
 * Stale-guarded: a result carrying FEWER strokes than we already have, or
 * "not holed" for a player who is already in the cup, is an out-of-order or
 * duplicate message and is dropped. Applying the same outcome twice is a no-op
 * because every field is absolute.
 */
function applyShotOutcome(state: GameState, outcome: ShotOutcome): GameState {
  const player = playerOf(state, outcome.playerId);
  if (player === null) return state;

  const strokes = Math.max(0, safeInt(outcome.strokes, player.strokes));
  if (strokes < player.strokes) return state;
  if (player.holed && !outcome.holed) return state;

  const round = state.roundState;
  let holeOutCounter = round === null ? 0 : round.holeOutCounter;
  let holeOutOrder = player.holeOutOrder;

  if (outcome.holed) {
    if (outcome.holeOutOrder !== null) {
      holeOutOrder = Math.max(1, safeInt(outcome.holeOutOrder, 1));
      holeOutCounter = Math.max(holeOutCounter, holeOutOrder);
    } else if (holeOutOrder === null) {
      holeOutCounter += 1;
      holeOutOrder = holeOutCounter;
    }
  }

  const nextPlayer: PlayerState = {
    ...player,
    currentPos: safeVec(outcome.restPos, player.currentPos),
    strokes,
    holed: outcome.holed,
    holeOutOrder: outcome.holed ? holeOutOrder : null,
  };

  const unchanged =
    nextPlayer.strokes === player.strokes &&
    nextPlayer.holed === player.holed &&
    nextPlayer.holeOutOrder === player.holeOutOrder &&
    nextPlayer.currentPos.x === player.currentPos.x &&
    nextPlayer.currentPos.y === player.currentPos.y;
  if (unchanged) return state;

  // ---- shared-ball modes: one ball per group ----------------------------
  //
  // In 'together' and 'teams' the ball belongs to a GROUP, not the shooter: the
  // whole room in co-op, one team in team play. The resting position goes onto
  // the round, and the group's members mirror it so aiming and rendering keep
  // reading one consistent value. When it drops, that whole group holed out —
  // there is no individual winner to single out inside a group.
  if (round !== null && round.mode !== 'battle') {
    const group = groupIdFor(player, state.mode);
    const ball = safeVec(outcome.restPos, round.balls[group] ?? round.level.ballStart);
    const holedNow = round.ballsHoled[group] === true || outcome.holed;

    const shared: Record<PlayerId, PlayerState> = { ...state.players };
    for (const id of Object.keys(shared) as PlayerId[]) {
      const p = shared[id];
      if (p === undefined) continue;
      if (groupIdFor(p, state.mode) !== group) continue;
      shared[id] = {
        ...p,
        // Only the shooter's stroke count moves.
        strokes: id === outcome.playerId ? strokes : p.strokes,
        currentPos: ball,
        holed: holedNow,
        holeOutOrder: holedNow ? (p.holeOutOrder ?? Math.max(1, round.holeOutCounter + 1)) : null,
      };
    }

    const nextState: GameState = { ...state, players: shared };
    return withRound(nextState, {
      ...round,
      balls: { ...round.balls, [group]: ball },
      ballsHoled: { ...round.ballsHoled, [group]: holedNow },
      holeOutCounter:
        holedNow && round.ballsHoled[group] !== true
          ? round.holeOutCounter + 1
          : round.holeOutCounter,
    });
  }

  const players = withPlayer(state.players, nextPlayer);
  const next: GameState = { ...state, players };
  if (round === null || holeOutCounter === round.holeOutCounter) return next;
  // 'together' returned above, so only the battle variant reaches here.
  return withRound(next, { ...round, holeOutCounter });
}

// ---------------------------------------------------------------------------
// Net message handlers
// ---------------------------------------------------------------------------

/** Host-authoritative messages bump `stateVersion`; snapshots set it absolutely. */
function bumpsVersion(type: NetMessageType): boolean {
  return HOST_ONLY.has(type) && type !== 'WELCOME' && type !== 'STATE_SYNC';
}

function handleNet(state: GameState, message: NetMessage): GameState {
  switch (message.type) {
    // -- handshake ---------------------------------------------------------
    case 'HELLO':
      // Peer bookkeeping only; the session layer answers it. No game state here.
      return state;

    case 'WELCOME': {
      if (message.rejected) return state;
      return applySnapshot(state, message.snapshot);
    }

    case 'PLAYER_JOINED':
      return upsertPlayer(state, message.player);

    case 'PLAYER_LEFT': {
      if (message.removed) return removePlayer(state, message.playerId);
      return setConnected(state, message.playerId, false);
    }

    // -- gameplay ----------------------------------------------------------
    case 'PLAYER_SHOT':
      // Intent only. Peers animate it, but scores change exclusively through the
      // host's SHOT_RESOLVED, so the reducer deliberately ignores it.
      return state;

    case 'SHOT_RESOLVED': {
      if (message.roundIndex !== state.currentRoundIndex) return state;
      if (message.strokeNumber < 1) return state;

      const applied = applyShotOutcome(state, {
        playerId: message.playerId,
        restPos: message.restPos,
        strokes: message.strokesAfter,
        holed: message.holed,
        holeOutOrder: null,
      });

      const round = applied.roundState;
      if (round === null || round.completed) return applied;

      const activeId = message.nextPlayerId;
      if (round.activePlayerId === activeId) return applied;
      const cursor = activeId === null ? round.turnCursor : turnCursorFor(applied, activeId);
      // Narrowed per variant so the discriminant survives the spread.
      return withRound(
        applied,
        round.mode === 'together'
          ? { ...round, activePlayerId: activeId, turnCursor: cursor }
          : { ...round, activePlayerId: activeId, turnCursor: cursor },
      );
    }

    case 'PLAYER_REACHED_GOAL': {
      if (message.roundIndex !== state.currentRoundIndex) return state;
      const player = playerOf(state, message.playerId);
      if (player === null) return state;
      return ensureTurn(
        applyShotOutcome(state, {
          playerId: message.playerId,
          restPos: player.currentPos,
          strokes: message.strokes,
          holed: true,
          holeOutOrder: message.holeOutOrder,
        }),
      );
    }

    case 'ROUND_STARTED': {
      const roundIndex = safeInt(message.roundIndex, 0);
      if (roundIndex < state.currentRoundIndex) return state;
      const existing = state.roundState;
      if (
        existing !== null &&
        existing.roundIndex === roundIndex &&
        !existing.completed &&
        state.status === 'playing'
      ) {
        return state; // already live - replayed message
      }

      const roomSeed = safeInt(message.roomSeed, state.roomSeed) >>> 0;
      const turnOrder = message.turnOrder;
      const round = buildRound({
        mode: message.mode,
        roomSeed,
        roundIndex,
        variants: message.variants,
        turnOrder,
        activePlayerId: message.activePlayerId,
        turnCursor: 0,
        startedAt: message.startedAt,
        holeOutCounter: 0,
        completed: false,
      });

      const players = resetPlayersForRound(state.players, round, message.variants);
      const next: GameState = {
        ...state,
        mode: message.mode,
        roomSeed,
        players,
        playerOrder: orderOf(players),
        currentRoundIndex: roundIndex,
        roundState: round,
        status: 'playing',
        results: null,
      };

      const active = round.activePlayerId;
      const cursor = active === null ? 0 : turnCursorFor(next, active);
      return withRound(
        next,
        round.mode === 'together'
          ? { ...round, turnCursor: cursor }
          : { ...round, turnCursor: cursor },
      );
    }

    case 'ROUND_COMPLETED': {
      const summary = message.summary;
      const roundIndex = safeInt(summary.roundIndex, -1);
      if (roundIndex !== state.currentRoundIndex) return state;

      const round = state.roundState;
      // `completed` is the dedupe key: applying a summary twice would inflate
      // `roundWins`, which is the one running tally that is not absolute.
      if (round !== null && round.roundIndex === roundIndex && round.completed) return state;

      let players = state.players;
      for (const result of summary.results) {
        const player = players[result.playerId];
        if (player === undefined) continue;
        players = withPlayer(players, mergeRoundResult(player, result, summary.mode));
      }

      const next: GameState = { ...state, players, status: 'round-summary' };
      if (round === null || round.roundIndex !== roundIndex) return next;
      return withRound(
        next,
        round.mode === 'together'
          ? { ...round, completed: true, activePlayerId: null }
          : { ...round, completed: true, activePlayerId: null },
      );
    }

    case 'GAME_ENDED': {
      if (state.status === 'finished' && state.results !== null) return state;
      return { ...state, status: 'finished', results: message.results };
    }

    // -- room management ---------------------------------------------------
    case 'HOST_CHANGED': {
      const hostId = message.newHostPlayerId;
      if (state.hostPlayerId === hostId) return state;
      let players = state.players;
      for (const key of Object.keys(players)) {
        const player = players[key as PlayerId];
        if (player === undefined) continue;
        const isHost = player.id === hostId;
        if (player.isHost !== isHost) players = withPlayer(players, { ...player, isHost });
      }
      return { ...state, hostPlayerId: hostId, players };
    }

    case 'STATE_SYNC': {
      const snapshot = message.snapshot;
      if (safeInt(snapshot.stateVersion, -1) <= state.stateVersion) return state;
      return applySnapshot(state, snapshot);
    }

    case 'SETTINGS_CHANGED': {
      const settings = message.settings;
      if (state.settings === settings) return state;
      return { ...state, settings, totalRounds: settings.totalRounds };
    }

    // -- no game-state effect ---------------------------------------------
    case 'HEARTBEAT':
    case 'PING':
    case 'PONG':
    case 'REQUEST_STATE':
    case 'EMOTE':
      return state;

    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// The reducer
// ---------------------------------------------------------------------------

export function gameReducer(state: GameState, action: GameAction): GameState {
  switch (action.type) {
    case 'net': {
      const next = handleNet(state, action.message);
      if (next === state) return state;
      if (!bumpsVersion(action.message.type)) return next;
      return { ...next, stateVersion: next.stateVersion + 1 };
    }

    case 'local/player-joined':
      return upsertPlayer(state, action.player);

    case 'local/peer-state':
      return setConnected(state, action.playerId, action.connected);

    case 'local/shot-applied': {
      const applied = applyShotOutcome(state, {
        playerId: action.playerId,
        restPos: action.restPos,
        strokes: action.strokes,
        holed: action.holed,
        holeOutOrder: action.holeOutOrder,
      });
      if (applied === state) return state;
      const round = applied.roundState;
      if (round === null || round.completed) return applied;
      // Only the player who just swung passes the turn on.
      if (round.activePlayerId !== action.playerId) return applied;
      const next = nextTurn(applied);
      const nextCursor = next === null ? round.turnCursor : turnCursorFor(applied, next);
      return withRound(applied, {
        ...round,
        activePlayerId: next,
        turnCursor: nextCursor,
      });
    }

    case 'local/settings': {
      if (state.settings === action.settings) return state;
      return { ...state, settings: action.settings, totalRounds: action.settings.totalRounds };
    }

    case 'local/host': {
      if (state.hostPlayerId === action.hostPlayerId) return state;
      let players = state.players;
      for (const key of Object.keys(players)) {
        const player = players[key as PlayerId];
        if (player === undefined) continue;
        const isHost = player.id === action.hostPlayerId;
        if (player.isHost !== isHost) players = withPlayer(players, { ...player, isHost });
      }
      return { ...state, hostPlayerId: action.hostPlayerId, players };
    }

    case 'local/status': {
      if (state.status === action.status) return state;
      return { ...state, status: action.status };
    }

    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Settings hygiene
// ---------------------------------------------------------------------------

// NOTE: snapshot PRODUCTION lives in `roomSession.buildSnapshot()` - only the
// host ever builds one, and keeping a second implementation here would be two
// sources of truth for the same wire shape. This module only CONSUMES snapshots
// (see `applySnapshot`).

/** Defensive clamp used when a host builds settings from untrusted UI input. */
export function normaliseSettings(settings: GameSettings): GameSettings {
  const totalRounds =
    settings.totalRounds === null
      ? null
      : Math.max(1, Math.min(LIMITS.MAX_ROUNDS, safeInt(settings.totalRounds, 1)));
  const maxStrokes = Math.max(1, safeInt(settings.maxStrokes, LIMITS.MAX_STROKES));
  const difficultyBias = Math.max(0, Math.min(1, Number.isFinite(settings.difficultyBias) ? settings.difficultyBias : 0));
  return { ...settings, totalRounds, maxStrokes, difficultyBias };
}
