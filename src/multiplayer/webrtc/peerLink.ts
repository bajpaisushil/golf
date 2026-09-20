/**
 * ONE peer-to-peer link: a single RTCPeerConnection plus a single reliable,
 * ordered RTCDataChannel.
 *
 * This module is deliberately game-agnostic. It moves opaque strings (or bytes)
 * between two browsers and reports its lifecycle; it knows nothing about golf,
 * players or rooms. `mesh.ts` layers a room of these into a full mesh.
 *
 * ---------------------------------------------------------------------------
 * GLARE ("both sides called at once")
 * ---------------------------------------------------------------------------
 * Two peers that discover each other simultaneously will both try to make an
 * offer, and the negotiation deadlocks. The classic fix is "perfect
 * negotiation": one side is POLITE (it rolls back its own offer when a remote
 * offer collides) and the other is IMPOLITE (it ignores the colliding remote
 * offer and lets its own win).
 *
 * The roles must be decided identically on both machines with no extra round
 * trip, so they are derived from the peer ids themselves:
 *
 *      initiator = selfPeerId < remotePeerId      (string comparison)
 *      polite    = !initiator
 *
 * Both browsers compute the same answer from the same two ids, so there is
 * never a negotiation about who negotiates.
 *
 * Every browser API used here is guarded: importing this file during SSR or the
 * static export is safe, and `start()` fails cleanly when WebRTC is missing.
 */

import { TIMING } from '@/game/config';
import type { ConnectionState, PeerId, PeerInfo, SignalingKind, Timestamp } from '@/types';
import { getRtcConfiguration } from './iceConfig';

/**
 * DataChannel label. Short on purpose - it is carried in the SDP.
 * `ordered: true` because lockstep input replay must not reorder shots, and the
 * payloads are ~80 bytes so head-of-line blocking costs nothing.
 */
export const DATA_CHANNEL_LABEL = 'fg';

/** What may be pushed through a link. The game only ever sends strings. */
export type PeerLinkPayload = string | ArrayBuffer | ArrayBufferView;

export interface PeerLinkOptions {
  readonly selfPeerId: PeerId;
  readonly remotePeerId: PeerId;
  /** Deterministic glare rule: initiator === (selfPeerId < remotePeerId). */
  readonly initiator: boolean;
  /** Hand this envelope payload to the signaling plane, addressed to the remote peer. */
  readonly onSignal: (kind: SignalingKind, payload: string) => void;
  readonly onMessage: (data: string) => void;
  readonly onStateChange: (state: ConnectionState, error?: string) => void;
  /** Overridable for tests. Defaults to TIMING.CONNECT_TIMEOUT_MS. */
  readonly connectTimeoutMs?: number;
}

export interface PeerLink {
  readonly remotePeerId: PeerId;
  readonly initiator: boolean;
  readonly state: ConnectionState;
  /** Creates the RTCPeerConnection; the initiator also creates the DataChannel + offer. */
  start(): Promise<void>;
  /** Feed a received offer/answer/ice payload (JSON string). */
  acceptSignal(kind: SignalingKind, payload: string): Promise<void>;
  /** false when the channel is not open. */
  send(data: PeerLinkPayload): boolean;
  info(): PeerInfo;
  close(reason?: string): void;
}

/** Above this many buffered bytes we refuse to send rather than grow the queue forever. */
const MAX_BUFFERED_BYTES = 1024 * 1024;

function describeError(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === 'string') return cause;
  return 'unknown error';
}

function parseJson<T>(payload: string): T | null {
  try {
    const parsed: unknown = JSON.parse(payload);
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed as T;
  } catch {
    return null;
  }
}

export function createPeerLink(options: PeerLinkOptions): PeerLink {
  const {
    selfPeerId,
    remotePeerId,
    initiator,
    onSignal,
    onMessage,
    onStateChange,
    connectTimeoutMs = TIMING.CONNECT_TIMEOUT_MS,
  } = options;

  /** The impolite peer wins a collision; the polite one rolls back. */
  const polite = !initiator;

  let pc: RTCPeerConnection | null = null;
  let channel: RTCDataChannel | null = null;
  let state: ConnectionState = 'idle';
  let lastError: string | null = null;
  let lastSeenAt: Timestamp = Date.now();
  let everConnected = false;
  let disposed = false;

  // Perfect-negotiation bookkeeping.
  let makingOffer = false;
  let ignoreOffer = false;
  let settingRemoteAnswer = false;

  /** ICE candidates that arrived before the remote description was applied. */
  const pendingCandidates: RTCIceCandidateInit[] = [];

  let connectTimer: ReturnType<typeof setTimeout> | null = null;

  function setState(next: ConnectionState, error?: string): void {
    if (error !== undefined) lastError = error;
    if (state === next) return;
    state = next;
    onStateChange(next, error);
  }

  function clearConnectTimer(): void {
    if (connectTimer !== null) {
      clearTimeout(connectTimer);
      connectTimer = null;
    }
  }

  function armConnectTimer(): void {
    clearConnectTimer();
    connectTimer = setTimeout(() => {
      connectTimer = null;
      if (disposed || state === 'connected') return;
      fail(`connection timed out after ${connectTimeoutMs}ms`);
    }, connectTimeoutMs);
  }

  /** Tear the transport down but report 'failed' (recoverable by the mesh) rather than 'closed'. */
  function fail(reason: string): void {
    if (disposed) return;
    teardown();
    setState('failed', reason);
  }

  function teardown(): void {
    clearConnectTimer();
    if (channel !== null) {
      channel.onopen = null;
      channel.onclose = null;
      channel.onerror = null;
      channel.onmessage = null;
      try {
        channel.close();
      } catch {
        /* already gone */
      }
      channel = null;
    }
    if (pc !== null) {
      pc.onicecandidate = null;
      pc.onnegotiationneeded = null;
      pc.onconnectionstatechange = null;
      pc.oniceconnectionstatechange = null;
      pc.ondatachannel = null;
      try {
        pc.close();
      } catch {
        /* already gone */
      }
      pc = null;
    }
    pendingCandidates.length = 0;
  }

  function attachChannel(next: RTCDataChannel): void {
    channel = next;
    channel.binaryType = 'arraybuffer';

    channel.onopen = () => {
      everConnected = true;
      clearConnectTimer();
      lastSeenAt = Date.now();
      setState('connected');
    };

    channel.onclose = () => {
      if (disposed) return;
      // A clean close after a live session is a disconnect, not a failure:
      // the mesh may still get this peer back through a fresh announce.
      if (everConnected) setState('disconnected', 'data channel closed');
      else fail('data channel closed before opening');
    };

    channel.onerror = (event: RTCErrorEvent) => {
      if (disposed) return;
      fail(`data channel error: ${event.error.message}`);
    };

    channel.onmessage = (event: MessageEvent) => {
      lastSeenAt = Date.now();
      const data: unknown = event.data;
      if (typeof data === 'string') {
        onMessage(data);
        return;
      }
      // Binary frames are not used by the game today, but a link that silently
      // dropped them would be a nasty surprise later, so decode them as UTF-8.
      if (typeof TextDecoder === 'undefined') return;
      if (data instanceof ArrayBuffer) {
        onMessage(new TextDecoder().decode(data));
      } else if (ArrayBuffer.isView(data)) {
        onMessage(new TextDecoder().decode(data));
      }
    };
  }

  async function createAndSendOffer(connection: RTCPeerConnection): Promise<void> {
    try {
      makingOffer = true;
      const offer = await connection.createOffer();
      await connection.setLocalDescription(offer);
      onSignal('offer', JSON.stringify({ type: offer.type, sdp: offer.sdp }));
    } catch (cause) {
      fail(`offer failed: ${describeError(cause)}`);
    } finally {
      makingOffer = false;
    }
  }

  function ensureConnection(): RTCPeerConnection | null {
    if (pc !== null) return pc;
    if (disposed) return null;

    if (typeof RTCPeerConnection === 'undefined') {
      fail('WebRTC is unavailable in this environment');
      return null;
    }

    let connection: RTCPeerConnection;
    try {
      connection = new RTCPeerConnection(getRtcConfiguration());
    } catch (cause) {
      fail(`could not create RTCPeerConnection: ${describeError(cause)}`);
      return null;
    }
    pc = connection;

    connection.onicecandidate = (event: RTCPeerConnectionIceEvent) => {
      if (disposed) return;
      if (event.candidate === null) {
        // End-of-candidates. Sent as an empty payload so the other side can stop
        // waiting; receivers treat it as informational only.
        onSignal('ice', '');
        return;
      }
      onSignal('ice', JSON.stringify(event.candidate.toJSON()));
    };

    connection.onnegotiationneeded = () => {
      if (disposed || pc === null) return;
      void createAndSendOffer(pc);
    };

    connection.ondatachannel = (event: RTCDataChannelEvent) => {
      if (disposed) return;
      if (event.channel.label !== DATA_CHANNEL_LABEL) {
        event.channel.close();
        return;
      }
      attachChannel(event.channel);
    };

    connection.onconnectionstatechange = () => {
      if (disposed || pc === null) return;
      switch (pc.connectionState) {
        case 'connecting':
          if (state !== 'connected') setState('connecting');
          break;
        case 'connected':
          // Not 'connected' for us until the DataChannel itself is open.
          if (state !== 'connected' && channel?.readyState !== 'open') setState('connecting');
          break;
        case 'disconnected':
          // ICE can recover from this on its own; give it until the timer fires.
          setState(everConnected ? 'reconnecting' : 'connecting', 'ice disconnected');
          if (everConnected) armConnectTimer();
          break;
        case 'failed':
          fail('ice connection failed (likely symmetric NAT - see iceConfig.ts)');
          break;
        case 'closed':
          if (!disposed) setState(everConnected ? 'disconnected' : 'failed', 'peer connection closed');
          break;
        default:
          break;
      }
    };

    return connection;
  }

  async function flushPendingCandidates(connection: RTCPeerConnection): Promise<void> {
    while (pendingCandidates.length > 0) {
      const candidate = pendingCandidates.shift();
      if (candidate === undefined) break;
      try {
        await connection.addIceCandidate(candidate);
      } catch {
        // A single bad candidate must never kill the link.
      }
    }
  }

  async function start(): Promise<void> {
    if (disposed || pc !== null) return;

    const connection = ensureConnection();
    if (connection === null) return;

    setState('signaling');
    armConnectTimer();

    if (initiator) {
      // Creating the channel fires negotiationneeded, which makes the offer.
      try {
        attachChannel(connection.createDataChannel(DATA_CHANNEL_LABEL, { ordered: true }));
      } catch (cause) {
        fail(`could not create data channel: ${describeError(cause)}`);
      }
    }
  }

  async function acceptSignal(kind: SignalingKind, payload: string): Promise<void> {
    // A failed link is never revived in place - the mesh throws it away and
    // builds a fresh one, so late signals for the dead link are ignored.
    if (disposed || state === 'failed') return;

    if (kind === 'bye') {
      close('peer left');
      return;
    }
    if (kind === 'announce') return; // handled by the mesh, not by a link

    const connection = ensureConnection();
    if (connection === null) return;
    if (state === 'idle') {
      setState('signaling');
      armConnectTimer();
    }

    if (kind === 'ice') {
      if (payload === '') return; // end-of-candidates marker
      const candidate = parseJson<RTCIceCandidateInit>(payload);
      if (candidate === null) return;
      if (connection.remoteDescription === null) {
        // Relays do not guarantee order: hold candidates until the description lands.
        pendingCandidates.push(candidate);
        return;
      }
      try {
        await connection.addIceCandidate(candidate);
      } catch {
        // Expected while ignoring a colliding offer; harmless otherwise.
      }
      return;
    }

    const description = parseJson<RTCSessionDescriptionInit>(payload);
    if (description === null || (description.type !== 'offer' && description.type !== 'answer')) {
      return;
    }

    try {
      const readyForOffer =
        !makingOffer && (connection.signalingState === 'stable' || settingRemoteAnswer);
      const offerCollision = description.type === 'offer' && !readyForOffer;

      ignoreOffer = !polite && offerCollision;
      if (ignoreOffer) return; // impolite peer: our own offer wins

      if (offerCollision) {
        // Polite peer: drop our own offer and take theirs.
        await connection.setLocalDescription({ type: 'rollback' });
      }

      settingRemoteAnswer = description.type === 'answer';
      await connection.setRemoteDescription(description);
      settingRemoteAnswer = false;

      await flushPendingCandidates(connection);

      if (description.type === 'offer') {
        const answer = await connection.createAnswer();
        await connection.setLocalDescription(answer);
        onSignal('answer', JSON.stringify({ type: answer.type, sdp: answer.sdp }));
      }
    } catch (cause) {
      settingRemoteAnswer = false;
      fail(`negotiation failed: ${describeError(cause)}`);
    }
  }

  function send(data: PeerLinkPayload): boolean {
    const open = channel !== null && channel.readyState === 'open';
    if (!open || channel === null) return false;
    if (channel.bufferedAmount > MAX_BUFFERED_BYTES) return false;
    try {
      if (typeof data === 'string') {
        channel.send(data);
      } else if (data instanceof ArrayBuffer) {
        channel.send(data);
      } else {
        // A view may be backed by a SharedArrayBuffer, which RTCDataChannel does
        // not accept, so copy into a plain buffer. The game only sends strings,
        // so this path is never hot.
        const copy = new Uint8Array(data.byteLength);
        copy.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
        channel.send(copy);
      }
      return true;
    } catch {
      return false;
    }
  }

  function info(): PeerInfo {
    return {
      peerId: remotePeerId,
      // A link carries no game identity; roomSession binds playerId after HELLO.
      playerId: null,
      displayName: '',
      state,
      isHost: false,
      rttMs: null,
      lastSeenAt,
      initiator,
      lastError,
    };
  }

  function close(reason?: string): void {
    if (disposed) return;
    disposed = true;
    teardown();
    state = 'closed';
    lastError = reason ?? lastError;
    onStateChange('closed', reason);
  }

  void selfPeerId; // kept in the options for symmetry / debugging of the glare rule

  return {
    remotePeerId,
    initiator,
    get state(): ConnectionState {
      return state;
    },
    start,
    acceptSignal,
    send,
    info,
    close,
  };
}
