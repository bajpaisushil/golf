'use client';

import clsx from 'clsx';
import type { ReactNode } from 'react';

export type BadgeTone = 'neutral' | 'accent' | 'good' | 'warn' | 'bad' | 'outline';
export type BadgeSize = 'sm' | 'md';

export interface BadgeProps {
  readonly tone?: BadgeTone;
  readonly size?: BadgeSize;
  readonly children: ReactNode;
  readonly className?: string;
  /** Rendered before the label, e.g. a dot or a tiny glyph. */
  readonly leading?: ReactNode;
  readonly title?: string;
}

const TONES: Readonly<Record<BadgeTone, string>> = {
  neutral: 'bg-raised/70 text-muted border-line',
  accent: 'bg-accent/15 text-accent-hi border-accent/30',
  good: 'bg-good/15 text-good border-good/30',
  warn: 'bg-warn/15 text-warn border-warn/30',
  bad: 'bg-bad/15 text-bad border-bad/30',
  outline: 'text-muted border-line-strong',
};

const SIZES: Readonly<Record<BadgeSize, string>> = {
  sm: 'h-6 gap-1 px-2 text-[0.6875rem]',
  md: 'h-7 gap-1.5 px-2.5 text-xs',
};

export function Badge({
  tone = 'neutral',
  size = 'sm',
  children,
  className,
  leading,
  title,
}: BadgeProps): React.JSX.Element {
  return (
    <span
      title={title}
      className={clsx(
        'inline-flex items-center rounded-full border font-semibold tracking-wide uppercase',
        TONES[tone],
        SIZES[size],
        className,
      )}
    >
      {leading}
      {children}
    </span>
  );
}
