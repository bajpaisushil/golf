/**
 * Room layer barrel.
 *
 * `RoomSession` is the only thing the app above this layer should need. The
 * election, watchdog and heartbeat pieces are exported too because they are
 * pure/injectable and worth unit-testing on their own - not because screens
 * should reach for them.
 *
 * Layering, top to bottom:
 *
 *   useGameSession / store          <- React owns lifecycle + storage
 *        |
 *   RoomSession                     <- THIS layer: membership, host authority,
 *        |                             turn flow, reconciliation
 *   Transport (mesh | loopback)     <- NetMessage in, NetMessage out
 *        |
 *   PeerLink / Mesh / Signaling     <- WebRTC plumbing
 *
 * Nothing below `RoomSession` knows what golf is; nothing above it knows what
 * an RTCPeerConnection is.
 */

export {
  buildSnapshot,
  createRoom,
  createRoomSession,
  joinRoom,
  type RoomSession,
  type RoomSessionOptions,
  type SessionEvent,
} from './roomSession';

export {
  createHostWatchdog,
  electHost,
  electHostFor,
  hostSuccession,
  isHost,
  playersOf,
  shouldClaimHost,
  type HostWatchdog,
  type HostWatchdogOptions,
} from './hostElection';

export {
  createHeartbeat,
  createManualClock,
  systemClock,
  type HeartbeatClock,
  type HeartbeatOptions,
  type HeartbeatService,
  type HeartbeatTimer,
  type ManualClock,
} from './heartbeat';
