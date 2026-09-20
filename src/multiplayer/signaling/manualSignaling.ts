/**
 * MANUAL signaling: the zero-infrastructure escape hatch.
 *
 * No relays, no BroadcastChannel, no network of any kind. The two players copy
 * one blob of text to each other through whatever chat app they are already in.
 * If every relay on earth is blocked by a corporate firewall, this still works.
 *
 * HOW A HUMAN USES IT
 *   1. Both players open the game and enter the SAME room code.
 *   2. Player A copies the blob from `outbox()` (the UI shows it as a code box
 *      and updates as more of it is produced) and pastes it to player B.
 *   3. Player B pastes it into `ingest()`, which feeds it to their mesh; their
 *      own outbox then fills with the reply.
 *   4. Player B copies THEIR blob back to player A, who ingests it. Connected.
 *
 * Wait a couple of seconds before copying: the blob grows as ICE candidates are
 * gathered, and a blob copied too early may not contain a usable route yet.
 * `onOutboxChange` exists so the UI can re-render the box while that happens.
 *
 * TIMESTAMPS: envelopes are RE-STAMPED with the current time on ingest. Copying
 * by hand takes human time, and every other layer drops envelopes older than
 * TIMING.SIGNALING_TTL_MS as replay protection - which would make hand-copied
 * signaling fail for the most boring possible reason. The person pasting the
 * blob is the trust boundary here, which is exactly what makes that safe.
 */

import { err, ok } from '@/types';
import type { PeerId, Result, RoomCode, SignalingEnvelope, SignalingStatus, Unsubscribe } from '@/types';
import { fromBase64Url, toBase64Url } from './crypto';
import { createDedupeSet, isSignalingEnvelope, type SignalingChannel } from './types';

/** Blob format version, so a future change can be detected rather than mis-parsed. */
const BLOB_VERSION = 1;
/** Hard cap on the outbox. Offer + ~20 ICE candidates is the realistic worst case. */
const MAX_OUTBOX = 64;

interface ManualBlob {
  readonly m: number;
  readonly e: readonly SignalingEnvelope[];
}

export interface ManualSignaling extends SignalingChannel {
  /** Envelopes waiting to be copied out, as one compact base64url blob. */
  outbox(): string;
  /** Paste a blob from the other player. Resolves to the number of envelopes accepted. */
  ingest(blob: string): Result<number, string>;
  onOutboxChange(listener: (blob: string) => void): Unsubscribe;
  /** Forget everything queued for copying (after the user has pasted it across). */
  clearOutbox(): void;
}

function encodeBlob(envelopes: readonly SignalingEnvelope[]): string {
  if (envelopes.length === 0) return '';
  const payload: ManualBlob = { m: BLOB_VERSION, e: envelopes };
  const json = JSON.stringify(payload);
  if (typeof TextEncoder === 'undefined') return json;
  return toBase64Url(new TextEncoder().encode(json));
}

function decodeBlob(blob: string): ManualBlob | null {
  const trimmed = blob.trim();
  if (trimmed.length === 0) return null;

  let json = '';
  if (trimmed.startsWith('{')) {
    // Tolerate a raw JSON paste as well as the compact form.
    json = trimmed;
  } else {
    const bytes = fromBase64Url(trimmed);
    if (bytes === null || typeof TextDecoder === 'undefined') return null;
    try {
      json = new TextDecoder().decode(bytes);
    } catch {
      return null;
    }
  }

  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const candidate = parsed as { m?: unknown; e?: unknown };
    if (candidate.m !== BLOB_VERSION || !Array.isArray(candidate.e)) return null;
    const envelopes: SignalingEnvelope[] = [];
    for (const entry of candidate.e) {
      if (isSignalingEnvelope(entry)) envelopes.push(entry);
    }
    return { m: BLOB_VERSION, e: envelopes };
  } catch {
    return null;
  }
}

export function createManualSignaling(): ManualSignaling {
  const pending: SignalingEnvelope[] = [];
  const seen = createDedupeSet(256);
  const envelopeListeners = new Set<(envelope: SignalingEnvelope) => void>();
  const statusListeners = new Set<(status: SignalingStatus) => void>();
  const outboxListeners = new Set<(blob: string) => void>();

  let status: SignalingStatus = 'idle';
  let room: RoomCode | null = null;
  let self: PeerId | null = null;
  let closed = false;

  function setStatus(next: SignalingStatus): void {
    if (status === next) return;
    status = next;
    for (const listener of [...statusListeners]) {
      try {
        listener(next);
      } catch {
        /* keep going */
      }
    }
  }

  function currentBlob(): string {
    return encodeBlob(pending);
  }

  function notifyOutbox(): void {
    const blob = currentBlob();
    for (const listener of [...outboxListeners]) {
      try {
        listener(blob);
      } catch {
        /* keep going */
      }
    }
  }

  return {
    name: 'manual',
    get status(): SignalingStatus {
      return status;
    },

    async open(nextRoom: RoomCode, nextSelf: PeerId): Promise<Result<void, string>> {
      if (closed) return err('manual signaling is closed');
      room = nextRoom;
      self = nextSelf;
      // Always "usable": it needs a human, not a network.
      setStatus('open');
      return ok(undefined);
    },

    async send(envelope: SignalingEnvelope): Promise<Result<void, string>> {
      if (closed) return err('manual signaling is closed');
      if (pending.some((queued) => queued.nonce === envelope.nonce)) return ok(undefined);
      pending.push(envelope);
      while (pending.length > MAX_OUTBOX) pending.shift();
      notifyOutbox();
      return ok(undefined);
    },

    onEnvelope(listener: (envelope: SignalingEnvelope) => void): Unsubscribe {
      envelopeListeners.add(listener);
      return () => {
        envelopeListeners.delete(listener);
      };
    },

    onStatus(listener: (next: SignalingStatus) => void): Unsubscribe {
      statusListeners.add(listener);
      return () => {
        statusListeners.delete(listener);
      };
    },

    outbox(): string {
      return currentBlob();
    },

    clearOutbox(): void {
      if (pending.length === 0) return;
      pending.length = 0;
      notifyOutbox();
    },

    ingest(blob: string): Result<number, string> {
      if (closed) return err('manual signaling is closed');

      const decoded = decodeBlob(blob);
      if (decoded === null) {
        return err('that does not look like a Friend Golf connection code');
      }
      if (decoded.e.length === 0) return err('the code contained no connection data');

      const now = Date.now();
      let accepted = 0;

      for (const envelope of decoded.e) {
        if (room !== null && envelope.room !== room) continue; // different room code
        if (self !== null && envelope.from === self) continue; // our own blob pasted back
        if (self !== null && envelope.to !== null && envelope.to !== self) continue;
        if (!seen.accept(envelope.nonce)) continue;

        // Re-stamp: see the note at the top of this file.
        const fresh: SignalingEnvelope = { ...envelope, ts: now };
        accepted += 1;
        for (const listener of [...envelopeListeners]) {
          try {
            listener(fresh);
          } catch {
            /* keep going */
          }
        }
      }

      if (accepted === 0) {
        return err('nothing in that code was for this room (already pasted, or wrong room code?)');
      }
      return ok(accepted);
    },

    onOutboxChange(listener: (blob: string) => void): Unsubscribe {
      outboxListeners.add(listener);
      return () => {
        outboxListeners.delete(listener);
      };
    },

    close(): void {
      if (closed) return;
      closed = true;
      setStatus('closed');
      envelopeListeners.clear();
      statusListeners.clear();
      outboxListeners.clear();
      pending.length = 0;
      seen.clear();
    },
  };
}
