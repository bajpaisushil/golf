'use client';

import clsx from 'clsx';
import { useId, type InputHTMLAttributes, type ReactNode, type Ref } from 'react';

export interface TextInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  readonly label: string;
  /** Hide the label visually but keep it for screen readers. */
  readonly hideLabel?: boolean;
  readonly hint?: ReactNode;
  readonly error?: string | null;
  /** Control rendered inside the field, on the right (e.g. a reroll button). */
  readonly trailing?: ReactNode;
  /** Bigger, chunkier field for hero inputs (the name + room code entries). */
  readonly hero?: boolean;
  readonly ref?: Ref<HTMLInputElement>;
}

export function TextInput({
  label,
  hideLabel = false,
  hint,
  error,
  trailing,
  hero = false,
  className,
  id,
  ref,
  ...rest
}: TextInputProps): React.JSX.Element {
  const autoId = useId();
  const inputId = id ?? autoId;
  const hintId = `${inputId}-hint`;
  const errorId = `${inputId}-error`;
  const describedBy = [error ? errorId : null, hint !== undefined && !error ? hintId : null]
    .filter((value): value is string => value !== null)
    .join(' ');

  return (
    <div className="w-full">
      <label
        htmlFor={inputId}
        className={clsx(
          'mb-2 block text-xs font-semibold tracking-[0.14em] text-faint uppercase',
          hideLabel && 'sr-only',
        )}
      >
        {label}
      </label>

      <div className="relative">
        <input
          ref={ref}
          id={inputId}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy === '' ? undefined : describedBy}
          className={clsx(
            'fg-well fg-press w-full rounded-lg text-text placeholder:text-faint',
            'focus:border-accent/50 focus-visible:outline-2',
            hero ? 'h-16 px-5 text-2xl font-bold tracking-[-0.01em]' : 'h-12 px-4 text-base',
            trailing !== undefined && (hero ? 'pr-20' : 'pr-14'),
            error && 'border-bad/60',
            className,
          )}
          {...rest}
        />
        {trailing === undefined ? null : (
          <div className="absolute inset-y-0 right-2 flex items-center">{trailing}</div>
        )}
      </div>

      {error ? (
        <p id={errorId} role="alert" className="mt-2 text-sm text-bad">
          {error}
        </p>
      ) : hint !== undefined ? (
        <p id={hintId} className="mt-2 text-sm text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
