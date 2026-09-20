'use client';

import clsx from 'clsx';
import type { Hex } from '@/types';

export type AvatarSize = 'xs' | 'sm' | 'md' | 'lg';

export interface AvatarProps {
  readonly name: string;
  readonly color: Hex;
  readonly size?: AvatarSize;
  /** Draws the soft halo used for "it is this player's turn". */
  readonly active?: boolean;
  readonly dimmed?: boolean;
  readonly className?: string;
}

const SIZES: Readonly<Record<AvatarSize, string>> = {
  xs: 'size-7 text-[0.625rem]',
  sm: 'size-9 text-xs',
  md: 'size-11 text-sm',
  lg: 'size-16 text-xl',
};

/** First letters of the first two words — "Happy Fox" becomes "HF". */
export function initialsFor(name: string): string {
  const words = name.trim().split(/\s+/).filter((word) => word.length > 0);
  const first = words[0];
  const second = words[1];
  if (first === undefined) return '?';
  const head = first.charAt(0);
  const tail = second === undefined ? '' : second.charAt(0);
  return (head + tail).toUpperCase();
}

/**
 * Procedural player disc: the player's colour, a soft inner light and their
 * initials. No images, ever.
 */
export function Avatar({
  name,
  color,
  size = 'md',
  active = false,
  dimmed = false,
  className,
}: AvatarProps): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className={clsx(
        'relative inline-grid shrink-0 place-items-center rounded-full font-black tracking-tight',
        'ring-1 ring-black/25',
        SIZES[size],
        dimmed && 'opacity-45 saturate-50',
        className,
      )}
      style={{
        color: '#0b1014',
        backgroundImage: `radial-gradient(115% 115% at 30% 18%, color-mix(in oklab, ${color} 62%, white), ${color} 62%, color-mix(in oklab, ${color} 74%, black))`,
        boxShadow: active
          ? `0 0 0 3px color-mix(in oklab, ${color} 45%, transparent), 0 8px 18px -8px ${color}`
          : '0 4px 10px -6px #000a',
      }}
    >
      {initialsFor(name)}
    </span>
  );
}
