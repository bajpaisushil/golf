'use client';

import clsx from 'clsx';
import { motion } from 'framer-motion';
import { useId } from 'react';

import { useMotionSafe } from '@/components/ui/motion';

export interface LogoMarkProps {
  /** Pixel size of the square mark. */
  readonly size?: number;
  /** Animates the putt line. Used on loading screens only. */
  readonly animated?: boolean;
  readonly className?: string;
}

/**
 * The Friend Golf mark: a ball, the arc of a putt, and the cup it falls into.
 *
 * 100% original, 100% procedural — three shapes and two gradients, no asset
 * request. Gradient ids are scoped with useId so several marks can coexist.
 */
export function LogoMark({ size = 40, animated = false, className }: LogoMarkProps): React.JSX.Element {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const ballGradient = `fg-ball-${uid}`;
  const arcGradient = `fg-arc-${uid}`;
  const cupGradient = `fg-cup-${uid}`;
  const motionSafe = useMotionSafe();
  const live = animated && motionSafe;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      role="img"
      aria-label="Friend Golf"
      className={clsx('shrink-0', className)}
    >
      <defs>
        <radialGradient id={ballGradient} cx="34%" cy="28%" r="78%">
          <stop offset="0%" stopColor="#ffffff" />
          <stop offset="58%" stopColor="#f3ece0" />
          <stop offset="100%" stopColor="#b9b0a2" />
        </radialGradient>
        <linearGradient id={arcGradient} x1="0" y1="1" x2="1" y2="0">
          <stop offset="0%" stopColor="var(--color-accent)" stopOpacity="0.25" />
          <stop offset="55%" stopColor="var(--color-accent)" />
          <stop offset="100%" stopColor="var(--color-accent-hi)" />
        </linearGradient>
        <linearGradient id={cupGradient} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--color-ink)" />
          <stop offset="100%" stopColor="var(--color-turf)" />
        </linearGradient>
      </defs>

      {/* the green the cup is cut into */}
      <ellipse cx="32.5" cy="36.5" rx="12.5" ry="6.4" fill="var(--color-turf)" opacity="0.55" />

      {/* the cup */}
      <ellipse cx="32.5" cy="36" rx="7.6" ry="3.9" fill={`url(#${cupGradient})`} />
      <ellipse
        cx="32.5"
        cy="36"
        rx="7.6"
        ry="3.9"
        fill="none"
        stroke="var(--color-accent)"
        strokeOpacity="0.55"
        strokeWidth="1.4"
      />

      {/* the putt */}
      <motion.path
        d="M11 34.5C12.8 18 24.5 11.5 31.2 23.4c1.4 2.5 1.8 5.2 1.4 8.4"
        stroke={`url(#${arcGradient})`}
        strokeWidth="3"
        strokeLinecap="round"
        strokeDasharray="0.1 6.4"
        initial={false}
        animate={live ? { strokeDashoffset: [0, -32] } : { strokeDashoffset: 0 }}
        transition={live ? { duration: 1.6, ease: 'linear', repeat: Infinity } : { duration: 0 }}
      />

      {/* the ball */}
      <circle cx="11" cy="34.5" r="6.4" fill={`url(#${ballGradient})`} />
      <circle cx="11" cy="34.5" r="6.4" fill="none" stroke="#0b1014" strokeOpacity="0.28" strokeWidth="1" />
      <circle cx="8.9" cy="32.2" r="1.7" fill="#ffffff" fillOpacity="0.85" />
    </svg>
  );
}
