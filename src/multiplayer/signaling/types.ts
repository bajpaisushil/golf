/**
 * THE SIGNALING SEAM.
 *
 * WebRTC cannot bootstrap itself: two browsers must first swap a few small
 * text blobs (SDP offer/answer + ICE candidates) over ANY other channel before
 * they can talk directly. That "any other channel" is the only part of a
 * serverless P2P game that normally forces you to run a server.
 *
 * This file is the one interface that makes that part swappable. Everything
 * above it (PeerLink, Mesh, the whole game) only ever sees `SignalingChannel`,
 * so the bootstrap can be free public Nostr relays, a BroadcastChannel between
 * tabs, hand-copied text, or something that does not exist yet - without a
 * single line changing anywhere else.
 *
 * A channel moves OPAQUE envelopes. It never inspects the payload and knows
 * nothing about golf, which is what makes this module reusable in another game.
 */

import { TIMING } from '@/game/config';
import type {
  PeerId,
  Result,
  RoomCode,
  SignalingEnvelope,
  SignalingKind,
  SignalingStatus,
  Timestamp,
  Unsubscribe,
} from '@/types';

export type { SignalingEnvelope, SignalingKind, SignalingStatus } from '@/types';

/**
 * A replaceable way to exchange {@link SignalingEnvelope}s with the other
 * members of a room.
 *
 * Contract every implementation must honour:
 *  - `open()` resolves ok as soon as the channel is USABLE; a channel that can
 *    never work resolves err instead of throwing.
 *  - `send()` is fire-and-forget. It resolves err only when the envelope could
 *    not be handed off at all (channel closed, no relay reachable).
 *  - `onEnvelope` delivers envelopes addressed to us (`to === self`) or
 *    broadcast (`to === null`) ONLY, must drop our own echoes, and must dedupe
 *    by `nonce` - public relays and multi-relay fan-out both deliver twice.
 *  - `close()` is idempotent and always safe to call.
 */
export interface SignalingChannel {
  /** Stable name for diagnostics: 'nostr' | 'broadcast' | 'manual' | 'composite'. */
  readonly name: string;
  /** Current health; also pushed through onStatus. */
  readonly status: SignalingStatus;
  /** Join the room's signaling topic. Resolves once the channel is usable (or errors). */
  open(room: RoomCode, self: PeerId): Promise<Result<void, string>>;
  /** Fire-and-forget publish. Resolves err when the envelope could not be sent at all. */
  send(envelope: SignalingEnvelope): Promise<Result<void, string>>;
  /** Envelopes addressed to us or broadcast. Implementations MUST drop our own echoes and dedupe by nonce. */
  onEnvelope(listener: (envelope: SignalingEnvelope) => void): Unsubscribe;
  onStatus(listener: (status: SignalingStatus) => void): Unsubscribe;
  close(): void;
}

export type SignalingFactory = () => SignalingChannel;

// ---------------------------------------------------------------------------
// Shared validation helpers
// ---------------------------------------------------------------------------
// Envelopes arrive from PUBLIC relays, so anyone can post anything into a room
// topic. Every adapter runs inbound data through these guards before it reaches
// the WebRTC layer.

/** Every legal envelope kind. */
export const SIGNALING_KINDS: readonly SignalingKind[] = [
  'announce',
  'offer',
  'answer',
  'ice',
  'bye',
];

export function isSignalingKind(value: unknown): value is SignalingKind {
  return typeof value === 'string' && (SIGNALING_KINDS as readonly string[]).includes(value);
}

/** Structural guard for untrusted inbound data. */
export function isSignalingEnvelope(value: unknown): value is SignalingEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.v === 'number' &&
    Number.isFinite(e.v) &&
    typeof e.room === 'string' &&
    e.room.length > 0 &&
    typeof e.from === 'string' &&
    e.from.length > 0 &&
    (e.to === null || (typeof e.to === 'string' && e.to.length > 0)) &&
    isSignalingKind(e.kind) &&
    typeof e.payload === 'string' &&
    typeof e.ts === 'number' &&
    Number.isFinite(e.ts) &&
    typeof e.nonce === 'string' &&
    e.nonce.length > 0
  );
}

/**
 * Replay protection: drop envelopes that are older than the signaling TTL, and
 * also ones dated absurdly far in the future (a peer with a broken clock, or a
 * replayed blob with a forged timestamp).
 */
export function isEnvelopeFresh(
  envelope: SignalingEnvelope,
  now: Timestamp,
  ttlMs: number = TIMING.SIGNALING_TTL_MS,
): boolean {
  const age = now - envelope.ts;
  return age <= ttlMs && age >= -ttlMs;
}

/** True when this envelope is for us: broadcast, or explicitly addressed to us. */
export function isEnvelopeForUs(envelope: SignalingEnvelope, self: PeerId): boolean {
  if (envelope.from === self) return false;
  return envelope.to === null || envelope.to === self;
}

/**
 * Bounded FIFO dedupe set. Relays re-deliver, several relays deliver the same
 * event, and the composite channel merges backends - so every adapter needs
 * one. Bounded so a long session cannot grow it without limit.
 */
export interface DedupeSet {
  /** Returns true the FIRST time an id is seen, false for every repeat. */
  accept(id: string): boolean;
  clear(): void;
  readonly size: number;
}

export function createDedupeSet(capacity = 512): DedupeSet {
  const seen = new Set<string>();
  const order: string[] = [];
  return {
    accept(id: string): boolean {
      if (seen.has(id)) return false;
      seen.add(id);
      order.push(id);
      while (order.length > capacity) {
        const oldest = order.shift();
        if (oldest !== undefined) seen.delete(oldest);
      }
      return true;
    },
    clear(): void {
      seen.clear();
      order.length = 0;
    },
    get size(): number {
      return seen.size;
    },
  };
}

/** Ranked so `compositeSignaling` can report the BEST child status. */
const STATUS_RANK: Readonly<Record<SignalingStatus, number>> = {
  open: 5,
  degraded: 4,
  connecting: 3,
  idle: 2,
  closed: 1,
  error: 0,
};

/** Returns the healthiest of the given statuses ('idle' when the list is empty). */
export function bestStatus(statuses: readonly SignalingStatus[]): SignalingStatus {
  let best: SignalingStatus = 'idle';
  let bestRank = -1;
  for (const status of statuses) {
    const rank = STATUS_RANK[status];
    if (rank > bestRank) {
      bestRank = rank;
      best = status;
    }
  }
  return best;
}
