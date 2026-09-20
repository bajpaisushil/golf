'use client';

import clsx from 'clsx';
import { AnimatePresence, motion } from 'framer-motion';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { SPRING_SNAPPY } from './motion';

export type ToastTone = 'neutral' | 'good' | 'warn' | 'bad' | 'accent';

export interface ToastOptions {
  readonly title: string;
  readonly description?: string;
  readonly tone?: ToastTone;
  /** Milliseconds on screen. Defaults to 3200. */
  readonly duration?: number;
}

interface ToastRecord extends ToastOptions {
  readonly id: number;
}

export interface ToastApi {
  /** Shows a toast and returns its id. */
  readonly push: (options: ToastOptions) => number;
  readonly dismiss: (id: number) => void;
}

const NOOP_API: ToastApi = {
  push: () => -1,
  dismiss: () => undefined,
};

const ToastContext = createContext<ToastApi>(NOOP_API);

/** Toast dispatcher. Safe to call outside the provider (it becomes a no-op). */
export function useToast(): ToastApi {
  return useContext(ToastContext);
}

const TONES: Readonly<Record<ToastTone, string>> = {
  neutral: 'border-line-strong',
  good: 'border-good/45',
  warn: 'border-warn/45',
  bad: 'border-bad/50',
  accent: 'border-accent/45',
};

const DOT: Readonly<Record<ToastTone, string>> = {
  neutral: 'bg-muted',
  good: 'bg-good',
  warn: 'bg-warn',
  bad: 'bg-bad',
  accent: 'bg-accent',
};

let nextToastId = 1;

export function ToastProvider({ children }: { readonly children: ReactNode }): React.JSX.Element {
  const [toasts, setToasts] = useState<readonly ToastRecord[]>([]);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback(
    (options: ToastOptions): number => {
      const id = nextToastId++;
      const record: ToastRecord = { ...options, id };
      // Never stack more than three; the oldest quietly leaves.
      setToasts((current) => [...current.slice(-2), record]);
      const duration = options.duration ?? 3200;
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), duration),
      );
      return id;
    },
    [dismiss],
  );

  useEffect(() => {
    const pending = timers.current;
    return () => {
      pending.forEach((timer) => clearTimeout(timer));
      pending.clear();
    };
  }, []);

  const api = useMemo<ToastApi>(() => ({ push, dismiss }), [push, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        aria-live="polite"
        aria-atomic="false"
        className="pointer-events-none fixed inset-x-0 top-0 z-[60] flex flex-col items-center gap-2 px-4 pt-safe"
      >
        <AnimatePresence initial={false}>
          {toasts.map((toast) => (
            <motion.div
              key={toast.id}
              layout
              initial={{ opacity: 0, y: -16, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -12, scale: 0.97 }}
              transition={SPRING_SNAPPY}
              className={clsx(
                'fg-panel-strong pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-lg px-4 py-3',
                TONES[toast.tone ?? 'neutral'],
              )}
            >
              <span className={clsx('mt-1.5 size-2 shrink-0 rounded-full', DOT[toast.tone ?? 'neutral'])} />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">{toast.title}</p>
                {toast.description === undefined ? null : (
                  <p className="mt-0.5 text-sm text-muted">{toast.description}</p>
                )}
              </div>
              <button
                type="button"
                onClick={() => dismiss(toast.id)}
                className="fg-press -m-2 shrink-0 rounded-md p-2 text-faint hover:text-text"
                aria-label="Dismiss notification"
              >
                <span aria-hidden="true">&times;</span>
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}
