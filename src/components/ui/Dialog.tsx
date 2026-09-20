'use client';

import clsx from 'clsx';
import { AnimatePresence, motion } from 'framer-motion';
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { IconClose } from './Icons';
import { IconButton } from './IconButton';
import { fade, sheetIn } from './motion';

export interface DialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title: string;
  readonly description?: string;
  readonly children?: ReactNode;
  /** Sticky action row pinned to the bottom of the panel. */
  readonly footer?: ReactNode;
  /** Hide the header close button (Escape and the backdrop still work). */
  readonly hideClose?: boolean;
  readonly className?: string;
}

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function focusablesIn(root: HTMLElement): readonly HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (element) => element.getClientRects().length > 0,
  );
}

/**
 * Accessible modal. It is a bottom sheet on phones and a centred dialog from the
 * `sm` breakpoint up — one component, one focus trap, one set of variants.
 *
 * - focus moves into the panel on open and back to the opener on close
 * - Tab / Shift+Tab cycle inside the panel
 * - Escape and a backdrop tap close it
 * - background scroll is locked while it is open
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  hideClose = false,
  className,
}: DialogProps): React.JSX.Element | null {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const [mounted, setMounted] = useState(false);
  const rawId = useId();
  const titleId = `${rawId}-title`;
  const descId = `${rawId}-desc`;

  useEffect(() => {
    setMounted(true);
  }, []);

  // Remember who opened us, move focus in, restore it on close.
  useEffect(() => {
    if (!open || typeof document === 'undefined') return;

    const active = document.activeElement;
    openerRef.current = active instanceof HTMLElement ? active : null;

    const frame = window.requestAnimationFrame(() => {
      const panel = panelRef.current;
      if (panel === null) return;
      const [first] = focusablesIn(panel);
      if (first === undefined) panel.focus();
      else first.focus();
    });

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      window.cancelAnimationFrame(frame);
      document.body.style.overflow = previousOverflow;
      const opener = openerRef.current;
      if (opener !== null && document.contains(opener)) opener.focus();
    };
  }, [open]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;

      const panel = panelRef.current;
      if (panel === null) return;
      const items = focusablesIn(panel);
      const first = items[0];
      const last = items[items.length - 1];
      if (first === undefined || last === undefined) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const current = document.activeElement;
      if (event.shiftKey && (current === first || current === panel)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && current === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [onClose],
  );

  if (!mounted || typeof document === 'undefined') return null;

  return createPortal(
    <AnimatePresence>
      {open ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-6">
          <motion.button
            type="button"
            aria-label="Close"
            tabIndex={-1}
            onClick={onClose}
            variants={fade}
            initial="hidden"
            animate="show"
            exit="exit"
            className="absolute inset-0 cursor-default bg-ink/70 backdrop-blur-[3px]"
          />

          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={description === undefined ? undefined : descId}
            tabIndex={-1}
            onKeyDown={onKeyDown}
            variants={sheetIn}
            initial="hidden"
            animate="show"
            exit="exit"
            className={clsx(
              'fg-panel-strong relative z-10 flex max-h-[88dvh] w-full flex-col',
              'rounded-t-3xl pb-safe sm:max-w-md sm:rounded-3xl sm:pb-0',
              className,
            )}
          >
            <div className="mx-auto mt-2.5 h-1.5 w-11 rounded-full bg-line-strong sm:hidden" />

            <div className="flex items-start justify-between gap-3 px-5 pt-4 pb-2">
              <div className="min-w-0">
                <h2 id={titleId} className="text-xl font-bold tracking-[-0.02em]">
                  {title}
                </h2>
                {description === undefined ? null : (
                  <p id={descId} className="mt-1 text-sm text-muted">
                    {description}
                  </p>
                )}
              </div>
              {hideClose ? null : (
                <IconButton label="Close" variant="bare" size="sm" onClick={onClose}>
                  <IconClose />
                </IconButton>
              )}
            </div>

            <div className="fg-scroll min-h-0 flex-1 px-5 pb-5">{children}</div>

            {footer === undefined ? null : (
              <div className="border-t border-line px-5 py-4">{footer}</div>
            )}
          </motion.div>
        </div>
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}
