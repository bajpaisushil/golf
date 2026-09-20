/**
 * IN-MEMORY TRANSPORT with deterministic fault injection.
 *
 * This is how the whole multiplayer stack is tested without a browser, a
 * network or a second machine: spin up a hub, ask it for a Transport per
 * player, and run 2-8 players of real game logic against each other inside one
 * vitest process.
 *
 * It is not a toy stand-in. Real peer connections lose packets, deliver them
 * twice, deliver them out of order, stall for a second, and go away entirely
 * when someone closes a laptop - and every one of those is a bug factory for a
 * lockstep protocol. So all of them are reproducible here:
 *
 *   hub.configure({ latencyMs: 80, jitterMs: 40, dropRate: 0.02,
 *                   duplicateRate: 0.05, reorderRate: 0.1 });
 *   hub.partition(alice, bob);     // network split
 *   hub.setOnline(host, false);    // host disconnect / host migration test
 *   hub.advance(500);              // move virtual time, deliver what is due
 *   hub.flush();                   // deliver everything still queued
 *
 * DETERMINISM: every random decision comes from a seeded PRNG and time comes
 * from an injectable clock that does not move unless a test moves it. The same
 * seed and the same calls produce the same delivery order, every run, on every
 * machine - so a failing test is a failing test, not a coin toss.
 *
 * (This file is test/dev infrastructure and is never part of the deterministic
 * game simulation, so Math.imul and friends are free to be used here.)
 */

import type { NetMessage } from '@/multiplayer/protocol/messages';
import { asPeerId, ok } from '@/types';
import type { PeerId, PeerInfo, PlayerId, Result, Timestamp, Unsubscribe } from '@/types';
import { decodeFrame, encodeFrame, type Transport } from './types';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface LoopbackFaults {
  /** Fixed one-way delay in ms applied to every frame. */
  readonly latencyMs: number;
  /** Extra uniform random delay in [0, jitterMs]. */
  readonly jitterMs: number;
  /** Probability in [0,1] that a frame is silently lost. */
  readonly dropRate: number;
  /** Probability in [0,1] that a frame is delivered twice. */
  readonly duplicateRate: number;
  /** Probability in [0,1] that a frame is pushed behind later frames. */
  readonly reorderRate: number;
  /** Extra delay applied to a reordered frame. */
  readonly reorderDelayMs: number;
}

export const NO_FAULTS: LoopbackFaults = {
  latencyMs: 0,
  jitterMs: 0,
  dropRate: 0,
  duplicateRate: 0,
  reorderRate: 0,
  reorderDelayMs: 120,
};

/** A hostile-but-survivable profile: roughly a bad mobile connection. */
export const FLAKY_FAULTS: LoopbackFaults = {
  latencyMs: 90,
  jitterMs: 60,
  dropRate: 0.03,
  duplicateRate: 0.04,
  reorderRate: 0.08,
  reorderDelayMs: 150,
};

export interface LoopbackStats {
  readonly sent: number;
  readonly delivered: number;
  readonly dropped: number;
  readonly duplicated: number;
  readonly reordered: number;
  /** Frames rejected by isNetMessage() or the size cap. */
  readonly rejected: number;
  readonly queued: number;
}

/**
 * 'manual' (the default) means virtual time: nothing is delivered late until a
 * test calls advance() or flush(), and no timers are ever created.
 * 'real' uses Date.now() and a single setTimeout, for running the app in one
 * tab without WebRTC.
 */
export type LoopbackClock = 'manual' | 'real' | (() => number);

export interface LoopbackHubOptions {
  /** PRNG seed. Same seed + same calls = same delivery order, always. */
  readonly seed?: number;
  readonly clock?: LoopbackClock;
  /** Deliver due frames as soon as they are sent (default true). */
  readonly autoFlush?: boolean;
  readonly faults?: Partial<LoopbackFaults>;
}

export interface LoopbackHub {
  transportFor(playerId: PlayerId): Transport;
  /** Deterministic test helper: deliver everything queued, in order, now. */
  flush(): void;
  /** Simulated one-way latency in ms (default 0). */
  setLatency(ms: number): void;
  /** Change any fault knob mid-test. */
  configure(faults: Partial<LoopbackFaults>): void;
  faults(): LoopbackFaults;
  /** Move virtual time forward and deliver whatever became due. */
  advance(ms: number): void;
  now(): Timestamp;
  /** Cut the link between two players, in both directions. */
  partition(a: PlayerId, b: PlayerId): void;
  heal(a: PlayerId, b: PlayerId): void;
  healAll(): void;
  /** Simulate a player dropping off entirely (host disconnect, closed laptop). */
  setOnline(playerId: PlayerId, online: boolean): void;
  isOnline(playerId: PlayerId): boolean;
  players(): readonly PlayerId[];
  stats(): LoopbackStats;
  /** Restart the PRNG, e.g. between cases in one test file. */
  reseed(seed: number): void;
  close(): void;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** mulberry32: small, fast, and identical on every JS engine. */
function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function clampMs(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, value);
}

function linkKey(a: PlayerId, b: PlayerId): string {
  return (a as string) < (b as string) ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

/** Stable synthetic PeerId so tests can assert on `from` without a real mesh. */
export function loopbackPeerId(playerId: PlayerId): PeerId {
  return asPeerId(`loopback:${playerId}`);
}

interface QueuedFrame {
  readonly seq: number;
  readonly from: PlayerId;
  readonly to: PlayerId;
  readonly raw: string;
  readonly dueAt: number;
}

interface RegisteredTransport extends Transport {
  /** Called by the hub when a frame is delivered to this player. */
  readonly deliver: (message: NetMessage, from: PeerId) => void;
  readonly notifyPeers: () => void;
}

/** Guard against a pathological test where handlers send forever. */
const MAX_DELIVERIES_PER_PUMP = 100_000;

export function createLoopbackHub(options?: LoopbackHubOptions): LoopbackHub {
  const clockMode: LoopbackClock = options?.clock ?? 'manual';
  const autoFlush = options?.autoFlush ?? true;

  let rng = createRng(options?.seed ?? 1);
  let faults: LoopbackFaults = { ...NO_FAULTS, ...(options?.faults ?? {}) };

  const transports = new Map<PlayerId, RegisteredTransport>();
  const partitions = new Set<string>();
  const offline = new Set<PlayerId>();
  const queue: QueuedFrame[] = [];

  let virtualNow = 0;
  let sequence = 0;
  let pumping = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  let sent = 0;
  let delivered = 0;
  let dropped = 0;
  let duplicated = 0;
  let reordered = 0;
  let rejected = 0;

  function now(): number {
    if (clockMode === 'manual') return virtualNow;
    if (typeof clockMode === 'function') return clockMode();
    return Date.now();
  }

  function reachable(from: PlayerId, to: PlayerId): boolean {
    if (from === to) return false;
    if (!transports.has(from) || !transports.has(to)) return false;
    if (offline.has(from) || offline.has(to)) return false;
    return !partitions.has(linkKey(from, to));
  }

  function notifyAllPeers(): void {
    for (const transport of [...transports.values()]) transport.notifyPeers();
  }

  /** Insert keeping the queue sorted by (dueAt, seq) - that IS the delivery order. */
  function insert(frame: QueuedFrame): void {
    let index = queue.length;
    while (index > 0) {
      const previous = queue[index - 1];
      if (previous === undefined) break;
      if (previous.dueAt < frame.dueAt) break;
      if (previous.dueAt === frame.dueAt && previous.seq < frame.seq) break;
      index -= 1;
    }
    queue.splice(index, 0, frame);
  }

  function scheduleTimer(): void {
    if (closed || !autoFlush) return;
    if (clockMode === 'manual') return; // virtual time: tests drive delivery
    const next = queue[0];
    if (next === undefined) return;
    if (timer !== null) return;
    const delay = Math.max(0, next.dueAt - now());
    timer = setTimeout(() => {
      timer = null;
      pump();
      scheduleTimer();
    }, delay);
  }

  function deliverFrame(frame: QueuedFrame): void {
    const target = transports.get(frame.to);
    if (target === undefined) {
      dropped += 1;
      return;
    }
    if (offline.has(frame.to) || offline.has(frame.from)) {
      // The player went away between send and delivery.
      dropped += 1;
      return;
    }
    const message = decodeFrame(frame.raw);
    if (message === null) {
      rejected += 1;
      return;
    }
    delivered += 1;
    target.deliver(message, loopbackPeerId(frame.from));
  }

  /** Delivers every frame that is due at the current clock reading. */
  function pump(): void {
    if (pumping || closed) return;
    pumping = true;
    try {
      let guard = 0;
      for (;;) {
        const next = queue[0];
        if (next === undefined || next.dueAt > now()) break;
        queue.shift();
        deliverFrame(next);
        guard += 1;
        if (guard >= MAX_DELIVERIES_PER_PUMP) break;
      }
    } finally {
      pumping = false;
    }
  }

  function enqueue(from: PlayerId, to: PlayerId, raw: string): void {
    if (closed) return;
    sent += 1;

    if (!reachable(from, to)) {
      dropped += 1;
      return;
    }
    if (faults.dropRate > 0 && rng() < faults.dropRate) {
      dropped += 1;
      return;
    }

    let delay = faults.latencyMs;
    if (faults.jitterMs > 0) delay += Math.floor(rng() * (faults.jitterMs + 1));
    if (faults.reorderRate > 0 && rng() < faults.reorderRate) {
      delay += faults.reorderDelayMs;
      reordered += 1;
    }

    sequence += 1;
    insert({ seq: sequence, from, to, raw, dueAt: now() + delay });

    if (faults.duplicateRate > 0 && rng() < faults.duplicateRate) {
      duplicated += 1;
      sequence += 1;
      // A duplicate arrives slightly after the original, like a real retransmit.
      const extra = faults.jitterMs > 0 ? Math.floor(rng() * (faults.jitterMs + 1)) : 0;
      insert({ seq: sequence, from, to, raw, dueAt: now() + delay + extra });
    }

    if (autoFlush) {
      pump();
      scheduleTimer();
    }
  }

  function unregister(playerId: PlayerId): void {
    if (!transports.delete(playerId)) return;
    offline.delete(playerId);
    for (const key of [...partitions]) {
      if (key.includes(playerId)) partitions.delete(key);
    }
    notifyAllPeers();
  }

  function createTransport(playerId: PlayerId): RegisteredTransport {
    const messageListeners = new Set<(message: NetMessage, from: PeerId) => void>();
    const peerListeners = new Set<(peers: readonly PeerInfo[]) => void>();
    let transportClosed = false;

    function peers(): readonly PeerInfo[] {
      const out: PeerInfo[] = [];
      for (const other of transports.keys()) {
        if (other === playerId) continue;
        out.push({
          peerId: loopbackPeerId(other),
          playerId: other,
          displayName: '',
          state: reachable(playerId, other) ? 'connected' : 'disconnected',
          isHost: false,
          rttMs: faults.latencyMs > 0 ? faults.latencyMs * 2 : 0,
          lastSeenAt: now(),
          initiator: (playerId as string) < (other as string),
          lastError: null,
        });
      }
      return out;
    }

    const transport: RegisteredTransport = {
      kind: 'loopback',
      selfId: playerId,

      async start(): Promise<Result<void, string>> {
        return ok(undefined);
      },

      broadcast(message: NetMessage): void {
        if (transportClosed || closed) return;
        const raw = encodeFrame(message);
        if (raw === null) return;
        for (const other of [...transports.keys()]) {
          if (other === playerId) continue;
          enqueue(playerId, other, raw);
        }
      },

      sendTo(target: PlayerId, message: NetMessage): boolean {
        if (transportClosed || closed) return false;
        if (!transports.has(target) || target === playerId) return false;
        if (!reachable(playerId, target)) return false;
        const raw = encodeFrame(message);
        if (raw === null) return false;
        enqueue(playerId, target, raw);
        return true;
      },

      onMessage(listener: (message: NetMessage, from: PeerId) => void): Unsubscribe {
        messageListeners.add(listener);
        return () => {
          messageListeners.delete(listener);
        };
      },

      onPeers(listener: (list: readonly PeerInfo[]) => void): Unsubscribe {
        peerListeners.add(listener);
        return () => {
          peerListeners.delete(listener);
        };
      },

      peers,

      close(): void {
        if (transportClosed) return;
        transportClosed = true;
        messageListeners.clear();
        peerListeners.clear();
        unregister(playerId);
      },

      deliver(message: NetMessage, from: PeerId): void {
        if (transportClosed) return;
        for (const listener of [...messageListeners]) {
          try {
            listener(message, from);
          } catch {
            // A throwing handler must not stop the rest of the room.
          }
        }
      },

      notifyPeers(): void {
        if (transportClosed) return;
        const snapshot = peers();
        for (const listener of [...peerListeners]) {
          try {
            listener(snapshot);
          } catch {
            /* keep going */
          }
        }
      },
    };

    return transport;
  }

  return {
    transportFor(playerId: PlayerId): Transport {
      const existing = transports.get(playerId);
      if (existing !== undefined) return existing;
      const transport = createTransport(playerId);
      transports.set(playerId, transport);
      notifyAllPeers();
      return transport;
    },

    flush(): void {
      // Deliver EVERYTHING, however far in the future it was scheduled, keeping
      // the (dueAt, seq) order. Virtual time jumps to the last delivery so a
      // later advance() still behaves sensibly. Frames that handlers send while
      // this runs join the same ordered queue and are drained by this loop -
      // the `pumping` flag stops a nested pump() from jumping the queue.
      if (pumping) return;
      pumping = true;
      try {
        let guard = 0;
        while (queue.length > 0 && guard < MAX_DELIVERIES_PER_PUMP) {
          const next = queue.shift();
          if (next === undefined) break;
          if (clockMode === 'manual' && next.dueAt > virtualNow) virtualNow = next.dueAt;
          deliverFrame(next);
          guard += 1;
        }
      } finally {
        pumping = false;
      }
    },

    setLatency(ms: number): void {
      faults = { ...faults, latencyMs: clampMs(ms) };
    },

    configure(next: Partial<LoopbackFaults>): void {
      faults = {
        latencyMs: clampMs(next.latencyMs ?? faults.latencyMs),
        jitterMs: clampMs(next.jitterMs ?? faults.jitterMs),
        dropRate: clamp01(next.dropRate ?? faults.dropRate),
        duplicateRate: clamp01(next.duplicateRate ?? faults.duplicateRate),
        reorderRate: clamp01(next.reorderRate ?? faults.reorderRate),
        reorderDelayMs: clampMs(next.reorderDelayMs ?? faults.reorderDelayMs),
      };
    },

    faults(): LoopbackFaults {
      return faults;
    },

    advance(ms: number): void {
      if (clockMode === 'manual') virtualNow += clampMs(ms);
      pump();
      scheduleTimer();
    },

    now(): Timestamp {
      return now();
    },

    partition(a: PlayerId, b: PlayerId): void {
      if (a === b) return;
      partitions.add(linkKey(a, b));
      notifyAllPeers();
    },

    heal(a: PlayerId, b: PlayerId): void {
      partitions.delete(linkKey(a, b));
      notifyAllPeers();
    },

    healAll(): void {
      if (partitions.size === 0) return;
      partitions.clear();
      notifyAllPeers();
    },

    setOnline(playerId: PlayerId, online: boolean): void {
      const wasOnline = !offline.has(playerId);
      if (wasOnline === online) return;
      if (online) offline.delete(playerId);
      else offline.add(playerId);
      notifyAllPeers();
    },

    isOnline(playerId: PlayerId): boolean {
      return transports.has(playerId) && !offline.has(playerId);
    },

    players(): readonly PlayerId[] {
      return [...transports.keys()];
    },

    stats(): LoopbackStats {
      return { sent, delivered, dropped, duplicated, reordered, rejected, queued: queue.length };
    },

    reseed(seed: number): void {
      rng = createRng(seed);
    },

    close(): void {
      if (closed) return;
      closed = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      queue.length = 0;
      for (const transport of [...transports.values()]) transport.close();
      transports.clear();
      partitions.clear();
      offline.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// Shared default hub
// ---------------------------------------------------------------------------

let defaultHub: LoopbackHub | null = null;

/**
 * The hub used when `createLoopbackTransport` is called without one, so two
 * transports created independently can still talk to each other (single-tab
 * development). Tests that want isolation should create their own hub, or call
 * {@link resetDefaultLoopbackHub} between cases.
 */
export function getDefaultLoopbackHub(): LoopbackHub {
  if (defaultHub === null) defaultHub = createLoopbackHub();
  return defaultHub;
}

export function resetDefaultLoopbackHub(): void {
  if (defaultHub !== null) defaultHub.close();
  defaultHub = null;
}

export function createLoopbackTransport(selfId: PlayerId, hub?: LoopbackHub): Transport {
  return (hub ?? getDefaultLoopbackHub()).transportFor(selfId);
}
