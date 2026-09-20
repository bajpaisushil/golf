'use client';

/**
 * Hud — the persistent top bar during a round.
 *
 * Layout rule that drives every decision here: the middle of the screen belongs
 * to the ball. Everything chrome-like is pinned to the very top (out of the
 * aiming zone) and kept to one compact row plus safe-area padding, so on a small
 * phone the slingshot drag never starts under a button. The rail and the
 * opponent boards live at the bottom, in thumb reach; nothing floats over the
 * course itself.
 *
 * Mode framing is deliberate:
 *   battle   — "ROUND 2 / 5", and a live "if you sink it now" points readout so
 *              the fewer-hits-scores-more rule is visible DURING the round, not
 *              just on the summary.
 *   together — "ROUND 2" with the friendship tier. No round total, because the
 *              journey is endless by design, and no points, because there are none.
 */

import { motion, useReducedMotion } from 'framer-motion';
import type { ReactNode } from 'react';

import { UI, withAlpha } from '@/game/rendering/palette';
import type { FriendshipTier, GameMode, Hex } from '@/types';
import { cn } from '@/utils/cn';
import { relativeToPar } from '@/utils/format';

/** Strokes left at which the stroke pill starts warning the player. */
const LOW_STROKES_WARNING = 3;

export interface HudProps {
  readonly mode: GameMode;
  /** 0-based index of the live round. */
  readonly roundIndex: number;
  /** null = endless (the co-op default). */
  readonly totalRounds: number | null;
  readonly strokes: number;
  readonly par: number;
  readonly maxStrokes: number;
  /** Co-op only: the tier reached so far. */
  readonly tier?: FriendshipTier | null;
  /** Battle only: points this player banks if they hole out on the next stroke. */
  readonly projectedPoints?: number | null;
  readonly selfColor: Hex;
  readonly isHost: boolean;
  readonly soundOn: boolean;
  readonly onToggleSound: () => void;
  /** Host only. Omit for guests — the button is not rendered at all. */
  readonly onEndGame?: () => void;
  /** Usually a <ConnectionBadge />. */
  readonly connectionSlot?: ReactNode;
  readonly className?: string;
}

function roundLabel(mode: GameMode, roundIndex: number, totalRounds: number | null): string {
  const human = roundIndex + 1;
  if (mode === 'battle' && totalRounds !== null && totalRounds > 0) {
    return `Round ${human} / ${totalRounds}`;
  }
  return `Round ${human}`;
}

export function Hud({
  mode,
  roundIndex,
  totalRounds,
  strokes,
  par,
  maxStrokes,
  tier = null,
  projectedPoints = null,
  selfColor,
  isHost,
  soundOn,
  onToggleSound,
  onEndGame,
  connectionSlot,
  className,
}: HudProps): React.JSX.Element {
  const reduced = useReducedMotion() ?? false;
  const strokesLeft = Math.max(0, maxStrokes - strokes);
  const running = strokesLeft <= LOW_STROKES_WARNING && strokesLeft > 0;
  const delta = relativeToPar(strokes, par);

  return (
    <header
      className={cn(
        'pointer-events-none flex w-full items-start justify-between gap-2 px-3 pt-[max(0.5rem,env(safe-area-inset-top))]',
        className,
      )}
    >
      {/* Left: round + mode framing */}
      <div className="pointer-events-auto flex min-w-0 flex-col gap-1">
        <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-black/40 px-2.5 py-1.5 backdrop-blur-xl">
          <span className="text-[11px] font-bold uppercase tracking-[0.16em] text-white/[0.85]">
            {roundLabel(mode, roundIndex, totalRounds)}
          </span>
          {mode === 'together' && totalRounds === null ? (
            <span className="hidden text-[10px] font-medium text-white/30 sm:inline">endless</span>
          ) : null}
        </div>

        {mode === 'together' && tier ? (
          <motion.div
            key={`${tier.title}:${tier.cycle}`}
            initial={reduced ? { opacity: 0 } : { opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ type: 'spring', stiffness: 460, damping: 32 }}
            className="flex max-w-[52vw] items-center gap-1.5 rounded-lg border border-white/10 bg-black/[0.35] px-2 py-1 backdrop-blur-xl"
          >
            <span aria-hidden="true" className="text-[12px] leading-none">
              {tier.emoji}
            </span>
            <span className="truncate text-[10.5px] font-semibold text-white/70">
              {tier.title}
              {tier.cycle > 0 ? ` ×${tier.cycle + 1}` : ''}
            </span>
          </motion.div>
        ) : null}

        {mode === 'battle' && projectedPoints !== null ? (
          <div
            className="flex items-center gap-1.5 rounded-lg border px-2 py-1 backdrop-blur-xl"
            style={{ borderColor: withAlpha(UI.accent, 0.3), backgroundColor: withAlpha(UI.accent, 0.12) }}
            title="Sink it on your next stroke and this is what the hit-efficiency bonus pays"
          >
            <span aria-hidden="true" className="text-[11px] leading-none">
              {'⚡'}
            </span>
            <span className="text-[10.5px] font-semibold" style={{ color: UI.accent }}>
              Sink now: +{projectedPoints}
            </span>
          </div>
        ) : null}
      </div>

      {/* Centre: the number that matters */}
      <div className="pointer-events-auto flex shrink-0 flex-col items-center">
        <div
          className="flex items-end gap-1.5 rounded-xl border bg-black/40 px-3 py-1.5 backdrop-blur-xl"
          style={{
            borderColor: running ? withAlpha(UI.warn, 0.45) : withAlpha(selfColor, 0.3),
          }}
        >
          <span
            className="font-mono text-[22px] font-bold leading-none tabular-nums"
            style={{ color: running ? UI.warn : '#FFFFFF' }}
          >
            {strokes}
          </span>
          <span className="pb-[2px] text-[10.5px] font-semibold uppercase tracking-[0.1em] text-white/40">
            {strokes === 1 ? 'hit' : 'hits'}
          </span>
        </div>
        <div className="mt-1 flex items-center gap-1.5 text-[10px] font-medium text-white/40">
          <span>par {par}</span>
          <span aria-hidden="true" className="text-white/20">
            {'·'}
          </span>
          <span className="font-mono tabular-nums">{delta}</span>
        </div>
        <span className="sr-only" aria-live="polite">
          {strokes} hits taken, par {par}
          {running ? `, ${strokesLeft} strokes left before you are out` : ''}
        </span>
      </div>

      {/* Right: quiet controls */}
      <div className="pointer-events-auto flex shrink-0 flex-col items-end gap-1.5">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onToggleSound}
            aria-pressed={soundOn}
            aria-label={soundOn ? 'Mute sound' : 'Unmute sound'}
            title={soundOn ? 'Mute' : 'Unmute'}
            className="flex h-8 w-8 items-center justify-center rounded-xl border border-white/10 bg-black/40 text-[13px] backdrop-blur-xl transition-colors hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/70"
          >
            <span aria-hidden="true">{soundOn ? '\u{1F50A}' : '\u{1F507}'}</span>
          </button>

          {isHost && onEndGame ? (
            <button
              type="button"
              onClick={onEndGame}
              className="flex h-8 items-center rounded-xl border px-2.5 text-[11px] font-semibold backdrop-blur-xl transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/70"
              style={{
                borderColor: withAlpha(UI.bad, 0.35),
                backgroundColor: withAlpha(UI.bad, 0.12),
                color: UI.bad,
              }}
            >
              End game
            </button>
          ) : null}
        </div>

        {connectionSlot}
      </div>
    </header>
  );
}

export default Hud;
