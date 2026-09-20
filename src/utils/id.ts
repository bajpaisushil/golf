/**
 * Identifier generation.
 *
 * Presentation/session layer, so `Math.random` and `crypto` are both fine here —
 * the determinism rules in docs/CONTRACTS.md cover `game/physics/**` and
 * `game/levels/**` only. Ids never influence a simulation outcome; they only key
 * players, peers and UI lists.
 *
 * SSR-safe: `crypto` is feature-detected, never assumed. Nothing runs at import
 * time, so a Next static build can pull this module into any bundle.
 */

import { asPeerId, asPlayerId, type PeerId, type PlayerId } from '@/types';

/** Lowercase base32-ish alphabet without look-alike characters (no i/l/o/u). */
const SHORT_ID_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

/** Default length of {@link shortId}. 8 chars of 32 symbols ≈ 40 bits. */
const SHORT_ID_LENGTH = 8;

/** Shape of the bits of `crypto` we actually use, so we never rely on `any`. */
interface MaybeCrypto {
  readonly randomUUID?: () => string;
  readonly getRandomValues?: <T extends ArrayBufferView>(array: T) => T;
}

/** Returns the platform crypto object when it exists, else null. Never throws. */
function cryptoOrNull(): MaybeCrypto | null {
  try {
    const candidate: unknown = typeof globalThis === 'undefined' ? undefined : globalThis.crypto;
    if (candidate === undefined || candidate === null) return null;
    return candidate as MaybeCrypto;
  } catch {
    return null;
  }
}

/**
 * Fills `target` with random bytes, preferring `crypto.getRandomValues` and
 * falling back to `Math.random`. The fallback is NOT cryptographically strong;
 * that is acceptable because these ids are collision avoidance, not secrets.
 */
function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  const api = cryptoOrNull();
  if (api !== null && typeof api.getRandomValues === 'function') {
    try {
      api.getRandomValues(out);
      return out;
    } catch {
      // fall through to Math.random
    }
  }
  for (let i = 0; i < length; i += 1) {
    out[i] = Math.floor(Math.random() * 256) & 0xff;
  }
  return out;
}

/** Hex for one byte, always two characters. */
function byteToHex(value: number): string {
  return (value & 0xff).toString(16).padStart(2, '0');
}

/**
 * RFC 4122 version 4 UUID built from {@link randomBytes}. Used only when
 * `crypto.randomUUID` is missing (older Safari, non-secure contexts).
 */
function uuidV4Fallback(): string {
  const bytes = randomBytes(16);
  // Version 4 and RFC 4122 variant bits.
  const b6 = bytes[6];
  const b8 = bytes[8];
  bytes[6] = ((b6 === undefined ? 0 : b6) & 0x0f) | 0x40;
  bytes[8] = ((b8 === undefined ? 0 : b8) & 0x3f) | 0x80;

  let hex = '';
  for (let i = 0; i < 16; i += 1) {
    const byte = bytes[i];
    hex += byteToHex(byte === undefined ? 0 : byte);
  }
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

/**
 * A fresh UUID. Uses `crypto.randomUUID` when available (every modern browser on
 * a secure origin) and a `Math.random` fallback otherwise. Never throws.
 */
export function newUuid(): string {
  const api = cryptoOrNull();
  if (api !== null && typeof api.randomUUID === 'function') {
    try {
      const value = api.randomUUID();
      if (typeof value === 'string' && value.length > 0) return value;
    } catch {
      // fall through
    }
  }
  return uuidV4Fallback();
}

/**
 * Stable identity of a human player for the lifetime of a room. Persisted in
 * sessionStorage (see `utils/storage`) so a refresh reclaims the same seat.
 */
export function newPlayerId(): PlayerId {
  return asPlayerId(newUuid());
}

/**
 * Identity of one RTCPeerConnection endpoint. A reconnecting player keeps their
 * {@link PlayerId} but gets a fresh PeerId, which is how the mesh tells a stale
 * connection apart from a live one.
 */
export function newPeerId(): PeerId {
  return asPeerId(newUuid());
}

/**
 * A short, URL-safe, human-readable id. Not a security token — use it for React
 * keys, toast ids, message ids and other local bookkeeping.
 */
export function shortId(length: number = SHORT_ID_LENGTH): string {
  const size = Math.max(1, Math.min(32, Math.floor(Number.isFinite(length) ? length : SHORT_ID_LENGTH)));
  const bytes = randomBytes(size);
  let out = '';
  for (let i = 0; i < size; i += 1) {
    const byte = bytes[i];
    const index = (byte === undefined ? 0 : byte) % SHORT_ID_ALPHABET.length;
    out += SHORT_ID_ALPHABET[index] ?? '0';
  }
  return out;
}

/**
 * Monotonic-ish local counter for things that must be unique within one page
 * session but never leave the device (e.g. toast ids). Cheaper than a UUID.
 */
let localCounter = 0;
export function nextLocalId(prefix = 'x'): string {
  localCounter += 1;
  return `${prefix}-${localCounter.toString(36)}`;
}

/**
 * A stable unsigned 32-bit hash of any string. Deterministic across engines
 * (FNV-1a with `Math.imul`, integer maths only), so two peers hashing the same
 * id agree — handy for picking a colour or a default avatar from an id.
 */
export function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i) & 0xff;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
