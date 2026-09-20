'use client';

import clsx from 'clsx';
import type { ConnectionState, Hex } from '@/types';

import { Avatar } from './Avatar';
import { Badge } from './Badge';

export interface PlayerChipProps {
  readonly name: string;
  readonly color: Hex;
  readonly isSelf?: boolean;
  readonly isHost?: boolean;
  readonly connection?: ConnectionState;
  /** Shown on the right — score, strokes, ping, anything short. */
  readonly trailing?: React.ReactNode;
  /** Highlights the row (active turn). */
  readonly active?: boolean;
  readonly className?: string;
}

const DOT_TONE: Readonly<Record<ConnectionState, string>> = {
  idle: 'bg-faint',
  signaling: 'bg-warn',
  connecting: 'bg-warn',
  connected: 'bg-good',
  reconnecting: 'bg-warn',
  disconnected: 'bg-bad',
  failed: 'bg-bad',
  closed: 'bg-faint',
};

const DOT_LABEL: Readonly<Record<ConnectionState, string>> = {
  idle: 'Not connected',
  signaling: 'Finding each other',
  connecting: 'Connecting',
  connected: 'Connected',
  reconnecting: 'Reconnecting',
  disconnected: 'Disconnected',
  failed: 'Connection failed',
  closed: 'Left',
};

/** One player, everywhere: lobby roster, HUD strip, summary rows. */
export function PlayerChip({
  name,
  color,
  isSelf = false,
  isHost = false,
  connection = 'connected',
  trailing,
  active = false,
  className,
}: PlayerChipProps): React.JSX.Element {
  const live = connection === 'connected';

  return (
    <div
      className={clsx(
        'flex min-h-14 items-center gap-3 rounded-lg px-3 py-2 transition-colors',
        active ? 'bg-accent/10 ring-1 ring-accent/25' : 'bg-raised/40',
        className,
      )}
    >
      <Avatar name={name} color={color} size="md" active={active} dimmed={!live} />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className={clsx('truncate font-semibold', !live && 'text-muted')}>{name}</span>
          {isSelf ? (
            <Badge tone="outline" size="sm">
              You
            </Badge>
          ) : null}
          {isHost ? (
            <Badge tone="accent" size="sm" title="Room host">
              Host
            </Badge>
          ) : null}
        </div>
        <div className="mt-0.5 flex items-center gap-1.5">
          <span
            className={clsx(
              'size-2 rounded-full',
              DOT_TONE[connection],
              (connection === 'connecting' || connection === 'signaling' || connection === 'reconnecting') &&
                'motion-keep animate-fg-pulse',
            )}
          />
          <span className="text-xs text-faint">{DOT_LABEL[connection]}</span>
        </div>
      </div>

      {trailing === undefined ? null : <div className="shrink-0 text-right">{trailing}</div>}
    </div>
  );
}
