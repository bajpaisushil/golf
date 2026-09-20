'use client';

/**
 * RoundSummary — the screen the whole game is really about.
 *
 * The two modes get genuinely different screens, not one screen with a toggle,
 * because they are making opposite promises:
 *
 *   together — a shared achievement. Steps listed in join order, no rank column,
 *              no medal, no "best" highlight, one collective total, and the
 *              friendship tier reached. If someone took 9 steps and someone took
 *              2, the screen says nothing about that difference.
 *
 *   battle   — a scoreboard that TEACHES the scoring rule. The podium shows the
 *              placement points (+3/+2/+1), the hit-efficiency bonus is broken
 *              out as its own explicit number next to each player's hit count,
 *              and a small scale shows what the NEXT hit would have cost. The
 *              user's headline requirement — fewer hits = more score — has to be
 *              legible here without anyone explaining it.
 *
 * Advancing is host-gated in both modes; guests get a real wait state naming the
 * host, never a dead button.
 */

import { motion, useReducedMotion } from 'framer-motion';

import { SCORING, efficiencyPointsFor } from '@/game/config';
import { criterionLabel, decidingCriterion } from '@/game/rules/scoring';

/**
 * Which tiebreak columns to show.
 *
 * Hits always. Time only if two players actually tied on hits, penalties only
 * if they also tied on time. Showing a column that never had to be consulted is
 * noise, and it implies the game was decided on something it was not.
 */
function columnsNeeded(results: readonly PlayerRoundResult[]): {
  readonly time: boolean;
  readonly penalties: boolean;
} {
  const live = results.filter((r) => !r.dnf);
  let time = false;
  let penalties = false;
  for (let i = 0; i < live.length; i += 1) {
    for (let j = i + 1; j < live.length; j += 1) {
      const a = live[i]!;
      const b = live[j]!;
      if (a.strokes !== b.strokes) continue;
      time = true;
      if (a.thinkTimeMs === b.thinkTimeMs) penalties = true;
    }
  }
  return { time, penalties };
}
import { formatDuration } from '@/utils/format';
import { friendshipHeadline } from '@/game/rules/friendship';
import { UI, withAlpha } from '@/game/rendering/palette';
import type {
  FinalStanding,
  Hex,
  PlayerId,
  PlayerRoundResult,
  PlayerState,
  RoundSummary as RoundSummaryModel,
} from '@/types';
import { cn } from '@/utils/cn';
import { relativeToPar, strokeLabel } from '@/utils/format';

import { Scoreboard } from './Scoreboard';

const MEDALS: readonly string[] = ['\u{1F947}', '\u{1F948}', '\u{1F949}'];

/** How far past par the efficiency scale keeps counting down. */
const SCALE_OVER_PAR = 3;

export interface RoundSummaryProps {
  readonly summary: RoundSummaryModel;
  readonly players: readonly PlayerState[];
  readonly selfId: PlayerId;
  readonly isHost: boolean;
  /** Display name of the host, for the guest wait state. */
  readonly hostName: string;
  readonly totalRounds: number | null;
  /** Battle only: the running TOTAL table under the podium. */
  readonly standings?: readonly FinalStanding[];
  /** Host action: start the next round. */
  readonly onContinue: () => void;
  /** Host action when this was the final round; falls back to onContinue. */
  readonly onFinish?: () => void;
  readonly className?: string;
}

function playerOf(players: readonly PlayerState[], playerId: PlayerId): PlayerState | null {
  for (const player of players) if (player.id === playerId) return player;
  return null;
}

function colorOf(players: readonly PlayerState[], playerId: PlayerId): Hex {
  return playerOf(players, playerId)?.color ?? '#F2F4F8';
}

function nameOf(players: readonly PlayerState[], playerId: PlayerId): string {
  return playerOf(players, playerId)?.displayName ?? 'Player';
}

/** Results in join order — the co-op ordering, which is explicitly NOT a ranking. */
function inJoinOrder(
  results: readonly PlayerRoundResult[],
  players: readonly PlayerState[],
): readonly PlayerRoundResult[] {
  const seq = new Map<PlayerId, number>();
  for (const player of players) seq.set(player.id, player.joinSeq);
  return [...results].sort((a, b) => (seq.get(a.playerId) ?? 0) - (seq.get(b.playerId) ?? 0));
}

/** Results by rank, DNF last — the battle ordering. */
function byRank(results: readonly PlayerRoundResult[]): readonly PlayerRoundResult[] {
  return [...results].sort((a, b) => {
    if (a.dnf !== b.dnf) return a.dnf ? 1 : -1;
    if (a.rank !== b.rank) return a.rank - b.rank;
    return a.strokes - b.strokes;
  });
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

function AdvanceButton({
  isHost,
  hostName,
  label,
  waitLabel,
  onClick,
  accent,
}: {
  readonly isHost: boolean;
  readonly hostName: string;
  readonly label: string;
  readonly waitLabel: string;
  readonly onClick: () => void;
  readonly accent: Hex;
}): React.JSX.Element {
  const reduced = useReducedMotion() ?? false;

  if (!isHost) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="flex w-full items-center justify-center gap-2 rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3"
      >
        <span aria-hidden="true" className="flex items-center gap-[3px]">
          {[0, 1, 2].map((index) => (
            <motion.span
              key={index}
              className="h-1.5 w-1.5 rounded-full bg-white/[0.45]"
              animate={reduced ? { opacity: 0.5 } : { opacity: [0.2, 1, 0.2] }}
              transition={
                reduced
                  ? { duration: 0 }
                  : { duration: 1.2, repeat: Infinity, delay: index * 0.16, ease: 'easeInOut' }
              }
            />
          ))}
        </span>
        <span className="text-[13px] font-medium text-white/60">
          {waitLabel.replace('{host}', hostName)}
        </span>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      autoFocus
      className="w-full rounded-2xl px-4 py-3.5 text-[15px] font-bold transition-transform focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/80 active:scale-[0.99]"
      style={{
        backgroundColor: accent,
        color: '#0B0F14',
        boxShadow: `0 14px 42px -18px ${withAlpha(accent, 1)}`,
      }}
    >
      {label}
    </button>
  );
}

/**
 * The "fewer hits = more points" scale, drawn from the SAME helper the scorer
 * uses. Highlights what this player actually took.
 */
function EfficiencyScale({
  par,
  strokes,
  accent,
}: {
  readonly par: number;
  readonly strokes: number;
  readonly accent: Hex;
}): React.JSX.Element {
  const start = Math.max(1, par - 1);
  const steps: number[] = [];
  for (let s = start; s <= par + SCALE_OVER_PAR; s += 1) steps.push(s);

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-2.5">
      <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.16em] text-white/40">
        Fewer hits = more points {'·'} par {par}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {steps.map((s) => {
          const points = efficiencyPointsFor(s, par);
          const mine = s === strokes;
          return (
            <div
              key={s}
              className={cn(
                'flex min-w-[52px] flex-col items-center rounded-lg border px-1.5 py-1',
                mine ? '' : 'border-white/[0.07] bg-white/[0.02]',
              )}
              style={
                mine
                  ? { borderColor: withAlpha(accent, 0.6), backgroundColor: withAlpha(accent, 0.16) }
                  : undefined
              }
            >
              <span
                className={cn(
                  'font-mono text-[10px] tabular-nums',
                  mine ? 'text-white' : 'text-white/40',
                )}
              >
                {s} {s === 1 ? 'hit' : 'hits'}
              </span>
              <span
                className="font-mono text-[13px] font-bold tabular-nums"
                style={{ color: mine ? accent : 'rgba(255,255,255,0.5)' }}
              >
                +{points}
              </span>
            </div>
          );
        })}
      </div>
      <p className="mt-1.5 text-[10px] leading-snug text-white/30">
        Holing out never pays less than {SCORING.efficiency.min}, and every stroke under par adds{' '}
        {SCORING.efficiency.underParBonus}.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// together
// ---------------------------------------------------------------------------

function TogetherSummary(props: RoundSummaryProps): React.JSX.Element {
  const { summary, players, selfId, isHost, hostName, onContinue } = props;
  const reduced = useReducedMotion() ?? false;
  const ordered = inJoinOrder(summary.results, players);
  const everyoneIn = ordered.length > 0 && ordered.every((result) => result.holed);
  const tier = summary.friendshipTier;
  const headline = friendshipHeadline(summary);
  const nextRound = summary.roundIndex + 2;

  return (
    <>
      <header role="status" aria-live="polite" className="text-center">
        <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-white/[0.35]">
          Round {summary.roundIndex + 1} complete
        </p>
        <motion.h2
          initial={reduced ? { opacity: 0 } : { opacity: 0, y: 10, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ type: 'spring', stiffness: 380, damping: 28 }}
          className="mt-2 text-balance text-[24px] font-bold leading-tight text-white"
        >
          {everyoneIn ? 'Everyone reached the goal! \u{1F389}' : 'That was a good one together'}
        </motion.h2>
        <p className="mt-1.5 text-[13px] leading-snug text-white/50">{headline}</p>
      </header>

      {/* Collective total — the only number that matters in co-op */}
      <motion.div
        initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.94 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ type: 'spring', stiffness: 340, damping: 26, delay: reduced ? 0 : 0.08 }}
        className="mt-5 rounded-2xl border p-4 text-center"
        style={{
          borderColor: withAlpha(UI.accent, 0.3),
          backgroundColor: withAlpha(UI.accent, 0.1),
        }}
      >
        <p className="text-[10.5px] font-bold uppercase tracking-[0.2em] text-white/40">Together</p>
        <p className="mt-1 font-mono text-[38px] font-bold leading-none tabular-nums text-white">
          {summary.collectiveStrokes}
        </p>
        <p className="mt-1 text-[12px] text-white/[0.45]">
          steps {'·'} {relativeToPar(summary.collectiveStrokes, summary.collectivePar)} against a
          combined par of {summary.collectivePar}
        </p>
      </motion.div>

      {/* Steps per player — join order, no rank, no winner styling */}
      <section className="mt-4" aria-label="Steps taken by each player">
        <h3 className="mb-2 text-[10.5px] font-bold uppercase tracking-[0.16em] text-white/[0.35]">
          Everyone&rsquo;s steps
        </h3>
        <ul className="flex flex-col gap-1">
          {ordered.map((result, index) => {
            const color = colorOf(players, result.playerId);
            const isSelf = result.playerId === selfId;
            return (
              <motion.li
                key={result.playerId}
                initial={reduced ? false : { opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{
                  type: 'spring',
                  stiffness: 400,
                  damping: 32,
                  delay: reduced ? 0 : 0.12 + index * 0.05,
                }}
                className="flex items-center gap-2.5 rounded-xl border border-white/[0.07] bg-white/[0.03] px-3 py-2"
              >
                <span
                  aria-hidden="true"
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: color }}
                />
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-white/[0.85]">
                  {nameOf(players, result.playerId)}
                  {isSelf ? <span className="ml-1 text-[10.5px] text-white/[0.35]">(you)</span> : null}
                </span>
                {result.holed ? (
                  <span aria-hidden="true" className="text-[12px] leading-none" title="Reached the goal">
                    {'✓'}
                  </span>
                ) : (
                  <span className="text-[10px] font-medium uppercase tracking-wide text-white/30">
                    still out there
                  </span>
                )}
                <span className="shrink-0 font-mono text-[13px] tabular-nums text-white/70">
                  {strokeLabel(result.strokes)}
                </span>
              </motion.li>
            );
          })}
        </ul>
      </section>

      {/* Friendship tier */}
      {tier ? (
        <motion.section
          initial={reduced ? { opacity: 0 } : { opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ type: 'spring', stiffness: 340, damping: 28, delay: reduced ? 0 : 0.2 }}
          className="mt-4 flex items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.04] p-3.5"
          aria-label="Friendship tier"
        >
          <span aria-hidden="true" className="text-[30px] leading-none">
            {tier.emoji}
          </span>
          <div className="min-w-0">
            <p className="text-[14px] font-bold text-white">
              {tier.title}
              {tier.cycle > 0 ? (
                <span className="ml-1.5 text-[11px] font-semibold text-white/40">
                  {'×'}
                  {tier.cycle + 1}
                </span>
              ) : null}
            </p>
            <p className="mt-0.5 text-[12px] leading-snug text-white/[0.45]">{tier.subtitle}</p>
          </div>
        </motion.section>
      ) : null}

      <div className="mt-5">
        <AdvanceButton
          isHost={isHost}
          hostName={hostName}
          label={`Continue to Round ${nextRound}`}
          waitLabel={`Waiting for {host} to start Round ${nextRound}`}
          onClick={onContinue}
          accent={UI.accent}
        />
      </div>
      <p className="mt-2 text-center text-[10.5px] text-white/25">
        Keep going as long as you like &mdash; there is no finish line in this mode.
      </p>
    </>
  );
}

// ---------------------------------------------------------------------------
// battle
// ---------------------------------------------------------------------------

function BattleSummaryView(props: RoundSummaryProps): React.JSX.Element {
  const { summary, players, selfId, isHost, hostName, totalRounds, standings, onContinue, onFinish } =
    props;
  const reduced = useReducedMotion() ?? false;
  const ranked = byRank(summary.results);
  const selfResult = summary.results.find((result) => result.playerId === selfId) ?? null;
  /** More than one player on rank 1 — nobody "took" the round on their own. */
  const sharedFirst = ranked.filter((result) => !result.dnf && result.rank === 1).length > 1;
  const columns = columnsNeeded(summary.results);
  const roundHuman = summary.roundIndex + 1;
  const isLastRound = totalRounds !== null && roundHuman >= totalRounds;
  const advance = isLastRound && onFinish ? onFinish : onContinue;

  return (
    <>
      <header role="status" aria-live="polite" className="text-center">
        <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-white/[0.35]">
          Round {roundHuman}
          {totalRounds !== null ? ` / ${totalRounds}` : ''} complete
        </p>
        <motion.h2
          initial={reduced ? { opacity: 0 } : { opacity: 0, y: 10, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ type: 'spring', stiffness: 380, damping: 28 }}
          className="mt-2 text-[24px] font-bold leading-tight text-white"
        >
          {selfResult && selfResult.dnf
            ? 'Out of hits this round'
            : selfResult && selfResult.rank === 1
              ? sharedFirst
                ? 'Tied for the round \u{1F91D}'
                : 'You took the round \u{1F947}'
              : 'Here is how it landed'}
        </motion.h2>
      </header>

      {/* Podium — placement points, explicitly labelled */}
      <section className="mt-5" aria-label="Round podium and points">
        <h3 className="mb-2 text-[10.5px] font-bold uppercase tracking-[0.16em] text-white/[0.35]">
          This round
        </h3>
        <ul className="flex flex-col gap-1.5">
          {ranked.map((result, index) => {
            // What separated this player from the one below them, so the podium
            // can explain itself instead of leaving ties looking arbitrary.
            const below = ranked[index + 1] ?? null;
            const decider =
              below === null || result.dnf ? null : decidingCriterion(result, below);
            const tiedWithNext = below !== null && below.rank === result.rank;
            const color = colorOf(players, result.playerId);
            const isSelf = result.playerId === selfId;
            const medal = result.dnf ? null : (MEDALS[result.rank - 1] ?? null);

            return (
              <motion.li
                key={result.playerId}
                initial={reduced ? false : { opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{
                  type: 'spring',
                  stiffness: 400,
                  damping: 30,
                  delay: reduced ? 0 : 0.08 + index * 0.06,
                }}
                className={cn(
                  'rounded-xl border px-3 py-2.5',
                  isSelf ? 'bg-white/[0.06]' : 'bg-white/[0.025]',
                )}
                style={{ borderColor: isSelf ? withAlpha(color, 0.45) : 'rgba(255,255,255,0.07)' }}
              >
                <div className="flex items-center gap-2.5">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center">
                    {medal ? (
                      <span aria-hidden="true" className="text-[19px] leading-none">
                        {medal}
                      </span>
                    ) : (
                      <span className="font-mono text-[12px] font-bold tabular-nums text-white/30">
                        {result.dnf ? '—' : result.rank}
                      </span>
                    )}
                  </span>

                  <span className="flex min-w-0 flex-1 items-center gap-1.5">
                    <span
                      aria-hidden="true"
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: color }}
                    />
                    <span
                      className={cn(
                        'truncate text-[13.5px]',
                        isSelf ? 'font-bold text-white' : 'font-medium text-white/80',
                      )}
                    >
                      {nameOf(players, result.playerId)}
                      {isSelf ? <span className="ml-1 text-[10px] text-white/[0.35]">(you)</span> : null}
                    </span>
                  </span>

                  <span
                    className="shrink-0 rounded-lg px-2 py-1 font-mono text-[15px] font-bold tabular-nums"
                    style={{ backgroundColor: withAlpha(color, 0.18), color: '#FFFFFF' }}
                  >
                    +{result.roundScore}
                  </span>
                </div>

                {/* The scoring breakdown, spelled out */}
                <div className="mt-2 flex flex-wrap items-center gap-1.5 pl-[38px]">
                  <span className="rounded-md bg-white/[0.06] px-1.5 py-[2px] text-[10.5px] font-medium text-white/[0.55]">
                    {result.dnf ? 'did not finish' : `${strokeLabel(result.strokes)} · par ${result.par}`}
                  </span>
                  <span
                    className="rounded-md px-1.5 py-[2px] text-[10.5px] font-semibold"
                    style={{ backgroundColor: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.7)' }}
                    title="Points for finishing position"
                  >
                    placement +{result.placementPoints}
                  </span>
                  <span
                    className="rounded-md px-1.5 py-[2px] text-[10.5px] font-bold"
                    style={{ backgroundColor: withAlpha(UI.good, 0.16), color: UI.good }}
                    title="Hit efficiency: fewer hits pay more"
                  >
                    hit bonus +{result.efficiencyPoints}
                  </span>
                  {!result.dnf ? (
                    <span className="font-mono text-[10.5px] tabular-nums text-white/30">
                      {relativeToPar(result.strokes, result.par)}
                    </span>
                  ) : null}
                </div>

                {/*
                  Every ranking criterion, spelled out. Without this a player who
                  tied on hits has no way of knowing why they placed second.
                */}
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5 pl-[38px]">
                  <span
                    className="rounded-md bg-white/[0.04] px-1.5 py-[2px] font-mono text-[10px] tabular-nums text-white/40"
                    title="Hits taken, penalties included"
                  >
                    {result.strokes} hits
                  </span>
                  {/* Only shown when hits alone did not settle it. */}
                  {columns.time ? (
                    <span
                      className="rounded-md bg-white/[0.04] px-1.5 py-[2px] font-mono text-[10px] tabular-nums text-white/40"
                      title="Time spent on your own turns — only consulted when hits are level"
                    >
                      {result.thinkTimeMs > 0 ? formatDuration(result.thinkTimeMs) : '—'} thinking
                    </span>
                  ) : null}
                  {columns.penalties ? (
                    <span
                      className="rounded-md bg-white/[0.04] px-1.5 py-[2px] font-mono text-[10px] tabular-nums text-white/40"
                      title="Penalty strokes from water"
                    >
                      {result.penaltyStrokes} penalties
                    </span>
                  ) : null}
                  {tiedWithNext ? (
                    <span className="rounded-md bg-white/[0.06] px-1.5 py-[2px] text-[10px] font-semibold text-white/50">
                      tied
                    </span>
                  ) : decider !== null ? (
                    <span
                      className="rounded-md px-1.5 py-[2px] text-[10px] font-semibold"
                      style={{ backgroundColor: withAlpha(UI.accent ?? '#FFC53D', 0.16), color: UI.accent ?? '#FFC53D' }}
                      title="What separated this player from the one below"
                    >
                      {criterionLabel(decider)}
                    </span>
                  ) : null}
                </div>
              </motion.li>
            );
          })}
        </ul>
      </section>

      {/* Make the rule undeniable */}
      {selfResult ? (
        <div className="mt-3">
          <EfficiencyScale
            par={selfResult.par}
            strokes={selfResult.strokes}
            accent={colorOf(players, selfId)}
          />
        </div>
      ) : null}

      {/* Running totals */}
      {standings && standings.length > 0 ? (
        <div className="mt-4">
          <Scoreboard
            standings={standings}
            players={players}
            selfId={selfId}
            mode="battle"
            title="Total"
          />
        </div>
      ) : null}

      <div className="mt-5">
        <AdvanceButton
          isHost={isHost}
          hostName={hostName}
          label={isLastRound ? 'See final results' : `Next round · ${roundHuman + 1}`}
          waitLabel={
            isLastRound ? 'Waiting for {host} to close the game' : 'Waiting for {host} to start the next round'
          }
          onClick={advance}
          accent={UI.accent}
        />
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------

export function RoundSummary(props: RoundSummaryProps): React.JSX.Element {
  const reduced = useReducedMotion() ?? false;

  return (
    <motion.div
      initial={reduced ? { opacity: 0 } : { opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: 'spring', stiffness: 320, damping: 30 }}
      className={cn(
        'mx-auto flex w-full max-w-[520px] flex-col px-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-6',
        props.className,
      )}
    >
      {props.summary.mode === 'together' ? (
        <TogetherSummary {...props} />
      ) : (
        <BattleSummaryView {...props} />
      )}
    </motion.div>
  );
}

export default RoundSummary;
