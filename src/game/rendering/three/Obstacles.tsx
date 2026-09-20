'use client';

/**
 * Every obstacle kind, drawn as one InstancedMesh per kind.
 *
 * Twenty walls are one draw call, not twenty. Nothing in here allocates during
 * `useFrame`: the bumper pulse buffer and the water/sand shader uniforms are
 * built once and mutated in place.
 *
 * All coordinates are COURSE UNITS; the parent group carries the world offset.
 */

import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import type { JSX } from 'react';
import * as THREE from 'three';

import { resolveQuality } from '@/game/rendering/quality';
import type { QualityProfile } from '@/game/config';
import type { Theme } from '@/game/levels/themes';
import type {
  BoostRect,
  BumperCircle,
  LevelSpec,
  QualityTier,
  SandRect,
  WallRect,
  WaterRect,
} from '@/types';

import {
  RENDER3D,
  chevron,
  disposeAll,
  taperedCylinder,
  themeColors,
  unitBox,
  type ThemeColors,
} from './materials';

// Module-scope scratch, used synchronously inside layout effects / frame callbacks.
const SCRATCH_MATRIX = new THREE.Matrix4();
const SCRATCH_POSITION = new THREE.Vector3();
const SCRATCH_QUATERNION = new THREE.Quaternion();
const SCRATCH_SCALE = new THREE.Vector3();
const UP_AXIS = new THREE.Vector3(0, 1, 0);

function composeInstance(
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
  if (yaw === 0) {
    SCRATCH_QUATERNION.identity();
  } else {
    SCRATCH_QUATERNION.setFromAxisAngle(UP_AXIS, yaw);
  }
  SCRATCH_MATRIX.compose(SCRATCH_POSITION, SCRATCH_QUATERNION, SCRATCH_SCALE);
  mesh.setMatrixAt(index, SCRATCH_MATRIX);
}

/**
 * Adds a `vFgPos` varying holding the fragment's world XZ, independent of which
 * three.js feature defines happen to be active. Both hazards use it to build a
 * procedural pattern without a texture.
 */
function injectWorldXZ(shader: { vertexShader: string; fragmentShader: string }): void {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec2 vFgPos;')
    .replace(
      '#include <begin_vertex>',
      [
        '#include <begin_vertex>',
        'vec4 fgWorld = vec4( transformed, 1.0 );',
        '#ifdef USE_INSTANCING',
        '  fgWorld = instanceMatrix * fgWorld;',
        '#endif',
        'fgWorld = modelMatrix * fgWorld;',
        'vFgPos = fgWorld.xz;',
      ].join('\n'),
    );
}

// ---------------------------------------------------------------------------
// Walls
// ---------------------------------------------------------------------------

interface WallsProps {
  readonly walls: readonly WallRect[];
  readonly colors: ThemeColors;
  readonly profile: QualityProfile;
}

function WallInstances({ walls, colors, profile }: WallsProps): JSX.Element | null {
  const box = unitBox();
  const bodyRef = useRef<THREE.InstancedMesh | null>(null);
  const capRef = useRef<THREE.InstancedMesh | null>(null);

  const materials = useMemo(() => {
    const body = new THREE.MeshStandardMaterial({
      color: colors.wall,
      roughness: 0.6,
      metalness: 0.06,
    });
    const cap = new THREE.MeshStandardMaterial({
      color: colors.wallTop,
      roughness: 0.32,
      metalness: 0.14,
    });
    return { body, cap };
  }, [colors]);

  useEffect(() => () => disposeAll(materials.body, materials.cap), [materials]);

  useLayoutEffect(() => {
    const capH = RENDER3D.WALL_CAP_HEIGHT;
    const bottom = -0.35;
    const bodyTop = RENDER3D.WALL_HEIGHT - capH;
    const bodyH = bodyTop - bottom;
    const bodyY = (bodyTop + bottom) * 0.5;
    const capY = RENDER3D.WALL_HEIGHT - capH * 0.5;

    const body = bodyRef.current;
    const cap = capRef.current;
    for (let i = 0; i < walls.length; i += 1) {
      const w = walls[i];
      if (w === undefined) continue;
      const cx = w.x + w.w * 0.5;
      const cz = w.y + w.h * 0.5;
      if (body !== null) composeInstance(body, i, cx, bodyY, cz, w.w, bodyH, w.h);
      if (cap !== null) composeInstance(cap, i, cx, capY, cz, w.w, capH, w.h);
    }
    if (body !== null) {
      body.instanceMatrix.needsUpdate = true;
      body.computeBoundingSphere();
    }
    if (cap !== null) {
      cap.instanceMatrix.needsUpdate = true;
      cap.computeBoundingSphere();
    }
  }, [walls, materials]);

  if (walls.length === 0) return null;

  return (
    <>
      <instancedMesh
        ref={bodyRef}
        args={[box, materials.body, walls.length]}
        castShadow={profile.shadows}
        receiveShadow={profile.shadows}
        frustumCulled={false}
      />
      <instancedMesh
        ref={capRef}
        args={[box, materials.cap, walls.length]}
        castShadow={profile.shadows}
        frustumCulled={false}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Bumpers
// ---------------------------------------------------------------------------

interface BumpersProps {
  readonly bumpers: readonly BumperCircle[];
  readonly colors: ThemeColors;
  readonly profile: QualityProfile;
  /** `pulses[obstacleId]` = performance.now() of the last recorded hit. */
  readonly pulses?: Float32Array;
}

function BumperInstances({ bumpers, colors, profile, pulses }: BumpersProps): JSX.Element | null {
  const meshRef = useRef<THREE.InstancedMesh | null>(null);
  const count = bumpers.length;

  /**
   * Cloned so the per-instance `aPulse` attribute never leaks into the shared
   * geometry cache, and built together with the attribute so the buffer exists
   * before the shader is ever compiled.
   */
  const { geometry, pulseData, pulseAttribute } = useMemo(() => {
    const geo = taperedCylinder(profile.circleSegments).clone();
    const data = new Float32Array(Math.max(1, count));
    const attribute = new THREE.InstancedBufferAttribute(data, 1);
    attribute.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aPulse', attribute);
    return { geometry: geo, pulseData: data, pulseAttribute: attribute };
  }, [profile.circleSegments, count]);

  useEffect(() => () => disposeAll(geometry), [geometry]);

  const material = useMemo(() => {
    const mat = new THREE.MeshStandardMaterial({
      color: colors.bumper,
      emissive: colors.bumper,
      emissiveIntensity: 0.22,
      roughness: 0.26,
      metalness: 0.18,
    });
    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aPulse;\nvarying float vFgPulse;')
        .replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\nvFgPulse = aPulse;\ntransformed *= 1.0 + aPulse * 0.07;',
        );
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vFgPulse;')
        .replace(
          '#include <emissivemap_fragment>',
          '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * vFgPulse * 2.2;',
        );
    };
    mat.customProgramCacheKey = () => 'fg-bumper-pulse';
    return mat;
  }, [colors]);

  useEffect(() => () => disposeAll(material), [material]);

  useLayoutEffect(() => {
    const mesh = meshRef.current;
    if (mesh === null) return;
    for (let i = 0; i < bumpers.length; i += 1) {
      const b = bumpers[i];
      if (b === undefined) continue;
      composeInstance(
        mesh,
        i,
        b.cx,
        RENDER3D.BUMPER_HEIGHT * 0.5 - 0.3,
        b.cy,
        b.r,
        RENDER3D.BUMPER_HEIGHT,
        b.r,
      );
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [bumpers, geometry, material]);

  // Decays the emissive pulse. Allocation-free; skips the upload when nothing moved.
  useFrame(() => {
    if (pulses === undefined) return;
    const now = performance.now();
    let changed = false;
    for (let i = 0; i < bumpers.length; i += 1) {
      const b = bumpers[i];
      if (b === undefined) continue;
      const stamp = pulses[b.id] ?? 0;
      let value = 0;
      if (stamp > 0) {
        const age = now - stamp;
        if (age >= 0 && age < RENDER3D.PULSE_MS) value = 1 - age / RENDER3D.PULSE_MS;
      }
      if (pulseData[i] !== value) {
        pulseData[i] = value;
        changed = true;
      }
    }
    if (changed) pulseAttribute.needsUpdate = true;
  });

  if (count === 0) return null;

  return (
    <instancedMesh
      ref={meshRef}
      args={[geometry, material, count]}
      castShadow={profile.shadows}
      receiveShadow={profile.shadows}
      frustumCulled={false}
    />
  );
}

// ---------------------------------------------------------------------------
// Sand
// ---------------------------------------------------------------------------

interface SandProps {
  readonly sand: readonly SandRect[];
  readonly colors: ThemeColors;
  readonly profile: QualityProfile;
}

function SandInstances({ sand, colors, profile }: SandProps): JSX.Element | null {
  const box = unitBox();
  const meshRef = useRef<THREE.InstancedMesh | null>(null);

  const material = useMemo(() => {
    const mat = new THREE.MeshStandardMaterial({
      color: colors.sand,
      roughness: 1,
      metalness: 0,
    });
    mat.onBeforeCompile = (shader) => {
      injectWorldXZ(shader);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vFgPos;')
        .replace(
          '#include <color_fragment>',
          [
            '#include <color_fragment>',
            // Value-noise grain: two octaves of a cheap hash, no texture needed.
            'float fgG = fract( sin( dot( vFgPos * 3.1, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 );',
            'float fgG2 = fract( sin( dot( vFgPos * 0.7, vec2( 39.3468, 11.135 ) ) ) * 24634.6345 );',
            'diffuseColor.rgb *= 0.90 + fgG * 0.13 + fgG2 * 0.07;',
          ].join('\n'),
        );
    };
    mat.customProgramCacheKey = () => 'fg-sand-grain';
    return mat;
  }, [colors]);

  useEffect(() => () => disposeAll(material), [material]);

  useLayoutEffect(() => {
    const mesh = meshRef.current;
    if (mesh === null) return;
    for (let i = 0; i < sand.length; i += 1) {
      const s = sand[i];
      if (s === undefined) continue;
      composeInstance(
        mesh,
        i,
        s.x + s.w * 0.5,
        RENDER3D.SAND_LIFT,
        s.y + s.h * 0.5,
        s.w,
        RENDER3D.SAND_HEIGHT,
        s.h,
      );
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [sand, material]);

  if (sand.length === 0) return null;

  return (
    <instancedMesh
      ref={meshRef}
      args={[box, material, sand.length]}
      receiveShadow={profile.shadows}
      frustumCulled={false}
    />
  );
}

// ---------------------------------------------------------------------------
// Water
// ---------------------------------------------------------------------------

interface WaterProps {
  readonly water: readonly WaterRect[];
  readonly colors: ThemeColors;
  readonly profile: QualityProfile;
  readonly reducedMotion: boolean;
}

function WaterInstances({ water, colors, profile, reducedMotion }: WaterProps): JSX.Element | null {
  const box = unitBox();
  const meshRef = useRef<THREE.InstancedMesh | null>(null);
  const timeUniform = useMemo<{ value: number }>(() => ({ value: 0 }), []);

  const material = useMemo(() => {
    const mat = new THREE.MeshStandardMaterial({
      color: colors.water,
      roughness: 0.08,
      metalness: 0.25,
      transparent: true,
      opacity: 0.86,
    });
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uFgTime = timeUniform;
      injectWorldXZ(shader);
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          '#include <common>\nuniform float uFgTime;\nvarying vec2 vFgPos;',
        )
        .replace(
          '#include <color_fragment>',
          [
            '#include <color_fragment>',
            // Two crossing wave trains: the classic cheap water read, no normal map.
            'float fgA = sin( vFgPos.x * 0.85 + uFgTime * 1.35 );',
            'float fgB = sin( vFgPos.y * 0.62 - uFgTime * 0.95 );',
            'float fgC = sin( ( vFgPos.x + vFgPos.y ) * 0.38 + uFgTime * 0.55 );',
            'diffuseColor.rgb += ( fgA * 0.030 + fgB * 0.026 + fgC * 0.022 );',
            'diffuseColor.rgb += max( 0.0, fgA * fgB ) * 0.06;',
          ].join('\n'),
        );
    };
    mat.customProgramCacheKey = () => 'fg-water-ripple';
    return mat;
  }, [colors, timeUniform]);

  useEffect(() => () => disposeAll(material), [material]);

  useLayoutEffect(() => {
    const mesh = meshRef.current;
    if (mesh === null) return;
    for (let i = 0; i < water.length; i += 1) {
      const w = water[i];
      if (w === undefined) continue;
      composeInstance(
        mesh,
        i,
        w.x + w.w * 0.5,
        RENDER3D.WATER_LIFT - RENDER3D.WATER_DEPTH * 0.5,
        w.y + w.h * 0.5,
        w.w,
        RENDER3D.WATER_DEPTH,
        w.h,
      );
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [water, material]);

  useFrame((state) => {
    if (reducedMotion) return;
    timeUniform.value = state.clock.elapsedTime;
  });

  if (water.length === 0) return null;

  return (
    <instancedMesh
      ref={meshRef}
      args={[box, material, water.length]}
      receiveShadow={profile.shadows}
      frustumCulled={false}
    />
  );
}

// ---------------------------------------------------------------------------
// Boost pads
// ---------------------------------------------------------------------------

interface BoostProps {
  readonly boosts: readonly BoostRect[];
  readonly colors: ThemeColors;
  readonly profile: QualityProfile;
}

function BoostInstances({ boosts, colors, profile }: BoostProps): JSX.Element | null {
  const box = unitBox();
  const chevronGeometry = chevron();
  const padRef = useRef<THREE.InstancedMesh | null>(null);
  const chevronRef = useRef<THREE.InstancedMesh | null>(null);
  const chevronCount = boosts.length * RENDER3D.CHEVRONS_PER_PAD;

  const materials = useMemo(() => {
    const pad = new THREE.MeshStandardMaterial({
      color: colors.boost,
      emissive: colors.boost,
      emissiveIntensity: 0.16,
      roughness: 0.55,
      metalness: 0.05,
    });
    const arrow = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      emissive: colors.boost,
      emissiveIntensity: 0.85,
      roughness: 0.4,
      metalness: 0,
      side: THREE.DoubleSide,
    });
    return { pad, arrow };
  }, [colors]);

  useEffect(() => () => disposeAll(materials.pad, materials.arrow), [materials]);

  useLayoutEffect(() => {
    const pads = padRef.current;
    const arrows = chevronRef.current;
    const perPad = RENDER3D.CHEVRONS_PER_PAD;

    for (let i = 0; i < boosts.length; i += 1) {
      const b = boosts[i];
      if (b === undefined) continue;
      const cx = b.x + b.w * 0.5;
      const cz = b.y + b.h * 0.5;
      if (pads !== null) {
        composeInstance(pads, i, cx, RENDER3D.BOOST_LIFT, cz, b.w, RENDER3D.BOOST_HEIGHT, b.h);
      }
      if (arrows === null) continue;

      // Chevrons point along the pad's baked unit direction. Trig is fine here:
      // this is presentation, the simulation never sees an angle.
      const yaw = Math.atan2(-b.dir.y, b.dir.x);
      const extent = Math.abs(b.dir.x) * b.w + Math.abs(b.dir.y) * b.h;
      const spacing = extent / (perPad + 1);
      const size = Math.max(1.1, Math.min(4, Math.min(b.w, b.h) * 0.62));
      for (let k = 0; k < perPad; k += 1) {
        const offset = (k + 1) * spacing - extent * 0.5;
        composeInstance(
          arrows,
          i * perPad + k,
          cx + b.dir.x * offset,
          RENDER3D.CHEVRON_LIFT,
          cz + b.dir.y * offset,
          size,
          1,
          size,
          yaw,
        );
      }
    }

    if (pads !== null) {
      pads.instanceMatrix.needsUpdate = true;
      pads.computeBoundingSphere();
    }
    if (arrows !== null) {
      arrows.instanceMatrix.needsUpdate = true;
      arrows.computeBoundingSphere();
    }
  }, [boosts, materials]);

  if (boosts.length === 0) return null;

  return (
    <>
      <instancedMesh
        ref={padRef}
        args={[box, materials.pad, boosts.length]}
        receiveShadow={profile.shadows}
        frustumCulled={false}
      />
      <instancedMesh
        ref={chevronRef}
        args={[chevronGeometry, materials.arrow, chevronCount]}
        frustumCulled={false}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

export interface ObstaclesProps {
  readonly level: LevelSpec;
  readonly theme: Theme;
  readonly quality: QualityTier;
  /**
   * Optional hit feedback, indexed by `Obstacle.id` (the generator assigns
   * `0..n-1` in creation order). Write `performance.now()` into a slot to make
   * that bumper flash. Owned by CourseScene so nothing here allocates.
   */
  readonly pulses?: Float32Array;
  readonly reducedMotion?: boolean;
}

export function Obstacles({
  level,
  theme,
  quality,
  pulses,
  reducedMotion = false,
}: ObstaclesProps): JSX.Element {
  const colors = useMemo(() => themeColors(theme), [theme]);
  const profile = resolveQuality(quality);

  const grouped = useMemo(() => {
    const walls: WallRect[] = [];
    const bumpers: BumperCircle[] = [];
    const sand: SandRect[] = [];
    const water: WaterRect[] = [];
    const boosts: BoostRect[] = [];
    for (const obstacle of level.obstacles) {
      switch (obstacle.kind) {
        case 'wall':
          walls.push(obstacle);
          break;
        case 'bumper':
          bumpers.push(obstacle);
          break;
        case 'sand':
          sand.push(obstacle);
          break;
        case 'water':
          water.push(obstacle);
          break;
        case 'boost':
          boosts.push(obstacle);
          break;
        default:
          break;
      }
    }
    return { walls, bumpers, sand, water, boosts };
  }, [level]);

  return (
    <group>
      <WallInstances walls={grouped.walls} colors={colors} profile={profile} />
      <BumperInstances
        bumpers={grouped.bumpers}
        colors={colors}
        profile={profile}
        pulses={pulses}
      />
      <SandInstances sand={grouped.sand} colors={colors} profile={profile} />
      <WaterInstances
        water={grouped.water}
        colors={colors}
        profile={profile}
        reducedMotion={reducedMotion}
      />
      <BoostInstances boosts={grouped.boosts} colors={colors} profile={profile} />
    </group>
  );
}

export default Obstacles;
