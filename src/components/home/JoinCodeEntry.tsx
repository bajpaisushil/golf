'use client';

import clsx from 'clsx';
import { useState, type FormEvent } from 'react';

import { Button } from '@/components/ui';
import { LIMITS, ROOM_CODE_ALPHABET } from '@/game/config';
import type { RoomCode } from '@/types';
import { isRoomCode, normaliseRoomCode } from '@/utils/roomCode';

export interface JoinCodeEntryProps {
  /** Pre-fills the field, e.g. from a shared ?room=CODE link. */
  readonly initialCode?: string;
  readonly onJoin: (code: RoomCode) => void;
  readonly busy?: boolean;
  readonly disabled?: boolean;
  readonly className?: string;
}

/** Keeps only alphabet characters, uppercased, capped at the code length. */
function sanitise(raw: string): string {
  let out = '';
  for (const character of raw.toUpperCase()) {
    if (ROOM_CODE_ALPHABET.includes(character)) out += character;
  }
  return out.slice(0, LIMITS.ROOM_CODE_LENGTH);
}

/** Accepts a bare code or a whole shared link ("...?room=AB7K9P"). */
export function extractRoomCode(text: string): string {
  const match = /(?:room|code)=([a-zA-Z0-9]+)/.exec(text);
  const candidate = match?.[1] ?? text;
  return sanitise(candidate);
}

/**
 * Join-with-code. Tolerates a pasted link, ignores case, and only enables the
 * button once the code is actually the right shape.
 */
export function JoinCodeEntry({
  initialCode = '',
  onJoin,
  busy = false,
  disabled = false,
  className,
}: JoinCodeEntryProps): React.JSX.Element {
  const [code, setCode] = useState<string>(() => sanitise(initialCode));
  const ready = isRoomCode(code);

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!ready || busy || disabled) return;
    onJoin(normaliseRoomCode(code));
  }

  return (
    <form onSubmit={submit} className={clsx('w-full', className)}>
      <label
        htmlFor="fg-room-code"
        className="mb-2 block text-xs font-semibold tracking-[0.14em] text-faint uppercase"
      >
        Got a code from a friend?
      </label>

      <div className="flex items-stretch gap-2">
        <input
          id="fg-room-code"
          value={code}
          onChange={(event) => setCode(sanitise(event.target.value))}
          onPaste={(event) => {
            const text = event.clipboardData.getData('text');
            if (text === '') return;
            event.preventDefault();
            setCode(extractRoomCode(text));
          }}
          inputMode="text"
          autoCapitalize="characters"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="go"
          maxLength={LIMITS.ROOM_CODE_LENGTH}
          placeholder="AB7K9P"
          aria-describedby="fg-room-code-hint"
          disabled={disabled}
          className={clsx(
            'fg-well fg-code h-14 min-w-0 flex-1 rounded-lg px-4 text-center text-2xl font-bold uppercase',
            'placeholder:font-normal placeholder:text-faint/60 focus:border-accent/50',
          )}
        />
        <Button
          type="submit"
          variant={ready ? 'primary' : 'ghost'}
          size="lg"
          loading={busy}
          disabled={!ready || disabled}
          className="px-6"
        >
          Join
        </Button>
      </div>

      <p id="fg-room-code-hint" className="mt-2 text-sm text-faint">
        {LIMITS.ROOM_CODE_LENGTH} characters, straight off their screen. A pasted link works too.
      </p>
    </form>
  );
}
