/**
 * Deterministic level generation + course themes.
 *
 * Import from `@/game/levels` everywhere:
 *   import { generateLevel, themeForRound, seedFor } from '@/game/levels';
 *
 * A `LevelSpec` is NEVER sent over the network: peers exchange
 * `{roomSeed, roundIndex, variantIndex}` and rebuild identical geometry locally.
 */

export * from './prng';
export * from './generator';
export * from './themes';
