'use client';

import { motion } from 'framer-motion';

import { useMotionSafe } from '@/components/ui/motion';

/**
 * The two tiny course previews on the home screen.
 *
 * Deliberately NOT three.js: the home route must never pull the 3D bundle. These
 * are ~20 SVG nodes each, animated with two transform tracks, and they collapse
 * to a static frame under `prefers-reduced-motion`.
 */

const FELT = 'var(--color-turf)';
const LINE = 'color-mix(in oklab, var(--color-text) 22%, transparent)';

function Felt({ x, y, w, h }: { readonly x: number; readonly y: number; readonly w: number; readonly h: number }) {
  return (
    <>
      <rect x={x} y={y} width={w} height={h} rx="9" fill={FELT} />
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx="9"
        fill="none"
        stroke={LINE}
        strokeWidth="1.2"
      />
    </>
  );
}

function Cup({ cx, cy }: { readonly cx: number; readonly cy: number }) {
  return (
    <>
      <circle cx={cx} cy={cy} r="5.2" fill="var(--color-ink)" opacity="0.85" />
      <circle cx={cx} cy={cy} r="5.2" fill="none" stroke="var(--color-accent)" strokeOpacity="0.7" strokeWidth="1.3" />
    </>
  );
}

/** Co-op: one shared course, two balls taking turns towards the same cup. */
export function TogetherPreview(): React.JSX.Element {
  const live = useMotionSafe();

  return (
    <svg viewBox="0 0 120 76" className="h-full w-full" aria-hidden="true">
      <Felt x={4} y={4} w={112} h={68} />

      <rect x="46" y="16" width="9" height="26" rx="4" fill="var(--color-text)" opacity="0.14" />
      <circle cx="74" cy="52" r="6" fill="var(--color-text)" opacity="0.12" />

      <path
        d="M22 56C34 52 40 34 56 30c14-3.5 22 2 32 8"
        fill="none"
        stroke={LINE}
        strokeWidth="1.4"
        strokeDasharray="2 5"
        strokeLinecap="round"
      />

      <Cup cx={96} cy={40} />

      <motion.circle
        r="5"
        fill="#E69F00"
        initial={false}
        animate={live ? { cx: [22, 58, 96], cy: [56, 32, 40] } : { cx: 62, cy: 34 }}
        transition={live ? { duration: 2.6, times: [0, 0.55, 1], repeat: Infinity, repeatDelay: 1.1, ease: 'easeInOut' } : { duration: 0 }}
      />
      <motion.circle
        r="5"
        fill="#56B4E9"
        initial={false}
        animate={live ? { cx: [22, 52, 96], cy: [62, 48, 40] } : { cx: 30, cy: 60 }}
        transition={
          live
            ? { duration: 2.6, times: [0, 0.55, 1], repeat: Infinity, repeatDelay: 1.1, delay: 1.3, ease: 'easeInOut' }
            : { duration: 0 }
        }
      />
    </svg>
  );
}

/** Battle: two private courses, both live at once, each with its own cup. */
export function BattlePreview(): React.JSX.Element {
  const live = useMotionSafe();

  return (
    <svg viewBox="0 0 120 76" className="h-full w-full" aria-hidden="true">
      <Felt x={3} y={4} w={53} h={68} />
      <Felt x={64} y={4} w={53} h={68} />

      <rect x="16" y="30" width="26" height="7" rx="3.5" fill="var(--color-text)" opacity="0.14" />
      <circle cx="90" cy="34" r="7" fill="var(--color-text)" opacity="0.13" />

      <Cup cx={29} cy={17} />
      <Cup cx={90} cy={17} />

      <motion.circle
        r="4.6"
        fill="#009E73"
        initial={false}
        animate={live ? { cx: [29, 20, 29], cy: [62, 44, 17] } : { cx: 24, cy: 48 }}
        transition={live ? { duration: 2.2, repeat: Infinity, repeatDelay: 1.4, ease: 'easeInOut' } : { duration: 0 }}
      />
      <motion.circle
        r="4.6"
        fill="#CC79A7"
        initial={false}
        animate={live ? { cx: [90, 101, 90], cy: [62, 40, 17] } : { cx: 97, cy: 52 }}
        transition={
          live
            ? { duration: 2.9, repeat: Infinity, repeatDelay: 0.7, delay: 0.35, ease: 'easeInOut' }
            : { duration: 0 }
        }
      />
    </svg>
  );
}
