/**
 * HEARTBEAT + LIVENESS.
 *
 * Three jobs, one timer:
 *
 *  1. LIVENESS. Every peer broadcasts `HEARTBEAT` on `TIMING.HEARTBEAT_MS`. The
 *     host's heartbeats are what the host watchdog watches: `HOST_TIMEOUT_MS` of
 *     silence from the host starts an election (see `hostElection.ts`). Everyone
 *     else's heartbeats let the host notice a player who dropped without a
 *     graceful goodbye - a closed laptop lid sends no `bye`.
 *  2. LATENCY. `PING` goes out on `TIMING.PING_INTERVAL_MS`; whoever receives it
 *     answers `PONG` with the same nonce, and the round trip drives the latency
 *     pill in the UI. Cosmetic only - nothing in the game logic reads it.
 *  3. CADENCE. `onTick` lets `RoomSession` hang its periodic work (host watchdog,
 *     membership sweep, STATE_SYNC) off this one timer instead of starting three
 *     more.
 *
 * INJECTABLE CLOCK: everything timed goes through {@link HeartbeatClock}, so a
 * test can drive hours of room life synchronously with {@link createManualClock}
 * and never touch a real timer. The default clock is the only place in this
 * module that reads `Date.now()` / `setInterval` - both are fine here, this is
 * network presentation, not simulation.
 */

import { TIMING } from '@/game/config';
import type { GameStatus, Millis, PlayerId, Timestamp, Unsubscribe } from '@/types';

import type { NetMessage } from '@/multiplayer/protocol/messages';
import type { Sequencer } from '@/multiplayer/protocol/sequencer';

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------

export interface HeartbeatTimer {
  cancel(): void;
}

export interface HeartbeatClock {
  now(): Timestamp;
  setInterval(fn: () => void, ms: Millis): HeartbeatTimer;
}

/** Real time. Safe during SSR: `start()` is only ever called from the client. */
export const systemClock: HeartbeatClock = {
  now: () => Date.now(),
  setInterval(fn: () => void, ms: Millis): HeartbeatTimer {
    const handle: ReturnType<typeof setInterval> = setInterval(fn, ms);
    return {
      cancel(): void {
        clearInterval(handle);
      },
    };
  },
};

export interface ManualClock extends HeartbeatClock {
  /** Step time forward, firing every interval that falls due, in order. */
  advance(ms: Millis): void;
  /** Jump to an absolute time (must not go backwards). */
  set(at: Timestamp): void;
}

interface ManualEntry {
  readonly fn: () => void;
  readonly everyMs: number;
  dueAt: number;
  cancelled: boolean;
}

/**
 * Deterministic clock for tests: no real timers, no waiting.
 * A safety cap stops a zero/negative interval from looping forever.
 */
export function createManualClock(startAt: Timestamp = 0): ManualClock {
  let current = startAt;
  const entries: ManualEntry[] = [];
  const MAX_FIRINGS_PER_ADVANCE = 100000;

  function runUntil(target: number): void {
    let firings = 0;
    for (;;) {
      let next: ManualEntry | null = null;
      for (const entry of entries) {
        if (entry.cancelled) continue;
        if (entry.dueAt > target) continue;
        if (next === null || entry.dueAt < next.dueAt) next = entry;
      }
      if (next === null) break;
      firings += 1;
      if (firings > MAX_FIRINGS_PER_ADVANCE) break;
      current = next.dueAt;
      next.dueAt += next.everyMs;
      next.fn();
    }
    current = target;
  }

  return {
    now: () => current,
    setInterval(fn: () => void, ms: Millis): HeartbeatTimer {
      const everyMs = ms > 0 ? ms : 1;
      const entry: ManualEntry = { fn, everyMs, dueAt: current + everyMs, cancelled: false };
      entries.push(entry);
      return {
        cancel(): void {
          entry.cancelled = true;
        },
      };
    },
    advance(ms: Millis): void {
      runUntil(current + Math.max(0, ms));
    },
    set(at: Timestamp): void {
      runUntil(Math.max(current, at));
    },
  };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface HeartbeatService {
  start(): void;
  stop(): void;
  /** True between `start()` and `stop()`. */
  isRunning(): boolean;
  /** Feed every inbound message: refreshes lastSeen, answers PING, records RTT. */
  handle(message: NetMessage): void;
  /** Record a sighting by hand, e.g. when a peer link opens before any message. */
  noteSeen(player: PlayerId, at: Timestamp): void;
  /** Drop all bookkeeping for a player who left for good. */
  forget(player: PlayerId): void;
  lastSeen(player: PlayerId): Timestamp | null;
  rtt(player: PlayerId): Millis | null;
  /** Players we have heard from, but not within `thresholdMs`. */
  staleSince(now: Timestamp, thresholdMs: Millis): readonly PlayerId[];
  /** Send a heartbeat immediately, outside the schedule. */
  beatNow(): void;
  onTick(listener: () => void): Unsubscribe;
}

export interface HeartbeatOptions {
  /** How the service puts a message on the wire (RoomSession broadcasts it). */
  readonly send: (message: NetMessage) => void;
  /** Envelope stamper, so heartbeats share the room's single outbound counter. */
  readonly stamp: Sequencer['stamp'];
  readonly self: PlayerId;
  readonly getStatus: () => GameStatus;
  readonly getStateVersion: () => number;
  readonly isHost: () => boolean;
  /** Injectable clock. Defaults to {@link systemClock}. */
  readonly clock?: HeartbeatClock;
  /** Override the heartbeat cadence. Defaults to `TIMING.HEARTBEAT_MS`. */
  readonly heartbeatMs?: Millis;
  /** Override the ping cadence. Defaults to `TIMING.PING_INTERVAL_MS`. */
  readonly pingIntervalMs?: Millis;
}

/** Monotonic part of a PING nonce, so two pings in the same millisecond differ. */
let nonceCounter = 0;

function newNonce(): string {
  nonceCounter = (nonceCounter + 1) % 0xffffff;
  const random = Math.floor(Math.random() * 0xffffff);
  return `${nonceCounter.toString(36)}.${random.toString(36)}`;
}

export function createHeartbeat(options: HeartbeatOptions): HeartbeatService {
  const clock = options.clock ?? systemClock;
  const heartbeatMs =
    typeof options.heartbeatMs === 'number' && options.heartbeatMs > 0
      ? options.heartbeatMs
      : TIMING.HEARTBEAT_MS;
  const pingIntervalMs =
    typeof options.pingIntervalMs === 'number' && options.pingIntervalMs > 0
      ? options.pingIntervalMs
      : TIMING.PING_INTERVAL_MS;

  /** Last time we heard ANYTHING from a player. */
  const lastSeenAt = new Map<PlayerId, Timestamp>();
  /** Most recent round-trip sample per player. */
  const rttMs = new Map<PlayerId, Millis>();
  /**
   * PINGs we sent that may still be answered, keyed by nonce.
   * Entries are NOT deleted on first use: one broadcast PING is answered by
   * every peer, and each of those PONGs must resolve against the same send time.
   */
  const pending = new Map<string, Timestamp>();

  const tickListeners = new Set<() => void>();

  let beatTimer: HeartbeatTimer | null = null;
  let pingTimer: HeartbeatTimer | null = null;
  let running = false;

  function sendHeartbeat(): void {
    options.send(
      options.stamp<'HEARTBEAT'>({
        type: 'HEARTBEAT',
        status: options.getStatus(),
        stateVersion: options.getStateVersion(),
        isHost: options.isHost(),
      }),
    );
  }

  function onBeat(): void {
    sendHeartbeat();
    // Listener failures must never kill the timer - one broken subscriber would
    // otherwise silence the whole room.
    for (const listener of Array.from(tickListeners)) {
      try {
        listener();
      } catch {
        // Swallowed on purpose: liveness outranks any single subscriber.
      }
    }
  }

  function prunePending(now: Timestamp): void {
    const horizon = now - pingIntervalMs * 4;
    for (const [nonce, sentAt] of pending) {
      if (sentAt < horizon) pending.delete(nonce);
    }
  }

  function onPing(): void {
    const now = clock.now();
    prunePending(now);
    const nonce = newNonce();
    pending.set(nonce, now);
    options.send(options.stamp<'PING'>({ type: 'PING', nonce }));
  }

  return {
    start(): void {
      if (running) return;
      running = true;
      beatTimer = clock.setInterval(onBeat, heartbeatMs);
      pingTimer = clock.setInterval(onPing, pingIntervalMs);
      // Announce ourselves immediately so a peer that just connected does not
      // wait a whole interval before it can see us.
      sendHeartbeat();
    },

    stop(): void {
      running = false;
      if (beatTimer !== null) beatTimer.cancel();
      if (pingTimer !== null) pingTimer.cancel();
      beatTimer = null;
      pingTimer = null;
      pending.clear();
      // lastSeenAt survives: the reconnect grace window is measured against it.
    },

    isRunning(): boolean {
      return running;
    },

    handle(message: NetMessage): void {
      if (message.from === options.self) return;
      const now = clock.now();
      lastSeenAt.set(message.from, now);

      if (message.type === 'PING') {
        // Answer immediately, echoing the sender's nonce and send time so the
        // sender can measure the round trip without trusting our clock.
        options.send(
          options.stamp<'PONG'>({ type: 'PONG', nonce: message.nonce, pingTs: message.ts }),
        );
        return;
      }

      if (message.type === 'PONG') {
        const sentAt = pending.get(message.nonce);
        const base = sentAt ?? (Number.isFinite(message.pingTs) ? message.pingTs : null);
        if (base === null) return;
        const sample = now - base;
        if (sample >= 0 && Number.isFinite(sample)) rttMs.set(message.from, sample);
      }
    },

    noteSeen(player: PlayerId, at: Timestamp): void {
      if (!Number.isFinite(at)) return;
      const current = lastSeenAt.get(player);
      if (current === undefined || at > current) lastSeenAt.set(player, at);
    },

    forget(player: PlayerId): void {
      lastSeenAt.delete(player);
      rttMs.delete(player);
    },

    lastSeen(player: PlayerId): Timestamp | null {
      const seen = lastSeenAt.get(player);
      return seen === undefined ? null : seen;
    },

    rtt(player: PlayerId): Millis | null {
      const sample = rttMs.get(player);
      return sample === undefined ? null : sample;
    },

    staleSince(now: Timestamp, thresholdMs: Millis): readonly PlayerId[] {
      const stale: PlayerId[] = [];
      for (const [player, seen] of lastSeenAt) {
        if (player === options.self) continue;
        if (now - seen > thresholdMs) stale.push(player);
      }
      return stale;
    },

    beatNow(): void {
      sendHeartbeat();
    },

    onTick(listener: () => void): Unsubscribe {
      tickListeners.add(listener);
      return () => {
        tickListeners.delete(listener);
      };
    },
  };
}
