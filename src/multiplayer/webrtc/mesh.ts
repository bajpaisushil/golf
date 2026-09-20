/**
 * FULL MESH of WebRTC links for one room (<= 8 players).
 *
 * ---------------------------------------------------------------------------
 * WHY A FULL MESH AND NOT A STAR AROUND THE HOST
 * ---------------------------------------------------------------------------
 * With <= 8 players the connection count (n*(n-1)/2 = 28 at most) is trivial,
 * and the payload is a handful of ~80-byte shot messages per minute - nothing
 * like a voice or video mesh. In exchange we get the property this game needs:
 * HOST AUTHORITY BECOMES PURE LOGIC. Everyone is already connected to everyone,
 * so when the host vanishes another player can simply be declared host with no
 * reconnection storm and no dropped room. That is what makes host migration
 * possible at all without a server.
 *
 * This layer is game-agnostic: it discovers peers over a {@link SignalingChannel},
 * maintains one {@link PeerLink} per peer, and moves opaque strings. It has no
 * idea what a stroke or a course is.
 *
 * GLARE: both sides compute `initiator = selfPeerId < remotePeerId` from the two
 * ids alone, so exactly one side offers and the two can never deadlock.
 */

import { LIMITS, TIMING } from '@/game/config';
import { SIGNALING_VERSION } from '@/multiplayer/protocol/version';
import { randomNonce } from '@/multiplayer/signaling/crypto';
import {
  isEnvelopeForUs,
  isEnvelopeFresh,
  type SignalingChannel,
} from '@/multiplayer/signaling/types';
import { err, ok } from '@/types';
import type {
  ConnectionState,
  MeshStats,
  PeerId,
  PeerInfo,
  Result,
  RoomIdentity,
  SignalingEnvelope,
  SignalingKind,
  Timestamp,
  Unsubscribe,
} from '@/types';
import { createPeerLink, type PeerLink } from './peerLink';

// --- Local plumbing constants. These are transport behaviour, not gameplay
// --- tuning, so they live with the code that owns them.

/** How many times a link is rebuilt before the peer is parked as unreachable. */
const MAX_LINK_ATTEMPTS = 3;
/** Backoff base between rebuild attempts (multiplied by the attempt count). */
const LINK_RETRY_BASE_MS = 1200;
/** Once everyone is connected we still announce occasionally so late joiners find us. */
const SLOW_ANNOUNCE_FACTOR = 6;
/** Grace given to a final 'bye' before the signaling channel is torn down. */
const BYE_FLUSH_MS = 150;

export interface MeshOptions {
  readonly identity: RoomIdentity;
  readonly signaling: SignalingChannel;
  /** Defaults to LIMITS.MAX_PLAYERS - 1 (everyone except us). */
  readonly maxPeers?: number;
}

export interface Mesh {
  start(): Promise<Result<void, string>>;
  broadcast(data: string): void;
  sendTo(peerId: PeerId, data: string): boolean;
  peers(): readonly PeerInfo[];
  stats(): MeshStats;
  onMessage(listener: (data: string, from: PeerId) => void): Unsubscribe;
  onPeers(listener: (peers: readonly PeerInfo[]) => void): Unsubscribe;
  /** Fires once per peer, the first time its data channel opens. */
  onPeerJoined(listener: (peer: PeerInfo) => void): Unsubscribe;
  /** Fires when a peer is dropped from the mesh for good. */
  onPeerLeft(listener: (peer: PeerInfo) => void): Unsubscribe;
  close(): void;
}

interface MeshPeerEntry {
  readonly peerId: PeerId;
  link: PeerLink;
  /** Rebuild attempts so far; reset to 0 once the link connects. */
  attempts: number;
  state: ConnectionState;
  lastError: string | null;
  lastSeenAt: Timestamp;
  joinedEmitted: boolean;
  retryTimer: ReturnType<typeof setTimeout> | null;
  removeTimer: ReturnType<typeof setTimeout> | null;
  lastAnnounceReplyAt: Timestamp;
}

/** Deterministic, symmetric glare rule - both browsers compute the same answer. */
function isInitiator(self: PeerId, remote: PeerId): boolean {
  return (self as string) < (remote as string);
}

/** UTF-8 size for stats. Falls back to code-unit length where TextEncoder is missing. */
function byteSize(data: string): number {
  if (typeof TextEncoder === 'undefined') return data.length;
  return new TextEncoder().encode(data).length;
}

function createEmitter<T extends readonly unknown[]>(): {
  add: (listener: (...args: T) => void) => Unsubscribe;
  emit: (...args: T) => void;
  clear: () => void;
} {
  const listeners = new Set<(...args: T) => void>();
  return {
    add(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit(...args) {
      for (const listener of [...listeners]) {
        try {
          listener(...args);
        } catch {
          // One bad listener must never take the mesh down.
        }
      }
    },
    clear() {
      listeners.clear();
    },
  };
}

/** Extra announce times (ms after start) that make joining feel immediate. */
const EARLY_ANNOUNCE_MS: readonly number[] = [400, 1100, 2200, 3500];

export function createMesh(options: MeshOptions): Mesh {
  const { identity, signaling } = options;
  const maxPeers = options.maxPeers ?? LIMITS.MAX_PLAYERS - 1;

  const entries = new Map<PeerId, MeshPeerEntry>();
  const messageEmitter = createEmitter<[string, PeerId]>();
  const peersEmitter = createEmitter<[readonly PeerInfo[]]>();
  const joinEmitter = createEmitter<[PeerInfo]>();
  const leaveEmitter = createEmitter<[PeerInfo]>();

  let started = false;
  let closed = false;
  let announceTimer: ReturnType<typeof setInterval> | null = null;
  /** Early-burst announce timers, cleared on close so nothing fires after teardown. */
  const earlyTimers: ReturnType<typeof setTimeout>[] = [];
  let ticks = 0;
  let unsubEnvelope: Unsubscribe | null = null;
  let unsubStatus: Unsubscribe | null = null;

  let messagesSent = 0;
  let messagesReceived = 0;
  let bytesSent = 0;
  let bytesReceived = 0;

  // -------------------------------------------------------------------------
  // Signaling helpers
  // -------------------------------------------------------------------------

  function makeEnvelope(kind: SignalingKind, payload: string, to: PeerId | null): SignalingEnvelope {
    return {
      v: SIGNALING_VERSION,
      room: identity.roomCode,
      from: identity.peerId,
      to,
      kind,
      payload,
      ts: Date.now(),
      nonce: randomNonce(),
    };
  }

  async function publish(envelope: SignalingEnvelope): Promise<void> {
    try {
      await signaling.send(envelope);
    } catch {
      // Signaling is best-effort by design: we re-announce on a timer.
    }
  }

  /** Extra announce times (ms after start) that make joining feel immediate. */
  function announce(): void {
    if (closed) return;
    void publish(makeEnvelope('announce', '', null));
  }

  // -------------------------------------------------------------------------
  // Peer bookkeeping
  // -------------------------------------------------------------------------

  function infoFor(entry: MeshPeerEntry): PeerInfo {
    return {
      ...entry.link.info(),
      state: entry.state,
      lastSeenAt: entry.lastSeenAt,
      lastError: entry.lastError,
    };
  }

  function snapshot(): readonly PeerInfo[] {
    return [...entries.values()].map(infoFor);
  }

  function emitPeers(): void {
    peersEmitter.emit(snapshot());
  }

  function connectedCount(): number {
    let count = 0;
    for (const entry of entries.values()) if (entry.state === 'connected') count += 1;
    return count;
  }

  function hasPendingLink(): boolean {
    for (const entry of entries.values()) if (entry.state !== 'connected') return true;
    return false;
  }

  function buildLink(peerId: PeerId): PeerLink {
    return createPeerLink({
      selfPeerId: identity.peerId,
      remotePeerId: peerId,
      initiator: isInitiator(identity.peerId, peerId),
      onSignal: (kind, payload) => {
        void publish(makeEnvelope(kind, payload, peerId));
      },
      onMessage: (data) => {
        const entry = entries.get(peerId);
        if (entry !== undefined) entry.lastSeenAt = Date.now();
        messagesReceived += 1;
        bytesReceived += byteSize(data);
        messageEmitter.emit(data, peerId);
      },
      onStateChange: (state, error) => {
        handleLinkState(peerId, state, error);
      },
    });
  }

  function clearTimers(entry: MeshPeerEntry): void {
    if (entry.retryTimer !== null) {
      clearTimeout(entry.retryTimer);
      entry.retryTimer = null;
    }
    if (entry.removeTimer !== null) {
      clearTimeout(entry.removeTimer);
      entry.removeTimer = null;
    }
  }

  function createEntry(peerId: PeerId): MeshPeerEntry {
    const entry: MeshPeerEntry = {
      peerId,
      link: buildLink(peerId),
      attempts: 1,
      state: 'idle',
      lastError: null,
      lastSeenAt: Date.now(),
      joinedEmitted: false,
      retryTimer: null,
      removeTimer: null,
      lastAnnounceReplyAt: 0,
    };
    entries.set(peerId, entry);
    void entry.link.start();
    emitPeers();
    return entry;
  }

  /** Throws the old link away and negotiates from scratch (renegotiation / recovery). */
  function rebuild(entry: MeshPeerEntry): MeshPeerEntry {
    clearTimers(entry);
    entry.link.close('rebuilding link');
    entry.attempts += 1;
    entry.state = 'idle';
    entry.joinedEmitted = false;
    entry.link = buildLink(entry.peerId);
    void entry.link.start();
    // Nudge the other side so it rebuilds too, otherwise it would keep talking
    // to a connection we have already thrown away.
    void publish(makeEnvelope('announce', '', entry.peerId));
    emitPeers();
    return entry;
  }

  /**
   * Finds or creates the entry for a peer.
   * Returns null when the room is full or the peer has exhausted its attempts.
   */
  function ensurePeer(peerId: PeerId): MeshPeerEntry | null {
    const existing = entries.get(peerId);
    if (existing !== undefined) {
      const dead = existing.state === 'failed' || existing.state === 'closed';
      if (dead && existing.attempts < MAX_LINK_ATTEMPTS) return rebuild(existing);
      return dead ? null : existing;
    }
    if (entries.size >= maxPeers) return null;
    return createEntry(peerId);
  }

  function removePeer(peerId: PeerId, reason: string): void {
    const entry = entries.get(peerId);
    if (entry === undefined) return;
    entries.delete(peerId);
    clearTimers(entry);
    const info = infoFor(entry);
    entry.link.close(reason);
    if (entry.joinedEmitted) leaveEmitter.emit(info);
    emitPeers();
  }

  function scheduleRecovery(entry: MeshPeerEntry): void {
    if (closed || entry.retryTimer !== null) return;

    if (entry.attempts < MAX_LINK_ATTEMPTS) {
      const delay = LINK_RETRY_BASE_MS * entry.attempts;
      entry.retryTimer = setTimeout(() => {
        entry.retryTimer = null;
        if (closed) return;
        if (entries.get(entry.peerId) !== entry) return;
        rebuild(entry);
      }, delay);
      return;
    }

    // Out of attempts: hold the slot for the reconnect grace window so a player
    // who is reloading the page keeps their place, then drop them.
    if (entry.removeTimer === null) {
      entry.removeTimer = setTimeout(() => {
        entry.removeTimer = null;
        removePeer(entry.peerId, 'peer unreachable');
      }, TIMING.RECONNECT_GRACE_MS);
    }
  }

  function handleLinkState(peerId: PeerId, state: ConnectionState, error?: string): void {
    const entry = entries.get(peerId);
    if (entry === undefined) return;

    entry.state = state;
    if (error !== undefined) entry.lastError = error;

    if (state === 'connected') {
      entry.attempts = 0;
      entry.lastSeenAt = Date.now();
      clearTimers(entry);
      if (!entry.joinedEmitted) {
        entry.joinedEmitted = true;
        joinEmitter.emit(infoFor(entry));
      }
    } else if (state === 'failed' || state === 'disconnected') {
      scheduleRecovery(entry);
    }

    emitPeers();
  }

  // -------------------------------------------------------------------------
  // Inbound signaling
  // -------------------------------------------------------------------------

  function handleEnvelope(envelope: SignalingEnvelope): void {
    if (closed) return;
    // Defence in depth: adapters filter too, but envelopes come from public
    // relays, so nothing reaches WebRTC without being checked here as well.
    if (envelope.v !== SIGNALING_VERSION) return;
    if (envelope.room !== identity.roomCode) return;
    if (!isEnvelopeForUs(envelope, identity.peerId)) return;
    if (!isEnvelopeFresh(envelope, Date.now())) return;

    const from = envelope.from;

    if (envelope.kind === 'bye') {
      removePeer(from, 'peer said goodbye');
      return;
    }

    const entry = ensurePeer(from);
    if (entry === null) return; // room full, or this peer is parked as unreachable

    if (envelope.kind === 'announce') {
      // Reply directly so they learn about us even if our own broadcast was
      // dropped by every relay. Rate limited so two peers cannot ping-pong.
      if (envelope.to === null) {
        const now = Date.now();
        if (now - entry.lastAnnounceReplyAt >= TIMING.SIGNALING_ANNOUNCE_MS) {
          entry.lastAnnounceReplyAt = now;
          void publish(makeEnvelope('announce', '', from));
        }
      }
      return;
    }

    void entry.link.acceptSignal(envelope.kind, envelope.payload);
  }

  function tick(): void {
    if (closed) return;
    ticks += 1;
    const full = entries.size >= maxPeers && !hasPendingLink();
    if (full) return;
    const urgent = connectedCount() === 0 || hasPendingLink();
    if (urgent || ticks % SLOW_ANNOUNCE_FACTOR === 0) announce();
  }

  // -------------------------------------------------------------------------
  // Public surface
  // -------------------------------------------------------------------------

  async function start(): Promise<Result<void, string>> {
    if (closed) return err('mesh is closed');
    if (started) return ok(undefined);
    if (typeof window === 'undefined') return err('the mesh needs a browser (WebRTC)');
    if (typeof RTCPeerConnection === 'undefined') {
      return err('this browser does not support WebRTC');
    }

    started = true;
    unsubEnvelope = signaling.onEnvelope(handleEnvelope);
    unsubStatus = signaling.onStatus((status) => {
      // Status is read live from the channel in stats(); this subscription also
      // keeps the UI updating when signaling health changes.
      emitPeers();

      // A relay that finishes connecting AFTER our first announce would never
      // have seen it, and we would sit waiting for the next 4s tick — which is
      // most of why joining a room used to feel like it hung for 10-20 seconds.
      // Re-announce the moment a backend comes up.
      if (status === 'open' && !closed && connectedCount() < maxPeers) announce();
    });

    const opened = await signaling.open(identity.roomCode, identity.peerId);
    if (!opened.ok) {
      started = false;
      unsubEnvelope?.();
      unsubStatus?.();
      unsubEnvelope = null;
      unsubStatus = null;
      return err(opened.error);
    }

    // Early burst. Relays accept a subscription slightly before they start
    // delivering, and a joiner arriving between two ticks should not wait a full
    // interval to be noticed. These are tiny messages, so a few extra are cheap.
    announce();
    for (const delay of EARLY_ANNOUNCE_MS) {
      const timer = setTimeout(() => {
        if (!closed && connectedCount() < maxPeers) announce();
      }, delay);
      earlyTimers.push(timer);
    }

    announceTimer = setInterval(tick, TIMING.SIGNALING_ANNOUNCE_MS);
    return ok(undefined);
  }

  function broadcast(data: string): void {
    if (closed) return;
    const size = byteSize(data);
    for (const entry of entries.values()) {
      if (entry.link.send(data)) {
        messagesSent += 1;
        bytesSent += size;
      }
    }
  }

  function sendTo(peerId: PeerId, data: string): boolean {
    if (closed) return false;
    const entry = entries.get(peerId);
    if (entry === undefined) return false;
    const sent = entry.link.send(data);
    if (sent) {
      messagesSent += 1;
      bytesSent += byteSize(data);
    }
    return sent;
  }

  function stats(): MeshStats {
    return {
      selfPeerId: identity.peerId,
      peers: snapshot(),
      connectedCount: connectedCount(),
      signaling: signaling.status,
      messagesSent,
      messagesReceived,
      bytesSent,
      bytesReceived,
    };
  }

  function close(): void {
    if (closed) return;
    closed = true;

    if (announceTimer !== null) {
      clearInterval(announceTimer);
      announceTimer = null;
    }
    while (earlyTimers.length > 0) {
      const timer = earlyTimers.pop();
      if (timer !== undefined) clearTimeout(timer);
    }

    // Tell the room we are going before the links die, so nobody waits out the
    // reconnect grace window for a player who left on purpose.
    const bye: SignalingEnvelope = {
      v: SIGNALING_VERSION,
      room: identity.roomCode,
      from: identity.peerId,
      to: null,
      kind: 'bye',
      payload: '',
      ts: Date.now(),
      nonce: randomNonce(),
    };

    let signalingClosed = false;
    const closeSignaling = (): void => {
      if (signalingClosed) return;
      signalingClosed = true;
      unsubEnvelope?.();
      unsubStatus?.();
      unsubEnvelope = null;
      unsubStatus = null;
      try {
        signaling.close();
      } catch {
        /* already gone */
      }
    };

    if (started) {
      void signaling.send(bye).then(closeSignaling, closeSignaling);
      setTimeout(closeSignaling, BYE_FLUSH_MS);
    } else {
      closeSignaling();
    }

    for (const entry of entries.values()) {
      clearTimers(entry);
      entry.link.close('mesh closed');
    }
    entries.clear();
    emitPeers();

    messageEmitter.clear();
    peersEmitter.clear();
    joinEmitter.clear();
    leaveEmitter.clear();
  }

  return {
    start,
    broadcast,
    sendTo,
    peers: snapshot,
    stats,
    onMessage: messageEmitter.add,
    onPeers: peersEmitter.add,
    onPeerJoined: joinEmitter.add,
    onPeerLeft: leaveEmitter.add,
    close,
  };
}
