/**
 * THE WIRE CODEC: `NetMessage` <-> the string that crosses a WebRTC DataChannel.
 *
 * JSON is deliberate. Gameplay traffic is tiny and infrequent (one ~120 byte
 * PLAYER_SHOT per stroke, a HEARTBEAT every couple of seconds), so a binary
 * format would buy nothing measurable and would cost us readability in the
 * devtools network panel - which is the only debugger a serverless P2P game has.
 *
 * SECURITY POSTURE - read this before changing anything here:
 *   Everything that reaches {@link decode} came from a stranger's browser over a
 *   DataChannel we do not control. It is HOSTILE INPUT. This module therefore:
 *     1. never throws (a malformed frame is a `Result` error, not an exception),
 *     2. bounds the work it does (size checked BEFORE JSON.parse),
 *     3. strips prototype-poisoning keys while parsing,
 *     4. runs the full structural validator from `messages.ts`,
 *     5. rejects protocol versions we cannot faithfully interpret.
 *   A frame that fails any step is dropped; the room carries on. Nothing here
 *   may ever feed an unvalidated number into the deterministic simulation.
 */

import { LIMITS } from '@/game/config';
import { err, ok, type Result } from '@/types';

import { isNetMessage, type NetMessage } from './messages';
import { isCompatibleVersion, PROTOCOL_VERSION } from './version';

// ---------------------------------------------------------------------------
// Size accounting
// ---------------------------------------------------------------------------

/**
 * Keys that must never survive a `JSON.parse` of untrusted input.
 * `{"__proto__": {...}}` is the classic prototype-pollution vector; the others
 * are cheap insurance and appear in no legitimate message.
 */
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set<string>([
  '__proto__',
  'constructor',
  'prototype',
]);

/**
 * UTF-8 byte length of `raw`, computed without allocating.
 *
 * We do NOT use `TextEncoder` (which allocates a Uint8Array per call) or
 * `Buffer` (a Node built-in, banned by the static-export rule). Counting by
 * code unit is exact and works identically in every browser and in vitest.
 */
export function byteLength(raw: string): number {
  if (typeof raw !== 'string') return 0;
  let bytes = 0;
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      // High surrogate: a well-formed pair encodes to 4 bytes.
      const next = i + 1 < raw.length ? raw.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else {
        // Lone surrogate - encoders emit U+FFFD, which is 3 bytes.
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/** True when a frame is small enough to put on the wire. */
export function fitsOnWire(raw: string): boolean {
  return byteLength(raw) <= LIMITS.MAX_MESSAGE_BYTES;
}

// ---------------------------------------------------------------------------
// Encode
// ---------------------------------------------------------------------------

/**
 * Serialises a message for the DataChannel.
 *
 * Every `NetMessage` is JSON-safe by construction (see the note at the top of
 * `types/game.ts`: no Map/Set, no class instances, no functions), so this cannot
 * fail for well-typed input. Call sites that want a belt-and-braces guarantee -
 * including a size check - should use {@link encodeChecked} instead.
 */
export function encode(message: NetMessage): string {
  return JSON.stringify(message);
}

/**
 * Defensive twin of {@link encode}: never throws, and refuses anything that
 * would exceed `LIMITS.MAX_MESSAGE_BYTES` on the wire.
 */
export function encodeChecked(message: NetMessage): Result<string, string> {
  let raw: string | undefined;
  try {
    raw = JSON.stringify(message);
  } catch {
    return err('encode: message is not JSON-serialisable');
  }
  if (typeof raw !== 'string') {
    return err('encode: message serialised to nothing');
  }
  const size = byteLength(raw);
  if (size > LIMITS.MAX_MESSAGE_BYTES) {
    return err(`encode: message is ${size} bytes, limit is ${LIMITS.MAX_MESSAGE_BYTES}`);
  }
  return ok(raw);
}

// ---------------------------------------------------------------------------
// Decode
// ---------------------------------------------------------------------------

/** `JSON.parse` reviver that drops prototype-poisoning keys. */
function safeReviver(key: string, value: unknown): unknown {
  if (FORBIDDEN_KEYS.has(key)) return undefined;
  return value;
}

/**
 * Parses and fully validates one frame from the wire.
 *
 * Order matters: the size check runs BEFORE `JSON.parse` so a hostile peer
 * cannot make us parse a megabyte of nested arrays. A failure is always an
 * `err(...)` describing what was wrong - callers log/count it and drop the
 * frame; they never surface the raw text to the player.
 */
export function decode(raw: string): Result<NetMessage, string> {
  if (typeof raw !== 'string') return err('decode: payload was not a string');
  if (raw.length === 0) return err('decode: empty payload');

  const size = byteLength(raw);
  if (size > LIMITS.MAX_MESSAGE_BYTES) {
    return err(`decode: payload is ${size} bytes, limit is ${LIMITS.MAX_MESSAGE_BYTES}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw, safeReviver);
  } catch {
    return err('decode: malformed JSON');
  }

  // Structural validation. This is what keeps NaN/Infinity (which JSON.stringify
  // turns into `null`), missing fields, wrong types and unknown `type` values out
  // of game state - `isNetMessage` checks every field of every variant.
  if (!isNetMessage(parsed)) {
    return err('decode: payload is not a valid NetMessage');
  }

  if (!isCompatibleVersion(parsed.v)) {
    return err(
      `decode: protocol v${parsed.v} is not compatible with v${PROTOCOL_VERSION}`,
    );
  }

  return ok(parsed);
}

/**
 * Convenience for transports that receive a batch of frames: decodes each one
 * independently so a single bad frame never discards the good ones.
 */
export function decodeAll(rawFrames: readonly string[]): {
  readonly messages: readonly NetMessage[];
  readonly errors: readonly string[];
} {
  const messages: NetMessage[] = [];
  const errors: string[] = [];
  for (const raw of rawFrames) {
    const result = decode(raw);
    if (result.ok) messages.push(result.value);
    else errors.push(result.error);
  }
  return { messages, errors };
}
