'use client';

/**
 * GameOverScreen — the last thing players see, and the thing they screenshot.
 *
 *   battle   — final points, rounds played, and a ROUND WINS breakdown that is
 *              its own visual (one pip per round won), because "who took the
 *              most rounds" is a different story from "who scored the most",
 *              and both are worth seeing.
 *   together — a warm collective recap. "5 friends completed 10 rounds
 *              together", total steps, rounds played, the tier reached. No
 *              winner, no rank column, no best-player highlight, ever.
 *
 * Both offer Share and Play Again.
 *
 * The confetti is a handful of procedurally-placed divs (no assets, no library)
 * and it does not render at all under `prefers-reduced-motion`.
 */

import { motion, useReducedMotion } from 'framer-motion';
import { useMemo } from 'react';

import { UI, withAlpha } from '@/game/rendering/palette';
import type { FinalStanding, GameResults, Hex, PlayerId, PlayerState } from '@/types';
import { cn } from '@/utils/cn';
import { strokeLabel } from '@/utils/format';

import { Scoreboard } from './Scoreboard';
import { ShareSheet } from './ShareSheet';

const CONFETTI_COUNT = 20;

export interface GameOverScreenProps {
  readonly results: GameResults;
  readonly players: readonly PlayerState[];
  readonly selfId: PlayerId;
  /** Leaves this room and returns to the home screen to start a fresh one. */
  readonly onPlayAgain: () => void;
  /** Optional secondary exit; omitted renders only Play Again. */
  readonly onLeave?: () => void;
  readonly className?: string;
}

function colorOf(players: readonly PlayerState[], playerId: PlayerId): Hex {
  for (const player of players) if (player.id === playerId) return player.color;
  return '#F2F4F8';
}

function winnersOf(standings: readonly FinalStanding[]): readonly FinalStanding[] {
  return standings.filter((row) => row.rank === 1);
}

function Confetti({ colors }: { readonly colors: readonly Hex[] }): React.JSX.Element | null {
  const reduced = useReducedMotion() ?? false;

  const pieces = useMemo(
    () =>
      Array.from({ length: CONFETTI_COUNT }, (_unused, index) => ({
        id: index,
        left: Math.random() * 100,
        delay: Math.random() * 0.8,
        duration: 2.4 + Math.random() * 1.8,
        drift: (Math.random() - 0.5) * 60,
        spin: (Math.random() - 0.5) * 540,
        size: 5 + Math.random() * 6,
        color: colors[index % Math.max(1, colors.length)] ?? UI.accent,
      })),
    [colors],
  );

  if (reduced) return null;

  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-[55vh] overflow-hidden">
      {pieces.map((piece) => (
        <motion.span
          key={piece.id}
          className="absolute top-[-6%] rounded-[2px]"
          style={{
            left: `${piece.left}%`,
            width: piece.size,
            height: piece.size * 1.6,
            backgroundColor: piece.color,
          }}
          initial={{ y: '-10%', opacity: 0, rotate: 0 }}
          animate={{ y: '120%', x: piece.drift, opacity: [0, 1, 1, 0], rotate: piece.spin }}
          transition={{ duration: piece.duration, delay: piece.delay, ease: 'easeIn' }}
        />
      ))}
    </div>
  );
}

function RoundWinsBreakdown({
  standings,
  players,
  selfId,
  roundsPlayed,
}: {
  readonly standings: readonly FinalStanding[];
  readonly players: readonly PlayerState[];
  readonly selfId: PlayerId;
  readonly roundsPlayed: number;
}): React.JSX.Element {
  const reduced = useReducedMotion() ?? false;
  const rows = [...standings].sort((a, b) => b.roundWins - a.roundWins || a.rank - b.rank);

  return (
    <section
      className="w-full rounded-2xl border border-white/10 bg-white/[0.035] p-3"
      aria-label="Round wins breakdown"
    >
      <div className="mb-2 flex items-baseline justify-between">
        <h3 className="text-[10.5px] font-bold uppercase tracking-[0.16em] text-white/[0.45]">Round wins</h3>
        <span className="text-[10.5px] text-white/30">
          {roundsPlayed} {roundsPlayed === 1 ? 'round' : 'rounds'} played
        </span>
      </div>

      <ul className="flex flex-col gap-1.5">
        {rows.map((row, index) => {
          const color = colorOf(players, row.playerId);
          const isSelf = row.playerId === selfId;
          return (
            <motion.li
              key={row.playerId}
              initial={reduced ? false : { opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ type: 'spring', stiffness: 400, damping: 32, delay: reduced ? 0 : index * 0.05 }}
              className="flex items-center gap-2"
            >
              <span
                aria-hidden="true"
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: color }}
              />
              <span
                className={cn(
                  'w-[88px] shrink-0 truncate text-[12px]',
                  isSelf ? 'font-bold text-white' : 'font-medium text-white/75',
                )}
              >
                {row.displayName}
              </span>
              <span className="flex min-w-0 flex-1 flex-wrap items-center gap-[3px]">
                {Array.from({ length: Math.max(0, roundsPlayed) }, (_unused, pip) => (
                  <span
                    key={pip}
                    aria-hidden="true"
                    className="h-2 w-2 rounded-[2px]"
                    style={{
                      backgroundColor: pip < row.roundWins ? color : 'rgba(255,255,255,0.09)',
                    }}
                  />
                ))}
              </span>
              <span
                className="w-6 shrink-0 text-right font-mono text-[12px] font-bold tabular-nums"
                style={{ color: row.roundWins > 0 ? color : 'rgba(255,255,255,0.25)' }}
              >
                {row.roundWins}
              </span>
              <span className="sr-only">
                {row.displayName} won {row.roundWins} of {roundsPlayed} rounds
              </span>
            </motion.li>
          );
        })}
      </ul>
    </section>
  );
}

export function GameOverScreen({
  results,
  players,
  selfId,
  onPlayAgain,
  onLeave,
  className,
}: GameOverScreenProps): React.JSX.Element {
  const reduced = useReducedMotion() ?? false;
  const together = results.mode === 'together';
  const winners = together ? [] : winnersOf(results.standings);
  const selfStanding = results.standings.find((row) => row.playerId === selfId) ?? null;
  const selfColor = colorOf(players, selfId);
  const accent = together ? UI.accent : (winners[0] ? colorOf(players, winners[0].playerId) : UI.accent);
  const palette = useMemo(() => players.map((player) => player.color), [players]);

  const friendCount = players.length;
  const headline = together
    ? `${friendCount} ${friendCount === 1 ? 'friend' : 'friends'} completed ${results.roundsPlayed} ${
        results.roundsPlayed === 1 ? 'round' : 'rounds'
      } together!`
    : winners.length === 0
      ? 'That is a wrap'
      : winners.length === 1
        ? `${winners[0]?.displayName ?? 'Someone'} takes it`
        : `${winners.map((row) => row.displayName).join(' & ')} tie it`;

  return (
    <div
      className={cn(
        'relative mx-auto flex w-full max-w-[520px] flex-col px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-8',
        className,
      )}
    >
      <Confetti colors={palette.length > 0 ? palette : [accent]} />

      <header role="status" aria-live="polite" className="relative text-center">
        <motion.p
          initial={reduced ? { opacity: 0 } : { opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
          className="text-[11px] font-bold uppercase tracking-[0.24em] text-white/[0.35]"
        >
          Game complete {'\u{1F389}'}
        </motion.p>
        <motion.h1
          initial={reduced ? { opacity: 0 } : { opacity: 0, y: 14, scale: 0.94 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ type: 'spring', stiffness: 340, damping: 26 }}
          className="mt-2 text-balance text-[27px] font-bold leading-tight text-white"
        >
          {headline}
        </motion.h1>
        {results.reason === 'host-ended' ? (
          <p className="mt-1.5 text-[12px] text-white/[0.35]">The host closed the room early.</p>
        ) : null}
      </header>

      {/* Headline numbers */}
      <motion.div
        initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ type: 'spring', stiffness: 330, damping: 27, delay: reduced ? 0 : 0.1 }}
        className="relative mt-5 grid grid-cols-3 gap-2"
      >
        {together ? (
          <>
            <Stat label="Steps" value={String(results.collectiveStrokes)} accent={accent} />
            <Stat label="Rounds" value={String(results.roundsPlayed)} accent={accent} />
            <Stat
              label="Friends"
              value={String(friendCount)}
              accent={accent}
            />
          </>
        ) : (
          <>
            <Stat
              label="Your points"
              value={String(selfStanding?.totalScore ?? 0)}
              accent={selfColor}
            />
            <Stat label="Rounds" value={String(results.roundsPlayed)} accent={accent} />
            <Stat
              label="Your hits"
              value={String(selfStanding?.totalStrokes ?? 0)}
              accent={selfColor}
            />
          </>
        )}
      </motion.div>

      {together && results.friendshipTier ? (
        <motion.section
          initial={reduced ? { opacity: 0 } : { opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ type: 'spring', stiffness: 340, damping: 28, delay: reduced ? 0 : 0.16 }}
          className="relative mt-3 flex items-center gap-3 rounded-2xl border p-3.5"
          style={{
            borderColor: withAlpha(UI.accent, 0.3),
            backgroundColor: withAlpha(UI.accent, 0.1),
          }}
          aria-label="Friendship tier reached"
        >
          <span aria-hidden="true" className="text-[32px] leading-none">
            {results.friendshipTier.emoji}
          </span>
          <div className="min-w-0">
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-white/40">Tier reached</p>
            <p className="text-[15px] font-bold text-white">
              {results.friendshipTier.title}
              {results.friendshipTier.cycle > 0 ? (
                <span className="ml-1.5 text-[11px] font-semibold text-white/[0.45]">
                  {'×'}
                  {results.friendshipTier.cycle + 1}
                </span>
              ) : null}
            </p>
            <p className="mt-0.5 text-[12px] leading-snug text-white/50">
              {results.friendshipTier.subtitle}
            </p>
          </div>
        </motion.section>
      ) : null}

      {together ? (
        <p className="relative mt-3 text-center text-[12.5px] leading-relaxed text-white/[0.45]">
          {strokeLabel(results.collectiveStrokes)} between you, across {results.roundsPlayed}{' '}
          {results.roundsPlayed === 1 ? 'round' : 'rounds'}. Nobody won. Nobody lost. That was the point.
        </p>
      ) : null}

      <div className="relative mt-4">
        <Scoreboard
          standings={results.standings}
          players={players}
          selfId={selfId}
          mode={results.mode}
          title={together ? 'Everyone' : 'Final standings'}
          collectiveStrokes={together ? results.collectiveStrokes : null}
        />
      </div>

      {!together ? (
        <div className="relative mt-3">
          <RoundWinsBreakdown
            standings={results.standings}
            players={players}
            selfId={selfId}
            roundsPlayed={results.roundsPlayed}
          />
        </div>
      ) : null}

      <div className="relative mt-3">
        <ShareSheet results={results} players={players} accent={accent} />
      </div>

      <div className="relative mt-4 flex flex-col gap-2">
        <button
          type="button"
          onClick={onPlayAgain}
          className="w-full rounded-2xl px-4 py-3.5 text-[15px] font-bold transition-transform focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/80 active:scale-[0.99]"
          style={{
            backgroundColor: accent,
            color: '#0B0F14',
            boxShadow: `0 14px 42px -18px ${withAlpha(accent, 1)}`,
          }}
        >
          Play again
        </button>
        {onLeave ? (
          <button
            type="button"
            onClick={onLeave}
            className="w-full rounded-2xl border border-white/[0.12] bg-white/[0.05] px-4 py-2.5 text-[13.5px] font-semibold text-white/70 transition-colors hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/70"
          >
            Back to home
          </button>
        ) : null}
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  readonly label: string;
  readonly value: string;
  readonly accent: Hex;
}): React.JSX.Element {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.04] px-2 py-3 text-center">
      <p className="font-mono text-[26px] font-bold leading-none tabular-nums" style={{ color: accent }}>
        {value}
      </p>
      <p className="mt-1.5 text-[9.5px] font-bold uppercase tracking-[0.14em] text-white/[0.35]">{label}</p>
    </div>
  );
}

export default GameOverScreen;
