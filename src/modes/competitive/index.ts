/**
 * Mode descriptor: "Friend Battle".
 *
 * Competitive. Every player gets their OWN independently generated course (same
 * generator, different variant index) and everyone plays simultaneously at their
 * own pace. A round is ranked by fewest hits first, finishing order as the
 * tie-break, and points are placement + hit-efficiency - so FEWER HITS SCORES
 * MORE, which is the whole point of the mode.
 *
 * DATA ONLY: no React, no components, so mode cards cost the home screen nothing.
 * The screens live in `BattleMode.tsx` / `BattleSummary.tsx` and are imported
 * directly by `src/modes/GameScreen.tsx`.
 */

import { DEFAULT_BATTLE_ROUNDS, LIMITS } from '@/game/config';
import type { ModeDescriptor } from '@/game/rules';
import { BATTLE_RULES } from '@/game/rules';

export const COMPETITIVE_MODE: ModeDescriptor = {
  id: 'battle',
  name: 'Friend Battle',
  tagline: 'Your own course each, all at once - fewest hits takes the round.',
  emoji: '\u{1F3AF}',
  minPlayers: LIMITS.MIN_PLAYERS,
  maxPlayers: LIMITS.MAX_PLAYERS,
  supportsInfiniteRounds: false,
  defaultRounds: DEFAULT_BATTLE_ROUNDS,
  ranked: true,
  rulesModule: BATTLE_RULES,
};

export default COMPETITIVE_MODE;
