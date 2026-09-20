'use client';

/**
 * Celebration burst and water ripples - pure three.js, no post-processing
 * package (none is installed, and none is needed).
 *
 * Both systems are pre-allocated pools driven by plain typed arrays. Nothing is
 * created after mount, `useFrame` allocates nothing, and when nothing is alive
 * the whole component costs one boolean check per frame.
 *
 * The imperative API is handed out through `apiRef` so `ShotAnimator` can fire
 * effects from inside a frame callback without triggering a React render.
 */

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import type { JSX, RefObject } from 'react';
import * as THREE from 'three';

import { resolveQuality } from '@/game/rendering/quality';
import type { QualityTier } from '@/types';

import { RENDER3D, disposeAll, flatRing, unitBox } from './materials';

const SCRATCH_MATRIX = new THREE.Matrix4();
const SCRATCH_POSITION = new THREE.Vector3();
const SCRATCH_QUATERNION = new THREE.Quaternion();
const SCRATCH_SCALE = new THREE.Vector3();
const SCRATCH_COLOR = new THREE.Color();

export interface EffectsApi {
  /** Confetti-style burst in course units. Call on a hole-out. */
  burst(x: number, z: number, color: THREE.ColorRepresentation): void;
  /** Expanding ring in course units. Call when a ball enters water. */
  ripple(x: number, z: number): void;
}

export interface EffectsProps {
  readonly quality: QualityTier;
  readonly reducedMotion?: boolean;
  /** Filled with the imperative API on mount. */
  readonly apiRef?: RefObject<EffectsApi | null>;
}

interface BurstState {
  readonly px: Float32Array;
  readonly py: Float32Array;
  readonly pz: Float32Array;
  readonly vx: Float32Array;
  readonly vy: Float32Array;
  readonly vz: Float32Array;
  readonly life: Float32Array;
  readonly maxLife: Float32Array;
  alive: number;
}

interface RippleState {
  readonly x: Float32Array;
  readonly z: Float32Array;
  readonly age: Float32Array;
  readonly active: Uint8Array;
  next: number;
  alive: number;
}

export function Effects({ quality, reducedMotion = false, apiRef }: EffectsProps): JSX.Element {
  const profile = resolveQuality(quality);
  const particleCount = profile.particles && !reducedMotion ? RENDER3D.BURST_PARTICLES : 0;
  const rippleCount = reducedMotion ? 0 : RENDER3D.RIPPLE_POOL;

  const box = unitBox();
  const burstRef = useRef<THREE.InstancedMesh | null>(null);

  const burst = useMemo<BurstState>(() => {
    const n = Math.max(1, particleCount);
    return {
      px: new Float32Array(n),
      py: new Float32Array(n),
      pz: new Float32Array(n),
      vx: new Float32Array(n),
      vy: new Float32Array(n),
      vz: new Float32Array(n),
      life: new Float32Array(n),
      maxLife: new Float32Array(n),
      alive: 0,
    };
  }, [particleCount]);

  const burstMaterial = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.95,
        depthWrite: false,
        toneMapped: false,
      }),
    [],
  );

  useEffect(() => () => disposeAll(burstMaterial), [burstMaterial]);

  // --- ripple pool ---------------------------------------------------------
  const ripples = useMemo<RippleState>(
    () => ({
      x: new Float32Array(Math.max(1, rippleCount)),
      z: new Float32Array(Math.max(1, rippleCount)),
      age: new Float32Array(Math.max(1, rippleCount)),
      active: new Uint8Array(Math.max(1, rippleCount)),
      next: 0,
      alive: 0,
    }),
    [rippleCount],
  );

  const rippleGroup = useMemo(() => {
    const group = new THREE.Group();
    if (rippleCount === 0) return group;
    const geometry = flatRing(Math.max(12, profile.circleSegments));
    for (let i = 0; i < rippleCount; i += 1) {
      const material = new THREE.MeshBasicMaterial({
        color: 0xdff5ff,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        toneMapped: false,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = 2;
      group.add(mesh);
    }
    return group;
  }, [rippleCount, profile.circleSegments]);

  useEffect(
    () => () => {
      for (const child of rippleGroup.children) {
        if (child instanceof THREE.Mesh && child.material instanceof THREE.Material) {
          child.material.dispose();
        }
      }
      rippleGroup.clear();
    },
    [rippleGroup],
  );

  // --- imperative API ------------------------------------------------------
  const api = useMemo<EffectsApi>(
    () => ({
      burst: (x: number, z: number, color: THREE.ColorRepresentation) => {
        const mesh = burstRef.current;
        if (mesh === null || particleCount === 0) return;
        SCRATCH_COLOR.set(color);
        for (let i = 0; i < particleCount; i += 1) {
          // Math.random is fine here: effects are presentation, never simulation.
          const angle = Math.random() * Math.PI * 2;
          const spread = 0.5 + Math.random() * 0.6;
          const speed = RENDER3D.BURST_SPEED * (0.45 + Math.random() * 0.85);
          burst.px[i] = x;
          burst.py[i] = 0.7 + Math.random() * 0.6;
          burst.pz[i] = z;
          burst.vx[i] = Math.cos(angle) * speed * spread;
          burst.vy[i] = speed * (0.6 + Math.random() * 0.7);
          burst.vz[i] = Math.sin(angle) * speed * spread;
          const life = RENDER3D.BURST_LIFE_MS * (0.6 + Math.random() * 0.6);
          burst.life[i] = life;
          burst.maxLife[i] = life;
          const tint = 0.75 + Math.random() * 0.5;
          SCRATCH_COLOR.set(color);
          SCRATCH_COLOR.multiplyScalar(tint);
          mesh.setColorAt(i, SCRATCH_COLOR);
        }
        burst.alive = particleCount;
        if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
        mesh.visible = true;
      },
      ripple: (x: number, z: number) => {
        if (rippleCount === 0) return;
        const slot = ripples.next % rippleCount;
        ripples.next = (ripples.next + 1) % rippleCount;
        ripples.x[slot] = x;
        ripples.z[slot] = z;
        ripples.age[slot] = 0;
        ripples.active[slot] = 1;
        ripples.alive += 1;
        const mesh = rippleGroup.children[slot];
        if (mesh !== undefined) mesh.visible = true;
      },
    }),
    [burst, ripples, rippleGroup, particleCount, rippleCount],
  );

  useEffect(() => {
    if (apiRef === undefined) return;
    apiRef.current = api;
    return () => {
      if (apiRef.current === api) apiRef.current = null;
    };
  }, [apiRef, api]);

  // --- integration ---------------------------------------------------------
  useFrame((_state, delta) => {
    const dt = Math.min(0.05, delta);
    const dtMs = dt * 1000;

    const mesh = burstRef.current;
    if (mesh !== null && burst.alive > 0 && particleCount > 0) {
      let alive = 0;
      for (let i = 0; i < particleCount; i += 1) {
        const remaining = burst.life[i] ?? 0;
        if (remaining <= 0) {
          SCRATCH_POSITION.set(0, -60, 0);
          SCRATCH_SCALE.set(0.0001, 0.0001, 0.0001);
          SCRATCH_MATRIX.compose(SCRATCH_POSITION, SCRATCH_QUATERNION, SCRATCH_SCALE);
          mesh.setMatrixAt(i, SCRATCH_MATRIX);
          continue;
        }
        let vy = (burst.vy[i] ?? 0) - RENDER3D.BURST_GRAVITY * dt;
        const px = (burst.px[i] ?? 0) + (burst.vx[i] ?? 0) * dt;
        let py = (burst.py[i] ?? 0) + vy * dt;
        const pz = (burst.pz[i] ?? 0) + (burst.vz[i] ?? 0) * dt;
        if (py < 0.15) {
          py = 0.15;
          vy = -vy * 0.34;
          burst.vx[i] = (burst.vx[i] ?? 0) * 0.66;
          burst.vz[i] = (burst.vz[i] ?? 0) * 0.66;
        }
        burst.px[i] = px;
        burst.py[i] = py;
        burst.pz[i] = pz;
        burst.vy[i] = vy;

        const left = remaining - dtMs;
        burst.life[i] = left;
        const max = burst.maxLife[i] ?? 1;
        const fade = Math.max(0, left / max);
        const size = RENDER3D.BURST_SIZE * (0.35 + fade * 0.85);
        SCRATCH_POSITION.set(px, py, pz);
        SCRATCH_SCALE.set(size, size, size);
        SCRATCH_MATRIX.compose(SCRATCH_POSITION, SCRATCH_QUATERNION, SCRATCH_SCALE);
        mesh.setMatrixAt(i, SCRATCH_MATRIX);
        if (left > 0) alive += 1;
      }
      burst.alive = alive;
      mesh.instanceMatrix.needsUpdate = true;
      if (alive === 0) mesh.visible = false;
    }

    if (ripples.alive > 0 && rippleCount > 0) {
      let alive = 0;
      for (let i = 0; i < rippleCount; i += 1) {
        if (ripples.active[i] !== 1) continue;
        const age = (ripples.age[i] ?? 0) + dtMs;
        ripples.age[i] = age;
        const child = rippleGroup.children[i];
        const p = age / RENDER3D.RIPPLE_LIFE_MS;
        if (p >= 1 || child === undefined) {
          ripples.active[i] = 0;
          if (child !== undefined) child.visible = false;
          continue;
        }
        alive += 1;
        const radius = 0.6 + p * RENDER3D.RIPPLE_MAX_RADIUS;
        child.position.set(ripples.x[i] ?? 0, 0.12, ripples.z[i] ?? 0);
        child.scale.set(radius, 1, radius);
        if (child instanceof THREE.Mesh && child.material instanceof THREE.MeshBasicMaterial) {
          child.material.opacity = (1 - p) * 0.65;
        }
      }
      ripples.alive = alive;
    }
  });

  return (
    <group>
      {particleCount > 0 ? (
        <instancedMesh
          ref={burstRef}
          args={[box, burstMaterial, particleCount]}
          frustumCulled={false}
          visible={false}
          renderOrder={2}
        />
      ) : null}
      {rippleCount > 0 ? <primitive object={rippleGroup} /> : null}
    </group>
  );
}

export default Effects;
