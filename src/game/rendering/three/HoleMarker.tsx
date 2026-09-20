'use client';

/**
 * The cup: a recessed dark shaft, a bright lip ring so the target reads at a
 * glance on a phone, and a procedural pennant flag.
 *
 * Positions are in COURSE UNITS (the parent group carries the world offset).
 */

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import type { JSX } from 'react';
import * as THREE from 'three';

import { resolveQuality } from '@/game/rendering/quality';
import type { Theme } from '@/game/levels/themes';
import type { Hex, Hole, QualityTier } from '@/types';

import {
  RENDER3D,
  disposeAll,
  flatDisc,
  flatRing,
  openTube,
  pennant,
  themeColors,
  unitCylinder,
} from './materials';

export interface HoleMarkerProps {
  readonly hole: Hole;
  readonly theme: Theme;
  readonly quality?: QualityTier;
  readonly reducedMotion?: boolean;
  /** Flag colour; defaults to the theme accent. */
  readonly flagColor?: Hex;
}

export function HoleMarker({
  hole,
  theme,
  quality,
  reducedMotion = false,
  flagColor,
}: HoleMarkerProps): JSX.Element {
  const colors = useMemo(() => themeColors(theme), [theme]);
  const profile = resolveQuality(quality ?? 'medium');
  const segments = profile.circleSegments;

  const tube = openTube(segments);
  const disc = flatDisc(segments);
  const ring = flatRing(segments);
  const pole = unitCylinder(Math.max(6, Math.floor(segments * 0.4)));
  const flagGeometry = pennant();

  const materials = useMemo(() => {
    const shaft = new THREE.MeshStandardMaterial({
      color: colors.holeInterior,
      roughness: 1,
      metalness: 0,
      side: THREE.BackSide,
    });
    const floor = new THREE.MeshStandardMaterial({
      color: colors.holeInterior,
      roughness: 1,
      metalness: 0,
    });
    // A real cup is a PALE liner ring around a black mouth. Painting the lip the
    // same near-black as the hole made the target read as a thin outline you could
    // see fairway through — the single biggest "I can't see the hole" complaint.
    const lip = new THREE.MeshStandardMaterial({
      color: 0xeef2e2,
      emissive: 0xeef2e2,
      emissiveIntensity: 0.12,
      roughness: 0.6,
      metalness: 0,
    });
    // Solid dark mouth sitting just under the surface, so the cup reads as a
    // filled hole from any camera angle instead of a ring.
    const mouth = new THREE.MeshStandardMaterial({
      color: colors.holeInterior,
      roughness: 1,
      metalness: 0,
    });
    const poleMat = new THREE.MeshStandardMaterial({
      color: 0xf2f4f8,
      roughness: 0.35,
      metalness: 0.25,
    });
    const flagMat = new THREE.MeshStandardMaterial({
      color: flagColor === undefined ? colors.accent : new THREE.Color(flagColor),
      emissive: flagColor === undefined ? colors.accent : new THREE.Color(flagColor),
      emissiveIntensity: 0.18,
      roughness: 0.75,
      metalness: 0,
    });
    return { shaft, floor, lip, mouth, poleMat, flagMat };
  }, [colors, flagColor]);

  useEffect(
    () => () => {
      disposeAll(
        materials.shaft,
        materials.floor,
        materials.lip,
        materials.mouth,
        materials.poleMat,
        materials.flagMat,
      );
    },
    [materials],
  );

  const flagRef = useRef<THREE.Group | null>(null);

  useFrame((state) => {
    const group = flagRef.current;
    if (group === null) return;
    if (reducedMotion) {
      group.rotation.y = 0;
      return;
    }
    // Cheap idle sway. Presentation only - trig is fine outside the simulation.
    const t = state.clock.elapsedTime;
    group.rotation.y = Math.sin(t * RENDER3D.FLAG_SWAY_HZ) * 0.22 + 0.5;
  });

  const r = hole.radius;
  const depth = RENDER3D.HOLE_DEPTH;

  return (
    <group position={[hole.center.x, 0, hole.center.y]}>
      {/* Pale collar ring so the cup is unmistakable even at a glance. */}
      <mesh geometry={ring} material={materials.lip} position={[0, 0.04, 0]} scale={[r * RENDER3D.HOLE_RIM_SCALE, 1, r * RENDER3D.HOLE_RIM_SCALE]} />

      {/* Solid dark mouth: this is what actually makes it look like a hole. */}
      <mesh geometry={disc} material={materials.mouth} position={[0, 0.02, 0]} scale={[r, 1, r]} />

      {/* Inner shaft, seen from above through the lip. */}
      <mesh geometry={tube} material={materials.shaft} position={[0, -depth * 0.5, 0]} scale={[r, depth, r]} />

      {/* Cup floor. */}
      <mesh geometry={disc} material={materials.floor} position={[0, -depth + 0.02, 0]} scale={[r, 1, r]} />

      {/* Flag. */}
      <mesh
        geometry={pole}
        material={materials.poleMat}
        position={[0, RENDER3D.FLAG_POLE_HEIGHT * 0.5, 0]}
        scale={[RENDER3D.FLAG_POLE_RADIUS, RENDER3D.FLAG_POLE_HEIGHT, RENDER3D.FLAG_POLE_RADIUS]}
        castShadow={profile.shadows}
      />
      <group ref={flagRef} position={[0, RENDER3D.FLAG_POLE_HEIGHT, 0]}>
        <mesh geometry={flagGeometry} material={materials.flagMat} castShadow={profile.shadows} />
      </group>
    </group>
  );
}

export default HoleMarker;
