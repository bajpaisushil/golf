/**
 * The ONLY module in the app that touches web storage.
 *
 * WHAT IS STORED, AND WHY IT IS HARMLESS
 * --------------------------------------
 * `sessionStorage['fg.identity']` — reconnect identity for the CURRENT tab only:
 *   { playerId, peerId, displayName, color, roomCode, createdRoom, createdAt }.
 *   It exists so that hitting refresh mid-round reclaims your seat and your score
 *   instead of spawning a stranger. It dies with the tab. None of it is secret:
 *   every one of these values is already broadcast to the other players in the
 *   room the moment you join, and the room code is what you say out loud to
 *   invite people.
 *
 * `localStorage['fg.prefs']` — device preferences:
 *   { sound, quality, haptics, lastName }. Sound/haptics on-off, the rendering
 *   quality tier, and the last nickname you picked so the name field is
 *   pre-filled next time.
 *
 * NOTHING ELSE IS EVER STORED. No tokens, no emails, no addresses, no history,
 * no analytics, no identifiers that outlive the tab except a nickname you typed
 * yourself. There is no server to send any of it to — this game has none.
 *
 * ROBUSTNESS
 * ----------
 * Every access is wrapped: Safari private mode throws on `setItem` (quota 0),
 * Chrome throws on merely *reading* `localStorage` when site data is blocked, and
 * during SSR the globals do not exist at all. Every reader therefore returns a
 * sane default instead of throwing, and every writer reports success as a boolean
 * rather than blowing up a render.
 */

import { DEFAULT_QUALITY_TIER, LIMITS, STORAGE_KEYS } from '@/game/config';
import {
  asPeerId,
  asPlayerId,
  asRoomCode,
  type Hex,
  type QualityTier,
  type RoomIdentity,
} from '@/types';

// ---------------------------------------------------------------------------
// Safe storage access
// ---------------------------------------------------------------------------

export type StorageKind = 'local' | 'session';

/**
 * Returns the requested Storage, or null when it is unavailable for ANY reason:
 * server-side rendering, private mode, blocked site data, a security error from
 * a sandboxed iframe. Never throws.
 */
function storageFor(kind: StorageKind): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    const store = kind === 'local' ? window.localStorage : window.sessionStorage;
    if (store === null || store === undefined) return null;
    return store;
  } catch {
    return null;
  }
}

/** Reads a raw string. Returns null when absent or storage is unavailable. */
function readRaw(kind: StorageKind, key: string): string | null {
  const store = storageFor(kind);
  if (store === null) return null;
  try {
    return store.getItem(key);
  } catch {
    return null;
  }
}

/** Writes a raw string. Returns false when storage refused (quota, private mode). */
function writeRaw(kind: StorageKind, key: string, value: string): boolean {
  const store = storageFor(kind);
  if (store === null) return false;
  try {
    store.setItem(key, value);
    return true;
  } catch {
    // QuotaExceededError in private mode, or a blocked-storage SecurityError.
    return false;
  }
}

/** Removes a key. Silent no-op when storage is unavailable. */
function removeRaw(kind: StorageKind, key: string): void {
  const store = storageFor(kind);
  if (store === null) return;
  try {
    store.removeItem(key);
  } catch {
    // nothing to do — the value simply stays
  }
}

/** JSON.parse that yields `null` rather than throwing on malformed input. */
function parseJson(raw: string | null): unknown {
  if (raw === null || raw.length === 0) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/** True when `value` is a non-null, non-array object we can read fields from. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** True when web storage can actually be written to on this device. */
export function isStorageAvailable(kind: StorageKind = 'local'): boolean {
  const probe = `${STORAGE_KEYS.prefs}.probe`;
  if (!writeRaw(kind, probe, '1')) return false;
  removeRaw(kind, probe);
  return true;
}

// ---------------------------------------------------------------------------
// Reconnect identity (sessionStorage — dies with the tab)
// ---------------------------------------------------------------------------

/**
 * Reads the reconnect identity for this tab. Returns null when nothing is
 * stored, when storage is blocked, or when the stored blob has the wrong shape
 * (an old build, or somebody poking at devtools — we never trust it blindly).
 */
export function loadIdentity(): RoomIdentity | null {
  const parsed = parseJson(readRaw('session', STORAGE_KEYS.identity));
  if (!isRecord(parsed)) return null;

  const playerId = asString(parsed['playerId']);
  const peerId = asString(parsed['peerId']);
  const displayName = asString(parsed['displayName']);
  const color = asString(parsed['color']);
  const roomCode = asString(parsed['roomCode']);
  if (playerId === null || peerId === null || displayName === null || roomCode === null) return null;

  const createdAtRaw = parsed['createdAt'];
  const createdAt = typeof createdAtRaw === 'number' && Number.isFinite(createdAtRaw) ? createdAtRaw : 0;

  return {
    playerId: asPlayerId(playerId),
    peerId: asPeerId(peerId),
    displayName: displayName.slice(0, LIMITS.MAX_NAME_LENGTH),
    color: (color === null ? '#F2F4F8' : color) as Hex,
    roomCode: asRoomCode(roomCode),
    createdRoom: asBoolean(parsed['createdRoom'], false),
    createdAt,
  };
}

/**
 * Persists the reconnect identity. Returns false when storage refused — callers
 * should carry on regardless, since losing this only costs a seat on refresh.
 */
export function saveIdentity(identity: RoomIdentity): boolean {
  try {
    return writeRaw(
      'session',
      STORAGE_KEYS.identity,
      JSON.stringify({
        playerId: identity.playerId,
        peerId: identity.peerId,
        displayName: identity.displayName,
        color: identity.color,
        roomCode: identity.roomCode,
        createdRoom: identity.createdRoom,
        createdAt: identity.createdAt,
      }),
    );
  } catch {
    return false;
  }
}

/** Forgets the reconnect identity. Called on "leave room" and on a clean game end. */
export function clearIdentity(): void {
  removeRaw('session', STORAGE_KEYS.identity);
}

/**
 * The stored identity, but only if it belongs to `roomCode`. Prevents a stale
 * identity from one room being replayed into a different room after navigation.
 */
export function loadIdentityForRoom(roomCode: string): RoomIdentity | null {
  const identity = loadIdentity();
  if (identity === null) return null;
  return identity.roomCode === roomCode.toUpperCase() ? identity : null;
}

// ---------------------------------------------------------------------------
// Preferences (localStorage — survives the tab, still harmless)
// ---------------------------------------------------------------------------

/**
 * Device preferences. `sound` and `quality` are the contract fields (see
 * docs/CONTRACTS.md §37); `haptics` and `lastName` are optional extras so that
 * `savePrefs({ sound, quality })` from older call sites still type-checks and
 * still preserves them — {@link savePrefs} merges rather than replaces.
 */
export interface Prefs {
  readonly sound: boolean;
  readonly quality: QualityTier;
  readonly haptics?: boolean;
  /** Last nickname the player typed, so the name field is pre-filled. */
  readonly lastName?: string;
}

/** Sound and haptics default ON; quality starts at the safe middle tier. */
export const DEFAULT_PREFS: Required<Prefs> = {
  sound: true,
  quality: DEFAULT_QUALITY_TIER,
  haptics: true,
  lastName: '',
};

function asQualityTier(value: unknown): QualityTier {
  return value === 'high' || value === 'medium' || value === 'low' ? value : DEFAULT_PREFS.quality;
}

/**
 * Reads preferences, filling in defaults for anything missing or malformed.
 * ALWAYS returns a fully populated object — never null, never throws.
 */
export function loadPrefs(): Required<Prefs> {
  const parsed = parseJson(readRaw('local', STORAGE_KEYS.prefs));
  if (!isRecord(parsed)) return DEFAULT_PREFS;

  const lastNameRaw = parsed['lastName'];
  const lastName =
    typeof lastNameRaw === 'string' ? lastNameRaw.slice(0, LIMITS.MAX_NAME_LENGTH) : DEFAULT_PREFS.lastName;

  return {
    sound: asBoolean(parsed['sound'], DEFAULT_PREFS.sound),
    quality: asQualityTier(parsed['quality']),
    haptics: asBoolean(parsed['haptics'], DEFAULT_PREFS.haptics),
    lastName,
  };
}

/**
 * Writes preferences, MERGING over whatever is already stored, so a caller that
 * only knows about `{ sound, quality }` never silently wipes `haptics` or
 * `lastName`. Returns false when storage refused.
 */
export function savePrefs(prefs: Prefs): boolean {
  const current = loadPrefs();
  const next: Required<Prefs> = {
    sound: typeof prefs.sound === 'boolean' ? prefs.sound : current.sound,
    quality: asQualityTier(prefs.quality),
    haptics: typeof prefs.haptics === 'boolean' ? prefs.haptics : current.haptics,
    lastName:
      typeof prefs.lastName === 'string' ? prefs.lastName.slice(0, LIMITS.MAX_NAME_LENGTH) : current.lastName,
  };
  try {
    return writeRaw('local', STORAGE_KEYS.prefs, JSON.stringify(next));
  } catch {
    return false;
  }
}

/** Merges a subset of preferences into storage and returns the result. */
export function patchPrefs(patch: Partial<Prefs>): Required<Prefs> {
  savePrefs({ ...loadPrefs(), ...patch });
  return loadPrefs();
}

/** Forgets all preferences (the "reset" button in settings). */
export function clearPrefs(): void {
  removeRaw('local', STORAGE_KEYS.prefs);
}

/** Convenience reader used by `utils/sound`. */
export function soundPref(): boolean {
  return loadPrefs().sound;
}

/** Convenience reader used by `utils/haptics`. */
export function hapticsPref(): boolean {
  return loadPrefs().haptics;
}

/** The nickname this device used last, or '' when there is none. */
export function lastNamePref(): string {
  return loadPrefs().lastName;
}

/** Remembers the nickname the player just chose. Harmless: they typed it themselves. */
export function rememberName(name: string): void {
  patchPrefs({ lastName: name.slice(0, LIMITS.MAX_NAME_LENGTH) });
}

/**
 * Wipes EVERYTHING this app has ever stored on the device. Wired to a visible
 * "forget me" control so the promise in the header is verifiable, not just a claim.
 */
export function clearAllStorage(): void {
  clearIdentity();
  clearPrefs();
}
