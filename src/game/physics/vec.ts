/**
 * Vec2 maths for the deterministic simulation.
 *
 * DETERMINISM CONTRACT: only `+ - * /`, `Math.sqrt`, `Math.abs`, `Math.min`,
 * `Math.max`, `Math.floor` appear in this file. No trig, no randomness, no clock.
 * Every function is pure and returns a FRESH object (treat results as frozen).
 *
 * Angles never exist in this codebase: a direction is always a normalised
 * `{x, y}` vector, because `Math.atan2`/`Math.sin` are not bit-identical across
 * JavaScript engines and would desync peers replaying the same shot.
 */

import type { Vec2 } from '@/types';

/** The zero vector. Frozen: it is handed out as a shared singleton. */
export const ZERO: Vec2 = Object.freeze({ x: 0, y: 0 });

/** Unit vector pointing to +x (right in course space). */
export const RIGHT: Vec2 = Object.freeze({ x: 1, y: 0 });

/** Unit vector pointing to +y (DOWN in course space - origin is top-left). */
export const DOWN: Vec2 = Object.freeze({ x: 0, y: 1 });

export function vec(x: number, y: number): Vec2 {
  return { x, y };
}

/** Defensive copy, so callers can never alias a caller-owned object. */
export function clone(a: Vec2): Vec2 {
  return { x: a.x, y: a.y };
}

export function add(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function sub(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function scale(a: Vec2, k: number): Vec2 {
  return { x: a.x * k, y: a.y * k };
}

/** `a + b * k` - the fused form the integrator uses, to avoid an intermediate. */
export function addScaled(a: Vec2, b: Vec2, k: number): Vec2 {
  return { x: a.x + b.x * k, y: a.y + b.y * k };
}

export function dot(a: Vec2, b: Vec2): number {
  return a.x * b.x + a.y * b.y;
}

/** 2D cross product (a scalar). Useful for side-of-line tests; no trig involved. */
export function cross(a: Vec2, b: Vec2): number {
  return a.x * b.y - a.y * b.x;
}

export function lengthSq(a: Vec2): number {
  return a.x * a.x + a.y * a.y;
}

export function length(a: Vec2): number {
  return Math.sqrt(a.x * a.x + a.y * a.y);
}

export function distanceSq(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

export function distance(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Unit vector with the same direction.
 * Zero-length (or non-finite) input returns {@link ZERO} - callers must treat
 * that as "no shot" rather than firing in an arbitrary direction.
 */
export function normalize(a: Vec2): Vec2 {
  const l2 = a.x * a.x + a.y * a.y;
  // Written as `!(l2 > 0)` so NaN falls through to ZERO instead of propagating.
  if (!(l2 > 0)) return ZERO;
  const l = Math.sqrt(l2);
  if (!(l > 0)) return ZERO;
  return { x: a.x / l, y: a.y / l };
}

/** Shrinks the vector to `max` length; shorter vectors are returned unchanged (as a copy). */
export function clampLength(a: Vec2, max: number): Vec2 {
  if (!(max > 0)) return ZERO;
  const l2 = a.x * a.x + a.y * a.y;
  if (!(l2 > 0)) return ZERO;
  if (l2 <= max * max) return { x: a.x, y: a.y };
  const k = max / Math.sqrt(l2);
  return { x: a.x * k, y: a.y * k };
}

/**
 * Mirror of `v` across the plane with unit normal `n`: `v - 2*(v.n)*n`.
 * `n` MUST already be unit length (see {@link normalize}).
 */
export function reflect(v: Vec2, n: Vec2): Vec2 {
  const d = 2 * (v.x * n.x + v.y * n.y);
  return { x: v.x - d * n.x, y: v.y - d * n.y };
}

/** Component of `v` along unit normal `n`, as a vector. */
export function project(v: Vec2, n: Vec2): Vec2 {
  const d = v.x * n.x + v.y * n.y;
  return { x: n.x * d, y: n.y * d };
}

/** Component of `v` perpendicular to unit normal `n`. */
export function tangent(v: Vec2, n: Vec2): Vec2 {
  const d = v.x * n.x + v.y * n.y;
  return { x: v.x - n.x * d, y: v.y - n.y * d };
}

export function negate(a: Vec2): Vec2 {
  return { x: -a.x, y: -a.y };
}

/**
 * Linear interpolation. PRESENTATION USE: the renderer walks a sampled path with
 * this. The simulation itself never interpolates.
 */
export function lerp(a: Vec2, b: Vec2, t: number): Vec2 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

export function equalsApprox(a: Vec2, b: Vec2, eps = 1e-6): boolean {
  return Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps;
}

/** True when both components are finite numbers - used to reject hostile wire data. */
export function isFiniteVec(a: Vec2): boolean {
  return Number.isFinite(a.x) && Number.isFinite(a.y);
}
