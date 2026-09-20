/**
 * Haptics — short `navigator.vibrate` patterns for the moments that deserve one.
 *
 * Feature-detected (iOS Safari does not implement the Vibration API at all), pref
 * respected, `prefers-reduced-motion` respected, and completely silent when any
 * of those say no. Nothing runs at import time, so this is safe in a server render.
 *
 * Patterns are deliberately SHORT. A putting game that buzzes for 200 ms every
 * shot is a game people mute, so the longest pattern here is the round-complete
 * flourish and everything in play is under 40 ms.
 */

import { hapticsPref, patchPrefs } from './storage';

/** The moments worth a buzz. */
export type HapticPattern =
  | 'tap'
  | 'aim'
  | 'putt'
  | 'bounce'
  | 'holed'
  | 'water'
  | 'your-turn'
  | 'round-complete'
  | 'error';

/**
 * Milliseconds on / off. A single number is one pulse; an array alternates
 * vibrate/pause starting with vibrate.
 */
const PATTERNS: Readonly<Record<HapticPattern, number | readonly number[]>> = {
  tap: 8,
  aim: 5,
  putt: 18,
  bounce: 10,
  holed: [24, 40, 24, 40, 48],
  water: [14, 50, 26],
  'your-turn': [16, 70, 16],
  'round-complete': [20, 45, 20, 45, 20, 45, 60],
  error: [30, 60, 30],
};

let enabled = true;
let prefsLoaded = false;

/** Reads the stored preference once, lazily (storage must not be touched on the server). */
function ensurePrefs(): void {
  if (prefsLoaded) return;
  prefsLoaded = true;
  try {
    enabled = hapticsPref();
  } catch {
    enabled = true;
  }
}

/** True when this device actually implements the Vibration API. */
export function hapticsSupported(): boolean {
  if (typeof navigator === 'undefined') return false;
  try {
    return typeof navigator.vibrate === 'function';
  } catch {
    return false;
  }
}

/** Cached query so a buzz per bounce does not allocate a MediaQueryList each time. */
let reducedMotionQuery: MediaQueryList | null = null;

/** True when the player asked for motion to be reduced at the OS level. */
function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    if (reducedMotionQuery === null) {
      reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    }
    return reducedMotionQuery.matches;
  } catch {
    return false;
  }
}

/** Current haptics preference (independent of whether the device supports it). */
export function isHapticsEnabled(): boolean {
  ensurePrefs();
  return enabled;
}

/** Turns haptics on or off and remembers the choice in localStorage. */
export function setHapticsEnabled(on: boolean): void {
  ensurePrefs();
  enabled = on === true;
  try {
    patchPrefs({ haptics: enabled });
  } catch {
    // In-memory only when storage is blocked — the toggle still works this session.
  }
}

/**
 * Fires a named pattern. Returns true only when the device actually accepted it,
 * so a caller can fall back to a visual cue. Never throws.
 */
export function vibrate(pattern: HapticPattern): boolean {
  ensurePrefs();
  if (!enabled) return false;
  if (prefersReducedMotion()) return false;
  if (!hapticsSupported()) return false;

  const spec = PATTERNS[pattern];
  const arg: number | number[] = typeof spec === 'number' ? spec : [...spec];
  try {
    return navigator.vibrate(arg) === true;
  } catch {
    return false;
  }
}

/** Stops any pattern currently playing (e.g. when the tab loses focus). */
export function stopVibration(): void {
  if (!hapticsSupported()) return;
  try {
    navigator.vibrate(0);
  } catch {
    // ignore
  }
}

/** Convenience wrappers so call sites read like the moment they describe. */
export const haptics = {
  tap: (): boolean => vibrate('tap'),
  aim: (): boolean => vibrate('aim'),
  putt: (): boolean => vibrate('putt'),
  bounce: (): boolean => vibrate('bounce'),
  holed: (): boolean => vibrate('holed'),
  water: (): boolean => vibrate('water'),
  yourTurn: (): boolean => vibrate('your-turn'),
  roundComplete: (): boolean => vibrate('round-complete'),
  error: (): boolean => vibrate('error'),
} as const;
