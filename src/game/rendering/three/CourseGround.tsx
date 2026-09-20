'use client';

/**
 * The course itself: rough apron, extruded fairway slab, mown stripes, an inner
 * collar and the four border walls.
 *
 * Everything is built from a single shared unit box. The walls and stripes are
 * instanced, so the whole ground costs at most six draw calls regardless of
 * course size. All positions are in COURSE UNITS - the parent `<group>` in
 * CourseScene carries the course-to-world offset.
 */

import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import type { JSX } from 'react';
import * as THREE from 'three';

import { resolveQuality } from '@/game/rendering/quality';
import type { Theme } from '@/game/levels/themes';
import type { LevelSpec, QualityTier } from '@/types';

import { RENDER3D, disposeAll, themeColors, unitBox } from './materials';

// Module-scope scratch: written and read synchronously inside layout effects only.
const SCRATCH_MATRIX = new THREE.Matrix4();
const SCRATCH_POSITION = new THREE.Vector3();
const SCRATCH_QUATERNION = new THREE.Quaternion();
const SCRATCH_SCALE = new THREE.Vector3();

function setInstance(
  mesh: THREE.InstancedMesh,
  index: number,
  x: number,
  y: number,
  z: number,
  sx: number,
  sy: number,
  sz: number,
): void {
  SCRATCH_POSITION.set(x, y, z);
  SCRATCH_SCALE.set(sx, sy, sz);
  SCRATCH_MATRIX.compose(SCRATCH_POSITION, SCRATCH_QUATERNION, SCRATCH_SCALE);
  mesh.setMatrixAt(index, SCRATCH_MATRIX);
}

export interface CourseGroundProps {
  readonly level: LevelSpec;
  readonly theme: Theme;
  /** Optional: drops stripes and the collar on the low tier. */
  readonly quality?: QualityTier;
}

const RIM_INSTANCES = 4;
const COLLAR_INSTANCES = 4;
const COLLAR_WIDTH = 0.9;

export function CourseGround({ level, theme, quality }: CourseGroundProps): JSX.Element {
  const colors = useMemo(() => themeColors(theme), [theme]);
  const profile = resolveQuality(quality ?? 'medium');
  const detailed = profile.tier !== 'low';

  const box = unitBox();

  const materials = useMemo(() => {
    const rough = new THREE.MeshStandardMaterial({
      color: colors.rough,
      roughness: 1,
      metalness: 0,
    });
    const felt = new THREE.MeshStandardMaterial({
      color: colors.felt,
      roughness: 0.96,
      metalness: 0,
    });
    const stripe = new THREE.MeshStandardMaterial({
      color: colors.feltStripe,
      roughness: 0.94,
      metalness: 0,
    });
    const collar = new THREE.MeshStandardMaterial({
      color: colors.feltEdge,
      roughness: 0.9,
      metalness: 0,
    });
    const wall = new THREE.MeshStandardMaterial({
      color: colors.wall,
      roughness: 0.62,
      metalness: 0.06,
    });
    const cap = new THREE.MeshStandardMaterial({
      color: colors.wallTop,
      roughness: 0.34,
      metalness: 0.12,
    });
    return { rough, felt, stripe, collar, wall, cap };
  }, [colors]);

  useEffect(
    () => () => {
      disposeAll(
        materials.rough,
        materials.felt,
        materials.stripe,
        materials.collar,
        materials.wall,
        materials.cap,
      );
    },
    [materials],
  );

  const { width, height } = level;
  const rimBodyRef = useRef<THREE.InstancedMesh | null>(null);
  const rimCapRef = useRef<THREE.InstancedMesh | null>(null);
  const stripeRef = useRef<THREE.InstancedMesh | null>(null);
  const collarRef = useRef<THREE.InstancedMesh | null>(null);

  const stripeCount = detailed ? Math.ceil(RENDER3D.STRIPE_COUNT / 2) : 0;

  useLayoutEffect(() => {
    const rw = RENDER3D.RIM_WIDTH;
    const capH = RENDER3D.RIM_CAP_HEIGHT;
    const bodyBottom = -RENDER3D.FELT_THICKNESS;
    const bodyTop = RENDER3D.RIM_HEIGHT - capH;
    const bodyH = bodyTop - bodyBottom;
    const bodyY = (bodyTop + bodyBottom) * 0.5;
    const capY = RENDER3D.RIM_HEIGHT - capH * 0.5;
    const outerW = width + rw * 2;

    const body = rimBodyRef.current;
    if (body !== null) {
      setInstance(body, 0, width * 0.5, bodyY, -rw * 0.5, outerW, bodyH, rw);
      setInstance(body, 1, width * 0.5, bodyY, height + rw * 0.5, outerW, bodyH, rw);
      setInstance(body, 2, -rw * 0.5, bodyY, height * 0.5, rw, bodyH, height);
      setInstance(body, 3, width + rw * 0.5, bodyY, height * 0.5, rw, bodyH, height);
      body.instanceMatrix.needsUpdate = true;
      body.computeBoundingSphere();
    }

    const cap = rimCapRef.current;
    if (cap !== null) {
      setInstance(cap, 0, width * 0.5, capY, -rw * 0.5, outerW, capH, rw);
      setInstance(cap, 1, width * 0.5, capY, height + rw * 0.5, outerW, capH, rw);
      setInstance(cap, 2, -rw * 0.5, capY, height * 0.5, rw, capH, height);
      setInstance(cap, 3, width + rw * 0.5, capY, height * 0.5, rw, capH, height);
      cap.instanceMatrix.needsUpdate = true;
      cap.computeBoundingSphere();
    }
  }, [width, height, materials]);

  useLayoutEffect(() => {
    const mesh = stripeRef.current;
    if (mesh === null || stripeCount === 0) return;
    const bandDepth = height / RENDER3D.STRIPE_COUNT;
    for (let i = 0; i < stripeCount; i += 1) {
      const band = i * 2; // every other band is "mown the other way"
      const z = band * bandDepth + bandDepth * 0.5;
      setInstance(mesh, i, width * 0.5, RENDER3D.STRIPE_LIFT, z, width, 0.02, bandDepth);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [width, height, stripeCount, materials]);

  useLayoutEffect(() => {
    const mesh = collarRef.current;
    if (mesh === null || !detailed) return;
    const c = COLLAR_WIDTH;
    const y = RENDER3D.STRIPE_LIFT * 1.6;
    setInstance(mesh, 0, width * 0.5, y, c * 0.5, width, 0.02, c);
    setInstance(mesh, 1, width * 0.5, y, height - c * 0.5, width, 0.02, c);
    setInstance(mesh, 2, c * 0.5, y, height * 0.5, c, 0.02, height);
    setInstance(mesh, 3, width - c * 0.5, y, height * 0.5, c, 0.02, height);
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [width, height, detailed, materials]);

  const roughW = width + RENDER3D.ROUGH_MARGIN * 2;
  const roughH = height + RENDER3D.ROUGH_MARGIN * 2;

  return (
    <group>
      {/* Rough apron. Sits below the felt so the fairway reads as raised. */}
      <mesh
        position={[width * 0.5, RENDER3D.ROUGH_Y - 0.6, height * 0.5]}
        geometry={box}
        material={materials.rough}
        scale={[roughW, 1.2, roughH]}
        receiveShadow={profile.shadows}
      />

      {/* Fairway slab: top face exactly at y = 0, the plane the simulation lives on. */}
      <mesh
        position={[width * 0.5, -RENDER3D.FELT_THICKNESS * 0.5, height * 0.5]}
        geometry={box}
        material={materials.felt}
        scale={[width, RENDER3D.FELT_THICKNESS, height]}
        receiveShadow={profile.shadows}
      />

      {stripeCount > 0 ? (
        <instancedMesh
          ref={stripeRef}
          args={[box, materials.stripe, stripeCount]}
          receiveShadow={profile.shadows}
          frustumCulled={false}
        />
      ) : null}

      {detailed ? (
        <instancedMesh
          ref={collarRef}
          args={[box, materials.collar, COLLAR_INSTANCES]}
          receiveShadow={profile.shadows}
          frustumCulled={false}
        />
      ) : null}

      <instancedMesh
        ref={rimBodyRef}
        args={[box, materials.wall, RIM_INSTANCES]}
        castShadow={profile.shadows}
        receiveShadow={profile.shadows}
        frustumCulled={false}
      />
      <instancedMesh
        ref={rimCapRef}
        args={[box, materials.cap, RIM_INSTANCES]}
        castShadow={profile.shadows}
        frustumCulled={false}
      />
    </group>
  );
}

export default CourseGround;
