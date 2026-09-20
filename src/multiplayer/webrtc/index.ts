/**
 * Barrel for the WebRTC layer.
 *
 * Import from '@/multiplayer/webrtc' rather than from the individual files:
 *   import { createMesh, getRtcConfiguration } from '@/multiplayer/webrtc';
 *
 * Nothing here touches a browser API at import time, so this barrel is safe to
 * pull into a module that Next also renders on the server during the static
 * export. The browser-only work all happens inside `start()`.
 */

export {
  DEFAULT_STUN_URLS,
  describeIceConfig,
  getIceServers,
  getRtcConfiguration,
  hasTurn,
} from './iceConfig';

export { createPeerLink, DATA_CHANNEL_LABEL } from './peerLink';
export type { PeerLink, PeerLinkOptions, PeerLinkPayload } from './peerLink';

export { createMesh } from './mesh';
export type { Mesh, MeshOptions } from './mesh';
