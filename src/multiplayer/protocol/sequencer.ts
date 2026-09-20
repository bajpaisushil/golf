/**
 * SEQUENCE NUMBERS + LOGICAL CLOCK.
 *
 * The user requirement this file exists for:
 *   "use sequence numbers / turn numbers to avoid duplicate or out-of-order
 *    state transitions."
 *
 * Two independent counters live here.
 *
 * 1. THE PER-SENDER SEQUENCE (`seq` on every NetMessage).
 *    Outbound: `stamp()` / `next()` hand out 1, 2, 3, ... for messages WE send.
 *    Inbound:  `accept()` gates every frame against a small sliding window kept
 *              per sender, so replaying a frame (or a mesh delivering it twice
 *              during host migration) can never apply a state transition twice.
 *              The gate is strictly increasing: a frame older than the newest we
 *              have from that sender is dropped, never re-applied out of order.
 *              PING/PONG/HEARTBEAT/HELLO bypass it (see ALWAYS_ACCEPT) because
 *              they are stateless and must work during a reconnect storm.
 *
 * 2. THE LAMPORT-ISH LOGICAL CLOCK (`clock` / `tick` / `observe`).
 *    Wall clocks disagree between browsers, so ordering room-level transitions
 *    (who is host, which election term won) by `ts` would be a race. The logical
 *    clock gives a causal order with no coordination: every peer bumps it when it
 *    emits a transition and pulls it forward when it sees a higher value from
 *    someone else, so a newly elected host always mints a term strictly greater
 *    than any term anyone has observed. `HOST_CHANGED.term` carries it on the wire.
 *
 * Determinism note: this module is NETWORK plumbing, not simulation. It may use
 * `Date.now()` (through the injectable `now`), and nothing it produces is ever
 * fed to the physics.
 */

import type { PlayerId } from '@/types';

import {
  ALWAYS_ACCEPT,
  type MessageOf,
  type NetMessage,
  type NetMessageBody,
  type NetMessageType,
} from './messages';
import { PROTOCOL_VERSION } from './version';

/**
 * How many recently seen sequence numbers we remember per sender.
 *
 * Big enough that a burst of traffic during a reconnect is still classified
 * accurately, small enough that eight peers cost a few hundred numbers total.
 * The window only sharpens DIAGNOSTICS (duplicate vs stale); the accept/reject
 * decision itself is the strictly-increasing rule and needs no window at all.
 */
const WINDOW_SIZE = 64;

/** Outcome of the inbound gate. Only `'accept'` may reach game state. */
export type AcceptVerdict =
  /** First time we have seen this sequence number from this sender. */
  | 'accept'
  /** Seen before, within the window - a retransmit or a mesh echo. */
  | 'duplicate'
  /** Older than the newest frame we hold from this sender - dropped, never re-applied. */
  | 'stale';

interface PeerRecord {
  /** Highest sequence number accepted from this sender so far. */
  highest: number;
  /** Sequence numbers accepted within `(highest - WINDOW_SIZE, highest]`. */
  readonly recent: Set<number>;
}

export interface Sequencer {
  /** Our own PlayerId; stamped into every outbound message as `from`. */
  readonly self: PlayerId;

  /**
   * Stamps the shared envelope onto a message body:
   * `{ v: PROTOCOL_VERSION, seq: ++n, from: self, ts: now() }`.
   *
   * Call sites never build an envelope themselves, so the outbound counter can
   * never desync. Gaps are legal (a stamped message that is discarded before
   * sending simply burns a number) - the inbound gate only requires INCREASING
   * sequence numbers, not contiguous ones.
   */
  stamp<K extends NetMessageType>(body: NetMessageBody<K>): MessageOf<K>;

  /** Raw outbound counter, for the rare call site that stamps by hand. */
  next(): number;

  /** Highest sequence number handed out so far (does not advance the counter). */
  peek(): number;

  /**
   * THE INBOUND GATE. `false` means drop the message without touching state.
   * Types in `ALWAYS_ACCEPT` bypass ordering but still advance the window.
   * Our own echoes (`message.from === self`) are always dropped.
   */
  accept(message: NetMessage): boolean;

  /**
   * The gate's three-state verdict, for callers that want to tell a harmless
   * retransmit ('duplicate') from a genuine ordering violation ('stale').
   * Mutating: an `'accept'` verdict records the sequence number.
   */
  classify(from: PlayerId, seq: number): AcceptVerdict;

  /** Highest sequence number accepted from `player`; 0 when we have heard nothing. */
  lastSeqFrom(player: PlayerId): number;

  /**
   * Forget inbound history so a peer that restarts its counter at 1 is not
   * rejected forever. Call it when a HELLO arrives from that player (a fresh
   * page load or a reconnect). With no argument, forgets every sender.
   * Never touches the OUTBOUND counter - restarting that would get us dropped
   * by everybody else.
   */
  reset(player?: PlayerId): void;

  /** Senders we currently hold inbound history for. */
  knownSenders(): readonly PlayerId[];

  // -- logical clock -------------------------------------------------------

  /** Current logical time. */
  clock(): number;
  /** Advance and return, before emitting a causal transition (e.g. a new election term). */
  tick(): number;
  /** Pull the clock past a value observed from a peer: `clock = max(clock, remote) + 1`. */
  observe(remote: number): number;
}

export interface SequencerOptions {
  /** Injectable wall clock so tests never depend on real time. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Override the per-sender window. Defaults to {@link WINDOW_SIZE}. */
  readonly windowSize?: number;
}

/**
 * Creates the per-connection sequencer.
 *
 * One instance per RoomSession - it is the single source of truth for both our
 * outbound numbering and the inbound duplicate gate for every peer.
 */
export function createSequencer(
  self: PlayerId,
  nowOrOptions?: (() => number) | SequencerOptions,
): Sequencer {
  const options: SequencerOptions =
    typeof nowOrOptions === 'function' ? { now: nowOrOptions } : (nowOrOptions ?? {});
  const now = options.now ?? (() => Date.now());
  const windowSize =
    typeof options.windowSize === 'number' && options.windowSize > 0
      ? Math.floor(options.windowSize)
      : WINDOW_SIZE;

  /** Our outbound counter. First message sent carries seq 1. */
  let outbound = 0;
  /** Lamport-ish logical time, see the file header. */
  let logical = 0;

  const peers = new Map<PlayerId, PeerRecord>();

  function prune(record: PeerRecord): void {
    const floor = record.highest - windowSize;
    if (floor <= 0) return;
    for (const seen of record.recent) {
      if (seen <= floor) record.recent.delete(seen);
    }
  }

  function classify(from: PlayerId, seq: number): AcceptVerdict {
    // A sequence number is always a positive integer. Anything else is a
    // malformed or hostile frame; `isNetMessage` already rejects most of these,
    // this is the second line of defence.
    if (!Number.isInteger(seq) || seq < 1) return 'stale';

    const record = peers.get(from);
    if (record === undefined) {
      peers.set(from, { highest: seq, recent: new Set<number>([seq]) });
      return 'accept';
    }

    if (seq > record.highest) {
      record.highest = seq;
      record.recent.add(seq);
      prune(record);
      return 'accept';
    }

    if (record.recent.has(seq)) return 'duplicate';
    // Older than the newest frame we hold. Ordered DataChannels make this rare;
    // it happens after host migration re-routes traffic. Dropping is correct:
    // re-applying an old transition is exactly the bug this file prevents.
    return 'stale';
  }

  return {
    self,

    stamp<K extends NetMessageType>(body: NetMessageBody<K>): MessageOf<K> {
      outbound += 1;
      // The spread produces every field of MessageOf<K>: the body supplies the
      // discriminant and payload, this supplies the envelope. TypeScript cannot
      // prove that for an unresolved K, hence the cast - it is checked by the
      // NetMessageBody<K> parameter type at every call site.
      const stamped = {
        ...body,
        v: PROTOCOL_VERSION,
        seq: outbound,
        from: self,
        ts: now(),
      };
      return stamped as unknown as MessageOf<K>;
    },

    next(): number {
      outbound += 1;
      return outbound;
    },

    peek(): number {
      return outbound;
    },

    accept(message: NetMessage): boolean {
      // Never re-apply our own traffic. A full mesh does not echo, but a
      // loopback hub (tests, single-tab dev) happily would.
      if (message.from === self) return false;

      const verdict = classify(message.from, message.seq);
      if (verdict === 'accept') return true;

      // Stateless chatter must survive a reconnect storm, where a peer's counter
      // restarted and every frame looks stale until the next HELLO resets us.
      return ALWAYS_ACCEPT.has(message.type);
    },

    classify,

    lastSeqFrom(player: PlayerId): number {
      const record = peers.get(player);
      return record === undefined ? 0 : record.highest;
    },

    reset(player?: PlayerId): void {
      if (player === undefined) peers.clear();
      else peers.delete(player);
    },

    knownSenders(): readonly PlayerId[] {
      return Array.from(peers.keys());
    },

    clock(): number {
      return logical;
    },

    tick(): number {
      logical += 1;
      return logical;
    },

    observe(remote: number): number {
      if (Number.isFinite(remote) && remote > logical) logical = Math.floor(remote);
      logical += 1;
      return logical;
    },
  };
}
