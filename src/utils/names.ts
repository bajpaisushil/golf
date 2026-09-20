/**
 * Friendly two-word player names — "Happy Fox", "Blue Panda", "Tiny Rocket".
 *
 * Presentation only, so `Math.random` is fine here: the determinism rules in
 * docs/CONTRACTS.md cover `game/physics/**` and `game/levels/**`. A name never
 * reaches the simulation.
 *
 * CURATION RULES, so nothing has to be moderated later:
 *   - every adjective is at most 6 characters, every noun at most 7, so the
 *     longest possible name is exactly LIMITS.MAX_NAME_LENGTH (14) and
 *     `clampName` never clips one;
 *   - every word is wholesome, concrete and safe in any room — animals, weather,
 *     food, space, plants. No slang, no bodies, no politics, no brands, no
 *     characters anybody owns, and no word that reads badly next to any other
 *     word in the opposite list (all 1,764 combinations were chosen to be
 *     printable on a screen a child might be watching).
 */

import { LIMITS } from '@/game/config';

/** 42 adjectives, each ≤ 6 characters. */
export const NAME_ADJECTIVES: readonly string[] = [
  'Happy',
  'Brave',
  'Tiny',
  'Sunny',
  'Lucky',
  'Swift',
  'Fuzzy',
  'Jolly',
  'Mellow',
  'Nifty',
  'Plucky',
  'Quiet',
  'Rapid',
  'Snappy',
  'Turbo',
  'Velvet',
  'Zesty',
  'Bold',
  'Chill',
  'Wild',
  'Cosmic',
  'Sleepy',
  'Breezy',
  'Golden',
  'Purple',
  'Blue',
  'Gentle',
  'Merry',
  'Noble',
  'Polite',
  'Royal',
  'Silly',
  'Sturdy',
  'Sweet',
  'Tidy',
  'Warm',
  'Witty',
  'Cheery',
  'Dandy',
  'Eager',
  'Kind',
  'Frosty',
];

/** 42 nouns, each ≤ 7 characters. */
export const NAME_NOUNS: readonly string[] = [
  'Fox',
  'Panda',
  'Rocket',
  'Otter',
  'Comet',
  'Puffin',
  'Tiger',
  'Walrus',
  'Falcon',
  'Cactus',
  'Donut',
  'Koala',
  'Meteor',
  'Narwhal',
  'Pebble',
  'Quokka',
  'Robin',
  'Turtle',
  'Badger',
  'Muffin',
  'Penguin',
  'Pixel',
  'Rabbit',
  'Zebra',
  'Yak',
  'Acorn',
  'Bagel',
  'Beacon',
  'Bison',
  'Cloud',
  'Dolphin',
  'Ferret',
  'Gecko',
  'Heron',
  'Island',
  'Lantern',
  'Maple',
  'Nectar',
  'Orbit',
  'Pelican',
  'Sparrow',
  'Wombat',
];

/** Total distinct names this generator can produce. */
export const NAME_COMBINATIONS = NAME_ADJECTIVES.length * NAME_NOUNS.length;

/** Safe list read: `noUncheckedIndexedAccess` means `list[i]` is `string | undefined`. */
function at(list: readonly string[], index: number): string {
  const size = list.length;
  if (size === 0) return '';
  const wrapped = ((Math.floor(index) % size) + size) % size;
  return list[wrapped] ?? list[0] ?? '';
}

/** Builds the name for a pair of indices, wrapping both. */
function nameAt(adjectiveIndex: number, nounIndex: number): string {
  const adjective = at(NAME_ADJECTIVES, adjectiveIndex);
  const noun = at(NAME_NOUNS, nounIndex);
  const name = `${adjective} ${noun}`.trim();
  return name.slice(0, LIMITS.MAX_NAME_LENGTH);
}

/** A fresh friendly name, e.g. "Cosmic Otter". */
export function randomName(): string {
  return nameAt(
    Math.floor(Math.random() * NAME_ADJECTIVES.length),
    Math.floor(Math.random() * NAME_NOUNS.length),
  );
}

/**
 * The same name for the same seed, on every device and every engine.
 *
 * Integer-only mixing (xorshift + `Math.imul`), so two peers that derive a name
 * from the same player id or room seed agree without exchanging anything. Useful
 * for placeholder names of players whose HELLO has not arrived yet.
 */
export function nameFromSeed(seed: number): string {
  let x = (Number.isFinite(seed) ? Math.floor(seed) : 0) >>> 0;
  // Avalanche so neighbouring seeds do not produce neighbouring names.
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  x = x >>> 0;

  const adjectiveIndex = x % NAME_ADJECTIVES.length;
  const nounIndex = Math.floor(x / NAME_ADJECTIVES.length) % NAME_NOUNS.length;
  return nameAt(adjectiveIndex, nounIndex);
}

/**
 * A deterministic name for any string key (a PlayerId, a PeerId, a room code).
 * FNV-1a, integer maths only, so every peer derives the same placeholder.
 */
export function nameFromKey(key: string): string {
  const text = typeof key === 'string' ? key : String(key);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i) & 0xff;
    hash = Math.imul(hash, 0x01000193);
  }
  return nameFromSeed(hash >>> 0);
}

/**
 * A name guaranteed to differ from `current`, so tapping the dice always feels
 * like it did something. Gives up after a few tries — with 1,764 combinations a
 * collision streak is vanishingly unlikely, and a repeat is harmless anyway.
 */
export function rerollName(current: string): string {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = randomName();
    if (candidate !== current) return candidate;
  }
  return randomName();
}

/**
 * A name that is not already taken in the room, so two players are never both
 * "Happy Fox". Falls back to appending a digit once the list is exhausted, which
 * needs more than 1,764 players in an 8-player room — i.e. never.
 */
export function uniqueName(taken: readonly string[]): string {
  const used = new Set(taken.map((name) => name.toLowerCase()));
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const candidate = randomName();
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  const base = randomName();
  for (let suffix = 2; suffix < 10; suffix += 1) {
    const candidate = `${base} ${suffix}`.slice(0, LIMITS.MAX_NAME_LENGTH);
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  return base;
}
