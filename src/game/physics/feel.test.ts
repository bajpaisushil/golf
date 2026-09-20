/**
 * The ball-feel slider drives PHYSICS, and BOTH ends must stay playable.
 * These are Sushil's three rules, asserted so retuning cannot quietly break them.
 */
import { describe, expect, it } from 'vitest';
import { simulateShot } from './simulate';
import { generateLevel } from '@/game/levels/generator';
import { PHYSICS, feelPhysicsFor } from '@/game/config';

const RIGID = feelPhysicsFor(0);
const VOLATILE = feelPhysicsFor(1);

/** An empty course, so we measure the ball and not the obstacles. */
const open = { ...generateLevel(7, 0, 0), obstacles: [] };
const tee = { x: open.width * 0.5, y: open.height - 6 };

describe('ball feel ends', () => {
  it('reaches the far end of the course at full force, at EITHER end of the slider', () => {
    for (const [name, feel] of [
      ['most rigid', RIGID],
      ['most volatile', VOLATILE],
    ] as const) {
      const r = simulateShot(open, tee, { x: 0, y: -1 }, 1, feel);
      // How far up the course did it get at its furthest point?
      const reached = Math.min(...r.path.map((p) => p.y));
      const travelled = tee.y - reached;
      expect(travelled, `${name} must cross the course (${open.height}cu)`).toBeGreaterThan(
        open.height * 0.92,
      );
    }
  });

  it('keeps working the walls at full force on most volatile', () => {
    const r = simulateShot(open, tee, { x: 0.32, y: -0.95 }, 1, VOLATILE);
    // Count direction reversals on each axis: every reversal is a rail hit.
    let bounces = 0;
    for (let i = 2; i < r.path.length; i += 1) {
      const a = r.path[i - 2]!;
      const b = r.path[i - 1]!;
      const c = r.path[i]!;
      const dx1 = b.x - a.x;
      const dx2 = c.x - b.x;
      const dy1 = b.y - a.y;
      const dy2 = c.y - b.y;
      if (dx1 * dx2 < 0 || dy1 * dy2 < 0) bounces += 1;
    }
    expect(bounces, 'should ricochet repeatedly, not die on the first rail').toBeGreaterThanOrEqual(3);
  });

  it('gentlest shot stays inside the cup even on most volatile', () => {
    // Otherwise a ball beside the hole can never be tapped in: you overshoot
    // however softly you pull.
    const r = simulateShot(open, tee, { x: 0, y: -1 }, PHYSICS.MIN_POWER, VOLATILE);
    const moved = Math.hypot(r.restPos.x - tee.x, r.restPos.y - tee.y);
    expect(moved).toBeLessThan(2.2);
  });

  it('still moves the ball at the very lowest force on most rigid', () => {
    const r = simulateShot(open, tee, { x: 0, y: -1 }, PHYSICS.MIN_POWER, RIGID);
    const moved = Math.hypot(r.restPos.x - tee.x, r.restPos.y - tee.y);
    // "Rigid" must mean settles quickly, never stuck.
    expect(moved).toBeGreaterThan(0.1);
  });

  it('is rigid-vs-volatile in the direction you would expect', () => {
    const soft = simulateShot(open, tee, { x: 0, y: -1 }, 0.4, RIGID);
    const lively = simulateShot(open, tee, { x: 0, y: -1 }, 0.4, VOLATILE);
    expect(lively.durationMs).toBeGreaterThan(soft.durationMs);
  });
});
