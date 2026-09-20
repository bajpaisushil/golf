'use client';

import clsx from 'clsx';
import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useState } from 'react';

import { Badge } from '@/components/ui';
import { SPRING_SOFT } from '@/components/ui/motion';
import type { ConnectionState, SignalingStatus } from '@/types';

export interface ConnectionBannerProps {
  readonly connection: ConnectionState;
  readonly signaling: SignalingStatus;
  /** Players currently in the room, including you. */
  readonly playerCount: number;
  readonly className?: string;
}

/** Milliseconds of "not connected yet" before we offer help. */
const PATIENCE_MS = 6000;

interface Pill {
  readonly tone: 'good' | 'warn' | 'bad' | 'neutral';
  readonly label: string;
}

function pillFor(connection: ConnectionState, signaling: SignalingStatus, playerCount: number): Pill {
  if (connection === 'connected' && playerCount > 1) return { tone: 'good', label: 'Connected' };
  if (signaling === 'error' || connection === 'failed') return { tone: 'bad', label: 'Connection problem' };
  if (signaling === 'closed' || connection === 'closed') return { tone: 'neutral', label: 'Offline' };
  if (signaling === 'degraded') return { tone: 'warn', label: 'Patchy link' };
  if (connection === 'reconnecting') return { tone: 'warn', label: 'Reconnecting' };
  if (signaling === 'open') return { tone: 'good', label: 'Room open' };
  return { tone: 'warn', label: 'Connecting…' };
}

/** Status pill plus a genuinely useful message when signalling drags on. */
export function ConnectionBanner({
  connection,
  signaling,
  playerCount,
  className,
}: ConnectionBannerProps): React.JSX.Element {
  const settled = signaling === 'open' || connection === 'connected';
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    if (settled) {
      setSlow(false);
      return;
    }
    const timer = setTimeout(() => setSlow(true), PATIENCE_MS);
    return () => clearTimeout(timer);
  }, [settled]);

  const pill = pillFor(connection, signaling, playerCount);
  const broken = signaling === 'error' || connection === 'failed';

  return (
    <div className={clsx('w-full', className)}>
      <Badge
        tone={pill.tone}
        size="md"
        leading={
          <span
            className={clsx(
              'size-2 rounded-full',
              pill.tone === 'good' && 'bg-good',
              pill.tone === 'warn' && 'motion-keep animate-fg-pulse bg-warn',
              pill.tone === 'bad' && 'bg-bad',
              pill.tone === 'neutral' && 'bg-faint',
            )}
          />
        }
      >
        {pill.label}
      </Badge>

      <AnimatePresence initial={false}>
        {slow || broken ? (
          <motion.p
            layout
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={SPRING_SOFT}
            className="mt-2 rounded-md border border-line bg-raised/50 px-3 py-2 text-sm leading-relaxed text-muted"
          >
            {broken
              ? 'We could not reach the room. Check your connection, then reload this page — your name and room are remembered.'
              : 'Still looking for your friends. Make sure they opened the same code, and keep this tab in the foreground — phones pause background tabs.'}
          </motion.p>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
