/**
 * Mode descriptor: "Play Together" (the Friendship Journey).
 *
 * Cooperative. ONE shared course per round, rotating turns in join order,
 * players who already holed out are skipped, and the round ends when nobody can
 * swing any more. There is no winner, no ranking and no leaderboard - only the
 * collective hit count and a friendship tier that rises with every round played.
 *
 * This file is deliberately DATA ONLY: it imports no React and no components, so
 * the home screen can render mode cards without pulling the game UI (or three.js)
 * into the first bundle. The screens themselves live in
 * `FriendshipMode.tsx` / `FriendshipSummary.tsx` and are imported directly by
 * `src/modes/GameScreen.tsx`.
 */

import { LIMITS } from '@/game/config';
import type { ModeDescriptor } from '@/game/rules';
import { TOGETHER_RULES } from '@/game/rules';

export const FRIENDSHIP_MODE: ModeDescriptor = {
  id: 'together',
  name: 'Play Together',
  tagline: 'One course, taking turns, no winners - just how far you get together.',
  emoji: '\u{1F49A}',
  minPlayers: LIMITS.MIN_PLAYERS,
  maxPlayers: LIMITS.MAX_PLAYERS,
  supportsInfiniteRounds: true,
  defaultRounds: null,
  ranked: false,
  rulesModule: TOGETHER_RULES,
};

export default FRIENDSHIP_MODE;
