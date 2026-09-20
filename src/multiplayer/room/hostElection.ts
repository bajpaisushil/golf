/**
 * HOST ELECTION - deterministic, coordination-free successor selection.
 *
 * This game has no server, so exactly one peer plays the role of authority: it
 * resolves shots, assigns hole-out order, computes scores and hands out state
 * snapshots. When that peer's tab closes, someone has to take over WITHOUT a
 * negotiation round-trip - the mesh is already fully connected, so a negotiation
 * would just be a slower way of computing something everybody can compute alone.
 *
 * THE RULE (every peer applies it to its own membership list and gets the same
 * answer, because both inputs are replicated state):
 *
 *   1. only CONNECTED players are candidates,
 *   2. lowest `joinSeq` wins - the longest-present player is the most likely to
 *      hold complete state,
 *   3. ties break on `PlayerId` string comparison, which is total and stable.
 *
 * Two peers can therefore never crown different hosts from the same membership
 * list. Where lists momentarily DIFFER (one peer saw a disconnect a heartbeat
 * earlier than another) the winner announces itself with `HOST_CHANGED` carrying
 * a monotonically increasing term, and the highest term wins - see
 * `protocol/sequencer.ts` for where the term comes from.
 *
 * TRUST MODEL: this is a CASUAL, host-authoritative, friends-only game. Any peer
 * that claims the host role is believed. It is NOT cheat-proof and is not meant
 * to be. The seam is deliberate: replace the elected host with a dedicated
 * authoritative server and NOT ONE BYTE of the protocol changes - the server
 * simply becomes the peer that always wins the election.
 */

import { TIMING } from '@/game/config';
import type { GameState, PlayerId, PlayerState, Timestamp } from '@/types';

// ---------------------------------------------------------------------------
// The election
// ---------------------------------------------------------------------------

/**
 * Total order over candidates: lower `joinSeq` first, then lower id.
 * Returns a negative number when `a` should be host ahead of `b`.
 */
function compareCandidates(a: PlayerState, b: PlayerState): number {
  if (a.joinSeq !== b.joinSeq) return a.joinSeq - b.joinSeq;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

/**
 * The host every peer agrees on, or `null` when nobody is connected.
 *
 * Pure and total: same list in, same answer out, on every device, with no
 * messages exchanged.
 */
export function electHost(players: readonly PlayerState[]): PlayerId | null {
  let best: PlayerState | null = null;
  for (const player of players) {
    if (!player.connected) continue;
    if (best === null || compareCandidates(player, best) < 0) best = player;
  }
  return best === null ? null : best.id;
}

/**
 * The full candidate order, host-first. Useful for the diagnostics panel and for
 * picking a successor when the current host leaves gracefully.
 */
export function hostSuccession(players: readonly PlayerState[]): readonly PlayerId[] {
  return players
    .filter((player) => player.connected)
    .slice()
    .sort(compareCandidates)
    .map((player) => player.id);
}

/** True when `self` should claim the host role right now. */
export function shouldClaimHost(players: readonly PlayerState[], self: PlayerId): boolean {
  return electHost(players) === self;
}

/**
 * Is `selfId` the host according to this state?
 *
 * Reads the replicated `hostPlayerId` rather than re-running the election: while
 * a `HOST_CHANGED` is still propagating, the announced host is the right answer
 * even on a peer whose membership list would elect somebody else.
 */
export function isHost(state: GameState, selfId: PlayerId): boolean {
  return state.hostPlayerId === selfId;
}

/**
 * Ordered, de-duplicated player list read straight out of `GameState`.
 * `playerOrder` is the canonical join order; anything it points at that is
 * missing from the map is skipped rather than trusted.
 */
export function playersOf(state: GameState): readonly PlayerState[] {
  const seen = new Set<PlayerId>();
  const players: PlayerState[] = [];
  for (const id of state.playerOrder) {
    if (seen.has(id)) continue;
    const player = state.players[id];
    if (player === undefined) continue;
    seen.add(id);
    players.push(player);
  }
  return players;
}

/** The host `state` would elect if the election ran right now. */
export function electHostFor(state: GameState): PlayerId | null {
  return electHost(playersOf(state));
}

// ---------------------------------------------------------------------------
// Watchdog
// ---------------------------------------------------------------------------

export interface HostWatchdog {
  /** Record host traffic (any message from the host, not just HEARTBEAT). */
  noteHostSeen(at: Timestamp): void;
  /**
   * Drive from the heartbeat tick. Returns `'elect'` exactly once per timeout
   * window: firing re-arms the watchdog for another full window, so a failed
   * election retries on a schedule instead of storming the mesh.
   */
  tick(now: Timestamp): 'ok' | 'elect';
  /** Arm (or re-arm) the watchdog, e.g. after adopting a new host. */
  reset(now: Timestamp): void;
  /** Milliseconds since the last host sighting; `null` while disarmed. */
  silenceFor(now: Timestamp): number | null;
  /** Stop firing until the next `reset`/`noteHostSeen`. */
  disarm(): void;
}

export interface HostWatchdogOptions {
  /** Silence before an election. Defaults to `TIMING.HOST_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
}

/**
 * Tracks how long the host has been silent.
 *
 * Deliberately timer-free: `RoomSession` already runs one heartbeat interval and
 * drives this from it, so there is exactly one timer in the whole room layer and
 * tests can step it by hand.
 */
export function createHostWatchdog(options?: HostWatchdogOptions): HostWatchdog {
  const timeoutMs =
    options !== undefined && typeof options.timeoutMs === 'number' && options.timeoutMs > 0
      ? options.timeoutMs
      : TIMING.HOST_TIMEOUT_MS;

  let lastSeen = 0;
  let armed = false;

  return {
    noteHostSeen(at: Timestamp): void {
      if (!Number.isFinite(at)) return;
      if (at > lastSeen) lastSeen = at;
      armed = true;
    },

    tick(now: Timestamp): 'ok' | 'elect' {
      if (!armed) return 'ok';
      if (now - lastSeen < timeoutMs) return 'ok';
      // Re-arm from NOW so the next election is a full window away.
      lastSeen = now;
      return 'elect';
    },

    reset(now: Timestamp): void {
      lastSeen = now;
      armed = true;
    },

    silenceFor(now: Timestamp): number | null {
      return armed ? now - lastSeen : null;
    },

    disarm(): void {
      armed = false;
    },
  };
}
