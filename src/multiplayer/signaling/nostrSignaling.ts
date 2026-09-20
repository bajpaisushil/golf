/**
 * DEFAULT signaling backend: free public Nostr relays.
 *
 * ---------------------------------------------------------------------------
 * WHY NOSTR
 * ---------------------------------------------------------------------------
 * WebRTC needs a way for two browsers to swap ~3KB of SDP before they can talk
 * directly. That normally means running a websocket server, which would mean a
 * VPS, a domain, a bill and a thing that can go down - everything this project
 * refuses to have.
 *
 * Nostr relays are public, free, require no account and speak plain websockets
 * from the browser. Posting an EPHEMERAL event (kind 20000-29999, which relays
 * forward to live subscribers and never store) to a room-specific topic gives
 * exactly the broadcast bus WebRTC needs, at zero cost and with no server of
 * our own. Once the peers are connected the relays are never used again - all
 * gameplay is browser-to-browser.
 *
 * ---------------------------------------------------------------------------
 * HOW THE FAILURE MODES ARE HANDLED
 * ---------------------------------------------------------------------------
 * Free relays go down, rate limit, or reject writes without warning. So:
 *  - we connect to SEVERAL at once and publish to all of them;
 *  - a room works as long as ANY ONE of them works;
 *  - duplicates (the same envelope arriving from four relays) are deduped by
 *    event id and again by envelope nonce;
 *  - status is 'degraded' rather than 'error' while at least one is alive.
 *
 * ---------------------------------------------------------------------------
 * PRIVACY
 * ---------------------------------------------------------------------------
 * Relays never see the room code (only its SHA-256 topic) and never see SDP
 * (the content is AES-GCM encrypted with a key derived from the room code -
 * see crypto.ts, including its honest note about how weak a 6-character code
 * is). The keypair is generated per session with generateSecretKey(), used to
 * sign these throwaway events and then discarded: it is NOT an account, it is
 * never persisted, and it is not reused between rooms.
 *
 * nostr-tools is imported DYNAMICALLY inside open(), so the home screen never
 * downloads it and the module is safe during SSR / static export.
 */

import { TIMING } from '@/game/config';
import { err, ok } from '@/types';
import type { PeerId, Result, RoomCode, SignalingEnvelope, SignalingStatus, Unsubscribe } from '@/types';
import { decryptEnvelope, deriveRoomKey, encryptEnvelope, roomTopic } from './crypto';
import {
  createDedupeSet,
  isEnvelopeForUs,
  isEnvelopeFresh,
  type SignalingChannel,
} from './types';

/**
 * Free public relays, no signup, all widely used.
 * Overridable at build time with NEXT_PUBLIC_SIGNALING_RELAYS.
 */
export const DEFAULT_RELAYS: readonly string[] = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nostr.band',
  'wss://relay.primal.net',
  'wss://nostr.mom',
];

/**
 * Ephemeral event kind. Anything in 20000-29999 is defined by NIP-01 as
 * "not stored by relays" - forwarded to whoever is subscribed right now and
 * then forgotten. Exactly right for signaling, and it means a finished game
 * leaves nothing behind on anybody's infrastructure.
 */
export const SIGNALING_EVENT_KIND = 20042;

/** How long to wait for a relay's websocket before writing it off for now. */
const RELAY_CONNECT_TIMEOUT_MS = 8000;
/** How often connection health is re-checked for the "connecting..." UI. */
const STATUS_POLL_MS = 5000;

export interface NostrSignalingOptions {
  /** Defaults to NEXT_PUBLIC_SIGNALING_RELAYS, else DEFAULT_RELAYS. */
  readonly relays?: readonly string[];
}

// Type-only references: erased at build time, so nostr-tools stays out of any
// bundle that does not actually start a game.
type Pool = import('nostr-tools/pool').SimplePool;
type SubCloser = ReturnType<Pool['subscribe']>;
type NostrEvent = import('nostr-tools/core').Event;

function normaliseRelay(url: string): string | null {
  const trimmed = url.trim().replace(/\/+$/, '');
  if (trimmed.length === 0) return null;
  if (trimmed.startsWith('wss://') || trimmed.startsWith('ws://')) return trimmed;
  return `wss://${trimmed}`;
}

function relaysFromEnv(): readonly string[] | null {
  // Written as a full literal so Next can inline it in the static export.
  const raw = process.env.NEXT_PUBLIC_SIGNALING_RELAYS;
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const url = normaliseRelay(part);
    if (url !== null && !out.includes(url)) out.push(url);
  }
  return out.length > 0 ? out : null;
}

export function resolveRelays(options?: NostrSignalingOptions): readonly string[] {
  if (options?.relays !== undefined && options.relays.length > 0) {
    const out: string[] = [];
    for (const entry of options.relays) {
      const url = normaliseRelay(entry);
      if (url !== null && !out.includes(url)) out.push(url);
    }
    if (out.length > 0) return out;
  }
  return relaysFromEnv() ?? DEFAULT_RELAYS;
}

export function createNostrSignaling(options?: NostrSignalingOptions): SignalingChannel {
  const relays = resolveRelays(options);

  let status: SignalingStatus = 'idle';
  let pool: Pool | null = null;
  let sub: SubCloser | null = null;
  let statusTimer: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  let room: RoomCode | null = null;
  let self: PeerId | null = null;
  let roomKey: CryptoKey | null = null;
  let topic: string | null = null;
  let secretKey: Uint8Array | null = null;
  let publicKey: string | null = null;
  let signEvent: ((template: {
    kind: number;
    created_at: number;
    tags: string[][];
    content: string;
  }, key: Uint8Array) => NostrEvent) | null = null;

  const seenEvents = createDedupeSet(1024);
  const seenNonces = createDedupeSet(512);
  const envelopeListeners = new Set<(envelope: SignalingEnvelope) => void>();
  const statusListeners = new Set<(status: SignalingStatus) => void>();

  function setStatus(next: SignalingStatus): void {
    if (status === next) return;
    status = next;
    for (const listener of [...statusListeners]) {
      try {
        listener(next);
      } catch {
        /* a listener must never break signaling */
      }
    }
  }

  function connectedRelayCount(): number {
    if (pool === null) return 0;
    let up = 0;
    for (const [, isConnected] of pool.listConnectionStatus()) {
      if (isConnected) up += 1;
    }
    return up;
  }

  /** open when most relays are alive, degraded while at least one is, error at zero. */
  function refreshStatus(): void {
    if (closed || pool === null) return;
    const up = connectedRelayCount();
    if (up === 0) setStatus('error');
    else if (up * 2 >= relays.length) setStatus('open');
    else setStatus('degraded');
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

  async function handleEvent(event: NostrEvent): Promise<void> {
    if (closed || roomKey === null || self === null || room === null) return;
    if (event.pubkey === publicKey) return; // our own echo
    if (!seenEvents.accept(event.id)) return; // same event from another relay

    const decrypted = await decryptEnvelope(roomKey, event.content);
    if (!decrypted.ok) return; // someone else's traffic on this topic, or junk

    const envelope = decrypted.value;
    if (envelope.room !== room) return;
    if (!isEnvelopeForUs(envelope, self)) return;
    if (!isEnvelopeFresh(envelope, Date.now(), TIMING.SIGNALING_TTL_MS)) return;
    if (!seenNonces.accept(envelope.nonce)) return;

    deliver(envelope);
  }

  async function open(nextRoom: RoomCode, nextSelf: PeerId): Promise<Result<void, string>> {
    if (closed) return err('signaling channel is closed');
    if (pool !== null) return ok(undefined);
    if (typeof window === 'undefined') return err('nostr signaling needs a browser');
    if (typeof WebSocket === 'undefined') return err('websockets are unavailable');

    setStatus('connecting');
    room = nextRoom;
    self = nextSelf;

    // A local, not the closure field, so the type stays narrowed below.
    let currentTopic = '';
    try {
      currentTopic = await roomTopic(nextRoom);
      roomKey = await deriveRoomKey(nextRoom);
      topic = currentTopic;
    } catch (cause) {
      setStatus('error');
      return err(
        cause instanceof Error ? `room key: ${cause.message}` : 'could not derive the room key',
      );
    }
    if (currentTopic === '' || roomKey === null) {
      setStatus('error');
      return err('could not derive the room key');
    }

    let nextPool: Pool | null = null;
    try {
      // Dynamic: keeps nostr-tools out of the home-screen bundle entirely.
      const [{ SimplePool }, { generateSecretKey, getPublicKey, finalizeEvent }] = await Promise.all(
        [import('nostr-tools/pool'), import('nostr-tools/pure')],
      );
      // Throwaway identity. Never persisted, never reused, not an account.
      const sk = generateSecretKey();
      secretKey = sk;
      publicKey = getPublicKey(sk);
      signEvent = finalizeEvent;
      nextPool = new SimplePool({ enableReconnect: true });
    } catch (cause) {
      setStatus('error');
      return err(cause instanceof Error ? `nostr-tools: ${cause.message}` : 'nostr-tools failed to load');
    }

    if (nextPool === null) {
      setStatus('error');
      return err('nostr-tools failed to load');
    }

    nextPool.onRelayConnectionSuccess = () => {
      refreshStatus();
    };
    nextPool.onRelayConnectionFailure = () => {
      refreshStatus();
    };
    pool = nextPool;

    // Try every relay in parallel and CARRY ON AS SOON AS ONE ANSWERS.
    //
    // This must not be `Promise.allSettled`: a relay that accepts a TCP
    // connection and then never completes its handshake takes the full
    // connection timeout to fail, and waiting for it stalled joining a room by
    // ~7 seconds even though four other relays were up within two. One survivor
    // is enough to play; the stragglers keep connecting in the background and
    // SimplePool starts using them when they arrive.
    const reachable = await new Promise<boolean>((resolve) => {
      let settledCount = 0;
      let done = false;
      const finish = (value: boolean): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => finish(false), RELAY_CONNECT_TIMEOUT_MS + 500);

      for (const url of relays) {
        void nextPool
          .ensureRelay(url, { connectionTimeout: RELAY_CONNECT_TIMEOUT_MS })
          .then(() => finish(true))
          .catch(() => undefined)
          .finally(() => {
            settledCount += 1;
            // Everybody reported and nobody made it.
            if (settledCount === relays.length && !done) finish(false);
          });
      }
    });

    if (closed) return err('signaling channel was closed while connecting');

    if (!reachable) {
      setStatus('error');
      try {
        nextPool.destroy();
      } catch {
        /* nothing to clean up */
      }
      pool = null;
      return err(`none of the ${relays.length} signaling relays could be reached`);
    }

    // Subscribe on ALL relays, including the ones that failed a moment ago:
    // SimplePool reconnects, so a relay that comes back later starts working.
    sub = nextPool.subscribe(
      [...relays],
      {
        kinds: [SIGNALING_EVENT_KIND],
        '#d': [currentTopic],
        // Ephemeral events are not stored, so this only guards against a relay
        // that (incorrectly) replays history.
        since: Math.floor((Date.now() - TIMING.SIGNALING_TTL_MS) / 1000),
      },
      {
        onevent: (event: NostrEvent) => {
          void handleEvent(event);
        },
        onclose: () => {
          refreshStatus();
        },
      },
    );

    statusTimer = setInterval(refreshStatus, STATUS_POLL_MS);
    refreshStatus();
    return ok(undefined);
  }

  async function send(envelope: SignalingEnvelope): Promise<Result<void, string>> {
    if (closed) return err('signaling channel is closed');
    const currentPool = pool;
    const key = roomKey;
    const currentTopic = topic;
    const sk = secretKey;
    const sign = signEvent;
    if (currentPool === null || key === null || currentTopic === null || sk === null || sign === null) {
      return err('nostr signaling is not open');
    }

    // Our own envelopes must never come back at us through a relay.
    seenNonces.accept(envelope.nonce);

    let event: NostrEvent;
    try {
      const content = await encryptEnvelope(key, envelope);
      event = sign(
        {
          kind: SIGNALING_EVENT_KIND,
          created_at: Math.floor(Date.now() / 1000),
          // '#d' is the room topic every peer subscribes to.
          tags: [['d', currentTopic]],
          content,
        },
        sk,
      );
    } catch (cause) {
      return err(cause instanceof Error ? `encrypt: ${cause.message}` : 'could not encrypt envelope');
    }

    let accepted = 0;
    try {
      const results = await Promise.allSettled(currentPool.publish([...relays], event));
      accepted = results.filter((r) => r.status === 'fulfilled').length;
    } catch (cause) {
      return err(cause instanceof Error ? `publish: ${cause.message}` : 'publish failed');
    }
    if (accepted === 0) {
      refreshStatus();
      return err('no relay accepted the envelope');
    }
    return ok(undefined);
  }

  return {
    name: 'nostr',
    get status(): SignalingStatus {
      return status;
    },
    open,
    send,

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

      if (statusTimer !== null) {
        clearInterval(statusTimer);
        statusTimer = null;
      }
      if (sub !== null) {
        try {
          sub.close();
        } catch {
          /* already closed */
        }
        sub = null;
      }
      if (pool !== null) {
        try {
          pool.close([...relays]);
          pool.destroy();
        } catch {
          /* already gone */
        }
        pool = null;
      }

      // Drop the throwaway identity and the room key with it.
      secretKey = null;
      publicKey = null;
      roomKey = null;
      signEvent = null;

      setStatus('closed');
      envelopeListeners.clear();
      statusListeners.clear();
      seenEvents.clear();
      seenNonces.clear();
    },
  };
}
