/**
 * The P2P model replays every shot locally on every peer instead of streaming
 * positions. That only works if simulateShot() is a PURE, DETERMINISTIC function.
 * These tests are the contract that makes the network model sound.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { simulateShot, shotSpeedFor, powerFromDrag, aimFromDrag } from './simulate';
import { generateLevel } from '@/game/levels/generator';
import { PHYSICS } from '@/game/config';
import type { Vec2 } from '@/types';

const level = generateLevel(20260920, 3, 0);

/** Deterministic spread of aim directions WITHOUT trig, matching the engine's own rule. */
function aimAt(i: number, n: number): Vec2 {
  const t = (i / n) * 4;
  const raw =
    t < 1 ? { x: 1, y: t } : t < 2 ? { x: 2 - t, y: 1 } : t < 3 ? { x: -(t - 2), y: 2 - t + 1 } : { x: -(4 - t), y: -1 };
  const len = Math.sqrt(raw.x * raw.x + raw.y * raw.y) || 1;
  return { x: raw.x / len, y: raw.y / len };
}

describe('determinism guarantees', () => {
  it('has no non-deterministic calls in the simulation source', () => {
    // Math.sin/cos/atan2 are NOT bit-identical across JS engines; Math.random and
    // Date.now are not reproducible at all. Any of them here desyncs peers.
    for (const file of ['src/game/physics/simulate.ts', 'src/game/physics/collision.ts', 'src/game/physics/vec.ts', 'src/game/levels/generator.ts', 'src/game/levels/prng.ts']) {
      const src = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '')
        // randomRoomSeed() is the ONE deliberately random function: the host mints a
        // brand-new room seed with it, then shares it. It never runs during replay.
        .replace(/export function randomRoomSeed\(\)[\s\S]*?\n}/, '');
      for (const banned of ['Math.random', 'Math.sin', 'Math.cos', 'Math.tan', 'Math.atan', 'Date.now', 'performance.now']) {
        expect(src.includes(banned), `${file} must not call ${banned}`).toBe(false);
      }
    }
  });

  it('confines Math.random to randomRoomSeed alone', () => {
    const src = readFileSync('src/game/levels/prng.ts', 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    const occurrences = (src.match(/Math\.random/g) ?? []).length;
    const inSeedFn = (src.match(/export function randomRoomSeed\(\)[\s\S]*?\n}/)?.[0]?.match(/Math\.random/g) ?? []).length;
    expect(occurrences).toBe(inSeedFn);
  });

  it('returns identical results for identical inputs', () => {
    for (let i = 0; i < 64; i++) {
      const aim = aimAt(i, 64);
      const power = (i % 10) / 10 + 0.1;
      const a = simulateShot(level, level.ballStart, aim, power);
      const b = simulateShot(level, level.ballStart, aim, power);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    }
  });

  it('survives a JSON round trip of its inputs (the wire format)', () => {
    const aim = aimAt(7, 64);
    const direct = simulateShot(level, level.ballStart, aim, 0.8);
    const overWire = simulateShot(
      JSON.parse(JSON.stringify(level)),
      JSON.parse(JSON.stringify(level.ballStart)),
      JSON.parse(JSON.stringify(aim)),
      0.8,
    );
    expect(JSON.stringify(overWire)).toBe(JSON.stringify(direct));
  });
});

describe('simulation safety', () => {
  it('never lets the ball escape the course, at any angle or power', () => {
    for (let round = 0; round < 6; round++) {
      const lvl = generateLevel(90210, round, 0);
      for (let i = 0; i < 96; i++) {
        const result = simulateShot(lvl, lvl.ballStart, aimAt(i, 96), 1);
        for (const p of result.path) {
          expect(p.x).toBeGreaterThanOrEqual(-PHYSICS.BALL_RADIUS);
          expect(p.x).toBeLessThanOrEqual(lvl.width + PHYSICS.BALL_RADIUS);
          expect(p.y).toBeGreaterThanOrEqual(-PHYSICS.BALL_RADIUS);
          expect(p.y).toBeLessThanOrEqual(lvl.height + PHYSICS.BALL_RADIUS);
        }
      }
    }
  });

  it('always terminates and never emits NaN', () => {
    for (let i = 0; i < 96; i++) {
      const r = simulateShot(level, level.ballStart, aimAt(i, 96), 1);
      expect(Number.isFinite(r.restPos.x)).toBe(true);
      expect(Number.isFinite(r.restPos.y)).toBe(true);
      expect(Number.isFinite(r.durationMs)).toBe(true);
      expect(r.durationMs).toBeLessThanOrEqual(PHYSICS.MAX_SIM_SECONDS * 1000 + 1);
      expect(r.path.length).toBeGreaterThan(0);
      for (const p of r.path) {
        expect(Number.isNaN(p.x) || Number.isNaN(p.y)).toBe(false);
      }
    }
  });

  it('bounds the trajectory sample count so long shots cannot bloat memory', () => {
    const r = simulateShot(level, level.ballStart, aimAt(3, 96), 1);
    expect(r.path.length).toBeLessThanOrEqual(256);
  });

  it('treats zero power as a no-op rather than a lost turn', () => {
    const r = simulateShot(level, level.ballStart, { x: 1, y: 0 }, 0);
    expect(r.restPos.x).toBeCloseTo(level.ballStart.x, 5);
    expect(r.restPos.y).toBeCloseTo(level.ballStart.y, 5);
    expect(r.holed).toBe(false);
  });
});

describe('ball goes in the hole', () => {
  it('captures a ball putted straight at the hole from close range', () => {
    const flat = generateLevel(1234, 0, 0);
    const hole = flat.hole.center;
    // Start one ball-radius short of the hole and tap it in.
    const from = { x: hole.x, y: hole.y + 6 };
    let holed = false;
    for (let p = 1; p <= 20 && !holed; p++) {
      holed = simulateShot(flat, from, { x: 0, y: -1 }, p / 20).holed;
    }
    expect(holed).toBe(true);
  });
});

describe('input mapping', () => {
  it('maps power monotonically to launch speed', () => {
    expect(shotSpeedFor(0.2)).toBeLessThan(shotSpeedFor(0.5));
    expect(shotSpeedFor(0.5)).toBeLessThan(shotSpeedFor(1));
  });

  it('clamps power to 0..1 regardless of drag length', () => {
    expect(powerFromDrag(0)).toBe(0);
    expect(powerFromDrag(PHYSICS.MAX_DRAG_CU * 99)).toBeLessThanOrEqual(1);
    expect(powerFromDrag(-5)).toBeGreaterThanOrEqual(0);
  });

  it('fires opposite the drag (slingshot) and always returns a unit vector', () => {
    const aim = aimFromDrag({ x: 3, y: 4 });
    expect(aim.x).toBeLessThan(0);
    expect(aim.y).toBeLessThan(0);
    expect(Math.sqrt(aim.x * aim.x + aim.y * aim.y)).toBeCloseTo(1, 6);
  });

  it('never returns NaN for a zero drag', () => {
    const aim = aimFromDrag({ x: 0, y: 0 });
    expect(Number.isNaN(aim.x) || Number.isNaN(aim.y)).toBe(false);
  });
});
