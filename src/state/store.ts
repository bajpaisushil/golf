/**
 * The zustand store.
 *
 * DELIBERATELY DUMB. It mirrors what `RoomSession` emits and nothing else: no
 * rules, no scoring, no turn logic. Everything that decides anything lives in
 * `@/game/rules` (pure) and `gameReducer.ts` (pure), so the multiplayer game can
 * be driven headlessly in vitest without React ever being involved.
 *
 * Read it with NARROW selectors - `useGameStore((s) => s.game)` - never by
 * destructuring the whole store, or every component re-renders on every packet.
 */

import { create } from 'zustand';

import type { ShotPlayback } from '@/game/rendering/three/types';
import type {
  ConnectionState,
  GameState,
  PeerInfo,
  RoomIdentity,
  SignalingStatus,
} from '@/types';

export interface GameStore {
  /** Who we are in this room (also mirrored into sessionStorage for reconnects). */
  readonly identity: RoomIdentity | null;
  /** The whole room, as produced by the pure reducer. null outside a session. */
  readonly game: GameState | null;
  readonly peers: readonly PeerInfo[];
  readonly connection: ConnectionState;
  readonly signaling: SignalingStatus;
  readonly lastError: string | null;
  /** The shot currently being animated, or null. Presentation only. */
  readonly playback: ShotPlayback | null;

  setIdentity(identity: RoomIdentity | null): void;
  setGame(state: GameState | null): void;
  setPeers(peers: readonly PeerInfo[]): void;
  setConnection(state: ConnectionState): void;
  setSignaling(status: SignalingStatus): void;
  setError(message: string | null): void;
  setPlayback(playback: ShotPlayback | null): void;
  reset(): void;
}

const EMPTY_PEERS: readonly PeerInfo[] = Object.freeze([]);

interface StoreData {
  readonly identity: RoomIdentity | null;
  readonly game: GameState | null;
  readonly peers: readonly PeerInfo[];
  readonly connection: ConnectionState;
  readonly signaling: SignalingStatus;
  readonly lastError: string | null;
  readonly playback: ShotPlayback | null;
}

const INITIAL: StoreData = {
  identity: null,
  game: null,
  peers: EMPTY_PEERS,
  connection: 'idle',
  signaling: 'idle',
  lastError: null,
  playback: null,
};

export const useGameStore = create<GameStore>()((set) => ({
  ...INITIAL,

  setIdentity: (identity) => set({ identity }),
  setGame: (game) => set({ game }),
  setPeers: (peers) => set({ peers }),
  setConnection: (connection) => set({ connection }),
  setSignaling: (signaling) => set({ signaling }),
  setError: (lastError) => set({ lastError }),
  setPlayback: (playback) => set({ playback }),
  reset: () => set({ ...INITIAL }),
}));

/** Non-reactive access for the session layer (event handlers, cleanup). */
export function gameStore(): GameStore {
  return useGameStore.getState();
}
