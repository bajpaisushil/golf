'use client';

/**
 * A player's ball: glossy sphere, soft contact shadow, self-highlight ring and
 * (above the low tier) a ring-buffered motion trail.
 *
 * The trail is a fixed-size Float32Array written in place - `useFrame` here never
 * allocates. Ball transforms during a shot are driven by `ShotAnimator`, which
 * finds this object through the ball registry below.
 */

import {
  createContext,
  memo,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from 'react';
import { useFrame } from '@react-three/fiber';
import type { JSX, ReactNode } from 'react';
import * as THREE from 'three';

import { PHYSICS } from '@/game/config';
import { resolveQuality } from '@/game/rendering/quality';
import type { PlayerId, QualityTier } from '@/types';

import { RENDER3D, disposeAll, flatDisc, flatRing, unitSphere } from './materials';
import type { BallView } from './types';

/** Golf-ball ivory. Tinted very slightly toward the player colour for identity. */
const BALL_WHITE = new THREE.Color(0xf7f7f2);

// ---------------------------------------------------------------------------
// Ball registry - lets ShotAnimator drive a ball without prop-drilling refs
// ---------------------------------------------------------------------------

export type BallRegistry = Map<PlayerId, THREE.Object3D>;

const BallRegistryContext = createContext<BallRegistry | null>(null);

export function BallRegistryProvider({ children }: { readonly children: ReactNode }): JSX.Element {
  const registry = useMemo<BallRegistry>(() => new Map(), []);
  return <BallRegistryContext.Provider value={registry}>{children}</BallRegistryContext.Provider>;
}

/** Null outside a provider; every consumer must cope with that. */
export function useBallRegistry(): BallRegistry | null {
  return useContext(BallRegistryContext);
}

// ---------------------------------------------------------------------------
// Ball
// ---------------------------------------------------------------------------

export interface BallProps {
  readonly view: BallView;
  readonly quality: QualityTier;
  readonly reducedMotion?: boolean;
}

const HOLED_SINK = PHYSICS.BALL_RADIUS * 0.55;

function BallImpl({ view, quality, reducedMotion = false }: BallProps): JSX.Element {
  const profile = resolveQuality(quality);
  const registry = useBallRegistry();
  const groupRef = useRef<THREE.Group | null>(null);

  const radius = PHYSICS.BALL_RADIUS;
  const sphere = unitSphere(profile.circleSegments);
  const disc = flatDisc(Math.max(8, Math.floor(profile.circleSegments * 0.6)));
  const ring = flatRing(Math.max(10, Math.floor(profile.circleSegments * 0.7)));

  const color = useMemo(() => new THREE.Color(view.color), [view.color]);

  const materials = useMemo(() => {
    // A real golf ball is white and matte, not a coloured marble. Player identity
    // lives in the ring under the ball and in the trail, so balls stay tellable
    // apart without turning the green into a pool table.
    const body = new THREE.MeshStandardMaterial({
      color: BALL_WHITE.clone().lerp(color, 0.14),
      roughness: 0.42,
      metalness: 0,
      envMapIntensity: 0.65,
    });
    const shadow = new THREE.MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0.28,
      depthWrite: false,
    });
    const highlight = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
    });
    return { body, shadow, highlight };
  }, [color]);

  useEffect(
    () => () => disposeAll(materials.body, materials.shadow, materials.highlight),
    [materials],
  );

  // Register / unregister so ShotAnimator can drive this ball directly.
  useLayoutEffect(() => {
    const group = groupRef.current;
    if (registry === null || group === null) return;
    registry.set(view.playerId, group);
    return () => {
      if (registry.get(view.playerId) === group) registry.delete(view.playerId);
    };
  }, [registry, view.playerId]);

  // --- trail ---------------------------------------------------------------
  const trailEnabled = profile.tier !== 'low' && !reducedMotion && !view.holed;

  const trail = useMemo(() => {
    if (!trailEnabled) return null;
    const capacity = Math.max(4, profile.trailPoints);
    const positions = new Float32Array(capacity * 3);
    const attribute = new THREE.BufferAttribute(positions, 3);
    attribute.setUsage(THREE.DynamicDrawUsage);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', attribute);
    geometry.setDrawRange(0, 0);
    const material = new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
    });
    const line = new THREE.Line(geometry, material);
    line.frustumCulled = false;
    line.renderOrder = 2;
    return { line, positions, attribute, geometry, material, capacity };
  }, [trailEnabled, profile.trailPoints, color]);

  useEffect(() => {
    if (trail === null) return;
    return () => disposeAll(trail.geometry, trail.material);
  }, [trail]);

  const trailCountRef = useRef(0);

  useEffect(() => {
    trailCountRef.current = 0;
    if (trail !== null) trail.geometry.setDrawRange(0, 0);
  }, [trail, view.playerId]);

  useFrame(() => {
    if (trail === null) return;
    const group = groupRef.current;
    if (group === null) return;

    const { positions, capacity } = trail;
    const x = group.position.x;
    const z = group.position.z;
    const y = radius * 0.28;
    let count = trailCountRef.current;

    if (count > 0) {
      const last = (count - 1) * 3;
      const dx = x - (positions[last] ?? 0);
      const dz = z - (positions[last + 2] ?? 0);
      const distSq = dx * dx + dz * dz;
      if (distSq < RENDER3D.TRAIL_MIN_STEP * RENDER3D.TRAIL_MIN_STEP) return;
      // A teleport (water reset, round change) must not draw a streak across the course.
      if (distSq > RENDER3D.TRAIL_RESET_JUMP * RENDER3D.TRAIL_RESET_JUMP) count = 0;
    }

    let writeAt: number;
    if (count >= capacity) {
      positions.copyWithin(0, 3);
      writeAt = (capacity - 1) * 3;
    } else {
      writeAt = count * 3;
      count += 1;
    }
    positions[writeAt] = x;
    positions[writeAt + 1] = y;
    positions[writeAt + 2] = z;

    trailCountRef.current = count;
    trail.attribute.needsUpdate = true;
    trail.geometry.setDrawRange(0, count);
  });

  const centreY = view.holed ? radius - HOLED_SINK : radius;
  const bodyScale = view.holed ? radius * 0.82 : radius;

  return (
    <>
      <group ref={groupRef} position={[view.pos.x, centreY, view.pos.y]}>
        <mesh
          geometry={sphere}
          material={materials.body}
          scale={bodyScale}
          castShadow={profile.shadows}
        />
        {/* Soft contact shadow, always present so the ball never floats. */}
        <mesh
          geometry={disc}
          material={materials.shadow}
          position={[0, -centreY + 0.05, 0]}
          scale={[radius * RENDER3D.BALL_SHADOW_SCALE, 1, radius * RENDER3D.BALL_SHADOW_SCALE]}
          renderOrder={1}
        />
        {view.isSelf && !view.holed ? (
          <mesh
            geometry={ring}
            material={materials.highlight}
            position={[0, -centreY + 0.09, 0]}
            scale={[radius * 2.1, 1, radius * 2.1]}
            renderOrder={1}
          />
        ) : null}
      </group>
      {trail !== null ? <primitive object={trail.line} /> : null}
    </>
  );
}

export const Ball = memo(BallImpl);

export default Ball;
