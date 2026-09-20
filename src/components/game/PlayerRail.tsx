'use client';

/**
 * PlayerRail — the compact "who is in this room" strip.
 *
 * Sits along the bottom edge on phones (thumb reach, clear of the aiming zone)
 * and reads left-to-right in join order, which is also the turn order in co-op.
 * Every chip carries the same four facts:
 *
 *   colour ring  — the ball you are watching on the course
 *   strokes      — hits taken this round (the number that drives the score)
 *   state        — holed ✓ / out of strokes / still playing
 *   presence     — host crown, and a dimmed chip when a peer has dropped
 *
 * In 'together' the active player's chip lifts and glows; in 'battle' nobody is
 * "active", so the chip for whoever is furthest along is never highlighted —
 * that would smuggle a ranking into a strip that is meant to be neutral.
 */

import { motion, useReducedMotion } from 'framer-motion';

import { isDnf } from '@/game/rules/competitive';
import { withAlpha } from '@/game/rendering/palette';
import type { GameMode, PlayerId, PlayerState } from '@/types';
import { cn } from '@/utils/cn';

export interface PlayerRailProps {
  readonly players: readonly PlayerState[];
  readonly selfId: PlayerId;
  /** 'together' only: whose turn it is. */
  readonly activePlayerId?: PlayerId | null;
  readonly maxStrokes: number;
  readonly mode: GameMode;
  /** Makes each chip a button (battle mode uses it to focus an opponent board). */
  readonly onSelectPlayer?: (playerId: PlayerId) => void;
  readonly selectedId?: PlayerId | null;
  readonly className?: string;
}

interface ChipStatus {
  readonly label: string;
  readonly tone: 'holed' | 'dnf' | 'playing';
}

function chipStatus(player: PlayerState, maxStrokes: number): ChipStatus {
  if (player.holed) return { label: '✓', tone: 'holed' };
  if (isDnf(player.strokes, player.holed, maxStrokes)) return { label: 'DNF', tone: 'dnf' };
  return { label: String(player.strokes), tone: 'playing' };
}

function statusColor(tone: ChipStatus['tone'], color: string): string {
  if (tone === 'holed') return color;
  if (tone === 'dnf') return 'rgba(255,255,255,0.35)';
  return 'rgba(255,255,255,0.88)';
}

export function PlayerRail({
  players,
  selfId,
  activePlayerId = null,
  maxStrokes,
  mode,
  onSelectPlayer,
  selectedId = null,
  className,
}: PlayerRailProps): React.JSX.Element {
  const reduced = useReducedMotion() ?? false;

  return (
    <ul
      className={cn(
        'flex w-full items-stretch gap-1.5 overflow-x-auto pb-0.5',
        '[-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
        className,
      )}
      aria-label="Players in this room"
    >
      {players.map((player) => {
        const isSelf = player.id === selfId;
        const isActive = mode === 'together' && player.id === activePlayerId;
        const isSelected = player.id === selectedId;
        const status = chipStatus(player, maxStrokes);
        const dimmed = !player.connected;

        const inner = (
          <>
            <span className="relative flex h-6 w-6 shrink-0 items-center justify-center">
              <span
                aria-hidden="true"
                className="absolute inset-0 rounded-full border-2"
                style={{
                  borderColor: player.color,
                  backgroundColor: withAlpha(player.color, player.holed ? 0.85 : 0.18),
                }}
              />
              <span
                className="relative text-[10px] font-bold leading-none"
                style={{ color: statusColor(status.tone, player.holed ? '#0B0F14' : player.color) }}
              >
                {status.label}
              </span>
              {player.isHost ? (
                <span
                  aria-hidden="true"
                  className="absolute -right-1.5 -top-2 text-[10px] leading-none drop-shadow"
                  title="Host"
                >
                  {'\u{1F451}'}
                </span>
              ) : null}
            </span>

            <span className="flex min-w-0 flex-col items-start leading-tight">
              <span className="max-w-[72px] truncate text-[11.5px] font-semibold text-white/90">
                {isSelf ? 'You' : player.displayName}
              </span>
              <span className="text-[9.5px] font-medium uppercase tracking-[0.1em] text-white/[0.35]">
                {player.connected
                  ? status.tone === 'holed'
                    ? `in · ${player.strokes}`
                    : status.tone === 'dnf'
                      ? 'out'
                      : `${player.strokes} hit${player.strokes === 1 ? '' : 's'}`
                  : 'reconnecting'}
              </span>
            </span>
          </>
        );

        const chipClass = cn(
          'flex items-center gap-2 rounded-xl border px-2 py-1.5 text-left transition-colors',
          dimmed ? 'opacity-45' : 'opacity-100',
          isSelected ? 'ring-1 ring-white/[0.45]' : '',
          onSelectPlayer
            ? 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/70'
            : '',
        );

        const chipStyle = {
          borderColor: isActive ? withAlpha(player.color, 0.65) : 'rgba(255,255,255,0.09)',
          backgroundColor: isActive ? withAlpha(player.color, 0.16) : 'rgba(255,255,255,0.045)',
          boxShadow: isActive ? `0 6px 26px -14px ${withAlpha(player.color, 1)}` : undefined,
        };

        const srSuffix = [
          isSelf ? 'you' : null,
          player.isHost ? 'host' : null,
          isActive ? 'taking their turn' : null,
          player.connected ? null : 'reconnecting',
          player.holed ? `holed out in ${player.strokes}` : `${player.strokes} hits so far`,
        ]
          .filter((part): part is string => part !== null)
          .join(', ');

        return (
          <motion.li
            key={player.id}
            layout={!reduced}
            transition={{ type: 'spring', stiffness: 420, damping: 34 }}
            animate={
              isActive && !reduced ? { y: -3 } : { y: 0 }
            }
            className="shrink-0"
          >
            {onSelectPlayer ? (
              <button
                type="button"
                onClick={() => onSelectPlayer(player.id)}
                className={chipClass}
                style={chipStyle}
                aria-pressed={isSelected}
              >
                {inner}
                <span className="sr-only">
                  {player.displayName}, {srSuffix}
                </span>
              </button>
            ) : (
              <div className={chipClass} style={chipStyle}>
                {inner}
                <span className="sr-only">
                  {player.displayName}, {srSuffix}
                </span>
              </div>
            )}
          </motion.li>
        );
      })}
    </ul>
  );
}

export default PlayerRail;
