'use client';

/**
 * The slingshot aim UI, in 3D.
 *
 * Four pieces, four draw calls: a dotted predicted path, an arrow head, a power
 * arc around the ball and the pulled-back sling band. Everything is unlit
 * (MeshBasicMaterial, `toneMapped: false`) so it stays punchy and readable on a
 * phone in daylight no matter what the course lighting is doing.
 *
 * All updates happen in a layout effect driven by the `aim` prop - the indicator
 * costs nothing per frame when the player is not dragging.
 */

import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import type { JSX } from 'react';
import * as THREE from 'three';

import { PHYSICS } from '@/game/config';
import { UI, mixHex } from '@/game/rendering/palette';
import { resolveQuality } from '@/game/rendering/quality';
import type { QualityTier } from '@/types';

import { RENDER3D, disposeAll, flatDisc, unitBox, unitCone } from './materials';
import type { AimPreview } from './types';

const SCRATCH_MATRIX = new THREE.Matrix4();
const SCRATCH_POSITION = new THREE.Vector3();
const SCRATCH_QUATERNION = new THREE.Quaternion();
const SCRATCH_SCALE = new THREE.Vector3();
const SCRATCH_COLOR = new THREE.Color();
const SCRATCH_COLOR_A = new THREE.Color();
const SCRATCH_COLOR_B = new THREE.Color();
const UP_AXIS = new THREE.Vector3(0, 1, 0);
const HIDDEN_SCALE = 0.0001;

function place(
  mesh: THREE.InstancedMesh,
  index: number,
  x: number,
  y: number,
  z: number,
  sx: number,
  sy: number,
  sz: number,
  yaw = 0,
): void {
  SCRATCH_POSITION.set(x, y, z);
  SCRATCH_SCALE.set(sx, sy, sz);
  if (yaw === 0) SCRATCH_QUATERNION.identity();
  else SCRATCH_QUATERNION.setFromAxisAngle(UP_AXIS, yaw);
  SCRATCH_MATRIX.compose(SCRATCH_POSITION, SCRATCH_QUATERNION, SCRATCH_SCALE);
  mesh.setMatrixAt(index, SCRATCH_MATRIX);
}

export interface AimIndicatorProps {
  readonly aim: AimPreview;
  readonly quality?: QualityTier;
}

export function AimIndicator({ aim, quality }: AimIndicatorProps): JSX.Element | null {
  const profile = resolveQuality(quality ?? 'medium');
  const dotGeometry = flatDisc(Math.max(8, Math.floor(profile.circleSegments * 0.5)));
  const coneGeometry = unitCone(Math.max(6, Math.floor(profile.circleSegments * 0.4)));
  const box = unitBox();

  const dotsRef = useRef<THREE.InstancedMesh | null>(null);
  const arcRef = useRef<THREE.InstancedMesh | null>(null);
  const bandRef = useRef<THREE.Mesh | null>(null);
  const arrowRef = useRef<THREE.Mesh | null>(null);

  const { origin, power, color } = aim;
  const aimX = aim.aim.x;
  const aimY = aim.aim.y;

  /**
   * Power reads as COLOUR, cool -> warm -> hot, because the guide itself is a
   * fixed length now. Blends through the player's own colour a touch at the
   * gentle end so you can still tell whose aim it is.
   */
  const hotHex = useMemo(() => {
    const p = Math.max(0, Math.min(1, power));
    const base =
      p < 0.5
        ? mixHex(RENDER3D.AIM_COOL, RENDER3D.AIM_WARM, p * 2)
        : mixHex(RENDER3D.AIM_WARM, RENDER3D.AIM_HOT, (p - 0.5) * 2);
    // A hint of the player's colour, strongest on soft taps.
    return mixHex(base, color, 0.18 * (1 - p));
  }, [color, power]);

  const materials = useMemo(() => {
    const dot = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.92,
      depthWrite: false,
      toneMapped: false,
    });
    const arc = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      toneMapped: false,
    });
    const band = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      toneMapped: false,
    });
    const arrow = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      depthWrite: false,
      toneMapped: false,
    });
    return { dot, arc, band, arrow };
  }, []);

  useEffect(
    () => () => disposeAll(materials.dot, materials.arc, materials.band, materials.arrow),
    [materials],
  );

  const visible = power >= PHYSICS.MIN_POWER && (aimX !== 0 || aimY !== 0);

  // --- dotted predicted path + arrow head ----------------------------------
  useLayoutEffect(() => {
    const dots = dotsRef.current;
    if (dots === null || !visible) return;

    const total = RENDER3D.AIM_DOTS;
    // Fixed dot count and fixed reach: the guide shows DIRECTION only.
    const shown = total;
    const reach = RENDER3D.AIM_FIXED_LENGTH;
    const start = PHYSICS.BALL_RADIUS + RENDER3D.AIM_GAP;
    const spacing = reach / shown;

    SCRATCH_COLOR.set(hotHex);
    const baseR = SCRATCH_COLOR.r;
    const baseG = SCRATCH_COLOR.g;
    const baseB = SCRATCH_COLOR.b;

    for (let i = 0; i < total; i += 1) {
      if (i >= shown) {
        place(dots, i, 0, -50, 0, HIDDEN_SCALE, HIDDEN_SCALE, HIDDEN_SCALE);
        continue;
      }
      const t = i / Math.max(1, shown - 1);
      const d = start + i * spacing;
      const size = RENDER3D.AIM_DOT_RADIUS * (1 - t * 0.5);
      place(
        dots,
        i,
        origin.x + aimX * d,
        RENDER3D.AIM_DOT_LIFT,
        origin.y + aimY * d,
        size,
        1,
        size,
      );
      // Fade the far end out so the line reads as direction, not as a wall.
      const fade = 1 - t * 0.55;
      SCRATCH_COLOR.setRGB(baseR * fade, baseG * fade, baseB * fade);
      dots.setColorAt(i, SCRATCH_COLOR);
    }
    dots.instanceMatrix.needsUpdate = true;
    if (dots.instanceColor !== null) dots.instanceColor.needsUpdate = true;
    dots.computeBoundingSphere();

    const arrow = arrowRef.current;
    if (arrow !== null) {
      const tip = start + reach + RENDER3D.AIM_ARROW_LENGTH * 0.5;
      arrow.position.set(origin.x + aimX * tip, RENDER3D.AIM_DOT_LIFT + 0.2, origin.y + aimY * tip);
      SCRATCH_POSITION.set(aimX, 0, aimY);
      arrow.quaternion.setFromUnitVectors(UP_AXIS, SCRATCH_POSITION);
      arrow.scale.set(
        RENDER3D.AIM_ARROW_RADIUS,
        RENDER3D.AIM_ARROW_LENGTH,
        RENDER3D.AIM_ARROW_RADIUS,
      );
      SCRATCH_COLOR.set(hotHex);
      materials.arrow.color.copy(SCRATCH_COLOR);
    }
  }, [visible, origin.x, origin.y, aimX, aimY, power, hotHex, materials]);

  // --- power arc around the ball -------------------------------------------
  useLayoutEffect(() => {
    const arc = arcRef.current;
    if (arc === null || !visible) return;

    const segments = RENDER3D.AIM_ARC_SEGMENTS;
    const lit = Math.max(1, Math.ceil(power * segments));
    // Lerp two cached Colors instead of building a hex string per segment.
    SCRATCH_COLOR_A.set(color);
    SCRATCH_COLOR_B.set(hotHex);
    // Start the sweep behind the ball so the filled part grows toward the aim.
    const baseAngle = Math.atan2(aimY, aimX) - Math.PI;
    const step = (Math.PI * 2) / segments;

    for (let i = 0; i < segments; i += 1) {
      const angle = baseAngle + i * step;
      const x = origin.x + Math.cos(angle) * RENDER3D.AIM_ARC_RADIUS;
      const z = origin.y + Math.sin(angle) * RENDER3D.AIM_ARC_RADIUS;
      const on = i < lit;
      const size = on ? RENDER3D.AIM_ARC_DOT : RENDER3D.AIM_ARC_DOT * 0.45;
      place(arc, i, x, RENDER3D.AIM_DOT_LIFT, z, size, 0.12, size, -angle);
      if (on) {
        const t = i / Math.max(1, segments - 1);
        SCRATCH_COLOR.copy(SCRATCH_COLOR_A).lerp(SCRATCH_COLOR_B, t);
      } else {
        SCRATCH_COLOR.setRGB(0.16, 0.2, 0.23);
      }
      arc.setColorAt(i, SCRATCH_COLOR);
    }
    arc.instanceMatrix.needsUpdate = true;
    if (arc.instanceColor !== null) arc.instanceColor.needsUpdate = true;
    arc.computeBoundingSphere();
  }, [visible, origin.x, origin.y, aimX, aimY, power, color, hotHex]);

  // --- pulled-back sling band ----------------------------------------------
  useLayoutEffect(() => {
    const band = bandRef.current;
    if (band === null || !visible) return;
    // Fixed too — an arrow that grew with power would give the distance away
    // just as the dotted guide used to.
    const length = RENDER3D.AIM_FIXED_LENGTH * 0.42;
    const yaw = Math.atan2(-aimY, aimX);
    band.position.set(
      origin.x - aimX * (length * 0.5 + PHYSICS.BALL_RADIUS),
      RENDER3D.AIM_DOT_LIFT,
      origin.y - aimY * (length * 0.5 + PHYSICS.BALL_RADIUS),
    );
    band.rotation.set(0, yaw, 0);
    band.scale.set(Math.max(0.01, length), 0.1, RENDER3D.AIM_BAND_WIDTH);
    SCRATCH_COLOR.set(hotHex);
    materials.band.color.copy(SCRATCH_COLOR);
  }, [visible, origin.x, origin.y, aimX, aimY, power, hotHex, materials]);

  if (!visible) return null;

  return (
    <group renderOrder={3}>
      <instancedMesh
        ref={dotsRef}
        args={[dotGeometry, materials.dot, RENDER3D.AIM_DOTS]}
        frustumCulled={false}
        renderOrder={3}
      />
      <instancedMesh
        ref={arcRef}
        args={[box, materials.arc, RENDER3D.AIM_ARC_SEGMENTS]}
        frustumCulled={false}
        renderOrder={3}
      />
      <mesh ref={bandRef} geometry={box} material={materials.band} renderOrder={3} />
      <mesh ref={arrowRef} geometry={coneGeometry} material={materials.arrow} renderOrder={3} />
    </group>
  );
}

export default AimIndicator;
