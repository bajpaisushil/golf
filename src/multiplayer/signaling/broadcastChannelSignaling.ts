/**
 * Signaling over BroadcastChannel - same browser, different tabs.
 *
 * This is the adapter that makes local development and testing bearable: open
 * the game in three tabs, join the same room code, and they find each other
 * INSTANTLY with no network, no relay and no internet connection at all.
 *
 * It is also genuinely useful in production as one half of the default
 * composite channel: two tabs on the same laptop connect through here in
 * milliseconds while everyone else comes in over Nostr.
 *
 * Scope: same browser profile, same origin. Nothing leaves the machine, which
 * is also why envelopes are NOT encrypted here - there is no third party to
 * hide them from. The envelope shape is identical to every other adapter so the
 * layers above cannot tell the difference.
 */

import { TIMING } from '@/game/config';
import { err, ok } from '@/types';
import type { PeerId, Result, RoomCode, SignalingEnvelope, SignalingStatus, Unsubscribe } from '@/types';
import { roomTopic } from './crypto';
import {
  createDedupeSet,
  isEnvelopeForUs,
  isEnvelopeFresh,
  isSignalingEnvelope,
  type SignalingChannel,
} from './types';

/**
 * True when this environment can do same-browser signaling.
 *
 * Deliberately NOT gated on `window`: node has BroadcastChannel too, so this
 * adapter is usable headlessly in vitest. SSR safety comes from the fact that
 * nothing here runs until `open()` is called, which only ever happens from a
 * client component.
 */
export function isBroadcastChannelSupported(): boolean {
  return typeof BroadcastChannel !== 'undefined';
}

/**
 * Local channel name. Normally the SHA-256 room topic, so two rooms never
 * collide and the raw code is not sitting in a channel name.
 *
 * `crypto.subtle` is missing on insecure origins (plain http on a LAN ip, which
 * is exactly how people test on a phone), and falling over there would take out
 * the one adapter that always works. So we degrade to the plain room code -
 * safe, because a BroadcastChannel never leaves the browser profile.
 */
async function channelName(room: RoomCode): Promise<string> {
  try {
    return `fg:${await roomTopic(room)}`;
  } catch {
    return `fg:local:${room}`;
  }
}

export function createBroadcastChannelSignaling(): SignalingChannel {
  let channel: BroadcastChannel | null = null;
  let status: SignalingStatus = 'idle';
  let self: PeerId | null = null;
  let room: RoomCode | null = null;

  const seen = createDedupeSet(512);
  const envelopeListeners = new Set<(envelope: SignalingEnvelope) => void>();
  const statusListeners = new Set<(status: SignalingStatus) => void>();

  function setStatus(next: SignalingStatus): void {
    if (status === next) return;
    status = next;
    for (const listener of [...statusListeners]) {
      try {
        listener(next);
      } catch {
        /* a listener must never break the channel */
      }
    }
  }

  function deliver(envelope: SignalingEnvelope): void {
    for (const listener of [...envelopeListeners]) {
      try {
        listener(envelope);
      } catch {
        /* keep going */
      }
    }
  }

  function handleMessage(event: MessageEvent): void {
    const data: unknown = event.data;
    if (!isSignalingEnvelope(data)) return;
    if (room !== null && data.room !== room) return;
    if (self !== null && !isEnvelopeForUs(data, self)) return;
    if (!isEnvelopeFresh(data, Date.now(), TIMING.SIGNALING_TTL_MS)) return;
    if (!seen.accept(data.nonce)) return;
    deliver(data);
  }

  return {
    name: 'broadcast',
    get status(): SignalingStatus {
      return status;
    },

    async open(nextRoom: RoomCode, nextSelf: PeerId): Promise<Result<void, string>> {
      if (!isBroadcastChannelSupported()) {
        setStatus('error');
        return err('BroadcastChannel is not available in this environment');
      }
      if (channel !== null) return ok(undefined);

      setStatus('connecting');
      room = nextRoom;
      self = nextSelf;

      try {
        const bc = new BroadcastChannel(await channelName(nextRoom));
        bc.onmessage = handleMessage;
        bc.onmessageerror = () => {
          // A message that could not be deserialised: ignore it, stay open.
        };
        channel = bc;
      } catch (cause) {
        setStatus('error');
        return err(cause instanceof Error ? cause.message : 'BroadcastChannel failed to open');
      }

      setStatus('open');
      return ok(undefined);
    },

    async send(envelope: SignalingEnvelope): Promise<Result<void, string>> {
      if (channel === null) return err('broadcast channel is not open');
      try {
        // Structured clone: the envelope crosses tabs as a real object, no JSON.
        // A BroadcastChannel never echoes to the posting context, so there is
        // nothing of our own to filter out on the way back in.
        channel.postMessage(envelope);
        seen.accept(envelope.nonce);
        return ok(undefined);
      } catch (cause) {
        return err(cause instanceof Error ? cause.message : 'postMessage failed');
      }
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
      if (channel !== null) {
        channel.onmessage = null;
        try {
          channel.close();
        } catch {
          /* already closed */
        }
        channel = null;
      }
      // Announce the close BEFORE dropping the listeners, or nobody hears it.
      setStatus('closed');
      envelopeListeners.clear();
      statusListeners.clear();
      seen.clear();
    },
  };
}
