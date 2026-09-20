/**
 * Shot feel. These lock in two things that were reported as broken:
 *   1. a ball beside the cup must be nudgeable — the gentlest legal shot has to
 *      travel less than the cup is wide, or close putts are impossible;
 *   2. a strong straight putt has to be able to reach the hole in ONE strike.
 */
import { describe, expect, it } from 'vitest';
import { simulateShot, shotSpeedFor } from './simulate';
import { generateLevel } from '@/game/levels/generator';
import { LEVEL, PHYSICS } from '@/game/config';

const level = generateLevel(20260920, 0, 0);
const from = level.ballStart;

function carry(power: number, aim = { x: 0, y: -1 }): number {
  const r = simulateShot(level, from, aim, power);
  return Math.sqrt((r.restPos.x - from.x) ** 2 + (r.restPos.y - from.y) ** 2);
}

describe('shot feel', () => {
  it('lets the gentlest legal shot nudge a ball that is beside the cup', () => {
    // Anything longer than the cup and a ball sitting next to it can never be
    // tapped in — you overshoot every time, which is exactly what was reported.
    expect(carry(PHYSICS.MIN_POWER)).toBeLessThan(LEVEL.HOLE_RADIUS * 2);
  });

  it('gives short putts real resolution instead of one big jump', () => {
    const tap = carry(0.08);
    const nudge = carry(0.16);
    const firm = carry(0.3);
    expect(tap).toBeLessThan(nudge);
    expect(nudge).toBeLessThan(firm);
    // The bottom of the range must stay genuinely short.
    expect(tap).toBeLessThan(6);
  });

  it('can reach the hole in one strike with a strong straight putt', () => {
    const toHole = Math.sqrt(
      (level.hole.center.x - from.x) ** 2 + (level.hole.center.y - from.y) ** 2,
    );
    let holedInOne = false;
    for (let p = 0.5; p <= 1 && !holedInOne; p += 0.05) {
      const aim = {
        x: (level.hole.center.x - from.x) / toHole,
        y: (level.hole.center.y - from.y) / toHole,
      };
      holedInOne = simulateShot(level, from, aim, p).holed;
    }
    expect(holedInOne).toBe(true);
  });

  it('keeps the ball alive long enough to work the walls', () => {
    // A full-power shot used to die in about two seconds; it should now carry on
    // rebounding rather than thudding into the first rail and stopping.
    const r = simulateShot(level, from, { x: 0.8, y: -0.6 }, 1);
    expect(r.durationMs).toBeGreaterThan(2500);
  });

  it('never exceeds full power however hard you pull', () => {
    expect(shotSpeedFor(5)).toBe(PHYSICS.MAX_SHOT_SPEED);
    expect(shotSpeedFor(1)).toBe(PHYSICS.MAX_SHOT_SPEED);
    expect(shotSpeedFor(0)).toBe(0);
  });
});
