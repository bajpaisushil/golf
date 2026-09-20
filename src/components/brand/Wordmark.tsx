'use client';

import clsx from 'clsx';

import { LogoMark } from './LogoMark';

export type WordmarkSize = 'sm' | 'md' | 'lg';

export interface WordmarkProps {
  readonly size?: WordmarkSize;
  /** Hide the mark and show type only (tight spaces such as the lobby top bar). */
  readonly markOnly?: boolean;
  readonly animated?: boolean;
  readonly className?: string;
}

const TYPE: Readonly<Record<WordmarkSize, string>> = {
  sm: 'text-xl',
  md: 'text-3xl',
  lg: 'text-[2.75rem] sm:text-6xl',
};

const MARK: Readonly<Record<WordmarkSize, number>> = { sm: 26, md: 36, lg: 58 };

/**
 * The lockup: mark + "friendgolf" set in two weights of the system stack, the
 * second half carrying the one accent colour. No webfont, no image.
 */
export function Wordmark({
  size = 'md',
  markOnly = false,
  animated = false,
  className,
}: WordmarkProps): React.JSX.Element {
  return (
    <span className={clsx('inline-flex items-center gap-2.5 select-none', className)}>
      <LogoMark size={MARK[size]} animated={animated} />
      {markOnly ? null : (
        <span
          className={clsx('leading-none tracking-[-0.045em] lowercase', TYPE[size])}
          aria-hidden="true"
        >
          <span className="font-light text-text/85">friend</span>
          <span
            className="font-black"
            style={{
              backgroundImage:
                'linear-gradient(105deg, var(--color-accent-hi), var(--color-accent) 58%, var(--color-accent-lo))',
              WebkitBackgroundClip: 'text',
              backgroundClip: 'text',
              color: 'transparent',
            }}
          >
            golf
          </span>
        </span>
      )}
    </span>
  );
}
