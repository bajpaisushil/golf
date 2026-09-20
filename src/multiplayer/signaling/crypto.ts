/**
 * Room-code derived encryption for the SIGNALING plane.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * The default signaling backend publishes to PUBLIC Nostr relays that anyone
 * can read. An SDP offer is not secret game data, but it does contain the
 * player's local network addresses (192.168.x.x, the public ip:port discovered
 * via STUN, and mDNS host names). Publishing that in the clear next to a room
 * code would be careless, so every envelope is AES-GCM encrypted with a key
 * derived from the room code, and the room code itself never leaves the browser
 * - relays only ever see a SHA-256 topic hash.
 *
 * ---------------------------------------------------------------------------
 * HONEST SECURITY NOTE - PLEASE READ BEFORE TRUSTING THIS
 * ---------------------------------------------------------------------------
 * A 6-character room code from a 32-symbol alphabet is ~30 bits of entropy.
 * That is CASUAL PRIVACY, not security. Anyone who guesses or is told the room
 * code can derive the same key, and 30 bits is brute-forceable by a motivated
 * attacker who is willing to spend PBKDF2 work per guess.
 *
 * What this DOES buy:
 *  - a relay operator, or someone idly scraping a relay, cannot read SDP or
 *    correlate rooms without first guessing the code;
 *  - the room code is never published anywhere, only its hash;
 *  - garbage or hostile events posted to the topic fail to decrypt and are
 *    dropped before they can reach the WebRTC layer.
 *
 * What this does NOT buy: protection against anyone who has the room code.
 * Nothing sensitive is ever sent over this plane, which is what makes that an
 * acceptable trade for a party game.
 *
 * Everything here needs `crypto.subtle`, which exists only in browsers (and
 * only in secure contexts: https, or localhost). Every entry point is guarded
 * so importing this module during SSR / static export can never throw.
 */

import { err, ok } from '@/types';
import type { Result, RoomCode, SignalingEnvelope } from '@/types';
import { isSignalingEnvelope } from './types';

// --- Fixed protocol constants. Not gameplay tunables, so they do not belong in
// --- @/game/config; changing any of them is a breaking signaling change.

/** Domain separation so a room topic can never collide with the key material. */
const TOPIC_PREFIX = 'friend-golf/v1/topic:';
/** Fixed KDF salt. A per-room random salt is impossible: both sides must derive the same key from the code alone. */
const KDF_SALT = 'friend-golf/v1/signaling-salt';
/** PBKDF2 rounds. High enough to make brute-forcing a 6-char code expensive, low enough to stay under ~100ms on a phone. */
const KDF_ITERATIONS = 100_000;
/** AES-GCM nonce length in bytes, per spec. */
const IV_BYTES = 12;
/** Bound to the ciphertext so a blob cannot be replayed into a future envelope format. */
const AAD = 'fg-sig-v1';

// ---------------------------------------------------------------------------
// Environment guards
// ---------------------------------------------------------------------------

function webCrypto(): Crypto | null {
  const candidate: unknown = typeof globalThis === 'undefined' ? undefined : globalThis.crypto;
  if (typeof candidate !== 'object' || candidate === null) return null;
  return candidate as Crypto;
}

function subtle(): SubtleCrypto | null {
  const c = webCrypto();
  if (c === null) return null;
  const s: unknown = c.subtle;
  return typeof s === 'object' && s !== null ? (s as SubtleCrypto) : null;
}

/** True when this environment can do room encryption at all. */
export function isCryptoAvailable(): boolean {
  return subtle() !== null && typeof TextEncoder !== 'undefined';
}

function requireSubtle(): SubtleCrypto {
  const s = subtle();
  if (s === null) {
    throw new Error(
      'crypto.subtle is unavailable (server render, or an insecure origin - use https or localhost)',
    );
  }
  return s;
}

const encoder = (): TextEncoder => new TextEncoder();

// ---------------------------------------------------------------------------
// base64url (no padding) - hand-rolled so it works identically in the browser,
// in vitest/node and during SSR, with no Buffer and no atob/btoa dependency.
// ---------------------------------------------------------------------------

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

const B64URL_LOOKUP: Readonly<Record<string, number>> = (() => {
  const table: Record<string, number> = {};
  for (let i = 0; i < B64URL.length; i += 1) {
    const ch = B64URL[i];
    if (ch !== undefined) table[ch] = i;
  }
  // Tolerate standard base64 too, so a blob pasted from anywhere still decodes.
  table['+'] = 62;
  table['/'] = 63;
  return table;
})();

export function toBase64Url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    const word = (b0 << 16) | ((b1 ?? 0) << 8) | (b2 ?? 0);
    out += B64URL[(word >>> 18) & 63] ?? '';
    out += B64URL[(word >>> 12) & 63] ?? '';
    if (b1 !== undefined) out += B64URL[(word >>> 6) & 63] ?? '';
    if (b2 !== undefined) out += B64URL[word & 63] ?? '';
  }
  return out;
}

/**
 * Returns null when the text contains anything that is not base64(url).
 * The `<ArrayBuffer>` type argument matters: `BufferSource` (what crypto.subtle
 * takes) does not accept a `Uint8Array<ArrayBufferLike>`.
 */
export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | null {
  const bytes: number[] = [];
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === undefined || ch === '=' || ch === '\n' || ch === '\r' || ch === ' ') continue;
    const value = B64URL_LOOKUP[ch];
    if (value === undefined) return null;
    acc = (acc << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((acc >>> bits) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i] ?? 0;
    out += byte.toString(16).padStart(2, '0');
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const topicCache = new Map<string, Promise<string>>();
const keyCache = new Map<string, Promise<CryptoKey>>();

/**
 * SHA-256 of a fixed prefix + room code, hex.
 *
 * This is the only room identifier that ever reaches a relay or a
 * BroadcastChannel name. The room code itself never leaves the browser.
 */
export function roomTopic(roomCode: RoomCode): Promise<string> {
  const cached = topicCache.get(roomCode);
  if (cached !== undefined) return cached;

  const pending = (async (): Promise<string> => {
    const digest = await requireSubtle().digest('SHA-256', encoder().encode(TOPIC_PREFIX + roomCode));
    return toHex(new Uint8Array(digest));
  })().catch((cause: unknown) => {
    topicCache.delete(roomCode); // never cache a failure
    throw cause;
  });

  topicCache.set(roomCode, pending);
  return pending;
}

/**
 * PBKDF2(roomCode, fixed salt, 100k, SHA-256) -> AES-GCM-256 key.
 *
 * Cached per room code: PBKDF2 is intentionally slow and every envelope would
 * otherwise pay for it.
 */
export function deriveRoomKey(roomCode: RoomCode): Promise<CryptoKey> {
  const cached = keyCache.get(roomCode);
  if (cached !== undefined) return cached;

  const pending = (async (): Promise<CryptoKey> => {
    const s = requireSubtle();
    const material = await s.importKey('raw', encoder().encode(roomCode), 'PBKDF2', false, [
      'deriveKey',
    ]);
    return s.deriveKey(
      {
        name: 'PBKDF2',
        salt: encoder().encode(KDF_SALT),
        iterations: KDF_ITERATIONS,
        hash: 'SHA-256',
      },
      material,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  })().catch((cause: unknown) => {
    keyCache.delete(roomCode);
    throw cause;
  });

  keyCache.set(roomCode, pending);
  return pending;
}

/** base64url( iv(12) || ciphertext ). Rejects when crypto.subtle is unavailable. */
export async function encryptEnvelope(
  key: CryptoKey,
  envelope: SignalingEnvelope,
): Promise<string> {
  const s = requireSubtle();
  const c = webCrypto();
  if (c === null) throw new Error('crypto.getRandomValues is unavailable');

  const iv = new Uint8Array(IV_BYTES);
  c.getRandomValues(iv);

  const plaintext = encoder().encode(JSON.stringify(envelope));
  const cipher = new Uint8Array(
    await s.encrypt(
      { name: 'AES-GCM', iv, additionalData: encoder().encode(AAD) },
      key,
      plaintext,
    ),
  );

  const packed = new Uint8Array(iv.length + cipher.length);
  packed.set(iv, 0);
  packed.set(cipher, iv.length);
  return toBase64Url(packed);
}

/**
 * Inverse of {@link encryptEnvelope}.
 *
 * Returns err (never throws) for every hostile case: junk on the relay topic,
 * an event encrypted with a different room code, a truncated blob, or valid
 * plaintext that is not a well-formed envelope.
 */
export async function decryptEnvelope(
  key: CryptoKey,
  blob: string,
): Promise<Result<SignalingEnvelope, string>> {
  const s = subtle();
  if (s === null) return err('crypto.subtle unavailable');

  const packed = fromBase64Url(blob);
  if (packed === null) return err('not base64url');
  if (packed.length <= IV_BYTES) return err('blob too short');

  const iv = packed.subarray(0, IV_BYTES);
  const cipher = packed.subarray(IV_BYTES);

  let plaintext: string;
  try {
    const decrypted = await s.decrypt(
      { name: 'AES-GCM', iv, additionalData: encoder().encode(AAD) },
      key,
      cipher,
    );
    plaintext = new TextDecoder().decode(decrypted);
  } catch {
    // Wrong room code, tampered bytes, or someone else's traffic on the topic.
    return err('decryption failed');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    return err('payload is not JSON');
  }

  if (!isSignalingEnvelope(parsed)) return err('payload is not a signaling envelope');
  return ok(parsed);
}

// ---------------------------------------------------------------------------
// Nonces
// ---------------------------------------------------------------------------

let nonceCounter = 0;

/**
 * 16 hex characters of randomness, used to dedupe envelopes that arrive twice
 * (multi-relay fan-out, composite backends, relay retransmits).
 *
 * Uniqueness matters, unpredictability does not, so the fallback path for
 * exotic environments without getRandomValues is acceptable - and it can never
 * weaken the encryption above, which uses getRandomValues directly.
 */
export function randomNonce(): string {
  const c = webCrypto();
  if (c !== null && typeof c.getRandomValues === 'function') {
    const bytes = new Uint8Array(8);
    c.getRandomValues(bytes);
    return toHex(bytes);
  }
  nonceCounter = (nonceCounter + 1) % 0xffff;
  const a = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
  const b = nonceCounter.toString(16).padStart(4, '0');
  const d = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0');
  return (a + b + d).slice(0, 16);
}
