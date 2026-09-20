'use client';

import clsx from 'clsx';
import type { HTMLAttributes, ReactNode } from 'react';

export type CardTone = 'default' | 'strong' | 'well' | 'bare';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  readonly tone?: CardTone;
  /** Adds hover lift. Use only when the whole card is genuinely clickable. */
  readonly interactive?: boolean;
  readonly padded?: boolean;
  readonly children?: ReactNode;
}

const TONES: Readonly<Record<CardTone, string>> = {
  default: 'fg-panel',
  strong: 'fg-panel-strong',
  well: 'fg-well',
  bare: 'border border-line',
};

export function Card({
  tone = 'default',
  interactive = false,
  padded = true,
  className,
  children,
  ...rest
}: CardProps): React.JSX.Element {
  return (
    <div
      className={clsx(
        'relative rounded-xl',
        TONES[tone],
        padded && 'p-4 sm:p-5',
        interactive && 'fg-press cursor-pointer hover:-translate-y-0.5 hover:shadow-pop',
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

export interface CardHeaderProps {
  readonly title: ReactNode;
  readonly subtitle?: ReactNode;
  readonly trailing?: ReactNode;
  readonly className?: string;
}

export function CardHeader({ title, subtitle, trailing, className }: CardHeaderProps): React.JSX.Element {
  return (
    <div className={clsx('flex items-start justify-between gap-3', className)}>
      <div className="min-w-0">
        <h2 className="text-base leading-tight font-semibold tracking-[-0.01em]">{title}</h2>
        {subtitle === undefined ? null : (
          <p className="mt-1 text-sm leading-snug text-muted">{subtitle}</p>
        )}
      </div>
      {trailing === undefined ? null : <div className="shrink-0">{trailing}</div>}
    </div>
  );
}
