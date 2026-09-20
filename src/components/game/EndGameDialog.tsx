'use client';

/**
 * EndGameDialog — the host's "stop everything" confirmation.
 *
 * Host-only and destructive for EVERY player in the room, so it is a real modal:
 * focus moves into it on open, Tab is trapped inside it, Escape cancels, and
 * focus returns to whatever opened it. Cancel is the safe default and receives
 * initial focus; "End game" is styled as the dangerous one.
 *
 * Self-contained on purpose (no shared ConfirmDialog import) because the focus
 * and aria behaviour here is load-bearing for accessibility and must not drift.
 */

import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useCallback, useEffect, useId, useRef } from 'react';

import { UI, withAlpha } from '@/game/rendering/palette';

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

export interface EndGameDialogProps {
  readonly open: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
  /** Shown in the body copy so the host knows exactly who this affects. */
  readonly playerCount?: number;
  /** Rounds finished so far; 0 hides the reassurance line. */
  readonly roundsPlayed?: number;
}

export function EndGameDialog({
  open,
  onCancel,
  onConfirm,
  playerCount = 0,
  roundsPlayed = 0,
}: EndGameDialogProps): React.JSX.Element {
  const reduced = useReducedMotion() ?? false;
  const panelRef = useRef<HTMLDivElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const bodyId = useId();

  // Remember what had focus, move focus in, and put it back on close.
  useEffect(() => {
    if (!open) return undefined;
    if (typeof document === 'undefined') return undefined;

    const active = document.activeElement;
    returnFocusRef.current = active instanceof HTMLElement ? active : null;

    const frame = window.requestAnimationFrame(() => {
      cancelRef.current?.focus();
    });

    return () => {
      window.cancelAnimationFrame(frame);
      const target = returnFocusRef.current;
      returnFocusRef.current = null;
      if (target && document.contains(target)) target.focus();
    };
  }, [open]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onCancel();
        return;
      }
      if (event.key !== 'Tab') return;

      const panel = panelRef.current;
      if (!panel) return;
      const nodes = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (node) => node.offsetParent !== null || node === document.activeElement,
      );
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (first === undefined || last === undefined) return;

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [onCancel],
  );

  const others = Math.max(0, playerCount - 1);

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          key="end-game-dialog"
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduced ? 0.12 : 0.18 }}
          onKeyDown={onKeyDown}
        >
          <button
            type="button"
            aria-label="Cancel and close"
            tabIndex={-1}
            onClick={onCancel}
            className="absolute inset-0 h-full w-full cursor-default bg-black/70 backdrop-blur-sm"
          />

          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={bodyId}
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: 18, scale: 0.94 }}
            animate={reduced ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, y: 10, scale: 0.97 }}
            transition={{ type: 'spring', stiffness: 460, damping: 34 }}
            className="relative w-full max-w-[380px] rounded-3xl border border-white/[0.12] bg-[#11161D] p-5 shadow-2xl"
          >
            <span aria-hidden="true" className="mb-3 block text-[26px] leading-none">
              {'\u{1F6D1}'}
            </span>

            <h2 id={titleId} className="text-[19px] font-bold leading-tight text-white">
              End this game for everyone?
            </h2>

            <p id={bodyId} className="mt-2 text-[13px] leading-relaxed text-white/[0.55]">
              {others > 0
                ? `You are the host, so this stops the game for you and ${others} other ${
                    others === 1 ? 'player' : 'players'
                  }.`
                : 'You are the host, so this stops the game for everyone in the room.'}{' '}
              {roundsPlayed > 0
                ? `The ${roundsPlayed} ${
                    roundsPlayed === 1 ? 'round' : 'rounds'
                  } played so far will still be shown on the results screen.`
                : 'Nothing has been scored yet.'}
            </p>

            <div className="mt-5 flex gap-2">
              <button
                ref={cancelRef}
                type="button"
                onClick={onCancel}
                className="flex-1 rounded-xl border border-white/[0.12] bg-white/[0.06] px-4 py-2.5 text-[14px] font-semibold text-white/[0.85] transition-colors hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/70"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={onConfirm}
                className="flex-1 rounded-xl px-4 py-2.5 text-[14px] font-bold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                style={{
                  backgroundColor: UI.bad,
                  color: '#0B0F14',
                  outlineColor: withAlpha(UI.bad, 0.9),
                  boxShadow: `0 10px 34px -16px ${withAlpha(UI.bad, 1)}`,
                }}
              >
                End game
              </button>
            </div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

export default EndGameDialog;
