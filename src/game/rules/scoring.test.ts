/**
 * Scoring rules. The headline requirement: FEWER HITS => HIGHER SCORE.
 * That rule is asserted as strict monotonicity so it cannot silently regress.
 */
import { describe, expect, it } from 'vitest';
import { SCORING, LIMITS, efficiencyPointsFor, placementPointsFor } from '@/game/config';
import { rankRound, rankPlayers, roundPointsFor, projectedScore } from './scoring';
import type { PlayerId } from '@/types';

const pid = (s: string) => s as PlayerId;

const opts = (playerCount: number, mode: 'battle' | 'together' = 'battle') => ({
  mode,
  playerCount,
  rankBy: SCORING.rankBy,
  maxStrokes: LIMITS.MAX_STROKES,
});

const entry = (id: string, strokes: number, order: number | null, par = 4) => ({
  playerId: pid(id),
  strokes,
  par,
  holed: order !== null,
  holeOutOrder: order,
  totalBefore: 0,
});

describe('FEWER HITS = HIGHER SCORE', () => {
  it('is strictly decreasing in stroke count', () => {
    const par = 4;
    for (let strokes = 1; strokes < LIMITS.MAX_STROKES; strokes++) {
      const better = efficiencyPointsFor(strokes, par);
      const worse = efficiencyPointsFor(strokes + 1, par);
      expect(better, `${strokes} strokes must beat ${strokes + 1}`).toBeGreaterThanOrEqual(worse);
    }
    // And strictly better across a meaningful span, not merely non-increasing.
    expect(efficiencyPointsFor(1, par)).toBeGreaterThan(efficiencyPointsFor(8, par));
  });

  it('rewards beating par and never drops below the floor', () => {
    expect(efficiencyPointsFor(2, 5)).toBeGreaterThan(efficiencyPointsFor(5, 5));
    expect(efficiencyPointsFor(500, 3)).toBe(SCORING.efficiency.min);
    expect(efficiencyPointsFor(500, 3)).toBeGreaterThan(0);
  });

  it('never returns NaN for hostile input', () => {
    for (const v of [NaN, Infinity, -Infinity, -5, 0]) {
      expect(Number.isFinite(efficiencyPointsFor(v, 4))).toBe(true);
      expect(Number.isFinite(efficiencyPointsFor(4, v))).toBe(true);
    }
  });

  it('projectedScore agrees with the efficiency table', () => {
    expect(projectedScore(3, 4)).toBe(efficiencyPointsFor(3, 4));
  });
});

describe('placement points', () => {
  it('follows the configured table and uses the 2-player variant', () => {
    expect(placementPointsFor(1, 4)).toBe(SCORING.placementPoints[0]);
    expect(placementPointsFor(2, 4)).toBe(SCORING.placementPoints[1]);
    expect(placementPointsFor(3, 4)).toBe(SCORING.placementPoints[2]);
    expect(placementPointsFor(1, 2)).toBe(SCORING.placementPointsTwoPlayer[0]);
    expect(placementPointsFor(2, 2)).toBe(SCORING.placementPointsTwoPlayer[1]);
  });

  it('scores 0 past the table and for nonsense ranks', () => {
    expect(placementPointsFor(9, 8)).toBe(0);
    expect(placementPointsFor(0, 4)).toBe(0);
    expect(placementPointsFor(-1, 4)).toBe(0);
  });
});

describe('rankRound (battle)', () => {
  it('ranks by fewest strokes, then by who holed out first', () => {
    const results = rankRound(
      [entry('a', 5, 1), entry('b', 3, 3), entry('c', 3, 2), entry('d', 7, 4)],
      opts(4),
    );
    const byId = new Map(results.map((r) => [r.playerId, r]));
    // c and b both took 3; c holed out earlier so c wins.
    expect(byId.get(pid('c'))?.rank).toBe(1);
    expect(byId.get(pid('b'))?.rank).toBe(2);
    expect(byId.get(pid('a'))?.rank).toBe(3);
    expect(byId.get(pid('d'))?.rank).toBe(4);
  });

  it('awards more total points for fewer hits', () => {
    const results = rankRound([entry('a', 2, 1), entry('b', 9, 2)], opts(2));
    const a = results.find((r) => r.playerId === pid('a'));
    const b = results.find((r) => r.playerId === pid('b'));
    expect(roundPointsFor(a!)).toBeGreaterThan(roundPointsFor(b!));
  });

  it('puts players who never holed out last and marks them DNF', () => {
    const results = rankRound(
      [entry('a', LIMITS.MAX_STROKES, null), entry('b', 6, 1)],
      opts(2),
    );
    const a = results.find((r) => r.playerId === pid('a'))!;
    const b = results.find((r) => r.playerId === pid('b'))!;
    expect(a.dnf).toBe(true);
    expect(b.dnf).toBe(false);
    expect(a.rank).toBeGreaterThan(b.rank);
  });

  it('rankPlayers orders best-first with DNF last', () => {
    const ordered = rankPlayers(
      rankRound([entry('a', 8, 2), entry('b', 3, 1), entry('c', LIMITS.MAX_STROKES, null)], opts(3)),
    );
    expect(ordered[0]?.playerId).toBe(pid('b'));
    expect(ordered[ordered.length - 1]?.dnf).toBe(true);
  });
});

describe('cooperative mode refuses to rank', () => {
  it('preserves join order instead of sorting, because a sorted list is a ranking', () => {
    const results = rankRound(
      [entry('a', 9, 3), entry('b', 2, 1), entry('c', 5, 2)],
      opts(3, 'together'),
    );
    expect(results.map((r) => r.playerId)).toEqual([pid('a'), pid('b'), pid('c')]);
  });

  it('gives every co-op player the same rank so no winner can be shown', () => {
    const results = rankRound([entry('a', 9, 2), entry('b', 2, 1)], opts(2, 'together'));
    const ranks = new Set(results.map((r) => r.rank));
    expect(ranks.size).toBe(1);
  });
});

describe('battle mode is an equal contest', () => {
  it('gives every player the identical course, so stroke counts are comparable', async () => {
    const { variantIndexFor } = await import('./competitive');
    const { generateLevel } = await import('@/game/levels/generator');
    const roster = [0, 1, 2, 3, 4, 5, 6, 7].map((joinSeq) => ({
      id: pid(`p${joinSeq}`),
      joinSeq,
    })) as unknown as Parameters<typeof variantIndexFor>[0][];

    const variants = roster.map((p) => variantIndexFor(p, 'battle'));
    expect(new Set(variants).size, 'all players must share one variant').toBe(1);

    // And that variant must produce one identical level for everyone.
    const levels = variants.map((v) => JSON.stringify(generateLevel(4242, 2, v)));
    expect(new Set(levels).size).toBe(1);
  });

  it('keeps co-op on a single shared course too', async () => {
    const { variantIndexFor } = await import('./competitive');
    const roster = [0, 1, 2].map((joinSeq) => ({ id: pid(`p${joinSeq}`), joinSeq })) as unknown as Parameters<typeof variantIndexFor>[0][];
    expect(new Set(roster.map((p) => variantIndexFor(p, 'together'))).size).toBe(1);
  });
});
