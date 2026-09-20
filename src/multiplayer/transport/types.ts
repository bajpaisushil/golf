/**
 * THE TRANSPORT SEAM.
 *
 * Everything above this line (roomSession, host authority, the reducer, the UI)
 * talks to a `Transport` and never to WebRTC. That is what lets the entire game
 * run headlessly in vitest against the in-memory loopback transport - with
 * simulated latency, duplicates, reordering and host disconnects - and then run
 * unchanged over real peer connections in the browser.
 *
 * A Transport speaks in PlayerIds (stable across reconnects) while the mesh
 * underneath speaks in PeerIds (one per RTCPeerConnection). Binding the two is
 * this layer's job.
 */

import { LIMITS } from '@/game/config';
import { isNetMessage, type NetMessage } from '@/multiplayer/protocol/messages';
import { createMesh } from '@/multiplayer/webrtc/mesh';
import type { SignalingChannel } from '@/multiplayer/signaling/types';
import { err } from '@/types';
import type {
  PeerId,
  PeerInfo,
  PlayerId,
  Result,
  RoomIdentity,
  Unsubscribe,
} from '@/types';

export interface Transport {
  readonly kind: 'mesh' | 'loopback';
  readonly selfId: PlayerId;
  /** Connects. Resolves ok once the transport is usable (peers may still be joining). */
  start(): Promise<Result<void, string>>;
  /** Send to every connected peer. Never throws; silently skips dead links. */
  broadcast(message: NetMessage): void;
  /** Send to one player. Returns false when that player is not reachable. */
  sendTo(target: PlayerId, message: NetMessage): boolean;
  /** Only messages that already passed isNetMessage() are delivered. */
  onMessage(listener: (message: NetMessage, from: PeerId) => void): Unsubscribe;
  onPeers(listener: (peers: readonly PeerInfo[]) => void): Unsubscribe;
  peers(): readonly PeerInfo[];
  close(): void;
}

export type TransportFactory = () => Transport;

// ---------------------------------------------------------------------------
// Wire encoding
// ---------------------------------------------------------------------------
// Kept tiny and local on purpose: a transport must be able to reject a hostile
// frame before anything else in the app has seen it. `protocol/codec.ts` is the
// richer, Result-returning version used by the game layer.

/** UTF-8 byte length, with a safe fallback where TextEncoder is missing. */
export function byteLengthOf(raw: string): number {
  if (typeof TextEncoder === 'undefined') return raw.length;
  return new TextEncoder().encode(raw).length;
}

/** Returns null when the message cannot be serialised or is over the size cap. */
export function encodeFrame(message: NetMessage): string | null {
  let raw: string;
  try {
    raw = JSON.stringify(message);
  } catch {
    return null;
  }
  if (typeof raw !== 'string' || raw.length === 0) return null;
  if (byteLengthOf(raw) > LIMITS.MAX_MESSAGE_BYTES) return null;
  return raw;
}

/** Returns null for anything that is not a valid, in-budget NetMessage. */
export function decodeFrame(raw: string): NetMessage | null {
  // Cheap guard first: UTF-16 length is never larger than the UTF-8 byte count
  // for the characters we allow, so this rejects the obvious flood cases before
  // JSON.parse is asked to do any work.
  if (raw.length > LIMITS.MAX_MESSAGE_BYTES) return null;
  if (byteLengthOf(raw) > LIMITS.MAX_MESSAGE_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return isNetMessage(parsed) ? parsed : null;
}

// ---------------------------------------------------------------------------
// Mesh-backed transport
// ---------------------------------------------------------------------------

export interface MeshTransportOptions {
  readonly identity: RoomIdentity;
  readonly signaling: SignalingChannel;
}

/**
 * Wraps the WebRTC mesh in the Transport surface.
 *
 * The PeerId -> PlayerId binding is learned from the traffic itself: every
 * NetMessage carries `from` (a PlayerId), so the first valid message on a link
 * tells us which player is on the other end of that peer connection. That keeps
 * this layer free of any handshake logic - HELLO/WELCOME stay a game concern.
 */
export function createMeshTransport(options: MeshTransportOptions): Transport {
  const { identity, signaling } = options;
  const mesh = createMesh({ identity, signaling });

  const playerByPeer = new Map<PeerId, PlayerId>();
  const peerByPlayer = new Map<PlayerId, PeerId>();

  const messageListeners = new Set<(message: NetMessage, from: PeerId) => void>();
  const peerListeners = new Set<(peers: readonly PeerInfo[]) => void>();

  let closed = false;

  function enrich(peers: readonly PeerInfo[]): readonly PeerInfo[] {
    return peers.map((peer) => {
      if (peer.playerId !== null) return peer;
      const playerId = playerByPeer.get(peer.peerId);
      return playerId === undefined ? peer : { ...peer, playerId };
    });
  }

  function emitPeers(): void {
    const snapshot = enrich(mesh.peers());
    for (const listener of [...peerListeners]) {
      try {
        listener(snapshot);
      } catch {
        /* one bad listener must not break the transport */
      }
    }
  }

  mesh.onPeers(() => {
    emitPeers();
  });

  mesh.onMessage((raw, from) => {
    const message = decodeFrame(raw);
    if (message === null) return; // hostile or corrupt frame: never reaches the game

    const previous = playerByPeer.get(from);
    if (previous !== message.from) {
      playerByPeer.set(from, message.from);
      // A reconnecting player keeps its PlayerId but arrives on a NEW PeerId,
      // so the reverse index always points at the newest link.
      peerByPlayer.set(message.from, from);
      emitPeers();
    }

    for (const listener of [...messageListeners]) {
      try {
        listener(message, from);
      } catch {
        /* keep delivering to the others */
      }
    }
  });

  mesh.onPeerLeft((peer) => {
    const playerId = playerByPeer.get(peer.peerId);
    playerByPeer.delete(peer.peerId);
    if (playerId !== undefined && peerByPlayer.get(playerId) === peer.peerId) {
      peerByPlayer.delete(playerId);
    }
  });

  return {
    kind: 'mesh',
    selfId: identity.playerId,

    async start(): Promise<Result<void, string>> {
      if (closed) return err('transport is closed');
      return mesh.start();
    },

    broadcast(message: NetMessage): void {
      if (closed) return;
      const raw = encodeFrame(message);
      if (raw === null) return;
      mesh.broadcast(raw);
    },

    sendTo(target: PlayerId, message: NetMessage): boolean {
      if (closed) return false;
      const peerId = peerByPlayer.get(target);
      if (peerId === undefined) return false;
      const raw = encodeFrame(message);
      if (raw === null) return false;
      return mesh.sendTo(peerId, raw);
    },

    onMessage(listener: (message: NetMessage, from: PeerId) => void): Unsubscribe {
      messageListeners.add(listener);
      return () => {
        messageListeners.delete(listener);
      };
    },

    onPeers(listener: (peers: readonly PeerInfo[]) => void): Unsubscribe {
      peerListeners.add(listener);
      return () => {
        peerListeners.delete(listener);
      };
    },

    peers(): readonly PeerInfo[] {
      return enrich(mesh.peers());
    },

    close(): void {
      if (closed) return;
      closed = true;
      mesh.close();
      messageListeners.clear();
      peerListeners.clear();
      playerByPeer.clear();
      peerByPlayer.clear();
    },
  };
}
