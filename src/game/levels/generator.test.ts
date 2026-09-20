/**
 * Level generation must be DETERMINISTIC: every peer generates the identical
 * course from the room code alone, so no level data is ever transmitted.
 * If these tests fail, peers see different courses and the game desyncs.
 */
import { describe, expect, it } from 'vitest';
import { generateLevel, isLevelPlayable, hasClearRoute } from './generator';
import { createPrng, hashSeed, seedFor } from './prng';
import { roomSeedFromCode } from '@/utils/roomCode';

describe('prng', () => {
  it('is reproducible for the same seed', () => {
    const a = createPrng(12345);
    const b = createPrng(12345);
    const seqA = Array.from({ length: 200 }, () => a.nextU32());
    const seqB = Array.from({ length: 200 }, () => b.nextU32());
    expect(seqA).toEqual(seqB);
  });

  it('diverges for different seeds', () => {
    const a = Array.from({ length: 50 }, (_, i) => createPrng(1).nextU32() + i);
    const b = Array.from({ length: 50 }, (_, i) => createPrng(2).nextU32() + i);
    expect(a).not.toEqual(b);
  });

  it('produces floats strictly inside [0,1)', () => {
    const rng = createPrng(99);
    for (let i = 0; i < 5000; i++) {
      const f = rng.nextFloat();
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThan(1);
      expect(Number.isNaN(f)).toBe(false);
    }
  });

  it('hashSeed is stable and order-sensitive', () => {
    expect(hashSeed('AB7K9P', 3)).toBe(hashSeed('AB7K9P', 3));
    expect(hashSeed('AB7K9P', 3)).not.toBe(hashSeed(3, 'AB7K9P'));
  });

  it('seedFor separates round and player variant', () => {
    expect(seedFor(1000, 0, 0)).toBe(seedFor(1000, 0, 0));
    expect(seedFor(1000, 0, 0)).not.toBe(seedFor(1000, 1, 0));
    expect(seedFor(1000, 0, 0)).not.toBe(seedFor(1000, 0, 1));
  });
});

describe('generateLevel', () => {
  it('is byte-identical for the same inputs', () => {
    for (let round = 0; round < 12; round++) {
      const a = generateLevel(4242, round, 0);
      const b = generateLevel(4242, round, 0);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    }
  });

  it('derives the same course on every peer from the room code alone', () => {
    // This is the whole reason no level data crosses the wire.
    const seed = roomSeedFromCode('AB7K9P');
    const peerA = generateLevel(seed, 2, 0);
    const peerB = generateLevel(roomSeedFromCode('ab7k9p'), 2, 0);
    expect(JSON.stringify(peerA)).toBe(JSON.stringify(peerB));
  });

  it('gives each battle player a different course', () => {
    const shapes = new Set<string>();
    for (let variant = 0; variant < 8; variant++) {
      shapes.add(JSON.stringify(generateLevel(777, 1, variant)));
    }
    expect(shapes.size).toBe(8);
  });

  it('varies layouts across rounds so play does not feel repetitive', () => {
    const shapes = new Set<string>();
    for (let round = 0; round < 20; round++) {
      shapes.add(JSON.stringify(generateLevel(555, round, 0)));
    }
    expect(shapes.size).toBe(20);
  });

  it('always produces a playable course with a clear route', () => {
    for (let seed = 0; seed < 40; seed++) {
      for (let round = 0; round < 8; round++) {
        const level = generateLevel(seed * 7919 + 13, round, seed % 4);
        expect(isLevelPlayable(level), `seed=${seed} round=${round}`).toBe(true);
        expect(hasClearRoute(level), `seed=${seed} round=${round}`).toBe(true);
      }
    }
  });

  it('keeps the ball start and hole inside the course', () => {
    for (let round = 0; round < 15; round++) {
      const l = generateLevel(31337, round, 0);
      expect(l.ballStart.x).toBeGreaterThan(0);
      expect(l.ballStart.x).toBeLessThan(l.width);
      expect(l.ballStart.y).toBeGreaterThan(0);
      expect(l.ballStart.y).toBeLessThan(l.height);
      expect(l.hole.center.x).toBeGreaterThan(0);
      expect(l.hole.center.x).toBeLessThan(l.width);
      expect(l.hole.center.y).toBeGreaterThan(0);
      expect(l.hole.center.y).toBeLessThan(l.height);
      expect(l.par).toBeGreaterThan(0);
    }
  });

  it('gets harder as rounds progress', () => {
    const early = generateLevel(8080, 0, 0).obstacles.length;
    const late = generateLevel(8080, 14, 0).obstacles.length;
    expect(late).toBeGreaterThan(early);
  });
});
