'use client';

import clsx from 'clsx';

export interface SpinnerProps {
  /** Pixel diameter. Defaults to 18 (inline with body text / buttons). */
  readonly size?: number;
  readonly className?: string;
  /** Screen-reader label; omit when a parent already announces the busy state. */
  readonly label?: string;
}

/**
 * Procedural conic spinner — no SVG, no asset, one composited property.
 * `motion-keep` opts it out of the global reduced-motion clamp (a frozen spinner
 * is worse than a slow one) while the CSS layer slows it to 2.4s.
 */
export function Spinner({ size = 18, className, label }: SpinnerProps): React.JSX.Element {
  return (
    <span
      role={label ? 'status' : 'presentation'}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={clsx('motion-keep inline-block shrink-0 animate-fg-spin rounded-full', className)}
      style={{
        width: size,
        height: size,
        background: 'conic-gradient(from 0deg, transparent 0deg, currentColor 300deg)',
        WebkitMask: `radial-gradient(farthest-side, transparent calc(100% - ${Math.max(2, Math.round(size / 9))}px), #000 0)`,
        mask: `radial-gradient(farthest-side, transparent calc(100% - ${Math.max(2, Math.round(size / 9))}px), #000 0)`,
      }}
    />
  );
}
