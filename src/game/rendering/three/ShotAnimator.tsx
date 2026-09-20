'use client';

/**
 * Replays a `ShotResult` path on the shooting player's ball.
 *
 * This is the one place where simulation output becomes motion. It samples the
 * pre-computed path by elapsed wall-clock time - it never re-simulates and never
 * writes gameplay state. Zero allocations per frame: every scratch object is
 * module scope and all mutable playback bookkeeping lives in one ref object.
 */

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import type { JSX, RefObject } from 'react';
import * as THREE from 'three';

import { PHYSICS } from '@/game/config';
import type { BumperCircle, Hex, LevelSpec, ShotEvent } from '@/types';

import { RENDER3D } from './materials';
import { useBallRegistry } from './Ball';
import type { EffectsApi } from './Effects';
import type { ShotPlayback } from './types';

export interface ShotAnimatorProps {
  readonly playback: ShotPlayback | null;
  readonly onEnd?: () => void;
  /** Optional extras - all additive on top of the contract's `{ playback, onEnd }`. */
  readonly level?: LevelSpec;
  /** Written with `performance.now()` at `Obstacle.id` when a bumper is struck. */
  readonly pulses?: Float32Array;
  readonly effects?: RefObject<EffectsApi | null>;
  /** Colour of the celebration burst; normally the shooting player's colour. */
  readonly burstColor?: Hex;
  readonly reducedMotion?: boolean;
  /**
   * 0 = rigid (follows the simulated samples exactly), 1 = volatile (heavily
   * damped and floaty). Presentation only — it can never change where the ball
   * ends up, so it cannot affect who wins. Defaults to RENDER3D.BALL_SMOOTHING.
   */
  readonly smoothing?: number;
}

interface AnimatorState {
  playback: ShotPlayback | null;
  target: THREE.Object3D | null;
  eventCursor: number;
  ended: boolean;
  impactAt: number;
  celebrated: boolean;
  /** Previous rendered position, for rolling and smoothing. */
  prevX: number;
  prevZ: number;
  hasPrev: boolean;
}

const IMPACT_KINDS: ReadonlySet<ShotEvent['kind']> = new Set<ShotEvent['kind']>(['wall', 'bumper']);

/** Scratch roll axis — hoisted so the frame loop never allocates. */
const ROLL_AXIS = new THREE.Vector3();

export function ShotAnimator({
  playback,
  onEnd,
  level,
  pulses,
  effects,
  burstColor = '#F2F4F8',
  reducedMotion = false,
  smoothing,
}: ShotAnimatorProps): JSX.Element | null {
  const registry = useBallRegistry();

  const bumpers = useMemo<readonly BumperCircle[]>(() => {
    if (level === undefined) return [];
    const list: BumperCircle[] = [];
    for (const obstacle of level.obstacles) {
      if (obstacle.kind === 'bumper') list.push(obstacle);
    }
    return list;
  }, [level]);

  // Clamped once: a hostile or stale value must never make the ball crawl.
  const smoothAmount = Math.max(
    0,
    Math.min(0.9, typeof smoothing === 'number' && Number.isFinite(smoothing)
      ? smoothing
      : RENDER3D.BALL_SMOOTHING),
  );

  const stateRef = useRef<AnimatorState>({
    playback: null,
    target: null,
    eventCursor: 0,
    ended: false,
    impactAt: 0,
    celebrated: false,
    prevX: 0,
    prevZ: 0,
    hasPrev: false,
  });

  // Never leave a ball squashed if the component unmounts mid-shot.
  useEffect(() => {
    const state = stateRef.current;
    return () => {
      if (state.target !== null) state.target.scale.set(1, 1, 1);
    };
  }, []);

  useFrame(() => {
    const state = stateRef.current;

    if (state.playback !== playback) {
      if (state.target !== null) state.target.scale.set(1, 1, 1);
      state.playback = playback;
      state.target = playback === null ? null : (registry?.get(playback.playerId) ?? null);
      state.eventCursor = 0;
      state.ended = false;
      state.impactAt = 0;
      state.hasPrev = false;
      state.celebrated = false;
    }

    if (playback === null) return;

    // The ball may mount a frame after the playback arrives.
    if (state.target === null) {
      state.target = registry?.get(playback.playerId) ?? null;
    }
    const target = state.target;

    const path = playback.path;
    const samples = path.length;
    const now = performance.now();
    const duration = playback.durationMs > 0 ? playback.durationMs : 1;
    let t = (now - playback.startedAt) / duration;
    if (!Number.isFinite(t) || t < 0) t = 0;
    if (t > 1) t = 1;
    const elapsed = t * duration;

    if (samples === 0) {
      if (!state.ended) {
        state.ended = true;
        onEnd?.();
      }
      return;
    }

    // --- position ----------------------------------------------------------
    if (target !== null) {
      let x: number;
      let z: number;
      if (samples === 1) {
        const only = path[0];
        x = only === undefined ? 0 : only.x;
        z = only === undefined ? 0 : only.y;
      } else {
        const f = t * (samples - 1);
        let index = Math.floor(f);
        if (index > samples - 2) index = samples - 2;
        if (index < 0) index = 0;
        const a = path[index];
        const b = path[index + 1];
        if (a === undefined) {
          x = 0;
          z = 0;
        } else if (b === undefined) {
          x = a.x;
          z = a.y;
        } else {
          const frac = f - index;
          x = a.x + (b.x - a.x) * frac;
          z = a.y + (b.y - a.y) * frac;
        }
      }

      const sinking = playback.holed && t >= 1;

      // --- smoothing -------------------------------------------------------
      // Presentation only: eases the corner off a hard bounce. Never feeds back
      // into the simulation, so it cannot desync anyone.
      const smooth = smoothAmount;
      if (smooth > 0 && state.hasPrev) {
        x = state.prevX + (x - state.prevX) * (1 - smooth);
        z = state.prevZ + (z - state.prevZ) * (1 - smooth);
      }

      // --- rolling ---------------------------------------------------------
      // The ball used to slide like a puck, which is most of why motion did not
      // read as smooth. Turn the sphere about the axis perpendicular to travel,
      // by exactly the distance covered over its radius.
      const body = target.userData.body as THREE.Mesh | undefined;
      if (body !== undefined && state.hasPrev && RENDER3D.BALL_ROLL > 0) {
        const dx = x - state.prevX;
        const dz = z - state.prevZ;
        const dist = Math.sqrt(dx * dx + dz * dz);
        if (dist > 1e-5) {
          ROLL_AXIS.set(dz / dist, 0, -dx / dist);
          body.rotateOnWorldAxis(ROLL_AXIS, (dist / PHYSICS.BALL_RADIUS) * RENDER3D.BALL_ROLL);
        }
      }
      state.prevX = x;
      state.prevZ = z;
      state.hasPrev = true;

      target.position.set(x, sinking ? PHYSICS.BALL_RADIUS * 0.45 : PHYSICS.BALL_RADIUS, z);

      // --- squash and stretch ---------------------------------------------
      if (reducedMotion || state.impactAt === 0) {
        target.scale.set(1, 1, 1);
      } else {
        const age = now - state.impactAt;
        if (age >= RENDER3D.SQUASH_MS) {
          state.impactAt = 0;
          target.scale.set(1, 1, 1);
        } else {
          const decay = 1 - age / RENDER3D.SQUASH_MS;
          const amount = decay * decay * RENDER3D.SQUASH_AMOUNT;
          target.scale.set(1 + amount * 0.75, 1 - amount, 1 + amount * 0.75);
        }
      }
    }

    // --- events ------------------------------------------------------------
    const events = playback.events;
    if (events !== undefined) {
      while (state.eventCursor < events.length) {
        const event = events[state.eventCursor];
        if (event === undefined) {
          state.eventCursor += 1;
          continue;
        }
        if (event.t * 1000 > elapsed) break;
        state.eventCursor += 1;

        if (IMPACT_KINDS.has(event.kind)) {
          state.impactAt = now;
          if (event.kind === 'bumper' && pulses !== undefined) {
            const id = nearestBumperId(bumpers, event.at.x, event.at.y);
            if (id >= 0 && id < pulses.length) pulses[id] = now;
          }
        } else if (event.kind === 'water') {
          effects?.current?.ripple(event.at.x, event.at.y);
        } else if (event.kind === 'hole') {
          if (!state.celebrated) {
            state.celebrated = true;
            effects?.current?.burst(event.at.x, event.at.y, burstColor);
          }
        }
      }
    }

    // --- completion --------------------------------------------------------
    if (t >= 1 && !state.ended) {
      state.ended = true;
      if (target !== null) target.scale.set(1, 1, 1);
      if (playback.holed && !state.celebrated) {
        state.celebrated = true;
        const last = path[samples - 1];
        if (last !== undefined) effects?.current?.burst(last.x, last.y, burstColor);
      }
      onEnd?.();
    }
  });

  return null;
}

/** Nearest bumper centre to a contact point; -1 when there is no plausible match. */
function nearestBumperId(bumpers: readonly BumperCircle[], x: number, y: number): number {
  let bestId = -1;
  let bestDistSq = Number.POSITIVE_INFINITY;
  for (const bumper of bumpers) {
    const dx = bumper.cx - x;
    const dy = bumper.cy - y;
    const distSq = dx * dx + dy * dy;
    const reach = bumper.r + PHYSICS.BALL_RADIUS * 2;
    if (distSq <= reach * reach && distSq < bestDistSq) {
      bestDistSq = distSq;
      bestId = bumper.id;
    }
  }
  return bestId;
}

export default ShotAnimator;
