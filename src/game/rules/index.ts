/**
 * Barrel + mode dispatch for the rules layer.
 *
 * Import rules from '@/game/rules' everywhere. The three modules underneath form
 * a strict, acyclic chain:
 *
 *     competitive.ts  (leaf: player status, variants, shot permission)
 *        <- friendship.ts (co-op turn rotation, tiers, collective totals)
 *           <- scoring.ts  (ranking + the "fewer hits = more score" rule)
 *              <- index.ts (this file: the per-mode strategy objects)
 *
 * Everything below is PURE - no React, no timers, no randomness, no Date.now.
 * That is what makes the whole multiplayer game testable headlessly.
 */

export * from './competitive';
export * from './friendship';
export * from './scoring';

import type { GameMode, GameState, PlayerId, PlayerState, PlayerVariant, RoundSummary } from '@/types';
import {
  assignVariants,
  canShoot,
  isBattleRoundOver,
  shouldEndGame,
  variantIndexFor,
} from './competitive';
import { firstTurn, isTogetherRoundOver, nextTurn } from './friendship';
import { summariseRound } from './scoring';

// ---------------------------------------------------------------------------
// The strategy interface both modes implement
// ---------------------------------------------------------------------------

/**
 * Everything the session layer and the UI need to know about "how this mode
 * works", so neither has to branch on `mode` anywhere.
 */
export interface ModeRules {
  readonly mode: GameMode;
  /** Level variant for one player (co-op: always 0 - one shared course). */
  variantIndexFor(player: PlayerState): number;
  /** The ROUND_STARTED `variants` payload for the whole room. */
  assignVariants(state: GameState): readonly PlayerVariant[];
  /** Who may swing first when a round opens (null in modes without turns). */
  firstActivePlayer(state: GameState): PlayerId | null;
  /** Who swings after the current cursor (null in modes without turns). */
  nextActivePlayer(state: GameState): PlayerId | null;
  /** True when this player is allowed to take a shot right now. */
  canShoot(state: GameState, playerId: PlayerId): boolean;
  /** True when nobody can swing any more. */
  isRoundOver(state: GameState): boolean;
  /** True when the round that just finished was the last one. */
  shouldEndGame(state: GameState): boolean;
  /** Authoritative round summary (points included). */
  summariseRound(state: GameState, roundIndex: number): RoundSummary;
}

// ---------------------------------------------------------------------------
// Together / Friendship Journey
// ---------------------------------------------------------------------------

export const TOGETHER_RULES: ModeRules = {
  mode: 'together',
  variantIndexFor: (player) => variantIndexFor(player, 'together'),
  assignVariants,
  firstActivePlayer: firstTurn,
  nextActivePlayer: nextTurn,
  canShoot,
  isRoundOver: isTogetherRoundOver,
  shouldEndGame,
  summariseRound,
};

// ---------------------------------------------------------------------------
// Battle / Friend Battle
// ---------------------------------------------------------------------------

export const BATTLE_RULES: ModeRules = {
  mode: 'battle',
  variantIndexFor: (player) => variantIndexFor(player, 'battle'),
  assignVariants,
  // Battle has no turns at all: everyone plays their own course simultaneously.
  firstActivePlayer: () => null,
  nextActivePlayer: () => null,
  canShoot,
  isRoundOver: isBattleRoundOver,
  shouldEndGame,
  summariseRound,
};

/** The rules for a mode. Never branch on `mode` outside this function. */
export function rulesFor(mode: GameMode): ModeRules {
  return mode === 'battle' ? BATTLE_RULES : TOGETHER_RULES;
}

/** Rules for the mode a live room is running. */
export function rulesForState(state: GameState): ModeRules {
  return rulesFor(state.mode);
}

// ---------------------------------------------------------------------------
// Mode descriptors (consumed by src/modes/*/index.ts and rendered generically)
// ---------------------------------------------------------------------------

/**
 * Everything the home screen needs to render a mode card without knowing
 * anything about the mode itself.
 */
export interface ModeDescriptor {
  readonly id: GameMode;
  readonly name: string;
  readonly tagline: string;
  readonly emoji: string;
  readonly minPlayers: number;
  readonly maxPlayers: number;
  /** Co-op rooms can run forever; battle rooms always have a round count. */
  readonly supportsInfiniteRounds: boolean;
  /** Default round count offered in the create-room panel (null = endless). */
  readonly defaultRounds: number | null;
  /** True when the UI should show ranks, points and a winner. */
  readonly ranked: boolean;
  readonly rulesModule: ModeRules;
}
