/**
 * Transport-agnostic multiplayer types.
 *
 * These describe the PLUMBING (peers, connection lifecycle, signaling payloads).
 * The gameplay wire protocol itself lives in `src/multiplayer/protocol/messages.ts`.
 *
 * The behavioural interfaces `SignalingChannel` and `Transport` are declared in
 * `src/multiplayer/signaling/types.ts` and `src/multiplayer/transport/types.ts`
 * respectively (see docs/CONTRACTS.md); they build on the types below.
 */

import type { Hex, Millis, PeerId, PlayerId, RoomCode, Timestamp } from './core';

// ---------------------------------------------------------------------------
// Connection lifecycle
// ---------------------------------------------------------------------------

/**
 * Lifecycle of a single peer link, and of the mesh as a whole.
 *
 * idle         - nothing started yet
 * signaling    - exchanging offer/answer/ICE through the signaling channel
 * connecting   - ICE is negotiating / DataChannel opening
 * connected    - DataChannel open, messages flowing
 * reconnecting - previously connected, lost, retrying within RECONNECT_GRACE_MS
 * disconnected - gone, but the player slot is still held
 * failed       - unrecoverable (ICE failed, protocol mismatch, timeout)
 * closed       - deliberately torn down by us
 */
export type ConnectionState =
  | 'idle'
  | 'signaling'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'
  | 'failed'
  | 'closed';

/** True when the link can carry messages right now. */
export const isLiveConnection = (state: ConnectionState): boolean => state === 'connected';

/** Live view of one remote peer, surfaced to the UI (connection pills, latency, host crown). */
export interface PeerInfo {
  readonly peerId: PeerId;
  /** null until HELLO has been received on this link. */
  readonly playerId: PlayerId | null;
  readonly displayName: string;
  readonly state: ConnectionState;
  readonly isHost: boolean;
  /** Round-trip time from the last PING/PONG, or null before the first sample. */
  readonly rttMs: Millis | null;
  /** Timestamp of the last message of any kind from this peer. */
  readonly lastSeenAt: Timestamp;
  /** Whether WE initiated the offer (deterministic: lower peerId offers). */
  readonly initiator: boolean;
  /** Reason for a 'failed' state, for the diagnostics panel. */
  readonly lastError: string | null;
}

// ---------------------------------------------------------------------------
// Signaling
// ---------------------------------------------------------------------------

/** What a signaling envelope carries. */
export type SignalingKind =
  /** "I am here, my peerId is X" - triggers offers from existing members. */
  | 'announce'
  /** SDP offer. */
  | 'offer'
  /** SDP answer. */
  | 'answer'
  /** A single trickled ICE candidate (or an end-of-candidates marker with empty payload). */
  | 'ice'
  /** Graceful departure. */
  | 'bye';

/**
 * One message on the signaling plane. Transported by Nostr relays, a
 * BroadcastChannel (same-browser tabs), or copy-paste. The `payload` is an
 * already-stringified JSON blob so every signaling backend can treat it as opaque
 * (and so it can be encrypted end-to-end with the room code as the key material).
 */
export interface SignalingEnvelope {
  /** Signaling protocol version; mismatches are dropped. */
  readonly v: number;
  readonly room: RoomCode;
  readonly from: PeerId;
  /** null = broadcast to the whole room. */
  readonly to: PeerId | null;
  readonly kind: SignalingKind;
  /** JSON string: RTCSessionDescriptionInit, RTCIceCandidateInit, or '' for bye/announce. */
  readonly payload: string;
  /** Sender wall clock; used only to drop very old envelopes. */
  readonly ts: Timestamp;
  /** Random per-envelope id; receivers dedupe on it (relays can deliver twice). */
  readonly nonce: string;
}

/** Health of a signaling backend, shown in the "Connecting..." UI. */
export type SignalingStatus = 'idle' | 'connecting' | 'open' | 'degraded' | 'closed' | 'error';

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * Who we are in this room. The ONLY thing written to sessionStorage, so a page
 * refresh can rejoin as the same player. Contains nothing sensitive.
 */
export interface RoomIdentity {
  readonly playerId: PlayerId;
  readonly peerId: PeerId;
  readonly displayName: string;
  readonly color: Hex;
  readonly roomCode: RoomCode;
  /** True if this browser created the room (initial host). */
  readonly createdRoom: boolean;
  readonly createdAt: Timestamp;
}

/** Diagnostics snapshot for the debug overlay (never persisted, never sent). */
export interface MeshStats {
  readonly selfPeerId: PeerId;
  readonly peers: readonly PeerInfo[];
  readonly connectedCount: number;
  readonly signaling: SignalingStatus;
  readonly messagesSent: number;
  readonly messagesReceived: number;
  readonly bytesSent: number;
  readonly bytesReceived: number;
}
