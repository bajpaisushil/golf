/**
 * Collision primitives for the deterministic simulation.
 *
 * DETERMINISM CONTRACT: only `+ - * /`, `Math.sqrt`, `Math.abs`, `Math.min`,
 * `Math.max`, `Math.floor`. Pure functions, no shared mutable state.
 *
 * Every contact is expressed as a normal that points FROM the obstacle TOWARD
 * the ball, plus a non-negative penetration depth. Moving the ball by
 * `normal * penetration` always puts it exactly on the surface, which is what
 * keeps the integrator from ever leaving a ball buried inside a wall.
 */

import type { Rect, Vec2 } from '@/types';

/** Normal points FROM the obstacle TOWARD the ball. `penetration` >= 0. */
export interface Contact {
  readonly normal: Vec2;
  readonly penetration: number;
}

/**
 * Fraction of the TANGENTIAL velocity kept through a bounce.
 *
 * Not in `@/game/config` (that file is owned by the contracts agent) - it is a
 * feel constant local to collision response. 1 = frictionless rails, which makes
 * glancing hits feel slippery; a hair under 1 makes walls feel like felt-covered
 * timber and settles the ball nicely after a corner rattle.
 *
 * NOTE FOR THE INTEGRATION PASS: promote this to `PHYSICS.BOUNCE_TANGENT_KEEP`.
 */
export const BOUNCE_TANGENT_KEEP = 0.985;

/** Deterministic fallback normal for perfectly concentric circles (points up-course). */
const DEGENERATE_NORMAL: Vec2 = Object.freeze({ x: 0, y: -1 });

export function pointInRect(px: number, py: number, r: Rect): boolean {
  return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
}

/** Closest point on (or inside) the rect to `p`, i.e. `p` clamped to the rect. */
export function closestPointOnRect(px: number, py: number, r: Rect): Vec2 {
  const x = Math.min(Math.max(px, r.x), r.x + r.w);
  const y = Math.min(Math.max(py, r.y), r.y + r.h);
  return { x, y };
}

export function circleIntersectsRect(cx: number, cy: number, radius: number, r: Rect): boolean {
  const qx = Math.min(Math.max(cx, r.x), r.x + r.w);
  const qy = Math.min(Math.max(cy, r.y), r.y + r.h);
  const dx = cx - qx;
  const dy = cy - qy;
  return dx * dx + dy * dy < radius * radius;
}

/**
 * Circle-vs-AABB contact.
 *
 * Outside case: the normal is the direction from the closest surface point to
 * the centre. Inside case (the centre itself is within the rect - only reachable
 * through a tunnelling edge case): the ball is pushed out along the axis of LEAST
 * penetration, scanned in the fixed order `-x, +x, -y, +y` so the tie-break is
 * identical on every device.
 */
export function circleRectContact(cx: number, cy: number, radius: number, r: Rect): Contact | null {
  const right = r.x + r.w;
  const bottom = r.y + r.h;

  if (cx > r.x && cx < right && cy > r.y && cy < bottom) {
    // Centre inside: pick the cheapest way out, deterministic order -x, +x, -y, +y.
    const outLeft = cx - r.x + radius;
    const outRight = right - cx + radius;
    const outUp = cy - r.y + radius;
    const outDown = bottom - cy + radius;

    let best = outLeft;
    let nx = -1;
    let ny = 0;
    if (outRight < best) {
      best = outRight;
      nx = 1;
      ny = 0;
    }
    if (outUp < best) {
      best = outUp;
      nx = 0;
      ny = -1;
    }
    if (outDown < best) {
      best = outDown;
      nx = 0;
      ny = 1;
    }
    return { normal: { x: nx, y: ny }, penetration: best };
  }

  const qx = Math.min(Math.max(cx, r.x), right);
  const qy = Math.min(Math.max(cy, r.y), bottom);
  const dx = cx - qx;
  const dy = cy - qy;
  const d2 = dx * dx + dy * dy;
  if (d2 >= radius * radius) return null;
  if (!(d2 > 0)) {
    // Exactly on the boundary with a zero-area degenerate rect.
    return { normal: DEGENERATE_NORMAL, penetration: radius };
  }
  const d = Math.sqrt(d2);
  return { normal: { x: dx / d, y: dy / d }, penetration: radius - d };
}

/** Circle A (the ball) against circle B (a bumper / the cup lip). */
export function circleCircleContact(
  ax: number,
  ay: number,
  ar: number,
  bx: number,
  by: number,
  br: number,
): Contact | null {
  const dx = ax - bx;
  const dy = ay - by;
  const sum = ar + br;
  const d2 = dx * dx + dy * dy;
  if (d2 >= sum * sum) return null;
  if (!(d2 > 0)) {
    // Perfectly concentric: any normal is "correct"; pick a fixed one.
    return { normal: DEGENERATE_NORMAL, penetration: sum };
  }
  const d = Math.sqrt(d2);
  return { normal: { x: dx / d, y: dy / d }, penetration: sum - d };
}

/**
 * Velocity after a bounce off a surface with unit normal `n`.
 *
 * The NORMAL component is reversed and scaled by `restitution` (>1 for bumpers,
 * which is what makes them kick); the TANGENTIAL component is preserved apart
 * from {@link BOUNCE_TANGENT_KEEP}. A ball already moving away from the surface
 * is returned untouched, which prevents the double-hit jitter you get when two
 * obstacles are resolved in the same step.
 */
export function bounceVelocity(vx: number, vy: number, n: Vec2, restitution: number): Vec2 {
  const vn = vx * n.x + vy * n.y;
  if (vn >= 0) return { x: vx, y: vy };
  const tx = vx - vn * n.x;
  const ty = vy - vn * n.y;
  const outward = -vn * restitution;
  return {
    x: tx * BOUNCE_TANGENT_KEEP + n.x * outward,
    y: ty * BOUNCE_TANGENT_KEEP + n.y * outward,
  };
}

/** True when the ball centre is inside the hole AND slow enough to be captured. */
export function circleInsideCircle(
  px: number,
  py: number,
  cx: number,
  cy: number,
  radius: number,
): boolean {
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy < radius * radius;
}

/** Axis-aligned overlap test used by the generator to keep spawn/hole areas clear. */
export function rectOverlapsCircle(r: Rect, cx: number, cy: number, radius: number): boolean {
  return circleIntersectsRect(cx, cy, radius, r);
}

export function rectOverlapsRect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Same as {@link rectOverlapsRect} but with a keep-out gap on every side of `a`. */
export function rectOverlapsRectPadded(a: Rect, b: Rect, pad: number): boolean {
  return (
    a.x - pad < b.x + b.w &&
    b.x < a.x + a.w + pad &&
    a.y - pad < b.y + b.h &&
    b.y < a.y + a.h + pad
  );
}

/** True when the two circles overlap (used for bumper-vs-bumper spacing). */
export function circleOverlapsCircle(
  ax: number,
  ay: number,
  ar: number,
  bx: number,
  by: number,
  br: number,
): boolean {
  const dx = ax - bx;
  const dy = ay - by;
  const sum = ar + br;
  return dx * dx + dy * dy < sum * sum;
}
