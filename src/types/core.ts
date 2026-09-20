/**
 * Core primitive types shared by every layer (simulation, network, UI).
 *
 * This file must stay dependency-free: it imports nothing, so it can be pulled
 * into the deterministic simulation, the worker-free network layer and the
 * React tree without dragging anything else along.
 */

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/**
 * A 2D point / vector in COURSE UNITS ("cu"), origin top-left, +x right, +y down.
 * Immutable on purpose: the deterministic simulation never mutates shared state,
 * it produces fresh values. Use {@link MutableVec2} for local scratch objects.
 */
export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

/** Mutable twin of {@link Vec2}, only for module-level scratch objects (renderer, input). */
export interface MutableVec2 {
  x: number;
  y: number;
}

/** An axis-aligned rectangle in course units. (x,y) is the TOP-LEFT corner. */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** A circle in course units. */
export interface Circle {
  readonly cx: number;
  readonly cy: number;
  readonly r: number;
}

// ---------------------------------------------------------------------------
// Branded ids
// ---------------------------------------------------------------------------

declare const BRAND: unique symbol;

/** Nominal typing helper: `Brand<string, 'PlayerId'>` is not assignable from a raw string. */
export type Brand<T, B extends string> = T & { readonly [BRAND]: B };

/** Stable identity of a human player for the lifetime of a room (survives reconnects). */
export type PlayerId = Brand<string, 'PlayerId'>;

/** Uppercase A-Z0-9 room code, LIMITS.ROOM_CODE_LENGTH characters long. */
export type RoomCode = Brand<string, 'RoomCode'>;

/** Identity of one RTCPeerConnection endpoint. A reconnecting player keeps its PlayerId but gets a new PeerId. */
export type PeerId = Brand<string, 'PeerId'>;

/** Level theme identifier, e.g. 'meadow' | 'dusk'. Kept open so themes.ts owns the list. */
export type ThemeId = Brand<string, 'ThemeId'>;

export const asPlayerId = (value: string): PlayerId => value as PlayerId;
export const asPeerId = (value: string): PeerId => value as PeerId;
export const asThemeId = (value: string): ThemeId => value as ThemeId;

/** Normalises to uppercase and brands. Does NOT validate length - see utils/roomCode.isRoomCode. */
export const asRoomCode = (value: string): RoomCode => value.toUpperCase() as RoomCode;

// ---------------------------------------------------------------------------
// Scalars with meaning
// ---------------------------------------------------------------------------

/** Milliseconds since the UNIX epoch (wall clock). Never used inside the simulation. */
export type Timestamp = number;
/** A duration in milliseconds. */
export type Millis = number;
/** A duration in seconds (simulation time). */
export type Seconds = number;
/** A `#rrggbb` colour string. */
export type Hex = string;

/** Rendering fidelity tier, picked once from device capability and stored in localStorage. */
export type QualityTier = 'high' | 'medium' | 'low';

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}

export interface Err<E> {
  readonly ok: false;
  readonly error: E;
}

/**
 * Explicit success/failure value. Used everywhere a failure is EXPECTED
 * (bad room code, rejected message, peer connection failure) instead of throwing.
 */
export type Result<T, E = string> = Ok<T> | Err<E>;

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = <E>(error: E): Err<E> => ({ ok: false, error });

export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.ok;
}

export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return !result.ok;
}

/** Returns the value, or `fallback` when the result is an error. */
export function unwrapOr<T, E>(result: Result<T, E>, fallback: T): T {
  return result.ok ? result.value : fallback;
}

/** Maps the success value, passing errors through untouched. */
export function mapResult<T, U, E>(result: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  return result.ok ? ok(fn(result.value)) : result;
}

// ---------------------------------------------------------------------------
// Utility types
// ---------------------------------------------------------------------------

/** Recursively readonly. Handy for freezing snapshots handed to the renderer. */
export type DeepReadonly<T> = T extends (infer R)[]
  ? ReadonlyArray<DeepReadonly<R>>
  : T extends ReadonlyArray<infer R>
    ? ReadonlyArray<DeepReadonly<R>>
    // eslint-disable-next-line @typescript-eslint/ban-types
    : T extends Function
      ? T
      : T extends object
        ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
        : T;

/** A plain-object map keyed by PlayerId. Indexing yields `T | undefined` (noUncheckedIndexedAccess). */
export type PlayerMap<T> = Readonly<Record<PlayerId, T>>;

/** Unsubscribe handle returned by every subscribe()/on() API in the codebase. */
export type Unsubscribe = () => void;

/** Generic event listener. */
export type Listener<T> = (payload: T) => void;
