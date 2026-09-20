/**
 * SCORING - the user's headline rule lives here:
 *
 *      FEWER HITS  =>  MORE SCORE.  Always.
 *
 * A round score has exactly two components and BOTH are configured in ONE
 * place, `SCORING` in `src/game/config.ts`:
 *
 *   1. placement points  - 1st = 3, 2nd = 2, 3rd = 1 (flatter table for 2-player
 *                          rooms). Battle mode only; co-op never ranks anyone.
 *   2. efficiency points - a pure function of (strokes, par) that is
 *                          monotonically NON-INCREASING in strokes and decays
 *                          towards a floor once you go over par.
 *
 *   roundScore = placementPointsFor(rank, playerCount) + efficiencyPointsFor(strokes, par)
 *
 * This module NEVER re-derives points from raw numbers - it calls the two config
 * helpers, so retuning the whole game means editing six numbers in `SCORING`.
 *
 * Everything here is PURE: no timers, no randomness, no Date.now, no I/O, so the
 * entire scoring system is unit-testable headlessly.
 */

import {
  LEVEL,
  LIMITS,
  SCORING,
  efficiencyPointsFor,
  placementPointsFor,
} from '@/game/config';
import type {
  FinalStanding,
  GameEndReason,
  GameMode,
  GameResults,
  GameState,
  PlayerId,
  PlayerRoundResult,
  RankBy,
  RoundSummary,
  Timestamp,
} from '@/types';
import { compareIds, isDnf, maxStrokesOf, playersInJoinOrder } from './competitive';
import { friendshipTierFor } from './friendship';

// Re-exported so every consumer can reach the scoring knobs through one module
// without ever being tempted to reimplement them.
export { efficiencyPointsFor, placementPointsFor, SCORING };

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** One player's raw round outcome, before any points are attached. */
export interface RoundEntry {
  readonly playerId: PlayerId;
  /** Strokes taken this round, penalty strokes INCLUDED. */
  readonly strokes: number;
  readonly par: number;
  readonly holed: boolean;
  /** 1-based finishing order, or null when they never holed out. */
  readonly holeOutOrder: number | null;
  /** Points this player had BEFORE this round (used to build `totalScore`). */
  readonly totalBefore: number;
}

export interface ScoreOptions {
  readonly mode: GameMode;
  readonly playerCount: number;
  /** Defaults to `SCORING.rankBy`. */
  readonly rankBy: RankBy;
  /** Defaults to `LIMITS.MAX_STROKES`. */
  readonly maxStrokes: number;
}

/** Midpoint of the generator's par range; only used when a level is unavailable. */
const FALLBACK_PAR = Math.max(
  LEVEL.PAR_MIN,
  Math.min(LEVEL.PAR_MAX, Math.floor((LEVEL.PAR_MIN + LEVEL.PAR_MAX) / 2)),
);

function safeInt(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.floor(value) : fallback;
}

// ---------------------------------------------------------------------------
// The two headline helpers, restated for call sites that only import scoring
// ---------------------------------------------------------------------------

/**
 * Points a fully-scored result is worth. Identical to
 * `placementPoints + efficiencyPoints`, or `SCORING.dnfPoints` when the player
 * never holed out. Use this instead of adding the fields by hand.
 */
export function roundPointsFor(result: PlayerRoundResult): number {
  if (result.dnf || !result.holed) return SCORING.dnfPoints;
  return result.placementPoints + result.efficiencyPoints;
}

/**
 * The efficiency points this player would bank if they holed out RIGHT NOW,
 * having taken `strokes` hits. The HUD shows it live while aiming, so "one more
 * hit costs you points" is visible before you pull back rather than after.
 */
export function projectedScore(strokes: number, par: number): number {
  return efficiencyPointsFor(strokes, par);
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

interface Row {
  readonly entry: RoundEntry;
  readonly strokes: number;
  readonly par: number;
  readonly dnf: boolean;
  /** Only a holed-out, non-DNF player earns points. */
  readonly scorable: boolean;
  readonly order: number;
}

/** Sentinel used so "never holed out" always sorts after every real finish. */
const NEVER_HOLED = Number.MAX_SAFE_INTEGER;

function toRow(entry: RoundEntry, maxStrokes: number): Row {
  const strokes = Math.max(0, safeInt(entry.strokes, 0));
  const par = Math.max(1, safeInt(entry.par, FALLBACK_PAR));
  const dnf = isDnf(strokes, entry.holed, maxStrokes);
  const order =
    entry.holeOutOrder === null || !Number.isFinite(entry.holeOutOrder)
      ? NEVER_HOLED
      : Math.floor(entry.holeOutOrder);
  return { entry, strokes, par, dnf, scorable: entry.holed && !dnf, order };
}

function compareRows(a: Row, b: Row, rankBy: RankBy): number {
  if (a.dnf !== b.dnf) return a.dnf ? 1 : -1;
  if (!a.dnf) {
    if (a.entry.holed !== b.entry.holed) return a.entry.holed ? -1 : 1;
    if (rankBy === 'time') {
      if (a.order !== b.order) return a.order - b.order;
      if (a.strokes !== b.strokes) return a.strokes - b.strokes;
    } else {
      if (a.strokes !== b.strokes) return a.strokes - b.strokes;
      if (a.order !== b.order) return a.order - b.order;
    }
  }
  // Final tie-break: lexicographic playerId. Never affects who is "tied" below,
  // it only keeps the array order byte-identical on every peer.
  return compareIds(a.entry.playerId, b.entry.playerId);
}

/** True when two rows genuinely share a rank (and therefore the same points). */
function sharesRank(a: Row, b: Row, rankBy: RankBy): boolean {
  if (a.dnf || b.dnf) return a.dnf && b.dnf;
  if (a.entry.holed !== b.entry.holed) return false;
  if (rankBy === 'time') return a.order === b.order && a.strokes === b.strokes;
  return a.strokes === b.strokes && a.order === b.order;
}

function buildResult(row: Row, rank: number, options: ScoreOptions): PlayerRoundResult {
  const isCoop = options.mode === 'together';
  const playerCount = Math.max(1, safeInt(options.playerCount, 1));

  // Co-op NEVER ranks and NEVER awards placement points. Efficiency points still
  // apply because they measure a player against the course, not against friends.
  const placementPoints = isCoop || !row.scorable ? 0 : placementPointsFor(rank, playerCount);
  const efficiencyPoints = row.scorable ? efficiencyPointsFor(row.strokes, row.par) : 0;
  const roundScore = row.scorable ? placementPoints + efficiencyPoints : SCORING.dnfPoints;

  return {
    playerId: row.entry.playerId,
    strokes: row.strokes,
    par: row.par,
    holed: row.entry.holed,
    holeOutOrder: row.entry.holeOutOrder,
    rank: isCoop ? 0 : rank,
    placementPoints,
    efficiencyPoints,
    roundScore,
    totalScore: safeInt(row.entry.totalBefore, 0) + roundScore,
    dnf: row.dnf,
  };
}

/**
 * Ranks one round and attaches points.
 *
 * - `strokes-then-time` (default): fewest strokes wins, `holeOutOrder` breaks ties.
 * - `time`: pure race, first into the cup wins whatever it cost them.
 * - DNF players always come last and SHARE the last rank; they score
 *   `SCORING.dnfPoints`.
 * - In `together` mode nothing is ranked at all: results come back in join order
 *   with `rank === 0` and `placementPoints === 0`.
 */
export function rankRound(
  entries: readonly RoundEntry[],
  options: ScoreOptions,
): readonly PlayerRoundResult[] {
  const maxStrokes = options.maxStrokes > 0 ? Math.floor(options.maxStrokes) : LIMITS.MAX_STROKES;
  const rows = entries.map((entry) => toRow(entry, maxStrokes));

  if (options.mode === 'together') {
    // Join order, no sorting: a sorted co-op list IS a ranking, however it is labelled.
    return rows.map((row) => buildResult(row, 0, options));
  }

  const rankBy: RankBy = options.rankBy;
  const sorted = rows.slice().sort((a, b) => compareRows(a, b, rankBy));
  const nonDnfCount = sorted.reduce((count, row) => (row.dnf ? count : count + 1), 0);
  const lastRank = nonDnfCount + 1;

  const results: PlayerRoundResult[] = [];
  let currentRank = 1;
  let previous: Row | undefined;

  for (let i = 0; i < sorted.length; i += 1) {
    const row = sorted[i];
    if (row === undefined) continue;
    if (row.dnf) {
      currentRank = lastRank;
    } else {
      if (previous === undefined || !sharesRank(previous, row, rankBy)) currentRank = i + 1;
      previous = row;
    }
    results.push(buildResult(row, currentRank, options));
  }
  return results;
}

/**
 * Orders already-scored results best-first using `SCORING.rankBy` semantics:
 * rank ascending, DNF last, then fewest strokes, then finishing order.
 * Pure re-ordering - it never recomputes points.
 */
export function rankPlayers(results: readonly PlayerRoundResult[]): readonly PlayerRoundResult[] {
  return results.slice().sort((a, b) => {
    if (a.dnf !== b.dnf) return a.dnf ? 1 : -1;
    if (a.rank !== b.rank) {
      if (a.rank === 0) return 1;
      if (b.rank === 0) return -1;
      return a.rank - b.rank;
    }
    if (a.strokes !== b.strokes) return a.strokes - b.strokes;
    const ao = a.holeOutOrder ?? NEVER_HOLED;
    const bo = b.holeOutOrder ?? NEVER_HOLED;
    if (ao !== bo) return ao - bo;
    return compareIds(a.playerId, b.playerId);
  });
}

// ---------------------------------------------------------------------------
// Round summary
// ---------------------------------------------------------------------------

/** Par of the course THIS player is playing (their own one in battle mode). */
export function parForPlayer(state: GameState, playerId: PlayerId): number {
  const round = state.roundState;
  if (round === null) return FALLBACK_PAR;
  if (round.mode !== 'battle') return Math.max(1, safeInt(round.level.par, FALLBACK_PAR));
  const level = round.levels[playerId];
  return level === undefined ? FALLBACK_PAR : Math.max(1, safeInt(level.par, FALLBACK_PAR));
}

/**
 * Builds the authoritative summary for a finished round.
 *
 * IDEMPOTENT: calling it again AFTER `ROUND_COMPLETED` has been folded into the
 * players (which is exactly what the summary screen does when it re-renders)
 * subtracts the already-applied `roundScore` again, so totals never inflate.
 */
export function summariseRound(state: GameState, roundIndex: number): RoundSummary {
  const players = playersInJoinOrder(state);
  const round = state.roundState;
  const alreadyApplied = round !== null && round.roundIndex === roundIndex && round.completed;

  const entries: RoundEntry[] = players.map((player) => ({
    playerId: player.id,
    strokes: player.strokes,
    par: parForPlayer(state, player.id),
    holed: player.holed,
    holeOutOrder: player.holeOutOrder,
    totalBefore: alreadyApplied ? player.totalScore - player.roundScore : player.totalScore,
  }));

  const results = rankRound(entries, {
    mode: state.mode,
    playerCount: players.length,
    rankBy: state.settings.rankBy,
    maxStrokes: maxStrokesOf(state),
  });

  const collectiveStrokes = entries.reduce((sum, entry) => sum + Math.max(0, entry.strokes), 0);
  const collectivePar = entries.reduce((sum, entry) => sum + Math.max(0, entry.par), 0);

  return {
    roundIndex,
    mode: state.mode,
    results,
    collectiveStrokes,
    collectivePar,
    friendshipTier: state.mode === 'together' ? friendshipTierFor(roundIndex + 1) : null,
  };
}

// ---------------------------------------------------------------------------
// Final standings
// ---------------------------------------------------------------------------

export interface FinalStandingsOptions {
  /**
   * Every round summary of the game, in order. When supplied, `totalStrokes` and
   * `collectiveStrokes` are exact across ALL rounds. Without it they fall back to
   * the last round only, because `GameState` carries no cumulative stroke tally
   * (see the note in the module report).
   */
  readonly history?: readonly RoundSummary[];
  /** Wall clock for `GameResults.endedAt`. Callers pass `Date.now()`; rules never do. */
  readonly endedAt?: Timestamp;
}

function totalStrokesFrom(history: readonly RoundSummary[]): ReadonlyMap<PlayerId, number> {
  const totals = new Map<PlayerId, number>();
  for (const summary of history) {
    for (const result of summary.results) {
      totals.set(result.playerId, (totals.get(result.playerId) ?? 0) + Math.max(0, result.strokes));
    }
  }
  return totals;
}

/**
 * Final leaderboard. Battle ranks by total score (roundWins, then fewest total
 * hits, then join order break ties). Co-op returns everyone with `rank === 0` in
 * join order - there is no winner to crown.
 */
export function finalStandings(
  state: GameState,
  reason: GameEndReason,
  options: FinalStandingsOptions = {},
): GameResults {
  const history = options.history ?? [];
  const strokeTotals = totalStrokesFrom(history);
  const players = playersInJoinOrder(state);

  const rows = players.map((player) => ({
    playerId: player.id,
    displayName: player.displayName,
    totalScore: player.totalScore,
    totalStrokes: strokeTotals.get(player.id) ?? Math.max(0, player.strokes),
    roundWins: player.roundWins,
    joinSeq: player.joinSeq,
  }));

  let standings: readonly FinalStanding[];
  if (state.mode === 'together') {
    standings = rows.map((row) => ({
      playerId: row.playerId,
      displayName: row.displayName,
      totalScore: row.totalScore,
      totalStrokes: row.totalStrokes,
      roundWins: row.roundWins,
      rank: 0,
    }));
  } else {
    const sorted = rows.slice().sort((a, b) => {
      if (a.totalScore !== b.totalScore) return b.totalScore - a.totalScore;
      if (a.roundWins !== b.roundWins) return b.roundWins - a.roundWins;
      // Fewer hits breaks a points tie - the user's rule all the way down.
      if (a.totalStrokes !== b.totalStrokes) return a.totalStrokes - b.totalStrokes;
      return compareIds(a.playerId, b.playerId);
    });

    const ranked: FinalStanding[] = [];
    let currentRank = 1;
    let previous: (typeof sorted)[number] | undefined;
    for (let i = 0; i < sorted.length; i += 1) {
      const row = sorted[i];
      if (row === undefined) continue;
      const tiedWithPrevious =
        previous !== undefined &&
        previous.totalScore === row.totalScore &&
        previous.roundWins === row.roundWins &&
        previous.totalStrokes === row.totalStrokes;
      if (!tiedWithPrevious) currentRank = i + 1;
      previous = row;
      ranked.push({
        playerId: row.playerId,
        displayName: row.displayName,
        totalScore: row.totalScore,
        totalStrokes: row.totalStrokes,
        roundWins: row.roundWins,
        rank: currentRank,
      });
    }
    standings = ranked;
  }

  const roundsPlayed =
    history.length > 0 ? history.length : Math.max(0, state.currentRoundIndex + 1);
  const collectiveStrokes =
    history.length > 0
      ? history.reduce((sum, summary) => sum + Math.max(0, summary.collectiveStrokes), 0)
      : standings.reduce((sum, row) => sum + Math.max(0, row.totalStrokes), 0);

  return {
    mode: state.mode,
    roundsPlayed,
    reason,
    standings,
    collectiveStrokes,
    friendshipTier: state.mode === 'together' ? friendshipTierFor(Math.max(1, roundsPlayed)) : null,
    endedAt: options.endedAt ?? state.roundState?.startedAt ?? 0,
  };
}
