/**
 * Selectors: pure functions of `GameState` (plus, where needed, "who am I").
 *
 * No hooks, no store access - so every one of them is directly unit-testable and
 * can be reused by the headless vitest harness.
 *
 * MEMO-FRIENDLY: the selectors that build arrays cache their last result keyed on
 * the state object identity. `GameState` is immutable and replaced wholesale on
 * every change, so a component doing
 * `useGameStore((s) => selectBallViews(s.game, me))` gets a STABLE reference
 * between renders instead of a fresh array that re-renders the 3D scene every
 * time a heartbeat lands.
 */

import { LIMITS } from '@/game/config';
import {
  collectiveStrokesInRound,
  finalStandings,
  isStillPlaying,
  maxStrokesOf,
  isDnf as ruleIsDnf,
  playersInJoinOrder,
} from '@/game/rules';
import type { BallView } from '@/game/rendering/three/types';
import type {
  ConnectionState,
  FinalStanding,
  GameState,
  LevelSpec,
  PeerInfo,
  PlayerId,
  PlayerState,
} from '@/types';

// ---------------------------------------------------------------------------
// One-entry memoisation keyed on argument identity
// ---------------------------------------------------------------------------

const MISS = Symbol('miss');

function memo1<A, R>(fn: (a: A) => R): (a: A) => R {
  let lastA: A | typeof MISS = MISS;
  let lastR: R | typeof MISS = MISS;
  return (a: A): R => {
    if (lastR === MISS || a !== lastA) {
      lastA = a;
      lastR = fn(a);
    }
    return lastR as R;
  };
}

function memo2<A, B, R>(fn: (a: A, b: B) => R): (a: A, b: B) => R {
  let lastA: A | typeof MISS = MISS;
  let lastB: B | typeof MISS = MISS;
  let lastR: R | typeof MISS = MISS;
  return (a: A, b: B): R => {
    if (lastR === MISS || a !== lastA || b !== lastB) {
      lastA = a;
      lastB = b;
      lastR = fn(a, b);
    }
    return lastR as R;
  };
}

const EMPTY_PLAYERS: readonly PlayerState[] = Object.freeze([]);
const EMPTY_BALLS: readonly BallView[] = Object.freeze([]);
const EMPTY_STANDINGS: readonly FinalStanding[] = Object.freeze([]);

// ---------------------------------------------------------------------------
// Players
// ---------------------------------------------------------------------------

/** Me, or null before WELCOME has landed. */
export function selectSelf(state: GameState | null, self: PlayerId): PlayerState | null {
  if (state === null) return null;
  const player = state.players[self];
  return player === undefined ? null : player;
}

/** Alias kept for call sites that read better as "my player". */
export const selectMyPlayer = selectSelf;

/** Everyone, in canonical join order. Stable reference per state object. */
export const selectOrderedPlayers = memo1((state: GameState | null): readonly PlayerState[] =>
  state === null ? EMPTY_PLAYERS : playersInJoinOrder(state),
);

/** Whose turn it is in co-op. Always null in battle (everyone plays at once). */
export function selectActivePlayer(state: GameState | null): PlayerState | null {
  if (state === null) return null;
  const round = state.roundState;
  if (round === null || round.mode !== 'together') return null;
  const activeId = round.activePlayerId;
  if (activeId === null) return null;
  const player = state.players[activeId];
  return player === undefined ? null : player;
}

export function selectIsMyTurn(state: GameState | null, self: PlayerId): boolean {
  if (state === null || state.status !== 'playing') return false;
  const round = state.roundState;
  if (round === null || round.completed) return false;
  if (round.mode === 'battle') {
    const player = state.players[self];
    return player !== undefined && isStillPlaying(state, player);
  }
  return round.activePlayerId === self;
}

// ---------------------------------------------------------------------------
// Course
// ---------------------------------------------------------------------------

/** The course THIS player is looking at: shared in co-op, private in battle. */
export function selectMyLevel(state: GameState | null, self: PlayerId): LevelSpec | null {
  if (state === null) return null;
  const round = state.roundState;
  if (round === null) return null;
  if (round.mode === 'together') return round.level;
  const level = round.levels[self];
  return level === undefined ? null : level;
}

/**
 * Balls to draw on MY course.
 *
 * Co-op: everyone, because the whole room shares one course.
 * Battle: only mine - opponents are on their own courses entirely, and their
 * live progress is shown as a strip, never as ghost balls on my green.
 */
export const selectBallViews = memo2((state: GameState | null, self: PlayerId): readonly BallView[] => {
  if (state === null) return EMPTY_BALLS;
  const round = state.roundState;
  if (round === null) return EMPTY_BALLS;

  const toView = (player: PlayerState): BallView => ({
    playerId: player.id,
    color: player.color,
    pos: player.currentPos,
    isSelf: player.id === self,
    holed: player.holed,
    label: player.displayName,
  });

  if (round.mode === 'battle') {
    const me = state.players[self];
    return me === undefined ? EMPTY_BALLS : [toView(me)];
  }
  return playersInJoinOrder(state).map(toView);
});

// ---------------------------------------------------------------------------
// Scores
// ---------------------------------------------------------------------------

/**
 * Final-style standings for the results screen and the live score table.
 * Returns the authoritative standings once the game is finished; before that it
 * derives them from the running totals. Co-op always comes back with rank 0.
 */
export const selectLeaderboard = memo1((state: GameState | null): readonly FinalStanding[] => {
  if (state === null) return EMPTY_STANDINGS;
  if (state.results !== null) return state.results.standings;
  return finalStandings(state, 'rounds-complete').standings;
});

/** Alias matching the "sorted standings" wording used around the UI. */
export const selectSortedStandings = selectLeaderboard;

/** Hits taken by everyone in the CURRENT round - the co-op headline number. */
export function selectCollectiveStrokes(state: GameState | null): number {
  return state === null ? 0 : collectiveStrokesInRound(state);
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

export interface RoundProgress {
  /** 0-based; -1 in the lobby. */
  readonly roundIndex: number;
  /** null for endless co-op rooms. */
  readonly totalRounds: number | null;
  /** Players who have holed out or run out of hits. */
  readonly finished: number;
  readonly total: number;
  /** 0..1 for a progress bar. */
  readonly fraction: number;
  /** "Round 2 of 5" / "Round 3". */
  readonly label: string;
}

export const selectRoundProgress = memo1((state: GameState | null): RoundProgress => {
  if (state === null || state.currentRoundIndex < 0) {
    return { roundIndex: -1, totalRounds: null, finished: 0, total: 0, fraction: 0, label: 'Lobby' };
  }
  const players = playersInJoinOrder(state);
  const max = maxStrokesOf(state);
  const finished = players.filter(
    (player) => player.holed || ruleIsDnf(player.strokes, player.holed, max) || !player.connected,
  ).length;
  const total = players.length;
  const human = state.currentRoundIndex + 1;
  return {
    roundIndex: state.currentRoundIndex,
    totalRounds: state.totalRounds,
    finished,
    total,
    fraction: total === 0 ? 0 : finished / total,
    label: state.totalRounds === null ? `Round ${human}` : `Round ${human} of ${state.totalRounds}`,
  };
});

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

export interface ConnectionSummary {
  readonly connectedPlayers: number;
  readonly totalPlayers: number;
  readonly livePeers: number;
  readonly allConnected: boolean;
  readonly worstState: ConnectionState;
  /** "4 connected" / "3 of 4 connected". */
  readonly label: string;
}

const STATE_SEVERITY: Readonly<Record<ConnectionState, number>> = {
  connected: 0,
  connecting: 1,
  signaling: 2,
  reconnecting: 3,
  idle: 4,
  disconnected: 5,
  closed: 6,
  failed: 7,
};

export function selectConnectionSummary(
  state: GameState | null,
  peers: readonly PeerInfo[],
): ConnectionSummary {
  const players = state === null ? EMPTY_PLAYERS : playersInJoinOrder(state);
  const connectedPlayers = players.filter((player) => player.connected).length;
  const livePeers = peers.filter((peer) => peer.state === 'connected').length;

  let worstState: ConnectionState = peers.length === 0 ? 'idle' : 'connected';
  for (const peer of peers) {
    if (STATE_SEVERITY[peer.state] > STATE_SEVERITY[worstState]) worstState = peer.state;
  }

  const allConnected = players.length > 0 && connectedPlayers === players.length;
  return {
    connectedPlayers,
    totalPlayers: players.length,
    livePeers,
    allConnected,
    worstState,
    label: allConnected
      ? `${connectedPlayers} connected`
      : `${connectedPlayers} of ${players.length} connected`,
  };
}

// ---------------------------------------------------------------------------
// Host controls
// ---------------------------------------------------------------------------

export function selectIsHost(state: GameState | null, self: PlayerId): boolean {
  return state !== null && state.hostPlayerId === self && self.length > 0;
}

/** Only the host, only from the lobby, only with enough humans in the room. */
export function selectCanStart(state: GameState | null, self: PlayerId): boolean {
  if (state === null || !selectIsHost(state, self)) return false;
  if (state.status !== 'lobby') return false;
  const connected = playersInJoinOrder(state).filter((player) => player.connected).length;
  return connected >= LIMITS.MIN_PLAYERS;
}

/** Host-only "next round" gate: between rounds, and not past the round limit. */
export function selectCanStartNextRound(state: GameState | null, self: PlayerId): boolean {
  if (state === null || !selectIsHost(state, self)) return false;
  if (state.status !== 'round-summary') return false;
  const total = state.totalRounds;
  if (total === null) return true;
  return state.currentRoundIndex + 1 < total;
}
