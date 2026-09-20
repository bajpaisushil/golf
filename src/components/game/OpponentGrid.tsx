'use client';

/**
 * OpponentGrid — every opponent's own course, live, in battle mode.
 *
 * Battle mode gives each player an INDEPENDENT course and lets everyone play
 * simultaneously, which removes the one thing competitive games normally have:
 * a shared screen to look at. These mini boards put it back. They are plain
 * inline SVG (`MiniCourse`), not three.js — eight of them cost roughly nothing,
 * they render on the same frame as the main canvas, and they work even when
 * WebGL is unavailable.
 *
 * Each board shows the three facts that matter while a round is live: where
 * their ball is, how many hits it has taken, and how close to the cup they are.
 */

import { motion, useReducedMotion } from 'framer-motion';

import { isDnf } from '@/game/rules/competitive';
import { MiniCourse } from '@/game/rendering/mini';
import { withAlpha } from '@/game/rendering/palette';
import type { BallView } from '@/game/rendering/three/types';
import type { LevelSpec, PlayerId, PlayerState, Vec2 } from '@/types';
import { cn } from '@/utils/cn';

export interface OpponentBoard {
  readonly player: PlayerState;
  /** `null` while their level has not been derived yet (e.g. a late joiner). */
  readonly level: LevelSpec | null;
  /** Optional recent trajectory, drawn as a faint trail. */
  readonly trail?: readonly Vec2[];
}

export interface OpponentGridProps {
  readonly boards: readonly OpponentBoard[];
  readonly maxStrokes: number;
  readonly selectedId?: PlayerId | null;
  readonly onSelect?: (playerId: PlayerId) => void;
  readonly className?: string;
}

/** 0..1 — how far along the straight line from spawn to cup this ball has travelled. */
export function holeProgress(level: LevelSpec, pos: Vec2): number {
  const total = Math.sqrt(
    (level.hole.center.x - level.ballStart.x) ** 2 + (level.hole.center.y - level.ballStart.y) ** 2,
  );
  if (!(total > 0)) return 1;
  const remaining = Math.sqrt(
    (level.hole.center.x - pos.x) ** 2 + (level.hole.center.y - pos.y) ** 2,
  );
  const progress = 1 - remaining / total;
  return Math.max(0, Math.min(1, progress));
}

function ballViewFor(player: PlayerState): BallView {
  return {
    playerId: player.id,
    color: player.color,
    pos: player.currentPos,
    isSelf: false,
    holed: player.holed,
    label: player.displayName,
  };
}

interface MiniBoardProps {
  readonly board: OpponentBoard;
  readonly maxStrokes: number;
  readonly selected: boolean;
  readonly onSelect?: (playerId: PlayerId) => void;
  readonly reduced: boolean;
}

function MiniBoard({ board, maxStrokes, selected, onSelect, reduced }: MiniBoardProps): React.JSX.Element {
  const { player, level } = board;
  const dnf = isDnf(player.strokes, player.holed, maxStrokes);
  const progress = level ? holeProgress(level, player.currentPos) : 0;
  const balls = [ballViewFor(player)];

  const body = (
    <>
      <div className="flex items-center gap-1.5 px-2 pt-1.5">
        <span
          aria-hidden="true"
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ backgroundColor: player.color }}
        />
        <span className="min-w-0 flex-1 truncate text-left text-[11px] font-semibold text-white/[0.85]">
          {player.displayName}
        </span>
        {player.isHost ? (
          <span aria-hidden="true" className="text-[9px] leading-none" title="Host">
            {'\u{1F451}'}
          </span>
        ) : null}
        <span
          className="shrink-0 rounded-md px-1.5 py-[1px] font-mono text-[10px] font-bold tabular-nums"
          style={{
            backgroundColor: player.holed ? withAlpha(player.color, 0.9) : 'rgba(255,255,255,0.08)',
            color: player.holed ? '#0B0F14' : dnf ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.9)',
          }}
        >
          {dnf ? 'DNF' : player.strokes}
        </span>
      </div>

      <div className="relative mt-1 px-1.5">
        {level ? (
          <MiniCourse level={level} balls={balls} trail={board.trail} className="h-full w-full" />
        ) : (
          <div className="flex aspect-[2/3] w-full items-center justify-center rounded-md bg-white/[0.04] text-[9px] text-white/25">
            no course
          </div>
        )}

        {player.holed ? (
          <motion.div
            initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.7 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ type: 'spring', stiffness: 520, damping: 26 }}
            className="absolute inset-x-1.5 top-1/2 -translate-y-1/2"
          >
            <div
              className="mx-auto w-fit rounded-full px-2 py-[2px] text-[9.5px] font-bold uppercase tracking-[0.14em]"
              style={{ backgroundColor: withAlpha(player.color, 0.92), color: '#0B0F14' }}
            >
              in {'·'} {player.strokes}
            </div>
          </motion.div>
        ) : null}
      </div>

      <div className="mt-1.5 px-2 pb-1.5">
        <div className="h-[3px] w-full overflow-hidden rounded-full bg-white/[0.08]">
          <motion.div
            className="h-full rounded-full"
            style={{ backgroundColor: player.color }}
            initial={false}
            animate={{ width: `${(player.holed ? 1 : progress) * 100}%` }}
            transition={reduced ? { duration: 0 } : { type: 'spring', stiffness: 220, damping: 30 }}
          />
        </div>
      </div>
    </>
  );

  const shellClass = cn(
    'flex w-[104px] shrink-0 flex-col rounded-xl border bg-black/[0.35] backdrop-blur-md transition-colors sm:w-full',
    player.connected ? 'opacity-100' : 'opacity-45',
    selected ? 'ring-1 ring-white/[0.45]' : '',
    onSelect
      ? 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/70'
      : '',
  );

  const shellStyle = { borderColor: withAlpha(player.color, player.holed ? 0.5 : 0.18) };

  const srText = `${player.displayName}: ${
    player.holed
      ? `holed out in ${player.strokes} hits`
      : dnf
        ? 'out of strokes'
        : `${player.strokes} hits, ${Math.round(progress * 100)} percent of the way to the cup`
  }${player.connected ? '' : ', reconnecting'}`;

  return (
    <motion.li layout={!reduced} transition={{ type: 'spring', stiffness: 400, damping: 34 }}>
      {onSelect ? (
        <button
          type="button"
          onClick={() => onSelect(player.id)}
          className={shellClass}
          style={shellStyle}
          aria-pressed={selected}
        >
          {body}
          <span className="sr-only">{srText}</span>
        </button>
      ) : (
        <div className={shellClass} style={shellStyle}>
          {body}
          <span className="sr-only">{srText}</span>
        </div>
      )}
    </motion.li>
  );
}

export function OpponentGrid({
  boards,
  maxStrokes,
  selectedId = null,
  onSelect,
  className,
}: OpponentGridProps): React.JSX.Element {
  const reduced = useReducedMotion() ?? false;

  if (boards.length === 0) {
    return (
      <div className={cn('px-3 py-2 text-[11px] text-white/30', className)}>
        No opponents connected right now.
      </div>
    );
  }

  return (
    <section className={cn('w-full', className)} aria-label="Opponent courses">
      <ul
        className={cn(
          'flex gap-2 overflow-x-auto pb-1',
          '[-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
          'sm:grid sm:grid-cols-2 sm:overflow-visible lg:grid-cols-1',
        )}
      >
        {boards.map((board) => (
          <MiniBoard
            key={board.player.id}
            board={board}
            maxStrokes={maxStrokes}
            selected={board.player.id === selectedId}
            onSelect={onSelect}
            reduced={reduced}
          />
        ))}
      </ul>
    </section>
  );
}

export default OpponentGrid;
