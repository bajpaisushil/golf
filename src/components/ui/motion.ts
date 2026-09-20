'use client';

/**
 * Shared motion language for the whole shell.
 *
 * Presentation only — this file never touches the deterministic simulation, so
 * trig / random / Date.now would be legal here (we simply do not need them).
 * Every consumer must honour `useMotionSafe()`; the CSS layer also clamps
 * durations under `prefers-reduced-motion`.
 */

import { useReducedMotion, type Transition, type Variants } from 'framer-motion';

/** Calm, slightly heavy spring — screens, cards, sheets. */
export const SPRING_SOFT: Transition = { type: 'spring', stiffness: 210, damping: 26, mass: 0.9 };

/** Quick, confident spring — buttons, chips, toggles. */
export const SPRING_SNAPPY: Transition = { type: 'spring', stiffness: 420, damping: 30, mass: 0.7 };

/** Bouncier spring reserved for the one hero moment per screen. */
export const SPRING_POP: Transition = { type: 'spring', stiffness: 320, damping: 18, mass: 0.8 };

export const EASE_OUT_SOFT: readonly [number, number, number, number] = [0.16, 1, 0.3, 1];

/** Rise + fade. The default entrance for anything that appears in a column. */
export const riseIn: Variants = {
  hidden: { opacity: 0, y: 18 },
  show: { opacity: 1, y: 0, transition: SPRING_SOFT },
  exit: { opacity: 0, y: -10, transition: { duration: 0.18, ease: EASE_OUT_SOFT } },
};

/** Scale + fade, for cards that should feel like they are being placed down. */
export const settleIn: Variants = {
  hidden: { opacity: 0, y: 24, scale: 0.97 },
  show: { opacity: 1, y: 0, scale: 1, transition: SPRING_SOFT },
  exit: { opacity: 0, scale: 0.98, transition: { duration: 0.16, ease: EASE_OUT_SOFT } },
};

/** Container that reveals its children one after the other. */
export function staggerContainer(stagger = 0.06, delayChildren = 0.02): Variants {
  return {
    hidden: {},
    show: { transition: { staggerChildren: stagger, delayChildren } },
    exit: {},
  };
}

/** Bottom sheet on phones, centred dialog on larger screens (same variants work for both). */
export const sheetIn: Variants = {
  hidden: { opacity: 0, y: 40, scale: 0.98 },
  show: { opacity: 1, y: 0, scale: 1, transition: SPRING_SOFT },
  exit: { opacity: 0, y: 24, scale: 0.98, transition: { duration: 0.16, ease: EASE_OUT_SOFT } },
};

export const fade: Variants = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { duration: 0.2, ease: EASE_OUT_SOFT } },
  exit: { opacity: 0, transition: { duration: 0.14, ease: EASE_OUT_SOFT } },
};

/**
 * True when it is fine to animate. Components should collapse looping/decorative
 * motion to a static frame when this is false (entrances may still cross-fade).
 */
export function useMotionSafe(): boolean {
  return useReducedMotion() !== true;
}
