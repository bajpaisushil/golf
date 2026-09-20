'use client';

import clsx from 'clsx';
import { motion } from 'framer-motion';
import type { ReactNode } from 'react';

import { Spinner } from '@/components/ui';
import { SPRING_SNAPPY } from '@/components/ui/motion';
import type { GameMode } from '@/types';

export interface ModeCardProps {
  readonly mode: GameMode;
  readonly title: string;
  /** One line. If a player needs two, the mode is too complicated. */
  readonly blurb: string;
  readonly meta: string;
  readonly icon: ReactNode;
  readonly preview: ReactNode;
  /** Tint for the card's glow and icon chip — a CSS colour. */
  readonly accent: string;
  readonly loading?: boolean;
  readonly disabled?: boolean;
  readonly onSelect: (mode: GameMode) => void;
}

/**
 * One of the two decisions on the home screen. The whole card is the button, so
 * the tap target is enormous and the choice reads in about two seconds.
 */
export function ModeCard({
  mode,
  title,
  blurb,
  meta,
  icon,
  preview,
  accent,
  loading = false,
  disabled = false,
  onSelect,
}: ModeCardProps): React.JSX.Element {
  return (
    <motion.button
      type="button"
      layout
      whileTap={disabled || loading ? undefined : { scale: 0.985 }}
      transition={SPRING_SNAPPY}
      onClick={() => onSelect(mode)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={clsx(
        'fg-panel group relative flex w-full items-stretch gap-4 overflow-hidden rounded-2xl p-4 text-left',
        'fg-press hover:-translate-y-0.5 hover:shadow-pop',
        'disabled:pointer-events-none disabled:opacity-60',
      )}
    >
      {/* accent wash — the only place each mode gets its own colour */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-70 transition-opacity duration-300 group-hover:opacity-100"
        style={{
          backgroundImage: `radial-gradient(120% 80% at 8% 0%, color-mix(in oklab, ${accent} 26%, transparent) 0%, transparent 62%)`,
        }}
      />

      <span className="relative flex min-w-0 flex-1 flex-col justify-between gap-3">
        <span className="flex items-center gap-2.5">
          <span
            aria-hidden="true"
            className="grid size-9 place-items-center rounded-md"
            style={{
              color: accent,
              backgroundColor: `color-mix(in oklab, ${accent} 18%, transparent)`,
              boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${accent} 32%, transparent)`,
            }}
          >
            {icon}
          </span>
          <span className="text-[1.35rem] leading-none font-black tracking-[-0.03em]">{title}</span>
        </span>

        <span className="block">
          <span className="block text-sm leading-snug text-muted">{blurb}</span>
          <span className="mt-2 flex items-center gap-2 text-[0.6875rem] font-semibold tracking-[0.12em] text-faint uppercase">
            {loading ? <Spinner size={13} /> : null}
            {loading ? 'Opening room' : meta}
          </span>
        </span>
      </span>

      <span className="fg-well relative grid w-[7.25rem] shrink-0 place-items-center overflow-hidden rounded-lg p-1.5 sm:w-32">
        {preview}
      </span>
    </motion.button>
  );
}
