/**
 * The mesh echoes, retransmits and reorders. The sequencer is the gate that makes
 * every peer converge on the same state regardless. If it leaks a duplicate, a
 * stroke gets double-counted; if it leaks a stale frame, a finished round reopens.
 */
import { describe, expect, it } from 'vitest';
import { createSequencer } from './sequencer';
import { electHost, hostSuccession, shouldClaimHost } from '@/multiplayer/room/hostElection';
import type { PlayerId, PlayerState } from '@/types';

const pid = (s: string) => s as PlayerId;
const clock = () => { let t = 0; return () => (t += 1000); };

describe('sequencer inbound gate', () => {
  it('accepts a fresh sequence number exactly once', () => {
    const s = createSequencer(pid('me'), clock());
    expect(s.classify(pid('peer'), 1)).toBe('accept');
    expect(s.classify(pid('peer'), 1)).toBe('duplicate');
    expect(s.classify(pid('peer'), 1)).toBe('duplicate');
  });

  it('rejects an out-of-order frame as stale, never re-applying it', () => {
    const s = createSequencer(pid('me'), clock());
    expect(s.classify(pid('peer'), 5)).toBe('accept');
    expect(s.classify(pid('peer'), 4)).toBe('stale');
    expect(s.classify(pid('peer'), 1)).toBe('stale');
    expect(s.classify(pid('peer'), 6)).toBe('accept');
  });

  it('tracks each sender independently', () => {
    const s = createSequencer(pid('me'), clock());
    expect(s.classify(pid('a'), 10)).toBe('accept');
    // b's counter is its own; 1 is not stale just because a is at 10.
    expect(s.classify(pid('b'), 1)).toBe('accept');
    expect(s.lastSeqFrom(pid('a'))).toBe(10);
    expect(s.lastSeqFrom(pid('b'))).toBe(1);
    expect(s.lastSeqFrom(pid('never-seen'))).toBe(0);
  });

  it('survives a flood of duplicates without accepting one twice', () => {
    const s = createSequencer(pid('me'), clock());
    let accepted = 0;
    for (let round = 0; round < 50; round++) {
      for (let seq = 1; seq <= 20; seq++) {
        if (s.classify(pid('peer'), seq) === 'accept') accepted++;
      }
    }
    expect(accepted).toBe(20);
  });

  it('lets a reconnecting peer restart its counter after reset', () => {
    const s = createSequencer(pid('me'), clock());
    s.classify(pid('peer'), 42);
    expect(s.classify(pid('peer'), 1)).toBe('stale');
    s.reset(pid('peer'));
    expect(s.classify(pid('peer'), 1)).toBe('accept');
  });

  it('never lets a reset break our own outbound counter', () => {
    const s = createSequencer(pid('me'), clock());
    const before = s.next();
    s.reset();
    expect(s.next()).toBeGreaterThan(before);
  });

  it('hands out strictly increasing outbound sequence numbers', () => {
    const s = createSequencer(pid('me'), clock());
    let prev = 0;
    for (let i = 0; i < 100; i++) {
      const n = s.next();
      expect(n).toBeGreaterThan(prev);
      prev = n;
    }
    expect(s.peek()).toBe(prev);
  });
});

describe('logical clock', () => {
  it('advances on tick and jumps past what a peer reports', () => {
    const s = createSequencer(pid('me'), clock());
    expect(s.tick()).toBeGreaterThan(0);
    const after = s.observe(500);
    expect(after).toBeGreaterThan(500);
    expect(s.clock()).toBe(after);
  });
});

// ---------------------------------------------------------------------------

const player = (id: string, joinSeq: number, connected = true): PlayerState => ({
  id: pid(id),
  displayName: id,
  color: '#ffffff' as PlayerState['color'],
  joinSeq,
  connected,
  isHost: false,
  currentPos: { x: 0, y: 0 },
  strokes: 0,
  holed: false,
  holeOutOrder: null,
  roundScore: 0,
  totalScore: 0,
  roundWins: 0,
  levelSeedVariant: joinSeq,
  teamId: null,
  thinkTimeMs: 0,
  penaltyStrokes: 0,
});

describe('host election', () => {
  const roster = [player('carol', 2), player('alice', 0), player('bob', 1)];

  it('elects the earliest joiner', () => {
    expect(electHost(roster)).toBe(pid('alice'));
  });

  it('is order-independent, so every peer agrees without coordinating', () => {
    // This is what prevents split-brain: no messages are exchanged to decide.
    const shuffles = [
      [roster[0]!, roster[1]!, roster[2]!],
      [roster[2]!, roster[0]!, roster[1]!],
      [roster[1]!, roster[2]!, roster[0]!],
    ];
    const answers = new Set(shuffles.map((r) => electHost(r)));
    expect(answers.size).toBe(1);
    expect([...answers][0]).toBe(pid('alice'));
  });

  it('skips disconnected players when the host drops', () => {
    const afterHostLeft = [player('alice', 0, false), player('bob', 1), player('carol', 2)];
    expect(electHost(afterHostLeft)).toBe(pid('bob'));
  });

  it('returns null when nobody is connected', () => {
    expect(electHost([player('alice', 0, false)])).toBeNull();
    expect(electHost([])).toBeNull();
  });

  it('produces a stable succession order', () => {
    expect(hostSuccession(roster)).toEqual([pid('alice'), pid('bob'), pid('carol')]);
  });

  it('lets exactly one player claim the host seat', () => {
    const claimants = roster.filter((p) => shouldClaimHost(roster, p.id));
    expect(claimants).toHaveLength(1);
    expect(claimants[0]?.id).toBe(pid('alice'));
  });

  it('breaks a joinSeq tie deterministically', () => {
    const tied = [player('zed', 0), player('amy', 0)];
    expect(electHost(tied)).toBe(electHost([tied[1]!, tied[0]!]));
  });
});
