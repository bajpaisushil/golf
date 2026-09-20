'use client';

import clsx from 'clsx';
import { AnimatePresence, motion } from 'framer-motion';

import { PlayerChip } from '@/components/ui';
import { SPRING_SOFT } from '@/components/ui/motion';
import { LIMITS } from '@/game/config';
import type { ConnectionState, PeerInfo, PlayerId, PlayerState } from '@/types';

export interface PlayerRosterProps {
  readonly players: readonly PlayerState[];
  readonly selfId: PlayerId | null;
  /** Live link info, used for the connection dot and ping. */
  readonly peers?: readonly PeerInfo[];
  /** How many empty "waiting" slots to imply. Defaults to LIMITS.MIN_PLAYERS. */
  readonly minPlayers?: number;
  readonly className?: string;
}

function connectionFor(
  player: PlayerState,
  selfId: PlayerId | null,
  peers: readonly PeerInfo[],
): ConnectionState {
  if (selfId !== null && player.id === selfId) return 'connected';
  const peer = peers.find((candidate) => candidate.playerId === player.id);
  if (peer !== undefined) return peer.state;
  return player.connected ? 'connected' : 'disconnected';
}

function pingFor(player: PlayerState, peers: readonly PeerInfo[]): number | null {
  const peer = peers.find((candidate) => candidate.playerId === player.id);
  return peer?.rttMs ?? null;
}

/** Who is in the room, in join order, with live connection dots. */
export function PlayerRoster({
  players,
  selfId,
  peers = [],
  minPlayers = LIMITS.MIN_PLAYERS,
  className,
}: PlayerRosterProps): React.JSX.Element {
  const ordered = [...players].sort((a, b) => a.joinSeq - b.joinSeq);
  const ghostCount = Math.max(0, minPlayers - ordered.length);

  return (
    <div className={clsx('space-y-2', className)}>
      <AnimatePresence initial={false}>
        {ordered.map((player) => {
          const ping = pingFor(player, peers);
          return (
            <motion.div
              key={player.id}
              layout
              initial={{ opacity: 0, y: 10, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, scale: 0.98 }}
              transition={SPRING_SOFT}
            >
              <PlayerChip
                name={player.displayName}
                color={player.color}
                isSelf={selfId !== null && player.id === selfId}
                isHost={player.isHost}
                connection={connectionFor(player, selfId, peers)}
                trailing={
                  ping === null ? null : (
                    <span className="tabular text-xs text-faint">{Math.round(ping)} ms</span>
                  )
                }
              />
            </motion.div>
          );
        })}
      </AnimatePresence>

      {Array.from({ length: ghostCount }, (_, index) => (
        <div
          key={`ghost-${index}`}
          className="flex min-h-14 items-center gap-3 rounded-lg border border-dashed border-line px-3 py-2"
        >
          <span className="motion-keep size-11 animate-fg-pulse rounded-full border border-dashed border-line-strong" />
          <span className="text-sm text-faint">Waiting for a friend to join…</span>
        </div>
      ))}
    </div>
  );
}
