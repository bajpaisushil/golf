'use client';

import clsx from 'clsx';
import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';

export type IconButtonVariant = 'solid' | 'ghost' | 'bare';
export type IconButtonSize = 'sm' | 'md' | 'lg';

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Required: an icon-only control must announce itself. */
  readonly label: string;
  readonly variant?: IconButtonVariant;
  readonly size?: IconButtonSize;
  readonly children: ReactNode;
  readonly ref?: Ref<HTMLButtonElement>;
}

const SIZES: Readonly<Record<IconButtonSize, string>> = {
  sm: 'size-11 rounded-md',
  md: 'size-12 rounded-lg',
  lg: 'size-14 rounded-xl',
};

const VARIANTS: Readonly<Record<IconButtonVariant, string>> = {
  solid: 'fg-panel-strong text-text hover:brightness-110',
  ghost: 'border border-line text-muted hover:text-text hover:bg-raised/60',
  bare: 'text-muted hover:text-text',
};

export function IconButton({
  label,
  variant = 'ghost',
  size = 'md',
  className,
  children,
  type = 'button',
  ref,
  ...rest
}: IconButtonProps): React.JSX.Element {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      className={clsx(
        'fg-press inline-flex shrink-0 items-center justify-center',
        'disabled:pointer-events-none disabled:opacity-45',
        SIZES[size],
        VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
