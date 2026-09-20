'use client';

/**
 * Scoreboard — running totals across the whole game.
 *
 * Two completely different tables behind one component, because the two modes
 * mean different things by "score":
 *
 *   battle   — ranked. Points (placement + hit efficiency), round wins, and the
 *              total strokes it took to get there. Sorted by the rank the rules
 *              layer already computed; ties share a rank.
 *   together — NOT ranked. Join order, steps contributed, and a collective total.
 *              There is no leader row, no medal, no highlight for "best" — the
 *              mode's whole promise is that nobody loses.
 *
 * It never computes points itself: `FinalStanding` arrives fully scored from
 * `game/rules/scoring`, which is the only module allowed to call the two
 * scoring helpers in config.
 */

import { motion, useReducedMotion } from 'framer-motion';

import { withAlpha } from '@/game/rendering/palette';
import type { FinalStanding, GameMode, Hex, PlayerId, PlayerState } from '@/types';
import { cn } from '@/utils/cn';

const MEDALS: readonly string[] = ['\u{1F947}', '\u{1F948}', '\u{1F949}'];

export interface ScoreboardProps {
  readonly standings: readonly FinalStanding[];
  /** Used purely to recover each player's ball colour. */
  readonly players: readonly PlayerState[];
  readonly selfId: PlayerId;
  readonly mode: GameMode;
  /** Battle only; hidden when every player has zero wins (round 1). */
  readonly showRoundWins?: boolean;
  readonly title?: string;
  /** Co-op only: the headline "together" number. */
  readonly collectiveStrokes?: number | null;
  readonly className?: string;
}

function colorOf(players: readonly PlayerState[], playerId: PlayerId): Hex {
  for (const player of players) if (player.id === playerId) return player.color;
  return '#F2F4F8';
}

/** Medal for a 1-based rank, or `null` past third. */
export function medalFor(rank: number): string | null {
  if (!Number.isFinite(rank) || rank < 1) return null;
  const medal = MEDALS[Math.floor(rank) - 1];
  return medal === undefined ? null : medal;
}

export function Scoreboard({
  standings,
  players,
  selfId,
  mode,
  showRoundWins = true,
  title,
  collectiveStrokes = null,
  className,
}: ScoreboardProps): React.JSX.Element {
  const reduced = useReducedMotion() ?? false;
  const competitive = mode === 'battle';
  const anyWins = standings.some((row) => row.roundWins > 0);
  const withWins = competitive && showRoundWins && anyWins;

  return (
    <section
      className={cn('w-full rounded-2xl border border-white/10 bg-white/[0.035] p-3', className)}
      aria-label={title ?? (competitive ? 'Standings' : 'Everyone so far')}
    >
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h3 className="text-[11px] font-bold uppercase tracking-[0.16em] text-white/[0.45]">
          {title ?? (competitive ? 'Standings' : 'Everyone so far')}
        </h3>
        {!competitive && collectiveStrokes !== null ? (
          <span className="font-mono text-[11px] tabular-nums text-white/[0.45]">
            together: {collectiveStrokes}
          </span>
        ) : null}
      </div>

      <table className="w-full border-collapse">
        <thead>
          <tr className="text-[9.5px] font-semibold uppercase tracking-[0.14em] text-white/30">
            <th scope="col" className="w-7 pb-1.5 text-left">
              {competitive ? '#' : ''}
            </th>
            <th scope="col" className="pb-1.5 text-left">
              Player
            </th>
            {withWins ? (
              <th scope="col" className="w-12 pb-1.5 text-right">
                Wins
              </th>
            ) : null}
            <th scope="col" className="w-14 pb-1.5 text-right">
              {competitive ? 'Hits' : 'Steps'}
            </th>
            {competitive ? (
              <th scope="col" className="w-14 pb-1.5 text-right">
                Points
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {standings.map((row, index) => {
            const isSelf = row.playerId === selfId;
            const color = colorOf(players, row.playerId);
            const medal = competitive ? medalFor(row.rank) : null;

            return (
              <motion.tr
                key={row.playerId}
                layout={!reduced}
                initial={reduced ? false : { opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ type: 'spring', stiffness: 380, damping: 32, delay: reduced ? 0 : index * 0.04 }}
                className={cn('border-t border-white/[0.06]', isSelf ? 'bg-white/[0.045]' : '')}
              >
                <td className="py-1.5 text-left align-middle">
                  {competitive ? (
                    medal ? (
                      <span aria-hidden="true" className="text-[13px] leading-none">
                        {medal}
                      </span>
                    ) : (
                      <span className="font-mono text-[11px] tabular-nums text-white/[0.35]">{row.rank}</span>
                    )
                  ) : (
                    <span
                      aria-hidden="true"
                      className="inline-block h-2 w-2 rounded-full"
                      style={{ backgroundColor: color }}
                    />
                  )}
                </td>

                <td className="py-1.5 align-middle">
                  <span className="flex min-w-0 items-center gap-1.5">
                    {competitive ? (
                      <span
                        aria-hidden="true"
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ backgroundColor: color }}
                      />
                    ) : null}
                    <span
                      className={cn(
                        'truncate text-[12.5px]',
                        isSelf ? 'font-bold text-white' : 'font-medium text-white/80',
                      )}
                    >
                      {row.displayName}
                      {isSelf ? <span className="ml-1 text-[10px] text-white/[0.35]">(you)</span> : null}
                    </span>
                  </span>
                </td>

                {withWins ? (
                  <td className="py-1.5 text-right align-middle">
                    <span
                      className="font-mono text-[12px] font-semibold tabular-nums"
                      style={{ color: row.roundWins > 0 ? color : 'rgba(255,255,255,0.25)' }}
                    >
                      {row.roundWins}
                    </span>
                  </td>
                ) : null}

                <td className="py-1.5 text-right align-middle">
                  <span className="font-mono text-[12px] tabular-nums text-white/60">
                    {row.totalStrokes}
                  </span>
                </td>

                {competitive ? (
                  <td className="py-1.5 text-right align-middle">
                    <span
                      className="rounded-md px-1.5 py-[2px] font-mono text-[12.5px] font-bold tabular-nums"
                      style={{
                        backgroundColor: withAlpha(color, isSelf ? 0.22 : 0.12),
                        color: '#FFFFFF',
                      }}
                    >
                      {row.totalScore}
                    </span>
                  </td>
                ) : null}
              </motion.tr>
            );
          })}
        </tbody>
      </table>

      {!competitive ? (
        <p className="mt-2 text-[10.5px] leading-snug text-white/30">
          No ranking here on purpose &mdash; every step counted toward the same total.
        </p>
      ) : (
        <p className="mt-2 text-[10.5px] leading-snug text-white/30">
          Points = placement + hit efficiency. Fewer hits always pays more.
        </p>
      )}
    </section>
  );
}

export default Scoreboard;
