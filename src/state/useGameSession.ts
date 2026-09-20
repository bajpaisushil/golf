'use client';

/**
 * The bridge between `RoomSession` (network + rules) and the zustand store (UI).
 *
 * This is the ONLY module allowed to construct signaling + transport +
 * `RoomSession`, and the only place that owns their lifecycle.
 *
 * The live session is a MODULE-LEVEL singleton, not per-component state: a tab
 * is in exactly one room, and the lobby, the game screen and the results screen
 * all call `useGameSession()` and must talk to the SAME session. Hook instances
 * are reference-counted, and the teardown on the last unmount is deferred by one
 * macrotask so that swapping one screen for another (and React StrictMode's
 * development remount) does not tear the room down underneath the player.
 *
 * Responsibilities:
 *  - create / join a room, reusing the sessionStorage reconnect identity
 *  - mirror session state, peers, signaling health and errors into the store
 *  - expose the action surface (shoot, start, next round, end, emote, leave)
 *  - enforce HOST-ONLY guards locally, so a guest never sends a message the rest
 *    of the mesh would only have to reject
 *  - tear everything down on unmount AND when the page is closed
 *
 * Nothing here is simulation code, so `Date.now()` / `performance.now()` are
 * fine: they drive animation start times and identity timestamps only.
 */

import { useCallback, useEffect, useMemo } from 'react';

import {
  DEFAULT_BATTLE_ROUNDS,
  DEFAULT_SETTINGS,
  LIMITS,
  SCORING,
  playerColorFor,
} from '@/game/config';
import { createRoomSession } from '@/multiplayer/room/roomSession';
import type { RoomSession, SessionEvent } from '@/multiplayer/room/roomSession';
import {
  createBroadcastChannelSignaling,
  isBroadcastChannelSupported,
} from '@/multiplayer/signaling/broadcastChannelSignaling';
import { createCompositeSignaling } from '@/multiplayer/signaling/compositeSignaling';
import { createNostrSignaling } from '@/multiplayer/signaling/nostrSignaling';
import type { SignalingChannel } from '@/multiplayer/signaling/types';
import { createMeshTransport } from '@/multiplayer/transport/types';
import type { Transport } from '@/multiplayer/transport/types';
import type {
  ConnectionState,
  GameMode,
  GameSettings,
  GameState,
  PeerInfo,
  Result,
  RoomCode,
  RoomIdentity,
  Unsubscribe,
  Vec2,
} from '@/types';
import { err, ok } from '@/types';
import { clampName } from '@/utils/format';
import { newPeerId, newPlayerId } from '@/utils/id';
import { generateRoomCode, isRoomCode, normaliseRoomCode } from '@/utils/roomCode';
import {
  clearIdentity,
  clearResume,
  loadIdentity,
  loadResume,
  saveIdentity,
  saveResume,
} from '@/utils/storage';
import { holdIdentity, isIdentityHeld } from '@/utils/tabClaim';

import { normaliseSettings } from './gameReducer';
import { useGameStore } from './store';

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface UseGameSession {
  readonly game: GameState | null;
  readonly identity: RoomIdentity | null;
  readonly peers: readonly PeerInfo[];
  readonly connection: ConnectionState;
  readonly error: string | null;
  readonly isHost: boolean;
  createRoom(args: {
    name: string;
    mode: GameMode;
    totalRounds: number | null;
  }): Promise<Result<RoomCode, string>>;
  joinRoom(args: { name: string; code: RoomCode }): Promise<Result<void, string>>;
  submitShot(aim: Vec2, power: number): void;
  startGame(): void;
  startNextRound(): void;
  /** Host only. The lobby uses it for the round-count picker. */
  changeSettings(patch: Partial<GameSettings>): void;
  endGame(): void;
  sendEmote(emoji: string): void;
  leave(): void;
}

// ---------------------------------------------------------------------------
// The singleton session
// ---------------------------------------------------------------------------

interface SessionBundle {
  readonly session: RoomSession;
  readonly transport: Transport;
  readonly signaling: SignalingChannel;
  readonly identity: RoomIdentity;
  readonly unsubscribes: readonly Unsubscribe[];
}

let activeBundle: SessionBundle | null = null;
/** Answers "is this player id in use?" for as long as this tab holds it. */
let claimRelease: (() => void) | null = null;
let mountCount = 0;
let pendingTeardown: ReturnType<typeof setTimeout> | null = null;

/**
 * How long the singleton survives with zero mounted hook instances before it is
 * torn down. This is a REACT LIFECYCLE detail, not a protocol timing, which is
 * why it lives here rather than in `config.TIMING`: a client-side route change
 * from `/` to `/room/?code=...` unmounts one screen and mounts the next, and a
 * Suspense boundary (`useSearchParams` needs one under static export) can put a
 * tick or two between the two. Tearing the mesh down in that gap would drop the
 * room the player just created.
 */
const HANDOFF_GRACE_MS = 400;

/** Presentation clock. Never used by the simulation. */
function nowMs(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

function teardownSession(options: { readonly forget: boolean }): void {
  // Stop answering claim probes: this id is free for another tab to resume.
  if (claimRelease !== null) {
    claimRelease();
    claimRelease = null;
  }
  const bundle = activeBundle;
  activeBundle = null;
  if (bundle === null) {
    if (options.forget) clearIdentity();
    return;
  }

  for (const unsubscribe of bundle.unsubscribes) {
    try {
      unsubscribe();
    } catch {
      /* a listener that is already gone is not an error */
    }
  }
  try {
    bundle.session.leave();
  } catch {
    /* best effort - we are tearing down anyway */
  }
  try {
    bundle.signaling.close();
  } catch {
    /* close is idempotent by contract, but never let it throw here */
  }
  if (options.forget) clearIdentity();
}

/**
 * Default room signaling: a BroadcastChannel (instant, same-browser tabs - this
 * is what makes local multi-tab testing work with zero infrastructure)
 * composited with free public Nostr relays for real cross-device play.
 * No server of ours, anywhere.
 */
function createRoomSignaling(): SignalingChannel {
  const channels: SignalingChannel[] = [];
  if (isBroadcastChannelSupported()) channels.push(createBroadcastChannelSignaling());
  channels.push(createNostrSignaling());
  return createCompositeSignaling(channels);
}

function deriveConnection(peers: readonly PeerInfo[]): ConnectionState {
  if (peers.length === 0) return 'connecting';
  if (peers.some((peer) => peer.state === 'connected')) return 'connected';
  if (
    peers.some(
      (peer) =>
        peer.state === 'connecting' || peer.state === 'signaling' || peer.state === 'reconnecting',
    )
  ) {
    return 'connecting';
  }
  if (peers.every((peer) => peer.state === 'failed')) return 'failed';
  return 'disconnected';
}

/**
 * Reuses the stored playerId when rejoining the SAME room, so a refresh comes
 * back as the same player holding the same score instead of as a ghost.
 * sessionStorage for this tab, plus an EXPIRING localStorage hint so a closed
 * tab can rejoin. Neither holds anything sensitive: id, name, room code.
 */
async function buildIdentity(args: {
  readonly name: string;
  readonly code: RoomCode;
  readonly createdRoom: boolean;
}): Promise<{ readonly identity: RoomIdentity; readonly reconnect: boolean }> {
  // This TAB's identity wins. It is the only per-tab record, so two tabs on one
  // device stay two distinct players rather than fighting over one seat.
  const stored = loadIdentity();
  const reuse = stored !== null && stored.roomCode === args.code;

  // Nothing in this tab, but the browser may still hold an unexpired resume hint
  // from a tab that was closed. Reusing its playerId is what lets the host give
  // the seat back instead of seating a duplicate player.
  //
  // But localStorage is shared by every tab, so we must not adopt an id that a
  // LIVE tab is already playing as — that would put two tabs on one seat and the
  // room would show one player instead of two. Ask first.
  const hint = reuse ? null : loadResume(Date.now());
  const resumable =
    hint !== null && hint.roomCode === args.code && !(await isIdentityHeld(hint.playerId));

  return {
    reconnect: reuse || resumable,
    identity: {
      playerId: reuse ? stored.playerId : resumable ? hint.playerId : newPlayerId(),
      // Always a fresh PeerId: the transport link is new even on a rejoin.
      peerId: newPeerId(),
      displayName: args.name,
      color:
        reuse && stored.color.length > 0
          ? stored.color
          : resumable && hint.color.length > 0
            ? hint.color
            : playerColorFor(0),
      roomCode: args.code,
      // Reloading into your own room goes through joinRoom(), which knows
      // nothing about who created it. Keep the stored flag so the creator can
      // still take an empty room back instead of returning as a plain player.
      createdRoom:
        args.createdRoom || (reuse && stored.createdRoom) || (resumable && hint.createdRoom),
      createdAt: Date.now(),
    },
  };
}

function buildSettings(mode: GameMode, totalRounds: number | null): GameSettings {
  // Co-op stays endless unless the host says otherwise; battle always has a count.
  const rounds = mode === 'battle' ? (totalRounds ?? DEFAULT_BATTLE_ROUNDS) : totalRounds;
  return normaliseSettings({
    ...DEFAULT_SETTINGS,
    totalRounds: rounds,
    maxStrokes: LIMITS.MAX_STROKES,
    rankBy: SCORING.rankBy,
  });
}

function handleSessionEvent(event: SessionEvent): void {
  const store = useGameStore.getState();
  switch (event.type) {
    case 'shot-playback':
      store.setPlayback({
        playerId: event.playerId,
        path: event.result.path,
        durationMs: event.result.durationMs,
        holed: event.result.holed,
        startedAt: nowMs(),
      });
      break;
    case 'round-started':
    case 'round-completed':
    case 'game-ended':
      store.setPlayback(null);
      break;
    case 'error':
      store.setError(event.message);
      break;
    default:
      // 'holed' | 'emote' | 'host-changed' are already visible in GameState or
      // are purely cosmetic; components read them from there.
      break;
  }
}

/** Builds, wires and starts a session. Replaces any session already running. */
async function attachSession(args: {
  readonly identity: RoomIdentity;
  readonly mode: GameMode;
  readonly isHost: boolean;
  readonly settings: GameSettings;
  readonly reconnect: boolean;
}): Promise<Result<void, string>> {
  const signaling = createRoomSignaling();
  const transport = createMeshTransport({ identity: args.identity, signaling });
  const session = createRoomSession({
    identity: args.identity,
    transport,
    mode: args.mode,
    isHost: args.isHost,
    settings: args.settings,
    reconnect: args.reconnect,
    // Creator of this room: may take it back if they reload into an empty room.
    reclaimHost: args.identity.createdRoom,
  });

  const unsubscribes: Unsubscribe[] = [
    session.subscribe((state) => {
      useGameStore.getState().setGame(state);

      // A resume hint is only worth keeping while a game is actually under way.
      // Writing it the moment a room was created left people with a "rejoin"
      // prompt for a game that never started; keeping it after the game ended
      // offered to rejoin something finished.
      if (state.status === 'playing' || state.status === 'round-summary') {
        saveResume(args.identity, Date.now());
      } else if (state.status === 'finished') {
        clearResume();
      }
    }),
    session.onEvent(handleSessionEvent),
    transport.onPeers((peers) => {
      const store = useGameStore.getState();
      store.setPeers(peers);
      store.setConnection(deriveConnection(peers));
    }),
    signaling.onStatus((status) => {
      useGameStore.getState().setSignaling(status);
    }),
  ];

  activeBundle = { session, transport, signaling, identity: args.identity, unsubscribes };

  const store = useGameStore.getState();
  store.setIdentity(args.identity);
  store.setError(null);
  store.setConnection('signaling');
  store.setGame(session.getState());

  const started = await session.start();
  if (!started.ok) {
    teardownSession({ forget: false });
    const failed = useGameStore.getState();
    failed.setConnection('failed');
    failed.setError(started.error);
    return err(started.error);
  }

  const live = useGameStore.getState();
  live.setGame(session.getState());
  live.setPeers(transport.peers());
  return ok(undefined);
}

async function createRoomImpl(args: {
  name: string;
  mode: GameMode;
  totalRounds: number | null;
}): Promise<Result<RoomCode, string>> {
  if (typeof window === 'undefined') return err('Multiplayer needs a browser.');

  const name = clampName(args.name);
  if (name.length === 0) return err('Pick a name your friends will recognise.');

  // A brand new room means a brand new identity - drop the old one first.
  teardownSession({ forget: true });

  const code = generateRoomCode();
  const { identity } = await buildIdentity({ name, code, createdRoom: true });
  saveIdentity(identity);
  claimRelease = holdIdentity(identity.playerId);

  const attached = await attachSession({
    identity,
    mode: args.mode,
    isHost: true,
    settings: buildSettings(args.mode, args.totalRounds),
    // A freshly minted room code can never be a reconnect.
    reconnect: false,
  });
  if (!attached.ok) return err(attached.error);
  return ok(code);
}

async function joinRoomImpl(args: {
  name: string;
  code: RoomCode;
}): Promise<Result<void, string>> {
  if (typeof window === 'undefined') return err('Multiplayer needs a browser.');

  const name = clampName(args.name);
  if (name.length === 0) return err('Pick a name your friends will recognise.');

  const code = normaliseRoomCode(args.code);
  if (!isRoomCode(code)) return err('That room code does not look right.');

  // Keep the stored identity: rejoining the same room must reuse our playerId.
  teardownSession({ forget: false });

  const { identity, reconnect } = await buildIdentity({ name, code, createdRoom: false });
  saveIdentity(identity);
  claimRelease = holdIdentity(identity.playerId);

  // Mode and settings arrive authoritatively in WELCOME; these are only what the
  // local state starts from before the host answers.
  return attachSession({
    identity,
    mode: 'together',
    isHost: false,
    settings: buildSettings('together', null),
    reconnect,
  });
}

function currentSession(): RoomSession | null {
  const bundle = activeBundle;
  if (bundle === null) {
    useGameStore.getState().setError('You are not in a room yet.');
    return null;
  }
  return bundle.session;
}

/**
 * Host-only guard applied locally, before anything reaches the mesh.
 * `session.isHost()` is authoritative here - it follows host migration, which a
 * stale render of `GameState` in a component might not have caught up with yet.
 */
function hostSession(what: string): RoomSession | null {
  const bundle = activeBundle;
  if (bundle === null) {
    useGameStore.getState().setError('You are not in a room yet.');
    return null;
  }
  if (!bundle.session.isHost()) {
    useGameStore.getState().setError(`Only the host can ${what}.`);
    return null;
  }
  return bundle.session;
}

function reportFailure(result: Result<void, string>): void {
  const store = useGameStore.getState();
  if (result.ok) store.setError(null);
  else store.setError(result.error);
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useGameSession(): UseGameSession {
  // Narrow selectors: the 3D scene must not re-render because a peer's RTT moved.
  const game = useGameStore((s) => s.game);
  const identity = useGameStore((s) => s.identity);
  const peers = useGameStore((s) => s.peers);
  const connection = useGameStore((s) => s.connection);
  const error = useGameStore((s) => s.lastError);

  /** True when THIS peer currently holds host authority. */
  const isHost = useMemo(() => {
    if (game === null || identity === null) return false;
    return game.hostPlayerId === identity.playerId;
  }, [game, identity]);

  const createRoom = useCallback(createRoomImpl, []);
  const joinRoom = useCallback(joinRoomImpl, []);

  const submitShot = useCallback((aim: Vec2, power: number) => {
    const session = currentSession();
    if (session === null) return;
    reportFailure(session.submitShot(aim, power));
  }, []);

  const startGame = useCallback(() => {
    const session = hostSession('start the game');
    if (session === null) return;
    reportFailure(session.startGame());
  }, []);

  const startNextRound = useCallback(() => {
    const session = hostSession('start the next round');
    if (session === null) return;
    reportFailure(session.startNextRound());
  }, []);

  const changeSettings = useCallback((patch: Partial<GameSettings>) => {
    const session = hostSession('change the room settings');
    if (session === null) return;
    reportFailure(session.changeSettings(patch));
  }, []);

  const endGame = useCallback(() => {
    const session = hostSession('end the game');
    if (session === null) return;
    reportFailure(session.endGame());
  }, []);

  const sendEmote = useCallback((emoji: string) => {
    const bundle = activeBundle;
    if (bundle === null) return;
    bundle.session.sendEmote(emoji);
  }, []);

  const leave = useCallback(() => {
    teardownSession({ forget: true });
    useGameStore.getState().reset();
  }, []);

  // Lifecycle. The session outlives any single screen, so it is only torn down
  // when the LAST hook instance goes away (deferred by a macrotask so a screen
  // swap - and StrictMode's dev remount - does not kill the room), or when the
  // page itself goes away. Leaving properly means peers stop waiting out the
  // whole reconnect grace period for somebody who is never coming back.
  useEffect(() => {
    mountCount += 1;
    if (pendingTeardown !== null) {
      clearTimeout(pendingTeardown);
      pendingTeardown = null;
    }

    const handlePageHide = (): void => {
      teardownSession({ forget: false });
    };
    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', handlePageHide);
      window.addEventListener('beforeunload', handlePageHide);
    }

    return () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('pagehide', handlePageHide);
        window.removeEventListener('beforeunload', handlePageHide);
      }
      mountCount = Math.max(0, mountCount - 1);
      if (mountCount > 0) return;
      if (pendingTeardown !== null) clearTimeout(pendingTeardown);
      pendingTeardown = setTimeout(() => {
        pendingTeardown = null;
        if (mountCount === 0) teardownSession({ forget: false });
      }, HANDOFF_GRACE_MS);
    };
  }, []);

  return {
    game,
    identity,
    peers,
    connection,
    error,
    isHost,
    createRoom,
    joinRoom,
    submitShot,
    startGame,
    startNextRound,
    changeSettings,
    endGame,
    sendEmote,
    leave,
  };
}
