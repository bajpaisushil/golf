/**
 * Deterministic pseudo-random numbers for level generation.
 *
 * Every peer regenerates the same course from three integers
 * (roomSeed, roundIndex, variantIndex), so this generator must produce the exact
 * same stream on every browser, CPU and OS. That rules out `Math.random`
 * entirely and restricts the arithmetic to EXACT 32-bit integer operations:
 * `Math.imul`, `>>>`, `<<`, `^`, `|0`. Float division by 2^32 at the very end is
 * IEEE-754 exact, so `next()` is portable too.
 *
 * Algorithm: mulberry32 (32-bit state, period 2^32, passes gjrand/PractRand at
 * this scale) - tiny, fast, and trivially auditable.
 */

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/** 1 / 2^32 - turns a uint32 into [0,1) with exactly 32 bits of resolution. */
const INV_U32 = 2.3283064365386963e-10;

/** One murmur3 mixing round. Exact 32-bit integer maths only. */
function mixStep(hash: number, key: number): number {
  let k = Math.imul(key | 0, 0xcc9e2d51);
  k = (k << 15) | (k >>> 17);
  k = Math.imul(k, 0x1b873593);
  let h = (hash ^ k) | 0;
  h = (h << 13) | (h >>> 19);
  return (Math.imul(h, 5) + 0xe6546b64) | 0;
}

/** murmur3 finaliser (avalanche). Returns an unsigned 32-bit integer. */
function avalanche(hash: number): number {
  let h = hash | 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * Mixes any number of parts into one uint32.
 *
 * Strings are folded by char code, numbers by their integer part AND a 16.16
 * fixed-point view (so `1.5` and `1` differ). A separator constant is mixed in
 * between parts, which makes `hashSeed(1, 23) !== hashSeed(12, 3)`.
 */
export function hashSeed(...values: readonly (number | string)[]): number {
  let h = 0x811c9dc5 | 0;
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (typeof value === 'string') {
      for (let c = 0; c < value.length; c += 1) {
        h = mixStep(h, value.charCodeAt(c));
      }
    } else if (typeof value === 'number') {
      const n = Number.isFinite(value) ? value : 0;
      h = mixStep(h, n | 0);
      h = mixStep(h, Math.floor(n * 65536) | 0);
    }
    h = mixStep(h, 0x9e3779b9 | 0);
  }
  return avalanche(h);
}

// ---------------------------------------------------------------------------
// The generator
// ---------------------------------------------------------------------------

export interface Prng {
  /** Raw 32-bit unsigned integer. */
  nextUint(): number;
  /** [0,1) with 2^-32 resolution. */
  next(): number;
  /** Integer in [min, max). Returns `floor(min)` when the range is empty. */
  nextInt(min: number, max: number): number;
  /** Float in [min, max). Returns `min` when the range is empty. */
  nextRange(min: number, max: number): number;
  /** True with probability p (p <= 0 never, p >= 1 always). */
  chance(p: number): boolean;
  /** Uniform element, or `undefined` for an empty array (noUncheckedIndexedAccess). */
  pick<T>(items: readonly T[]): T | undefined;
  /** Independent stream derived from the CURRENT state; never advances the parent. */
  fork(salt: number): Prng;

  // --- aliases (same functions, the names used in the build plan) -----------
  /** Alias of {@link Prng.nextUint}. */
  nextU32(): number;
  /** Alias of {@link Prng.next}. */
  nextFloat(): number;
  /** Alias of {@link Prng.nextRange}. */
  range(min: number, max: number): number;
  /** Alias of {@link Prng.nextInt}. */
  int(min: number, maxExclusive: number): number;
}

/** mulberry32. `seed` is coerced to uint32, so any integer works. */
export function createPrng(seed: number): Prng {
  let state = (Number.isFinite(seed) ? seed : 0) >>> 0;

  const nextUint = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };

  const next = (): number => nextUint() * INV_U32;

  const nextRange = (min: number, max: number): number => {
    if (!(max > min)) return min;
    return min + next() * (max - min);
  };

  const nextInt = (min: number, max: number): number => {
    const lo = Math.floor(min);
    const hi = Math.floor(max);
    if (!(hi > lo)) return lo;
    return lo + Math.floor(next() * (hi - lo));
  };

  const prng: Prng = {
    nextUint,
    next,
    nextInt,
    nextRange,
    chance(p: number): boolean {
      if (!(p > 0)) return false;
      if (p >= 1) return true;
      return next() < p;
    },
    pick<T>(items: readonly T[]): T | undefined {
      if (items.length === 0) return undefined;
      return items[nextInt(0, items.length)];
    },
    fork(salt: number): Prng {
      // Reads `state` without advancing it: forking twice with the same salt
      // yields the same child stream, which keeps generation reproducible.
      return createPrng(hashSeed(state, salt, 0x5eed));
    },
    nextU32: nextUint,
    nextFloat: next,
    range: nextRange,
    int: nextInt,
  };
  return prng;
}

/** Alias of {@link createPrng}. */
export const makeRng = createPrng;

/**
 * The seed for one concrete course. Mixing (rather than adding) the three parts
 * means neighbouring rounds/variants look completely different.
 */
export function seedFor(roomSeed: number, roundIndex: number, variantIndex: number): number {
  return hashSeed(roomSeed >>> 0, roundIndex | 0, variantIndex | 0, 0x46470001);
}

/**
 * Crypto-quality room seed. HOST/UI ONLY - never call this inside generation,
 * it is the one non-deterministic function in the levels package.
 */
export function randomRoomSeed(): number {
  const g: { crypto?: Crypto } = globalThis as unknown as { crypto?: Crypto };
  const webCrypto = g.crypto;
  if (webCrypto !== undefined && typeof webCrypto.getRandomValues === 'function') {
    const buffer = new Uint32Array(1);
    webCrypto.getRandomValues(buffer);
    const value = buffer[0];
    if (value !== undefined) return value >>> 0;
  }
  // Fallback for exotic/SSR environments. Still only ever used by the host UI.
  return hashSeed(Math.floor(Math.random() * 4294967296), Math.floor(Math.random() * 4294967296));
}
