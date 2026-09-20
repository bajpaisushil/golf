/**
 * Cooperative rules - "Play Together" / the Friendship Journey.
 *
 * ONE shared course per round. Players take one shot each in join order; anyone
 * who already holed out (or ran out of strokes, or dropped) is skipped. The round
 * ends when nobody is left who can still swing. Rounds continue for as long as
 * the group wants to keep playing.
 *
 * THERE IS NO RANKING IN THIS FILE, and there never should be: no winner, no
 * placement, no "best player". The only numbers co-op surfaces are COLLECTIVE
 * ones (how many hits we took together) and a friendship tier that rises purely
 * with how many rounds the group has played side by side.
 *
 * Pure: no timers, no randomness, no Date.now, no I/O.
 */

import { FRIENDSHIP_CYCLE_FROM, FRIENDSHIP_TIERS, LIMITS } from '@/game/config';
import type { FriendshipTier, GameState, PlayerId, PlayerState, RoundSummary } from '@/types';
import { isStillPlaying, playersInJoinOrder } from './competitive';

// ---------------------------------------------------------------------------
// Tiers
// ---------------------------------------------------------------------------

/** Positive modulo - JS `%` keeps the sign of the dividend, which we never want here. */
function wrap(value: number, span: number): number {
  if (span <= 0) return 0;
  return ((value % span) + span) % span;
}

/**
 * The tier reached after `roundsCompleted` rounds (1-based).
 *
 * Rounds 1..N walk the explicit `FRIENDSHIP_TIERS` list with `cycle === 0`.
 * After that the tail of the list (from `FRIENDSHIP_CYCLE_FROM` onwards) repeats
 * with a rising `cycle`, so round 11 shows "In Perfect Sync" again with
 * `cycle === 1` (the UI renders that as "x2"), round 16 with `cycle === 2`, and
 * so on for as long as the group keeps playing.
 *
 * NOTE: `config.FRIENDSHIP_TIERS`' doc comment writes the cycle formula as
 * `1 + floor(...)`, which would label the FIRST pass through tiers 6-10 as
 * cycle 1 while also stating "0 on the first pass". This implementation honours
 * the stated intent - the first pass is always cycle 0.
 */
export function friendshipTierFor(roundsCompleted: number): FriendshipTier {
  const total = FRIENDSHIP_TIERS.length;
  const fallback: FriendshipTier = {
    round: 1,
    emoji: '\u{1F331}',
    title: 'Starting Together',
    subtitle: 'Every journey begins with one putt.',
    cycle: 0,
  };
  if (total === 0) return fallback;

  const round = Math.max(1, Number.isFinite(roundsCompleted) ? Math.floor(roundsCompleted) : 1);

  if (round <= total) {
    const spec = FRIENDSHIP_TIERS[round - 1];
    if (spec === undefined) return fallback;
    return { round: spec.round, emoji: spec.emoji, title: spec.title, subtitle: spec.subtitle, cycle: 0 };
  }

  const from = Math.max(0, Math.min(total - 1, FRIENDSHIP_CYCLE_FROM));
  const span = Math.max(1, total - from);
  const offset = round - 1 - from;
  const index = from + wrap(offset, span);
  const cycle = Math.max(1, Math.floor(offset / span));
  const spec = FRIENDSHIP_TIERS[index];
  if (spec === undefined) return fallback;
  return { round: spec.round, emoji: spec.emoji, title: spec.title, subtitle: spec.subtitle, cycle };
}

/** Same thing keyed by the 0-based `roundIndex` the rest of the code passes around. */
export function tierForRound(roundIndex: number): FriendshipTier {
  const index = Number.isFinite(roundIndex) ? Math.floor(roundIndex) : 0;
  return friendshipTierFor(index + 1);
}

/** "Unbreakable" on the first pass, "Unbreakable x2" once the list has wrapped. */
export function tierLabel(tier: FriendshipTier): string {
  return tier.cycle > 0 ? `${tier.title} ×${tier.cycle + 1}` : tier.title;
}

// ---------------------------------------------------------------------------
// Turn rotation
// ---------------------------------------------------------------------------

/** The turn order, filtered down to players the room actually knows about. */
export function liveTurnOrder(state: GameState): readonly PlayerId[] {
  const round = state.roundState;
  // BOTH modes take turns now. Battle used to let everyone putt at once, which
  // made a room of friends feel like several people playing solo side by side.
  if (round === null) return playersInJoinOrder(state).map((player) => player.id);
  const known = round.turnOrder.filter((id) => state.players[id] !== undefined);
  return known.length > 0 ? known : playersInJoinOrder(state).map((player) => player.id);
}

/**
 * The group's shared hit budget for a co-op round.
 *
 * Co-op is ONE ball, so a per-player stroke cap makes no sense — the cap has to
 * belong to the group. Everyone contributes roughly `maxStrokes` worth of hits.
 */
export function collectiveStrokeCap(state: GameState): number {
  const raw = state.settings.maxStrokes;
  const perPlayer = Math.max(1, Number.isFinite(raw) ? Math.floor(raw) : LIMITS.MAX_STROKES);
  const players = Math.max(1, playersInJoinOrder(state).length);
  return perPlayer * players;
}

/** True when this player still owes the group a shot this round. */
export function isEligibleForTurn(state: GameState, playerId: PlayerId): boolean {
  const player = state.players[playerId];
  if (player === undefined) return false;
  if (!player.connected) return false;

  const round = state.roundState;
  if (round !== null && round.mode === 'together') {
    // One shared ball: nobody is individually "out". The whole group stops
    // together when the ball drops or the shared budget runs out.
    if (round.ballHoled) return false;
    return collectiveStrokesInRound(state) < collectiveStrokeCap(state);
  }
  return isStillPlaying(state, player);
}

/**
 * Whose turn it is AFTER the player the cursor currently points at.
 *
 * Walks the rotation once (including wrapping back to the current player, which
 * is correct when they are the last one still going) and returns `null` when
 * nobody is left - that is exactly the round-over condition.
 */
export function nextTurn(state: GameState): PlayerId | null {
  const round = state.roundState;
  if (round === null || round.completed) return null;

  const order = liveTurnOrder(state);
  if (order.length === 0) return null;

  const cursor = Number.isFinite(round.turnCursor) ? Math.floor(round.turnCursor) : 0;
  for (let step = 1; step <= order.length; step += 1) {
    const index = wrap(cursor + step, order.length);
    const candidate = order[index];
    if (candidate === undefined) continue;
    if (isEligibleForTurn(state, candidate)) return candidate;
  }
  return null;
}

/** Index of `playerId` in the live rotation, or -1. Used to move the cursor. */
export function turnCursorFor(state: GameState, playerId: PlayerId | null): number {
  if (playerId === null) return 0;
  const order = liveTurnOrder(state);
  for (let i = 0; i < order.length; i += 1) {
    if (order[i] === playerId) return i;
  }
  return 0;
}

/** The first player of a fresh co-op round: the earliest joiner who can play. */
export function firstTurn(state: GameState): PlayerId | null {
  const order = liveTurnOrder(state);
  for (const id of order) {
    if (isEligibleForTurn(state, id)) return id;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Round completion
// ---------------------------------------------------------------------------

/** Nobody can swing any more: everyone holed out, ran out of hits, or left. */
export function isTogetherRoundOver(state: GameState): boolean {
  const round = state.roundState;
  if (round === null) return false;
  if (round.completed) return true;
  const players = playersInJoinOrder(state);
  if (players.length === 0) return true;

  if (round.mode === 'together') {
    // The shared ball is the only thing that ends a co-op round.
    if (round.ballHoled) return true;
    if (collectiveStrokesInRound(state) >= collectiveStrokeCap(state)) return true;
    return players.every((player) => !player.connected);
  }
  return players.every((player) => !isStillPlaying(state, player));
}

// ---------------------------------------------------------------------------
// Collective totals (the only numbers co-op ever shows)
// ---------------------------------------------------------------------------

/** One player's step count for the current round. */
export interface StepCount {
  readonly playerId: PlayerId;
  readonly displayName: string;
  readonly steps: number;
  readonly holed: boolean;
  readonly connected: boolean;
}

/** Per-player steps this round, join order. Deliberately NOT sorted by score. */
export function stepCounts(state: GameState): readonly StepCount[] {
  return playersInJoinOrder(state).map((player: PlayerState) => ({
    playerId: player.id,
    displayName: player.displayName,
    steps: player.strokes,
    holed: player.holed,
    connected: player.connected,
  }));
}

/** Total hits the whole group has taken in the CURRENT round. */
export function collectiveStrokesInRound(state: GameState): number {
  return playersInJoinOrder(state).reduce((sum, player) => sum + Math.max(0, player.strokes), 0);
}

/** Total hits across every round summarised so far. */
export function collectiveStrokes(summaries: readonly RoundSummary[]): number {
  return summaries.reduce((sum, summary) => sum + Math.max(0, summary.collectiveStrokes), 0);
}

/** Total par across every round summarised so far, for "x under together". */
export function collectivePar(summaries: readonly RoundSummary[]): number {
  return summaries.reduce((sum, summary) => sum + Math.max(0, summary.collectivePar), 0);
}

/** How many players actually took part in a round. */
export function participantCount(summary: RoundSummary): number {
  return summary.results.length;
}

// ---------------------------------------------------------------------------
// Warm, non-competitive copy
// ---------------------------------------------------------------------------

function hits(count: number): string {
  const n = Math.max(0, Number.isFinite(count) ? Math.floor(count) : 0);
  return n === 1 ? '1 hit' : `${n} hits`;
}

/** One sentence for the top of the co-op summary. Never a ranking, never a winner. */
export function friendshipHeadline(summary: RoundSummary): string {
  const total = summary.results.length;
  if (total === 0) return 'A quiet round on an empty course.';

  const holed = summary.results.filter((result) => result.holed).length;
  const together = hits(summary.collectiveStrokes);

  if (holed === total) {
    return total === 1
      ? `You reached the goal in ${together}.`
      : `Everyone reached the goal! ${together} together.`;
  }
  if (holed === 0) {
    return `Nobody found the cup this time - ${together} between you, and plenty of laughing.`;
  }
  return `${holed} of ${total} reached the goal - ${together} together.`;
}

/** The longer paragraph under the headline: totals, rounds played, who was there. */
export function cooperativeSummaryText(summary: RoundSummary, roundsCompleted: number): string {
  const players = summary.results.length;
  const rounds = Math.max(1, Number.isFinite(roundsCompleted) ? Math.floor(roundsCompleted) : 1);
  const tier = friendshipTierFor(rounds);
  const people = players === 1 ? '1 player' : `${players} players`;
  const roundWord = rounds === 1 ? '1 round' : `${rounds} rounds`;
  const relative = summary.collectiveStrokes - summary.collectivePar;
  const versusPar =
    relative === 0
      ? 'right on par together'
      : relative < 0
        ? `${Math.abs(relative)} under par together`
        : `${relative} over par together`;

  return `${roundWord} played, ${people} on the course, ${hits(summary.collectiveStrokes)} - ${versusPar}. ${tierLabel(tier)}: ${tier.subtitle}`;
}

/** Short line for the persistent co-op HUD banner. */
export function turnBannerText(state: GameState, self: PlayerId): string {
  const round = state.roundState;
  if (round === null || round.mode !== 'together') return '';
  const activeId = round.activePlayerId;
  if (activeId === null) return 'Round complete - nice work, everyone.';
  if (activeId === self) return 'Your turn - drag back from your ball and let go.';
  const player = state.players[activeId];
  return player === undefined ? 'Waiting for the next player...' : `${player.displayName} is lining up...`;
}
