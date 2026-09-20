'use client';

import clsx from 'clsx';
import { motion } from 'framer-motion';
import { useState } from 'react';

import { Button, Dialog, IconButton, IconMinus, IconPlus } from '@/components/ui';
import { SPRING_SNAPPY } from '@/components/ui/motion';
import { LIMITS, ROUND_OPTIONS } from '@/game/config';

export interface RoundsSelectorProps {
  /** null = endless. */
  readonly value: number | null;
  readonly onChange: (rounds: number | null) => void;
  readonly disabled?: boolean;
  readonly className?: string;
}

function clampRounds(value: number): number {
  if (!Number.isFinite(value)) return ROUND_OPTIONS[0] ?? 3;
  return Math.min(LIMITS.MAX_ROUNDS, Math.max(1, Math.floor(value)));
}

/** Host-only rounds picker: 3 / 5 / 10 / Custom. */
export function RoundsSelector({
  value,
  onChange,
  disabled = false,
  className,
}: RoundsSelectorProps): React.JSX.Element {
  const [customOpen, setCustomOpen] = useState(false);
  const [draft, setDraft] = useState<number>(() => clampRounds(value ?? 7));
  const isPreset = value !== null && ROUND_OPTIONS.includes(value);
  const activeKey = value === null ? 'custom' : isPreset ? String(value) : 'custom';

  const options: readonly { readonly key: string; readonly label: string; readonly apply: () => void }[] = [
    ...ROUND_OPTIONS.map((rounds) => ({
      key: String(rounds),
      label: String(rounds),
      apply: () => onChange(rounds),
    })),
    {
      key: 'custom',
      label: !isPreset && value !== null ? String(value) : 'Custom',
      apply: () => {
        setDraft(clampRounds(value ?? 7));
        setCustomOpen(true);
      },
    },
  ];

  return (
    <div className={className}>
      <div
        role="group"
        aria-label="Number of rounds"
        className={clsx('fg-well flex gap-1 rounded-lg p-1', disabled && 'opacity-55')}
      >
        {options.map((option) => {
          const active = option.key === activeKey;
          return (
            <button
              key={option.key}
              type="button"
              disabled={disabled}
              aria-pressed={active}
              onClick={option.apply}
              className={clsx(
                'fg-press relative h-11 flex-1 rounded-md text-sm font-bold',
                active ? 'text-accent-ink' : 'text-muted hover:text-text',
                'disabled:pointer-events-none',
              )}
            >
              {active ? (
                <motion.span
                  layoutId="fg-rounds-pill"
                  transition={SPRING_SNAPPY}
                  className="absolute inset-0 rounded-md bg-linear-to-b from-accent-hi to-accent shadow-accent"
                />
              ) : null}
              <span className="relative">{option.label}</span>
            </button>
          );
        })}
      </div>

      <Dialog
        open={customOpen}
        onClose={() => setCustomOpen(false)}
        title="How many rounds?"
        description={`Between 1 and ${LIMITS.MAX_ROUNDS}. Everyone plays every round.`}
        footer={
          <div className="flex gap-2">
            <Button variant="ghost" size="md" fullWidth onClick={() => setCustomOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="md"
              fullWidth
              onClick={() => {
                onChange(clampRounds(draft));
                setCustomOpen(false);
              }}
            >
              Set {clampRounds(draft)} rounds
            </Button>
          </div>
        }
      >
        <div className="flex items-center justify-center gap-5 py-4">
          <IconButton
            label="One fewer round"
            variant="solid"
            onClick={() => setDraft((current) => clampRounds(current - 1))}
          >
            <IconMinus />
          </IconButton>

          <label className="sr-only" htmlFor="fg-custom-rounds">
            Rounds
          </label>
          <input
            id="fg-custom-rounds"
            type="number"
            inputMode="numeric"
            min={1}
            max={LIMITS.MAX_ROUNDS}
            value={draft}
            onChange={(event) => setDraft(clampRounds(Number.parseInt(event.target.value, 10)))}
            className="fg-well tabular h-16 w-28 rounded-lg text-center text-3xl font-black"
          />

          <IconButton
            label="One more round"
            variant="solid"
            onClick={() => setDraft((current) => clampRounds(current + 1))}
          >
            <IconPlus />
          </IconButton>
        </div>
      </Dialog>
    </div>
  );
}
