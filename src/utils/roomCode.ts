/**
 * Room codes.
 *
 * A room code is the ONLY thing a player has to type or say out loud, and it is
 * also the seed for every course in the room — `roomSeedFromCode` turns the six
 * characters into a uint32, so no seed ever has to travel over the wire. Two
 * browsers that agree on "K7PQ3M" agree on every hole they will ever play.
 *
 * The alphabet (`ROOM_CODE_ALPHABET` in `game/config`) drops O/0 and I/1 so a
 * code read over a phone call cannot be mistyped.
 *
 * SSR-safe: nothing here touches `window`, and nothing runs at import time.
 */

import { LIMITS, ROOM_CODE_ALPHABET } from '@/game/config';
import { asRoomCode, type RoomCode } from '@/types';

/**
 * Cryptographically-seeded when possible. Room codes are not secrets (anyone
 * with the code joins the room, by design — that is the whole invite model), but
 * a good spread keeps accidental collisions on a public signalling relay rare.
 */
function randomIndex(bound: number): number {
  try {
    const api = globalThis.crypto;
    if (api !== undefined && api !== null && typeof api.getRandomValues === 'function') {
      const buf = new Uint32Array(1);
      // Rejection sampling keeps the distribution uniform.
      const limit = Math.floor(0x100000000 / bound) * bound;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        api.getRandomValues(buf);
        const value = buf[0];
        if (value === undefined) break;
        if (value < limit) return value % bound;
      }
    }
  } catch {
    // fall through to Math.random
  }
  return Math.floor(Math.random() * bound) % bound;
}

/** A fresh, readable room code of `LIMITS.ROOM_CODE_LENGTH` characters. */
export function generateRoomCode(): RoomCode {
  const length = Math.max(4, Math.floor(LIMITS.ROOM_CODE_LENGTH));
  let out = '';
  for (let i = 0; i < length; i += 1) {
    const index = randomIndex(ROOM_CODE_ALPHABET.length);
    out += ROOM_CODE_ALPHABET[index] ?? 'A';
  }
  return asRoomCode(out);
}

/**
 * Cleans up whatever a human pasted: uppercases and drops everything that is not
 * an alphabet character — spaces, dashes, punctuation, a leading "#", the tail of
 * a pasted invite URL, emoji.
 *
 * Look-alikes are deliberately NOT "corrected": O/0 and I/1 are absent from the
 * alphabet, so a code can never legitimately contain them, and silently rewriting
 * one to a neighbouring letter would send the player to somebody else's room.
 * They are dropped, the code fails {@link isValidRoomCode}, and the player retypes.
 */
export function normaliseRoomCode(value: string): RoomCode {
  if (typeof value !== 'string') return asRoomCode('');
  const upper = value.toUpperCase();
  let out = '';
  for (let i = 0; i < upper.length && out.length < LIMITS.ROOM_CODE_LENGTH; i += 1) {
    const char = upper[i];
    if (char === undefined) continue;
    if (ROOM_CODE_ALPHABET.indexOf(char) >= 0) out += char;
  }
  return asRoomCode(out);
}

/**
 * True when `value` is EXACTLY a well-formed room code: right length, every
 * character in the alphabet. Does not normalise — call {@link normaliseRoomCode}
 * first if the string came from a human.
 */
export function isValidRoomCode(value: string): boolean {
  if (typeof value !== 'string') return false;
  if (value.length !== LIMITS.ROOM_CODE_LENGTH) return false;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (char === undefined) return false;
    if (ROOM_CODE_ALPHABET.indexOf(char) < 0) return false;
  }
  return true;
}

/** Contract alias of {@link isValidRoomCode} (docs/CONTRACTS.md §37). */
export const isRoomCode = isValidRoomCode;

/** Normalises and validates in one step. Returns null when the input is unusable. */
export function parseRoomCode(value: string): RoomCode | null {
  const code = normaliseRoomCode(value);
  return isValidRoomCode(code) ? code : null;
}

/**
 * Deterministic unsigned 32-bit seed for a room code.
 *
 * FNV-1a over the normalised characters, finished with an avalanche mix so that
 * codes differing by one character produce wildly different courses. Integer
 * maths only (`Math.imul`, xor, shifts) so every JS engine agrees bit for bit —
 * which is exactly why the seed never needs to be transmitted.
 */
export function roomSeedFromCode(code: RoomCode | string): number {
  const normalised = normaliseRoomCode(typeof code === 'string' ? code : String(code));
  let hash = 0x811c9dc5;
  for (let i = 0; i < normalised.length; i += 1) {
    hash ^= normalised.charCodeAt(i) & 0xff;
    hash = Math.imul(hash, 0x01000193);
  }
  // Avalanche (murmur3 finaliser) — one changed letter changes every bit.
  let x = hash >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return x >>> 0;
}

/**
 * Cosmetic grouping for display: "K7P QM3". Never store or transmit this form —
 * {@link normaliseRoomCode} strips the space again on the way back in.
 */
export function formatRoomCode(code: RoomCode | string): string {
  const text = typeof code === 'string' ? code : String(code);
  if (text.length < 6) return text;
  const half = Math.floor(text.length / 2);
  return `${text.slice(0, half)} ${text.slice(half)}`;
}
