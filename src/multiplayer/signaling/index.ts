/**
 * Barrel for the signaling layer, plus the DEFAULT channel the game uses.
 *
 * Import from '@/multiplayer/signaling':
 *   import { createDefaultSignaling } from '@/multiplayer/signaling';
 *
 * Nothing here opens a socket at import time, and nostr-tools is only loaded
 * once a room is actually joined, so this barrel is safe during SSR / static
 * export and costs the home screen nothing.
 */

export type { SignalingChannel, SignalingFactory, DedupeSet } from './types';
export type { SignalingEnvelope, SignalingKind, SignalingStatus } from './types';
export {
  bestStatus,
  createDedupeSet,
  isEnvelopeForUs,
  isEnvelopeFresh,
  isSignalingEnvelope,
  isSignalingKind,
  SIGNALING_KINDS,
} from './types';

export {
  decryptEnvelope,
  deriveRoomKey,
  encryptEnvelope,
  fromBase64Url,
  isCryptoAvailable,
  randomNonce,
  roomTopic,
  toBase64Url,
} from './crypto';

export {
  createNostrSignaling,
  DEFAULT_RELAYS,
  resolveRelays,
  SIGNALING_EVENT_KIND,
} from './nostrSignaling';
export type { NostrSignalingOptions } from './nostrSignaling';

export {
  createBroadcastChannelSignaling,
  isBroadcastChannelSupported,
} from './broadcastChannelSignaling';

export { createCompositeSignaling } from './compositeSignaling';

export { createManualSignaling } from './manualSignaling';
export type { ManualSignaling } from './manualSignaling';

import { createBroadcastChannelSignaling, isBroadcastChannelSupported } from './broadcastChannelSignaling';
import { createCompositeSignaling } from './compositeSignaling';
import { createNostrSignaling, type NostrSignalingOptions } from './nostrSignaling';
import type { SignalingChannel } from './types';

export interface DefaultSignalingOptions extends NostrSignalingOptions {
  /** Same-browser tab discovery. On by default; there is no reason to turn it off. */
  readonly broadcastChannel?: boolean;
  /** Cross-device discovery over free public relays. On by default. */
  readonly nostr?: boolean;
}

/**
 * THE DEFAULT ROOM SIGNALING CHANNEL.
 *
 * BroadcastChannel first (instant, offline, same-browser tabs) and Nostr
 * alongside it (cross-device, free public relays). They run simultaneously and
 * the composite dedupes, so whichever gets there first wins and a dead backend
 * is merely ignored.
 */
export function createDefaultSignaling(options?: DefaultSignalingOptions): SignalingChannel {
  const channels: SignalingChannel[] = [];

  if (options?.broadcastChannel !== false && isBroadcastChannelSupported()) {
    channels.push(createBroadcastChannelSignaling());
  }
  if (options?.nostr !== false) {
    const relays = options?.relays;
    channels.push(createNostrSignaling(relays !== undefined ? { relays } : undefined));
  }

  return createCompositeSignaling(channels);
}
