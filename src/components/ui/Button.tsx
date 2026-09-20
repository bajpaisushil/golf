'use client';

import clsx from 'clsx';
import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';

import { Spinner } from './Spinner';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'quiet' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'color'> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  /** Shows a spinner, sets aria-busy and blocks clicks. */
  readonly loading?: boolean;
  readonly fullWidth?: boolean;
  readonly leading?: ReactNode;
  readonly trailing?: ReactNode;
  readonly ref?: Ref<HTMLButtonElement>;
}

/** Every size clears the 44px minimum touch target. */
const SIZES: Readonly<Record<ButtonSize, string>> = {
  sm: 'h-11 gap-2 rounded-md px-4 text-[0.9375rem]',
  md: 'h-12 gap-2.5 rounded-lg px-5 text-base',
  lg: 'h-14 gap-3 rounded-xl px-7 text-lg',
};

const VARIANTS: Readonly<Record<ButtonVariant, string>> = {
  primary:
    'bg-linear-to-b from-accent-hi to-accent text-accent-ink shadow-accent font-semibold ' +
    'border border-accent-lo/40 hover:brightness-[1.06] active:brightness-95',
  secondary:
    'fg-panel-strong text-text font-semibold hover:border-line-strong hover:brightness-110',
  ghost: 'border border-line text-text font-medium hover:bg-raised/60',
  quiet: 'text-muted font-medium hover:text-text hover:bg-raised/50',
  danger: 'bg-bad/15 text-bad border border-bad/35 font-semibold hover:bg-bad/25',
};

/**
 * The single button primitive. Always a real <button> so keyboard, form and
 * assistive-tech behaviour comes for free.
 */
export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  fullWidth = false,
  leading,
  trailing,
  className,
  children,
  disabled,
  type = 'button',
  ref,
  ...rest
}: ButtonProps): React.JSX.Element {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled === true || loading}
      aria-busy={loading || undefined}
      className={clsx(
        'fg-press relative inline-flex select-none items-center justify-center whitespace-nowrap',
        'disabled:pointer-events-none disabled:opacity-50',
        SIZES[size],
        VARIANTS[variant],
        fullWidth && 'w-full',
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner size={size === 'lg' ? 20 : 16} /> : leading}
      <span className="min-w-0 truncate">{children}</span>
      {loading ? null : trailing}
    </button>
  );
}
