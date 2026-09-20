/**
 * Wire protocol version.
 *
 * Bump PROTOCOL_VERSION whenever the shape or meaning of anything in
 * `messages.ts` changes, or whenever the deterministic simulation / level
 * generator changes in a way that alters outcomes - peers on different
 * versions would silently desync otherwise.
 *
 * Peers exchange this in HELLO. A mismatch outside the compatible range is a
 * hard, user-visible failure ("This player is on a different version of the
 * game - both of you should refresh").
 */

/** Current protocol. Increment on ANY breaking change to messages or simulation. */
export const PROTOCOL_VERSION = 1;

/** Oldest protocol we still accept. Keep equal to PROTOCOL_VERSION unless a shim exists. */
export const MIN_COMPATIBLE_PROTOCOL_VERSION = 1;

/** Signaling-plane version, carried in SignalingEnvelope.v. Independent of the game protocol. */
export const SIGNALING_VERSION = 1;

/** True when a peer announcing `version` can safely play with us. */
export function isCompatibleVersion(version: number): boolean {
  return (
    Number.isInteger(version) &&
    version >= MIN_COMPATIBLE_PROTOCOL_VERSION &&
    version <= PROTOCOL_VERSION
  );
}
