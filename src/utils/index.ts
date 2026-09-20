/**
 * Barrel for the utility layer.
 *
 * Every module underneath is a LEAF: pure functions, or a thin guarded wrapper
 * around exactly one browser API. None of them import from `@/state`,
 * `@/multiplayer`, `@/modes` or `@/components`, so importing from here can never
 * drag game state or the 3D renderer into a bundle.
 *
 *   names.ts       friendly two-word player names (random + deterministic)
 *   roomCode.ts    generate / normalise / validate codes, and the room seed
 *   id.ts          player + peer ids, short ids, string hashing
 *   storage.ts     the ONLY module that touches sessionStorage / localStorage
 *   format.ts      pure string formatting (hits, steps, par, ordinals, durations)
 *   share.ts       result text, clipboard, Web Share, mailto — all local
 *   resultImage.ts the result card, drawn on a canvas with zero assets
 *   sound.ts       procedural WebAudio SFX, zero audio files
 *   haptics.ts     navigator.vibrate patterns
 *
 * `cn.ts` and `math.ts` are listed in docs/CONTRACTS.md §37 but are owned by
 * another agent; they are intentionally NOT re-exported here. Import them
 * directly (`@/utils/cn`) as the existing components already do.
 */

export * from './cn';
export * from './format';
export * from './haptics';
export * from './id';
export * from './names';
export * from './resultImage';
export * from './roomCode';
export * from './share';
export * from './sound';
export * from './storage';
