'use client';

/**
 * TurnBanner — the single most important line of text on screen.
 *
 * In 'together' it answers "is it me, or am I watching?" — turn rotation is the
 * whole rhythm of co-op mode, so this gets a spring entrance and the active
 * player's own colour.
 *
 * In 'battle' nobody waits for anybody: every player plays the same course and
 * plays at their own pace. So instead of a turn, it surfaces momentum —
 * "3 players still putting" — which is the only shared clock that mode has.
 *
 * The banner is `aria-live="polite"`: screen reader users hear the turn change
 * without the focus being yanked away from the course.
 */

import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';

import { withAlpha } from '@/game/rendering/palette';
import type { GameMode, Hex } from '@/types';
import { cn } from '@/utils/cn';

export interface TurnBannerProps {
  readonly mode: GameMode;
  /** 'together' only: is the local player the active shooter? */
  readonly isMyTurn: boolean;
  /** 'together' only: whose turn it is right now. */
  readonly activeName: string | null;
  readonly activeColor: Hex | null;
  /** The local player has already holed out this round. */
  readonly selfHoled: boolean;
  /** The local player ran out of strokes this round. */
  readonly selfDnf?: boolean;
  /** 'battle' only: how many players have not finished the round yet. */
  readonly stillPutting?: number;
  /** Strokes the local player has taken this round. Drives the first-shot hint. */
  readonly selfStrokes?: number;
  /** A shot is animating — the banner steps back so it does not chatter. */
  readonly busy?: boolean;
  /** The round has finished but the summary is not up yet. */
  readonly roundOver?: boolean;
  readonly selfColor: Hex;
  readonly className?: string;
}

export interface TurnBannerModel {
  /** Changes whenever the banner should re-animate. */
  readonly key: string;
  readonly title: string;
  readonly detail: string | null;
  readonly accent: Hex;
  /** Show the three animated waiting dots. */
  readonly pulse: boolean;
  /** Strong, celebratory treatment (it is the player's moment to act). */
  readonly emphatic: boolean;
}

/** Pure — the whole banner decision tree, so it can be unit-tested without React. */
export function turnBannerModel(props: TurnBannerProps): TurnBannerModel {
  const {
    mode,
    isMyTurn,
    activeName,
    activeColor,
    selfHoled,
    selfDnf = false,
    stillPutting = 0,
    selfStrokes = 0,
    busy = false,
    roundOver = false,
    selfColor,
  } = props;

  if (roundOver) {
    return {
      key: 'round-over',
      title: 'Round complete',
      detail: 'Tallying it up…',
      accent: selfColor,
      pulse: true,
      emphatic: false,
    };
  }

  if (mode === 'battle') {
    const remaining = Math.max(0, Math.floor(stillPutting));
    const hint = 'Drag back from the ball, then let go';

    // Holed out: you are done, but the round is not. You now WATCH the others
    // finish rather than dropping out of the room.
    if (selfHoled) {
      return {
        key: 'battle-holed',
        title: 'You are in \u{1F3AF}',
        detail:
          activeName !== null
            ? `Watching ${activeName} putt`
            : remaining > 0
              ? `${remaining} still to finish`
              : 'Everyone is done',
        accent: selfColor,
        pulse: false,
        emphatic: false,
      };
    }

    if (selfDnf) {
      return {
        key: 'battle-dnf',
        title: 'Out of hits',
        detail: activeName !== null ? `Watching ${activeName} putt` : 'Waiting for the round to close',
        accent: selfColor,
        pulse: false,
        emphatic: false,
      };
    }

    if (isMyTurn) {
      return {
        key: 'battle-your-shot',
        title: selfStrokes === 0 ? 'Take your shot' : 'Your shot',
        detail: hint,
        accent: selfColor,
        pulse: true,
        emphatic: true,
      };
    }

    return {
      key: 'battle-waiting',
      title: activeName === null ? 'Next up…' : `${activeName} is putting`,
      detail: remaining > 1 ? `${remaining} still to finish` : 'You are up next',
      accent: activeColor ?? selfColor,
      pulse: true,
      emphatic: false,
    };
  }

  // --- together -----------------------------------------------------------
  if (selfHoled || selfDnf) {
    return {
      key: activeName === null ? 'together-done' : `together-cheer:${activeName}`,
      title: selfDnf ? 'Sitting this one out' : 'You are in \u{1F3AF}',
      detail: activeName === null ? 'Waiting for the round to close' : `Cheering on ${activeName}`,
      accent: activeColor ?? selfColor,
      pulse: activeName !== null,
      emphatic: false,
    };
  }

  if (busy) {
    return {
      key: 'together-busy',
      title: activeName === null ? 'Rolling…' : `${activeName} is rolling…`,
      detail: null,
      accent: activeColor ?? selfColor,
      pulse: true,
      emphatic: false,
    };
  }

  if (isMyTurn) {
    return {
      key: 'together-mine',
      title: 'Your turn',
      detail: 'Drag back from the ball, then let go',
      accent: selfColor,
      pulse: false,
      emphatic: true,
    };
  }

  return {
    key: `together-waiting:${activeName ?? 'someone'}`,
    title: activeName === null ? 'Waiting…' : `Waiting for ${activeName}`,
    detail: null,
    accent: activeColor ?? selfColor,
    pulse: true,
    emphatic: false,
  };
}

export function TurnBanner(props: TurnBannerProps): React.JSX.Element {
  const reduced = useReducedMotion() ?? false;
  const model = turnBannerModel(props);

  const spring = reduced
    ? { duration: 0.18 }
    : ({ type: 'spring', stiffness: 520, damping: 30, mass: 0.7 } as const);

  return (
    <div
      className={cn('pointer-events-none flex w-full justify-center', props.className)}
      aria-live="polite"
      aria-atomic="true"
    >
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={model.key}
          initial={reduced ? { opacity: 0 } : { opacity: 0, y: -18, scale: 0.9 }}
          animate={reduced ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
          exit={reduced ? { opacity: 0 } : { opacity: 0, y: -10, scale: 0.96 }}
          transition={spring}
          className={cn(
            'flex max-w-[92vw] items-center gap-2.5 rounded-full border px-4 py-2 backdrop-blur-xl',
            model.emphatic ? 'shadow-lg' : '',
          )}
          style={{
            borderColor: withAlpha(model.accent, model.emphatic ? 0.55 : 0.24),
            backgroundColor: model.emphatic ? withAlpha(model.accent, 0.18) : 'rgba(0,0,0,0.4)',
            boxShadow: model.emphatic ? `0 8px 40px -14px ${withAlpha(model.accent, 0.95)}` : undefined,
          }}
        >
          <motion.span
            aria-hidden="true"
            className="h-2.5 w-2.5 shrink-0 rounded-full"
            style={{ backgroundColor: model.accent }}
            animate={model.emphatic && !reduced ? { scale: [1, 1.35, 1] } : { scale: 1 }}
            transition={
              model.emphatic && !reduced
                ? { duration: 1.4, repeat: Infinity, ease: 'easeInOut' }
                : { duration: 0.2 }
            }
          />

          <div className="flex min-w-0 flex-col leading-tight">
            <span
              className={cn(
                'truncate font-semibold',
                model.emphatic ? 'text-[15px] text-white' : 'text-[13.5px] text-white/90',
              )}
            >
              {model.title}
            </span>
            {model.detail ? (
              <span className="truncate text-[11px] text-white/[0.45]">{model.detail}</span>
            ) : null}
          </div>

          {model.pulse ? (
            <span aria-hidden="true" className="ml-0.5 flex shrink-0 items-center gap-[3px]">
              {[0, 1, 2].map((index) => (
                <motion.span
                  key={index}
                  className="h-1 w-1 rounded-full bg-white/50"
                  animate={reduced ? { opacity: 0.5 } : { opacity: [0.2, 1, 0.2] }}
                  transition={
                    reduced
                      ? { duration: 0 }
                      : { duration: 1.2, repeat: Infinity, delay: index * 0.16, ease: 'easeInOut' }
                  }
                />
              ))}
            </span>
          ) : null}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

export default TurnBanner;
