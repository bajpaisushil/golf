'use client';

import clsx from 'clsx';
import { AnimatePresence, motion } from 'framer-motion';

import { Avatar, IconButton, IconDice, TextInput } from '@/components/ui';
import { SPRING_POP } from '@/components/ui/motion';
import { LIMITS, PLAYER_COLORS } from '@/game/config';
import type { Hex } from '@/types';
import { clampName } from '@/utils/format';
import { rerollName } from '@/utils/names';

export interface NameFlowProps {
  readonly name: string;
  readonly onNameChange: (name: string) => void;
  readonly color: Hex;
  readonly onColorChange: (color: Hex) => void;
  /** Tighter spacing for the room join gate. */
  readonly compact?: boolean;
  readonly className?: string;
}

/**
 * "What's your name?" — pre-filled, so doing nothing is a valid answer.
 * A dice button rerolls it and a chip picks the ball colour.
 */
export function NameFlow({
  name,
  onNameChange,
  color,
  onColorChange,
  compact = false,
  className,
}: NameFlowProps): React.JSX.Element {
  return (
    <div className={clsx('flex items-start gap-4', className)}>
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={color}
          initial={{ scale: 0.7, opacity: 0, rotate: -12 }}
          animate={{ scale: 1, opacity: 1, rotate: 0 }}
          exit={{ scale: 0.7, opacity: 0 }}
          transition={SPRING_POP}
          className={clsx('mt-6 shrink-0', compact && 'mt-5')}
        >
          <Avatar name={name} color={color} size="lg" />
        </motion.span>
      </AnimatePresence>

      <div className="min-w-0 flex-1">
        <TextInput
          label="What's your name?"
          value={name}
          onChange={(event) => onNameChange(clampName(event.target.value))}
          onFocus={(event) => event.currentTarget.select()}
          maxLength={LIMITS.MAX_NAME_LENGTH}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="done"
          hero={!compact}
          trailing={
            <IconButton
              label="Pick another name"
              variant="bare"
              size={compact ? 'sm' : 'md'}
              onClick={() => onNameChange(clampName(rerollName(name)))}
            >
              <IconDice size={compact ? 18 : 22} />
            </IconButton>
          }
        />

        <fieldset className="mt-3">
          <legend className="sr-only">Pick your ball colour</legend>
          <div className="flex flex-wrap gap-1.5">
            {PLAYER_COLORS.map((swatch) => {
              const selected = swatch.hex.toLowerCase() === color.toLowerCase();
              return (
                <label
                  key={swatch.hex}
                  className="fg-press relative grid size-11 cursor-pointer place-items-center rounded-full"
                  title={swatch.name}
                >
                  <input
                    type="radio"
                    name="fg-ball-colour"
                    className="peer sr-only"
                    checked={selected}
                    onChange={() => onColorChange(swatch.hex)}
                    value={swatch.hex}
                  />
                  <span className="sr-only">{swatch.name}</span>
                  <span
                    aria-hidden="true"
                    className={clsx(
                      'size-7 rounded-full transition-transform duration-200',
                      'peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent',
                      selected ? 'scale-110' : 'scale-90 opacity-70',
                    )}
                    style={{
                      backgroundImage: `radial-gradient(110% 110% at 32% 20%, color-mix(in oklab, ${swatch.hex} 55%, white), ${swatch.hex} 68%)`,
                      boxShadow: selected
                        ? `0 0 0 2px var(--color-surface), 0 0 0 4px ${swatch.hex}, 0 6px 14px -8px ${swatch.hex}`
                        : '0 2px 6px -4px #000a',
                    }}
                  />
                </label>
              );
            })}
          </div>
        </fieldset>
      </div>
    </div>
  );
}
