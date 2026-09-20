/**
 * Competitive rules - "Friend Battle".
 *
 * Every player plays their OWN independently generated course (same generator,
 * different `variantIndex`) at the SAME time. Nobody waits for a turn. A round
 * ends when every still-connected player has either holed out or hit
 * `settings.maxStrokes` (DNF).
 *
 * This module is the LEAF of the rules layer: it imports nothing from
 * `scoring.ts` or `friendship.ts`, so the dependency graph stays acyclic
 * (competitive <- friendship <- scoring <- index).
 *
 * Everything here is PURE: no timers, no randomness, no Date.now, no I/O.
 * It never computes points - points come from `scoring.ts`, which is the only
 * module allowed to call `placementPointsFor` / `efficiencyPointsFor`.
 */

import { LIMITS } from '@/game/config';
import type {
  GameMode,
  GameState,
  PlayerId,
  PlayerRoundResult,
  PlayerState,
  PlayerVariant,
  RoundSummary,
} from '@/types';

// ---------------------------------------------------------------------------
// Small shared helpers (the whole rules layer reads players through these)
// ---------------------------------------------------------------------------

/** Coerces anything that came off the wire into a sane non-negative integer. */
function safeInt(value: number, fallback = 0): number {
  return Number.isFinite(value) ? Math.floor(value) : fallback;
}

/**
 * Every player in canonical join order.
 *
 * `playerOrder` is authoritative, but we defensively append any player that is
 * present in the map yet missing from the order (can only happen mid-repair
 * after a STATE_SYNC race) and sort the strays by joinSeq so the result is
 * deterministic on every peer.
 */
export function playersInJoinOrder(state: GameState): readonly PlayerState[] {
  const seen = new Set<string>();
  const ordered: PlayerState[] = [];

  for (const id of state.playerOrder) {
    const player = state.players[id];
    if (player === undefined || seen.has(player.id)) continue;
    seen.add(player.id);
    ordered.push(player);
  }

  const strays: PlayerState[] = [];
  for (const key of Object.keys(state.players)) {
    const player = state.players[key as PlayerId];
    if (player === undefined || seen.has(player.id)) continue;
    seen.add(player.id);
    strays.push(player);
  }
  strays.sort((a, b) => (a.joinSeq === b.joinSeq ? compareIds(a.id, b.id) : a.joinSeq - b.joinSeq));

  return ordered.concat(strays);
}

/** Deterministic, locale-independent id comparison (never use localeCompare here). */
export function compareIds(a: PlayerId, b: PlayerId): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** The stroke ceiling in force for this room, falling back to the global limit. */
export function maxStrokesOf(state: GameState): number {
  const configured = safeInt(state.settings.maxStrokes, LIMITS.MAX_STROKES);
  return configured > 0 ? configured : LIMITS.MAX_STROKES;
}

// ---------------------------------------------------------------------------
// Course assignment
// ---------------------------------------------------------------------------

/**
 * Which level variant a player plays.
 *
 * - `battle`   -> `joinSeq + 1`, so every player gets a different course and
 *                 nobody ever plays variant 0 (that one is reserved for co-op,
 *                 which keeps the shared-course seed stable across modes).
 * - `together` -> always 0: ONE shared course for the whole room.
 */
export function variantIndexFor(player: PlayerState, mode: GameMode): number {
  if (mode !== 'battle') return 0;
  return Math.max(0, safeInt(player.joinSeq, 0)) + 1;
}

/**
 * The `variants` payload for ROUND_STARTED. Levels themselves are NEVER sent -
 * every peer calls `generateLevel(roomSeed, roundIndex, variantIndex)` locally.
 */
export function assignVariants(state: GameState): readonly PlayerVariant[] {
  return playersInJoinOrder(state).map((player) => ({
    playerId: player.id,
    variantIndex: variantIndexFor(player, state.mode),
  }));
}

// ---------------------------------------------------------------------------
// Per-player round status
// ---------------------------------------------------------------------------

/** A player is DNF when they burned `maxStrokes` without the ball dropping. */
export function isDnf(strokes: number, holed: boolean, maxStrokes: number): boolean {
  if (holed) return false;
  const limit = Number.isFinite(maxStrokes) && maxStrokes > 0 ? Math.floor(maxStrokes) : LIMITS.MAX_STROKES;
  return safeInt(strokes, 0) >= limit;
}

/** Convenience wrapper reading the ceiling straight off the room settings. */
export function isPlayerDnf(state: GameState, player: PlayerState): boolean {
  return isDnf(player.strokes, player.holed, maxStrokesOf(state));
}

/**
 * True while this player may still take shots this round: present, connected,
 * not holed out and not DNF. Disconnected players are treated as finished so a
 * dropped peer can never stall the room.
 */
export function isStillPlaying(state: GameState, player: PlayerState): boolean {
  if (!player.connected) return false;
  if (player.holed) return false;
  return !isPlayerDnf(state, player);
}

/** Everyone who can still swing, in join order. */
export function playersStillPlaying(state: GameState): readonly PlayerId[] {
  const round = state.roundState;
  if (round === null || round.completed || state.status !== 'playing') return [];
  return playersInJoinOrder(state)
    .filter((player) => isStillPlaying(state, player))
    .map((player) => player.id);
}

// ---------------------------------------------------------------------------
// Round / game completion
// ---------------------------------------------------------------------------

/**
 * Battle round completion: nobody is left who can still take a shot.
 *
 * Note this is the SAME predicate co-op uses (see `friendship.isTogetherRoundOver`);
 * the difference between the modes is who is allowed to shoot when, not when the
 * round ends.
 */
export function isBattleRoundOver(state: GameState): boolean {
  const round = state.roundState;
  if (round === null) return false;
  if (round.completed) return true;
  const players = playersInJoinOrder(state);
  if (players.length === 0) return true;
  return players.every((player) => !isStillPlaying(state, player));
}

/**
 * True when the round that just finished was the last one.
 * Endless co-op rooms (`totalRounds === null`) never end on their own - the host
 * stops the game explicitly.
 */
export function shouldEndGame(state: GameState): boolean {
  const total = state.totalRounds;
  if (total === null || !Number.isFinite(total) || total <= 0) return false;
  return state.currentRoundIndex + 1 >= Math.floor(total);
}

/** Rounds still to play after the current one (null for an endless room). */
export function roundsRemaining(state: GameState): number | null {
  const total = state.totalRounds;
  if (total === null || !Number.isFinite(total) || total <= 0) return null;
  return Math.max(0, Math.floor(total) - (state.currentRoundIndex + 1));
}

// ---------------------------------------------------------------------------
// Shot permission
// ---------------------------------------------------------------------------

/**
 * The single gate every shot passes through, on the shooter AND on every peer
 * validating an inbound PLAYER_SHOT. Battle = anyone still playing, any time.
 * Together = only the player the turn cursor points at.
 */
export function canShoot(state: GameState, playerId: PlayerId): boolean {
  if (state.status !== 'playing') return false;
  const round = state.roundState;
  if (round === null || round.completed) return false;
  if (round.roundIndex !== state.currentRoundIndex) return false;

  const player = state.players[playerId];
  if (player === undefined) return false;
  if (!isStillPlaying(state, player)) return false;

  if (round.mode === 'together') return round.activePlayerId === playerId;
  return true;
}

// ---------------------------------------------------------------------------
// Awarding a finished round
// ---------------------------------------------------------------------------

/** Players who took rank 1 this round (battle only; co-op never ranks). */
export function roundWinners(summary: RoundSummary): readonly PlayerId[] {
  if (summary.mode !== 'battle') return [];
  return summary.results.filter((result) => result.rank === 1 && !result.dnf).map((r) => r.playerId);
}

/**
 * Folds one authoritative {@link PlayerRoundResult} into a player.
 *
 * IDEMPOTENT by construction: `roundScore` and `totalScore` are absolute values
 * taken from the result, so replaying ROUND_COMPLETED cannot inflate a total.
 * `roundWins` is the one running tally, so the caller must apply a given round
 * exactly once - `gameReducer` guards that with `roundState.completed`.
 */
export function mergeRoundResult(
  player: PlayerState,
  result: PlayerRoundResult,
  mode: GameMode,
): PlayerState {
  const wonRound = mode === 'battle' && result.rank === 1 && !result.dnf;
  return {
    ...player,
    strokes: safeInt(result.strokes, player.strokes),
    holed: result.holed,
    holeOutOrder: result.holeOutOrder,
    roundScore: result.roundScore,
    totalScore: result.totalScore,
    roundWins: wonRound ? player.roundWins + 1 : player.roundWins,
  };
}

/** Per-player live progress strip for the battle HUD. Never a ranking mid-round. */
export interface BattleProgress {
  readonly playerId: PlayerId;
  readonly displayName: string;
  readonly strokes: number;
  readonly holed: boolean;
  readonly dnf: boolean;
  readonly connected: boolean;
  readonly holeOutOrder: number | null;
}

export function battleProgress(state: GameState): readonly BattleProgress[] {
  const max = maxStrokesOf(state);
  return playersInJoinOrder(state).map((player) => ({
    playerId: player.id,
    displayName: player.displayName,
    strokes: player.strokes,
    holed: player.holed,
    dnf: isDnf(player.strokes, player.holed, max),
    connected: player.connected,
    holeOutOrder: player.holeOutOrder,
  }));
}
