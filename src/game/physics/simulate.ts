/**
 * THE deterministic core of Friend Golf.
 *
 * Every peer replays the same `{aim, power}` through this function and gets a
 * BYTE-IDENTICAL trajectory, which is what lets the network layer send ~40 bytes
 * per shot instead of per-frame positions.
 *
 * DETERMINISM CONTRACT (enforced by review, not by the compiler):
 *   - only `+ - * /`, `Math.sqrt`, `Math.abs`, `Math.min`, `Math.max`, `Math.floor`
 *   - no `Math.random`, no trig, no `Date.now()`, no `performance.now()`
 *   - no reads of module-level mutable state; the function is pure
 *   - iteration order over obstacles is the level's array order, always
 *
 * Fixed step order, identical on every device:
 *   accelerations (boost pads, cup magnet) -> friction (sand aware) -> integrate
 *   -> outer walls -> wall rects -> bumpers -> water -> hole capture -> rest check
 */

import { PHYSICS } from '@/game/config';
import type {
  BoostRect,
  BumperCircle,
  LevelSpec,
  SandRect,
  ShotEvent,
  ShotInput,
  ShotResult,
  Vec2,
  WallRect,
  WaterRect,
} from '@/types';
import { bounceVelocity, circleCircleContact, circleRectContact, pointInRect } from './collision';
import { lerp, normalize, ZERO } from './vec';

// ---------------------------------------------------------------------------
// Local feel constants
//
// These are NOT in `@/game/config` because that file is owned by the contracts
// agent. They are simulation-affecting, so the integration pass should promote
// them into `PHYSICS` verbatim (see the report) rather than re-tune them here.
// ---------------------------------------------------------------------------

/** Cup magnetism reaches this multiple of the hole radius. Makes near misses curl in. */
export const HOLE_PULL_RADIUS_MULT = 1.85;
/** Acceleration (cu/s^2) toward the cup centre at the very edge of the pull radius. */
export const HOLE_PULL_ACCEL = 38;
/** Below CAPTURE_SPEED * this, the magnet is active. Fast balls just lip out. */
export const HOLE_PULL_SPEED_MULT = 1.6;
/** Below STOP_SPEED * this, friction ramps up so the ball SETTLES instead of creeping. */
export const SETTLE_SPEED_MULT = 6;
/** Extra friction applied inside the settle band. */
export const SETTLE_FRICTION_MULT = 5.5;
/** Hard ceiling on speed (x MAX_SHOT_SPEED) so chained bumpers can never tunnel a wall. */
export const MAX_SPEED_MULT = 1.35;
/** Trajectory events are presentation sugar; cap them so a pinball level stays cheap. */
export const MAX_SHOT_EVENTS = 96;

export interface SimOptions {
  /** Default `PHYSICS.MAX_SIM_SECONDS`. */
  readonly maxSeconds?: number;
  /** Default `PHYSICS.PATH_SAMPLE_EVERY` (steps between samples). */
  readonly sampleEvery?: number;
  /** Default true. Set false in hot loops (drift repair) where events are ignored. */
  readonly collectEvents?: boolean;
  /**
   * Rolling resistance. Default `PHYSICS.FRICTION`. Supplied per-room from the
   * host's ball-feel setting; MUST be identical on every peer or trajectories
   * diverge, which is why it travels in GameSettings rather than being a local
   * preference.
   */
  readonly friction?: number;
  /** Wall bounciness. Default `PHYSICS.WALL_RESTITUTION`. Same sync rule. */
  readonly restitution?: number;
}

/** One raw integrator step. Only produced by {@link simulateShotSteps} (tests/tools). */
export interface ShotTraceStep {
  /** Simulated seconds since the shot started. */
  readonly t: number;
  readonly pos: Vec2;
  readonly vel: Vec2;
}

export interface ShotTrace {
  readonly result: ShotResult;
  /** Full-resolution, one entry per simulated step (never downsampled). */
  readonly steps: readonly ShotTraceStep[];
}

// ---------------------------------------------------------------------------
// Small deterministic helpers
// ---------------------------------------------------------------------------

function clamp01(value: number): number {
  if (!(value > 0)) return 0; // also catches NaN
  return value > 1 ? 1 : value;
}

/** Speed (cu/s) for a 0..1 power. */
export function shotSpeedFor(power: number): number {
  // Non-linear so short putts get real resolution. Uses only multiplication, so
  // it stays bit-identical across engines (Math.pow with a non-integer exponent
  // is NOT guaranteed identical, and would desync peers).
  const p = clamp01(power);
  const curved = p * (PHYSICS.POWER_TOE + (1 - PHYSICS.POWER_TOE) * p);
  return curved * PHYSICS.MAX_SHOT_SPEED;
}

/** Slingshot power from a drag length in course units. */
export function powerFromDrag(dragLengthCu: number): number {
  if (!(dragLengthCu > 0)) return 0;
  return clamp01(dragLengthCu / PHYSICS.MAX_DRAG_CU);
}

/**
 * Shot direction = OPPOSITE of the drag (pull back to fire forward), normalised.
 * Returns {@link ZERO} for a zero-length drag, which callers treat as "no shot".
 */
export function aimFromDrag(drag: Vec2): Vec2 {
  return normalize({ x: -drag.x, y: -drag.y });
}

/** Keeps every even index; halves the sample rate of an over-long path in place. */
function downsamplePath(path: Vec2[]): void {
  let write = 1;
  for (let i = 2; i < path.length; i += 2) {
    const point = path[i];
    if (point !== undefined) {
      path[write] = point;
      write += 1;
    }
  }
  path.length = write;
}

function lastPoint(path: readonly Vec2[]): Vec2 | undefined {
  return path.length > 0 ? path[path.length - 1] : undefined;
}

// ---------------------------------------------------------------------------
// The simulation
// ---------------------------------------------------------------------------

function run(
  level: LevelSpec,
  from: Vec2,
  aim: Vec2,
  power: number,
  options: SimOptions | undefined,
  trace: ShotTraceStep[] | null,
): ShotResult {
  const dt = PHYSICS.DT;
  const radius = PHYSICS.BALL_RADIUS;
  const maxSeconds =
    options !== undefined && options.maxSeconds !== undefined && options.maxSeconds > 0
      ? options.maxSeconds
      : PHYSICS.MAX_SIM_SECONDS;
  const rawSample =
    options !== undefined && options.sampleEvery !== undefined ? Math.floor(options.sampleEvery) : PHYSICS.PATH_SAMPLE_EVERY;
  const collectEvents = options === undefined || options.collectEvents !== false;
  // Per-room feel. Defaults keep every existing call site behaving exactly as
  // before; the room session supplies the host's values so all peers agree.
  const baseFriction =
    options !== undefined && options.friction !== undefined && options.friction > 0
      ? options.friction
      : PHYSICS.FRICTION;
  const wallRestitution =
    options !== undefined && options.restitution !== undefined && options.restitution > 0
      ? options.restitution
      : PHYSICS.WALL_RESTITUTION;
  const maxSteps = Math.floor(maxSeconds / dt);
  const maxSamples = Math.max(8, Math.floor(PHYSICS.MAX_PATH_SAMPLES));
  const speedCap = PHYSICS.MAX_SHOT_SPEED * MAX_SPEED_MULT;
  const stopSpeed = PHYSICS.STOP_SPEED;
  const settleSpeed = stopSpeed * SETTLE_SPEED_MULT;
  const captureSpeed = PHYSICS.CAPTURE_SPEED;
  const pullRadius = level.hole.radius * HOLE_PULL_RADIUS_MULT;
  const pullSpeed = captureSpeed * HOLE_PULL_SPEED_MULT;

  const startX = Number.isFinite(from.x) ? from.x : 0;
  const startY = Number.isFinite(from.y) ? from.y : 0;
  const start: Vec2 = { x: startX, y: startY };

  const path: Vec2[] = [{ x: startX, y: startY }];
  const events: ShotEvent[] = [];

  // A zero aim or zero power is not a shot: the ball simply does not move.
  const dir = normalize(aim);
  const speed0 = shotSpeedFor(power);
  if (dir === ZERO || !(speed0 > 0)) {
    return {
      path,
      restPos: start,
      holed: false,
      penaltyStrokes: 0,
      durationMs: 0,
      reason: 'stopped',
      events,
    };
  }

  // Partition obstacles once per shot: the step loop then touches only what it needs.
  const walls: WallRect[] = [];
  const bumpers: BumperCircle[] = [];
  const sands: SandRect[] = [];
  const waters: WaterRect[] = [];
  const boosts: BoostRect[] = [];
  for (let i = 0; i < level.obstacles.length; i += 1) {
    const obstacle = level.obstacles[i];
    if (obstacle === undefined) continue;
    if (obstacle.kind === 'wall') walls.push(obstacle);
    else if (obstacle.kind === 'bumper') bumpers.push(obstacle);
    else if (obstacle.kind === 'sand') sands.push(obstacle);
    else if (obstacle.kind === 'water') waters.push(obstacle);
    else boosts.push(obstacle);
  }

  let px = startX;
  let py = startY;
  let vx = dir.x * speed0;
  let vy = dir.y * speed0;

  let sampleEvery = Math.max(1, rawSample);
  let sinceSample = 0;
  let steps = 0;
  let penaltyStrokes = 0;
  let reason: ShotResult['reason'] = 'timeout';
  let restX = startX;
  let restY = startY;
  /** Sand membership of the previous step, so `sand-enter` fires once per entry. */
  let wasInSand = false;

  const pushEvent = (t: number, kind: ShotEvent['kind'], x: number, y: number, eventSpeed: number): void => {
    if (!collectEvents || events.length >= MAX_SHOT_EVENTS) return;
    events.push({ t, kind, at: { x, y }, speed: eventSpeed });
  };

  while (steps < maxSteps) {
    const t = steps * dt;

    // --- 1. accelerations -------------------------------------------------
    for (let i = 0; i < boosts.length; i += 1) {
      const pad = boosts[i];
      if (pad === undefined) continue;
      if (pointInRect(px, py, pad)) {
        vx += pad.dir.x * pad.strength * dt;
        vy += pad.dir.y * pad.strength * dt;
        pushEvent(t, 'boost', px, py, Math.sqrt(vx * vx + vy * vy));
      }
    }

    {
      // Cup magnetism: a gentle, deterministic pull so a slow ball rolling past
      // the lip curls in instead of sliding by. Scales to 0 at the pull radius.
      const hdx = level.hole.center.x - px;
      const hdy = level.hole.center.y - py;
      const hd2 = hdx * hdx + hdy * hdy;
      const speedNow2 = vx * vx + vy * vy;
      if (hd2 > 0 && hd2 < pullRadius * pullRadius && speedNow2 < pullSpeed * pullSpeed) {
        const hd = Math.sqrt(hd2);
        const falloff = 1 - hd / pullRadius;
        const accel = HOLE_PULL_ACCEL * falloff * dt;
        vx += (hdx / hd) * accel;
        vy += (hdy / hd) * accel;
      }
    }

    // --- 2. friction (sand aware, with a settle ramp) ---------------------
    let friction = baseFriction;
    let inSand = false;
    for (let i = 0; i < sands.length; i += 1) {
      const sand = sands[i];
      if (sand === undefined) continue;
      if (pointInRect(px, py, sand)) {
        inSand = true;
        const mult = sand.frictionMult === undefined ? PHYSICS.SAND_FRICTION_MULT : sand.frictionMult;
        friction = friction * mult;
        break;
      }
    }
    if (inSand && !wasInSand) {
      pushEvent(t, 'sand-enter', px, py, Math.sqrt(vx * vx + vy * vy));
    }
    wasInSand = inSand;

    const preSpeed2 = vx * vx + vy * vy;
    if (preSpeed2 < settleSpeed * settleSpeed) friction = friction * SETTLE_FRICTION_MULT;

    const damping = 1 - friction * dt;
    if (damping > 0) {
      vx = vx * damping;
      vy = vy * damping;
    } else {
      vx = 0;
      vy = 0;
    }

    // Speed ceiling: chained bumpers must never push the ball past the
    // tunnelling threshold (speedCap * DT stays below the thinnest wall).
    const capped2 = vx * vx + vy * vy;
    if (capped2 > speedCap * speedCap) {
      const k = speedCap / Math.sqrt(capped2);
      vx = vx * k;
      vy = vy * k;
    }

    // --- 3. integrate ------------------------------------------------------
    px += vx * dt;
    py += vy * dt;
    steps += 1;

    // --- 4. outer walls ----------------------------------------------------
    if (px < radius) {
      px = radius + (radius - px) * wallRestitution;
      const hit = bounceVelocity(vx, vy, { x: 1, y: 0 }, wallRestitution);
      pushEvent(t, 'wall', px, py, Math.abs(vx));
      vx = hit.x;
      vy = hit.y;
    } else if (px > level.width - radius) {
      const limit = level.width - radius;
      px = limit - (px - limit) * wallRestitution;
      const hit = bounceVelocity(vx, vy, { x: -1, y: 0 }, wallRestitution);
      pushEvent(t, 'wall', px, py, Math.abs(vx));
      vx = hit.x;
      vy = hit.y;
    }
    if (py < radius) {
      py = radius + (radius - py) * wallRestitution;
      const hit = bounceVelocity(vx, vy, { x: 0, y: 1 }, wallRestitution);
      pushEvent(t, 'wall', px, py, Math.abs(vy));
      vx = hit.x;
      vy = hit.y;
    } else if (py > level.height - radius) {
      const limit = level.height - radius;
      py = limit - (py - limit) * wallRestitution;
      const hit = bounceVelocity(vx, vy, { x: 0, y: -1 }, wallRestitution);
      pushEvent(t, 'wall', px, py, Math.abs(vy));
      vx = hit.x;
      vy = hit.y;
    }

    // --- 5. wall rects -----------------------------------------------------
    for (let i = 0; i < walls.length; i += 1) {
      const wall = walls[i];
      if (wall === undefined) continue;
      const contact = circleRectContact(px, py, radius, wall);
      if (contact === null) continue;
      px += contact.normal.x * contact.penetration;
      py += contact.normal.y * contact.penetration;
      const impact = Math.sqrt(vx * vx + vy * vy);
      const restitution = wall.restitution === undefined ? wallRestitution : wall.restitution;
      const hit = bounceVelocity(vx, vy, contact.normal, restitution);
      vx = hit.x;
      vy = hit.y;
      pushEvent(t, 'wall', px, py, impact);
    }

    // --- 6. bumpers --------------------------------------------------------
    for (let i = 0; i < bumpers.length; i += 1) {
      const bumper = bumpers[i];
      if (bumper === undefined) continue;
      const contact = circleCircleContact(px, py, radius, bumper.cx, bumper.cy, bumper.r);
      if (contact === null) continue;
      px += contact.normal.x * contact.penetration;
      py += contact.normal.y * contact.penetration;
      const impact = Math.sqrt(vx * vx + vy * vy);
      const restitution = bumper.restitution === undefined ? PHYSICS.BUMPER_RESTITUTION : bumper.restitution;
      const hit = bounceVelocity(vx, vy, contact.normal, restitution);
      vx = hit.x;
      vy = hit.y;
      pushEvent(t, 'bumper', px, py, impact);
      const kicked2 = vx * vx + vy * vy;
      if (kicked2 > speedCap * speedCap) {
        const k = speedCap / Math.sqrt(kicked2);
        vx = vx * k;
        vy = vy * k;
      }
    }

    if (trace !== null) {
      trace.push({ t: steps * dt, pos: { x: px, y: py }, vel: { x: vx, y: vy } });
    }

    // --- 7. water ----------------------------------------------------------
    let splashed = false;
    for (let i = 0; i < waters.length; i += 1) {
      const water = waters[i];
      if (water === undefined) continue;
      if (pointInRect(px, py, water)) {
        pushEvent(steps * dt, 'water', px, py, Math.sqrt(vx * vx + vy * vy));
        splashed = true;
        break;
      }
    }
    if (splashed) {
      // The path ends at the splash so the renderer can play the plop; the ball
      // itself goes back to where the shot started and the stroke costs extra.
      path.push({ x: px, y: py });
      penaltyStrokes = PHYSICS.WATER_PENALTY_STROKES;
      reason = 'water-reset';
      restX = startX;
      restY = startY;
      return {
        path,
        restPos: { x: restX, y: restY },
        holed: false,
        penaltyStrokes,
        durationMs: steps * dt * 1000,
        reason,
        events,
      };
    }

    // --- 8. hole capture ---------------------------------------------------
    {
      const hdx = px - level.hole.center.x;
      const hdy = py - level.hole.center.y;
      const hd2 = hdx * hdx + hdy * hdy;
      const speed2 = vx * vx + vy * vy;
      if (hd2 < level.hole.radius * level.hole.radius && speed2 < captureSpeed * captureSpeed) {
        px = level.hole.center.x;
        py = level.hole.center.y;
        pushEvent(steps * dt, 'hole', px, py, Math.sqrt(speed2));
        path.push({ x: px, y: py });
        return {
          path,
          restPos: { x: px, y: py },
          holed: true,
          penaltyStrokes: 0,
          durationMs: steps * dt * 1000,
          reason: 'holed',
          events,
        };
      }
    }

    // --- 9. sampling + rest check -----------------------------------------
    sinceSample += 1;
    if (sinceSample >= sampleEvery) {
      sinceSample = 0;
      path.push({ x: px, y: py });
      if (path.length >= maxSamples) {
        downsamplePath(path);
        sampleEvery = sampleEvery * 2;
      }
    }

    const speed2 = vx * vx + vy * vy;
    if (speed2 < stopSpeed * stopSpeed) {
      reason = 'stopped';
      restX = px;
      restY = py;
      break;
    }
  }

  // Falling out of the loop means the step budget ran out: `reason` is still
  // its initial 'timeout' and the ball rests wherever the last step left it.
  if (reason === 'timeout') {
    restX = px;
    restY = py;
  }

  const tail = lastPoint(path);
  if (tail === undefined || tail.x !== restX || tail.y !== restY) {
    path.push({ x: restX, y: restY });
  }

  return {
    path,
    restPos: { x: restX, y: restY },
    holed: false, // the holed path returns early, above
    penaltyStrokes,
    durationMs: steps * dt * 1000,
    reason,
    events,
  };
}

/**
 * Simulate one stroke. Same inputs => byte-identical output on every device.
 *
 * `aim` is re-normalised internally, so a peer that sent a slightly denormalised
 * vector over the wire still produces exactly the same trajectory everywhere.
 */
export function simulateShot(
  level: LevelSpec,
  from: Vec2,
  aim: Vec2,
  power: number,
  options?: SimOptions,
): ShotResult {
  return run(level, from, aim, power, options, null);
}

/** Convenience wrapper used by the network layer when replaying a peer's PLAYER_SHOT. */
export function replayShot(
  level: LevelSpec,
  from: Vec2,
  shot: ShotInput,
  options?: SimOptions,
): ShotResult {
  return run(level, from, shot.aim, shot.power, options, null);
}

/**
 * Same simulation, plus the full per-step trace. For tests, tuning and the
 * drift-repair diff - NOT for gameplay (the trace allocates one object per step).
 */
export function simulateShotSteps(
  level: LevelSpec,
  from: Vec2,
  aim: Vec2,
  power: number,
  options?: SimOptions,
): ShotTrace {
  const steps: ShotTraceStep[] = [];
  const result = run(level, from, aim, power, options, steps);
  return { result, steps };
}

// ---------------------------------------------------------------------------
// Playback helper (PRESENTATION - may use wall-clock time freely)
// ---------------------------------------------------------------------------

/**
 * Position along a finished shot at `elapsedMs`, linearly interpolated between
 * path samples. Pure and allocation-light (one Vec2 per call), so the renderer
 * can call it from `useFrame` without touching the simulation.
 */
export function samplePathAt(path: readonly Vec2[], durationMs: number, elapsedMs: number): Vec2 {
  if (path.length === 0) return ZERO;
  const first = path[0];
  const last = path[path.length - 1];
  if (first === undefined || last === undefined) return ZERO;
  if (path.length === 1 || !(durationMs > 0)) return last;
  if (!(elapsedMs > 0)) return first;
  if (elapsedMs >= durationMs) return last;

  const segments = path.length - 1;
  const progress = (elapsedMs / durationMs) * segments;
  const index = Math.min(segments - 1, Math.floor(progress));
  const a = path[index];
  const b = path[index + 1];
  if (a === undefined || b === undefined) return last;
  return lerp(a, b, progress - index);
}

export interface ShotReplay {
  readonly durationMs: number;
  /** 0..1 playback progress. */
  progressAt(elapsedMs: number): number;
  positionAt(elapsedMs: number): Vec2;
  isFinished(elapsedMs: number): boolean;
  /** Events whose `t` falls in `(fromMs, toMs]` - drives sfx without re-simulating. */
  eventsBetween(fromMs: number, toMs: number): readonly ShotEvent[];
}

/** Wraps a {@link ShotResult} so the renderer can drive it purely by elapsed time. */
export function createShotReplay(result: ShotResult): ShotReplay {
  const durationMs = result.durationMs;
  return {
    durationMs,
    progressAt(elapsedMs: number): number {
      if (!(durationMs > 0)) return 1;
      return clamp01(elapsedMs / durationMs);
    },
    positionAt(elapsedMs: number): Vec2 {
      return samplePathAt(result.path, durationMs, elapsedMs);
    },
    isFinished(elapsedMs: number): boolean {
      return !(durationMs > 0) || elapsedMs >= durationMs;
    },
    eventsBetween(fromMs: number, toMs: number): readonly ShotEvent[] {
      const out: ShotEvent[] = [];
      for (let i = 0; i < result.events.length; i += 1) {
        const event = result.events[i];
        if (event === undefined) continue;
        const ms = event.t * 1000;
        if (ms > fromMs && ms <= toMs) out.push(event);
      }
      return out;
    },
  };
}
