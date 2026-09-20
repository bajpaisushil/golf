'use client';

import { motion } from 'framer-motion';
import { useState } from 'react';

import { Wordmark } from '@/components/brand';
import {
  Badge,
  Button,
  Card,
  Dialog,
  IconBack,
  IconButton,
  IconPlay,
  IconSwords,
  IconUsers,
} from '@/components/ui';
import { riseIn, staggerContainer } from '@/components/ui/motion';
import { LIMITS } from '@/game/config';
import type {
  ConnectionState,
  GameMode,
  PeerInfo,
  PlayerId,
  PlayerState,
  RoomCode,
  SignalingStatus,
} from '@/types';

import { ConnectionBanner } from './ConnectionBanner';
import { PlayerRoster } from './PlayerRoster';
import { RoomCodeCard } from './RoomCodeCard';
import { RoundsSelector } from './RoundsSelector';

export interface LobbyProps {
  readonly roomCode: RoomCode;
  readonly mode: GameMode;
  readonly players: readonly PlayerState[];
  readonly selfId: PlayerId | null;
  readonly isHost: boolean;
  /** null = endless (always the case in co-op). */
  readonly totalRounds: number | null;
  readonly connection: ConnectionState;
  readonly signaling: SignalingStatus;
  readonly peers?: readonly PeerInfo[];
  readonly starting?: boolean;
  readonly onStart: () => void;
  readonly onLeave: () => void;
  /** null when this client cannot change settings (guest, or the session has no setter). */
  readonly onChangeRounds: ((rounds: number | null) => void) | null;
}

const MODE_COPY: Readonly<Record<GameMode, { readonly title: string; readonly blurb: string }>> = {
  together: {
    title: 'Play Together',
    blurb: 'One shared course. You take turns, nobody loses, the journey just keeps going.',
  },
  battle: {
    title: 'Friend Battle',
    blurb: 'Everyone plays the same course at the same time. Fewer hits scores more points.',
  },
};

/** The room before the first putt: code, people, settings, start. */
export function Lobby({
  roomCode,
  mode,
  players,
  selfId,
  isHost,
  totalRounds,
  connection,
  signaling,
  peers = [],
  starting = false,
  onStart,
  onLeave,
  onChangeRounds,
}: LobbyProps): React.JSX.Element {
  const [confirmLeave, setConfirmLeave] = useState(false);
  const copy = MODE_COPY[mode];
  const ready = players.length >= LIMITS.MIN_PLAYERS;
  const missing = Math.max(0, LIMITS.MIN_PLAYERS - players.length);
  const host = players.find((player) => player.isHost);

  return (
    <div className="relative z-10 mx-auto flex min-h-dvh w-full max-w-lg flex-col px-safe pt-safe">
      <header className="flex items-center justify-between gap-3 py-2">
        <IconButton label="Leave this room" variant="bare" size="sm" onClick={() => setConfirmLeave(true)}>
          <IconBack />
        </IconButton>
        <Wordmark size="sm" />
        <span className="w-11" aria-hidden="true" />
      </header>

      <motion.main
        variants={staggerContainer(0.07)}
        initial="hidden"
        animate="show"
        className="flex-1 space-y-4 pb-40"
      >
        <motion.div variants={riseIn}>
          <RoomCodeCard code={roomCode} />
        </motion.div>

        <motion.div variants={riseIn} className="flex justify-center">
          <ConnectionBanner
            connection={connection}
            signaling={signaling}
            playerCount={players.length}
            className="flex flex-col items-center text-center"
          />
        </motion.div>

        <motion.div variants={riseIn}>
          <Card tone="default" className="flex items-start gap-3">
            <span
              aria-hidden="true"
              className="grid size-10 shrink-0 place-items-center rounded-md bg-accent/15 text-accent-hi"
            >
              {mode === 'together' ? <IconUsers size={22} /> : <IconSwords size={22} />}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h2 className="font-bold tracking-[-0.01em]">{copy.title}</h2>
                <Badge tone="neutral" size="sm">
                  {totalRounds === null ? 'Endless' : `${totalRounds} rounds`}
                </Badge>
              </div>
              <p className="mt-1 text-sm leading-snug text-muted">{copy.blurb}</p>
            </div>
          </Card>
        </motion.div>

        <motion.section variants={riseIn} aria-labelledby="fg-roster-heading">
          <div className="mb-2 flex items-baseline justify-between px-1">
            <h2 id="fg-roster-heading" className="text-sm font-bold tracking-[0.1em] text-faint uppercase">
              In the room
            </h2>
            <span className="tabular text-xs text-faint">
              {players.length} / {LIMITS.MAX_PLAYERS}
            </span>
          </div>
          <PlayerRoster players={players} selfId={selfId} peers={peers} />
        </motion.section>

        {isHost && mode === 'battle' ? (
          <motion.section variants={riseIn} aria-labelledby="fg-settings-heading">
            <Card tone="default">
              <div className="mb-3 flex items-baseline justify-between">
                <h2 id="fg-settings-heading" className="text-sm font-bold tracking-[0.1em] text-faint uppercase">
                  Rounds
                </h2>
                <span className="text-xs text-faint">Host only</span>
              </div>
              {onChangeRounds === null ? (
                <div className="fg-well flex items-center justify-between gap-3 rounded-lg px-4 py-3">
                  <span className="tabular text-2xl font-black">
                    {totalRounds === null ? '∞' : totalRounds}
                  </span>
                  <span className="text-right text-sm text-muted">
                    Set when you opened the room.
                  </span>
                </div>
              ) : (
                <RoundsSelector value={totalRounds} onChange={onChangeRounds} />
              )}
            </Card>
          </motion.section>
        ) : null}

        {isHost && mode === 'together' ? (
          <motion.p variants={riseIn} className="px-1 text-sm text-faint">
            Co-op rooms run as long as you want — finish a round, then keep going or stop.
          </motion.p>
        ) : null}
      </motion.main>

      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-20">
        <div className="pointer-events-none h-16 bg-linear-to-t from-ink/90 to-transparent" />
        <div className="pointer-events-auto bg-ink/90 px-safe pb-safe backdrop-blur-md">
          <div className="mx-auto w-full max-w-lg pt-2 pb-2">
            {isHost ? (
              <>
                <Button
                  variant="primary"
                  size="lg"
                  fullWidth
                  loading={starting}
                  disabled={!ready}
                  onClick={onStart}
                  leading={starting ? undefined : <IconPlay size={18} />}
                >
                  {ready ? 'Start the game' : `Waiting for ${missing} more`}
                </Button>
                <p className="mt-2 text-center text-xs text-faint">
                  {ready
                    ? 'Everyone jumps in at once — no waiting room after this.'
                    : 'Share the code above. You need at least two players.'}
                </p>
              </>
            ) : (
              <div className="flex min-h-14 items-center justify-center gap-2.5 rounded-xl border border-line bg-raised/50 px-4 text-center">
                <span className="motion-keep size-2 animate-fg-pulse rounded-full bg-accent" />
                <span className="text-sm text-muted">
                  Waiting for {host === undefined ? 'the host' : host.displayName} to start…
                </span>
              </div>
            )}
          </div>
        </div>
      </div>

      <Dialog
        open={confirmLeave}
        onClose={() => setConfirmLeave(false)}
        title="Leave this room?"
        description={
          isHost
            ? 'You are the host. Someone else takes over automatically, but you will drop out of this round.'
            : 'You can come back with the same code while your friends are still playing.'
        }
        footer={
          <div className="flex gap-2">
            <Button variant="ghost" size="md" fullWidth onClick={() => setConfirmLeave(false)}>
              Stay
            </Button>
            <Button
              variant="danger"
              size="md"
              fullWidth
              onClick={() => {
                setConfirmLeave(false);
                onLeave();
              }}
            >
              Leave
            </Button>
          </div>
        }
      />
    </div>
  );
}
