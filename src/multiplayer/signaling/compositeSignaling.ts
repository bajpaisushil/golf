/**
 * Runs several signaling backends AT ONCE and merges them into one channel.
 *
 * This is the default, and it is what makes the game feel instant in the two
 * situations that actually happen:
 *
 *   - two tabs on the same laptop  -> BroadcastChannel connects them in ~1ms,
 *     with no internet involved at all;
 *   - a friend on another device   -> the same envelopes also go out over
 *     public Nostr relays.
 *
 * Neither backend knows about the other. Envelopes are deduped by `nonce`, so
 * an envelope that arrives over both paths is delivered exactly once, and a
 * backend that is broken (relays unreachable, BroadcastChannel unsupported) is
 * simply dead weight rather than a failure: the composite is open as long as
 * ANY child opened.
 */

import { err, ok } from '@/types';
import type { PeerId, Result, RoomCode, SignalingEnvelope, SignalingStatus, Unsubscribe } from '@/types';
import { bestStatus, createDedupeSet, type SignalingChannel } from './types';

/**
 * How long to wait for a signaling backend before falling back to whatever is
 * already open. Long enough for a healthy relay on a slow phone connection,
 * short enough that a dead relay never strands someone on the join screen.
 */
const OPEN_TIMEOUT_MS = 6000;

export function createCompositeSignaling(
  channels: readonly SignalingChannel[],
): SignalingChannel {
  const children = [...channels];
  const seen = createDedupeSet(512);
  const envelopeListeners = new Set<(envelope: SignalingEnvelope) => void>();
  const statusListeners = new Set<(status: SignalingStatus) => void>();
  const childSubs: Unsubscribe[] = [];

  let status: SignalingStatus = 'idle';
  let closed = false;

  function recomputeStatus(): void {
    const next = closed ? 'closed' : bestStatus(children.map((child) => child.status));
    if (next === status) return;
    status = next;
    for (const listener of [...statusListeners]) {
      try {
        listener(next);
      } catch {
        /* keep going */
      }
    }
  }

  function deliver(envelope: SignalingEnvelope): void {
    // The SAME envelope legitimately arrives over several backends.
    if (!seen.accept(envelope.nonce)) return;
    for (const listener of [...envelopeListeners]) {
      try {
        listener(envelope);
      } catch {
        /* keep going */
      }
    }
  }

  // Subscribe immediately: a child may start delivering the moment it opens,
  // and an envelope missed during the handshake costs a whole retry cycle.
  for (const child of children) {
    childSubs.push(child.onEnvelope(deliver));
    childSubs.push(
      child.onStatus(() => {
        recomputeStatus();
      }),
    );
  }

  return {
    name: 'composite',
    get status(): SignalingStatus {
      return status;
    },

    async open(room: RoomCode, self: PeerId): Promise<Result<void, string>> {
      if (closed) return err('composite signaling is closed');
      if (children.length === 0) return err('no signaling backends configured');

      // Resolve as soon as the FIRST backend is usable, and let the slower ones
      // keep opening in the background.
      //
      // This must never be `Promise.all`/`allSettled`. Public Nostr relays go
      // down, rate-limit, or accept a TCP connection and then never complete the
      // WebSocket handshake — and a relay that never settles would otherwise hang
      // the join forever, even though BroadcastChannel was ready in a millisecond.
      // One working backend is genuinely enough to play.
      const failures: string[] = [];
      let settled = 0;
      let done = false;

      return await new Promise<Result<void, string>>((resolve) => {
        const finish = (result: Result<void, string>): void => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          recomputeStatus();
          resolve(result);
        };

        // Backstop: if every backend is merely slow rather than failed, proceed
        // anyway once at least one reports itself open, otherwise give up.
        const timer = setTimeout(() => {
          const anyOpen = children.some((child) => child.status === 'open');
          finish(
            anyOpen
              ? ok(undefined)
              : err(
                  failures.length > 0
                    ? failures.join('; ')
                    : 'signaling timed out while opening',
                ),
          );
        }, OPEN_TIMEOUT_MS);

        for (const child of children) {
          void child
            .open(room, self)
            .then(
              (result) => {
                if (result.ok) finish(ok(undefined));
                else failures.push(`${child.name}: ${result.error}`);
              },
              (reason: unknown) => {
                failures.push(`${child.name}: ${String(reason)}`);
              },
            )
            .finally(() => {
              settled += 1;
              recomputeStatus();
              // Every backend has now reported and none succeeded.
              if (settled === children.length && !done) {
                finish(
                  err(
                    failures.length > 0
                      ? failures.join('; ')
                      : 'no signaling backend could be opened',
                  ),
                );
              }
            });
        }
      });
    },

    async send(envelope: SignalingEnvelope): Promise<Result<void, string>> {
      if (closed) return err('composite signaling is closed');
      if (children.length === 0) return err('no signaling backends configured');

      // Our own envelope must not be re-delivered to us if a backend echoes it.
      seen.accept(envelope.nonce);

      const results = await Promise.allSettled(children.map((child) => child.send(envelope)));

      const failures: string[] = [];
      let sent = 0;
      for (let i = 0; i < results.length; i += 1) {
        const result = results[i];
        const name = children[i]?.name ?? 'unknown';
        if (result === undefined) continue;
        if (result.status === 'rejected') failures.push(`${name}: ${String(result.reason)}`);
        else if (result.value.ok) sent += 1;
        else failures.push(`${name}: ${result.value.error}`);
      }

      if (sent > 0) return ok(undefined);
      return err(failures.length > 0 ? failures.join('; ') : 'no backend accepted the envelope');
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

    close(): void {
      if (closed) return;
      closed = true;
      for (const unsubscribe of childSubs) {
        try {
          unsubscribe();
        } catch {
          /* already gone */
        }
      }
      childSubs.length = 0;
      for (const child of children) {
        try {
          child.close();
        } catch {
          /* already gone */
        }
      }
      recomputeStatus();
      envelopeListeners.clear();
      statusListeners.clear();
      seen.clear();
    },
  };
}
