'use client';

/**
 * The garden around the hole: trees, shrubs and flower clumps.
 *
 * This is pure decoration — the simulation knows nothing about it, and nothing
 * here is ever collided against. It exists because a bare fairway on a flat
 * plane reads as a pool table rather than a real course.
 *
 * Cost control: every tree trunk, every canopy and every shrub is one
 * InstancedMesh, so the entire garden is THREE draw calls no matter how dense
 * it looks. Nothing here allocates or animates per frame.
 *
 * Placement is derived from `level.seed`, so every peer in the room sees the
 * identical garden without a single byte crossing the wire.
 */
import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { createPrng } from '@/game/levels/prng';
import { resolveQuality } from '@/game/rendering/quality';
import { themeColors } from './materials';
import type { Theme } from '@/game/levels/themes';
import type { LevelSpec, QualityTier } from '@/types';

export interface SceneryProps {
  readonly level: LevelSpec;
  readonly theme: Theme;
  readonly quality: QualityTier;
}

/** How far beyond the course edge the planting band extends, in course units. */
const BAND_INNER = 3.5;
const BAND_OUTER = 26;

/** Planting density per quality tier. Low-end devices still get a garden, just sparser. */
const DENSITY: Record<string, { trees: number; shrubs: number }> = {
  high: { trees: 26, shrubs: 40 },
  medium: { trees: 16, shrubs: 24 },
  low: { trees: 9, shrubs: 12 },
};

/** Scratch objects — hoisted so building the garden never allocates in a loop. */
const M = new THREE.Matrix4();
const P = new THREE.Vector3();
const Q = new THREE.Quaternion();
const S = new THREE.Vector3();

export function Scenery({ level, theme, quality }: SceneryProps): React.JSX.Element | null {
  const profile = resolveQuality(quality);
  const colors = useMemo(() => themeColors(theme), [theme]);
  const counts = DENSITY[quality] ?? DENSITY.medium!;

  const geometries = useMemo(
    () => ({
      trunk: new THREE.CylinderGeometry(0.34, 0.5, 1, profile.shadows ? 7 : 5),
      canopy: new THREE.IcosahedronGeometry(1, profile.shadows ? 1 : 0),
      shrub: new THREE.IcosahedronGeometry(1, 0),
    }),
    [profile.shadows],
  );

  const materials = useMemo(() => {
    const canopy = colors.rough.clone().lerp(new THREE.Color(0x2f7d3a), 0.55);
    return {
      trunk: new THREE.MeshStandardMaterial({ color: 0x6b4a2f, roughness: 0.92, metalness: 0 }),
      canopy: new THREE.MeshStandardMaterial({ color: canopy, roughness: 0.85, metalness: 0, flatShading: true }),
      shrub: new THREE.MeshStandardMaterial({
        color: colors.rough.clone().lerp(new THREE.Color(0x5fae4a), 0.4),
        roughness: 0.9,
        metalness: 0,
        flatShading: true,
      }),
    };
  }, [colors]);

  useEffect(
    () => () => {
      for (const g of Object.values(geometries)) g.dispose();
      for (const m of Object.values(materials)) m.dispose();
    },
    [geometries, materials],
  );

  /**
   * Deterministic placement. Rejection-sampled into the band around the course so
   * nothing ever sits on the playing surface or blocks the camera's view of it.
   */
  const layout = useMemo(() => {
    const rng = createPrng(level.seed ^ 0x5ca7e12);
    const trees: { x: number; z: number; h: number; r: number; tilt: number }[] = [];
    const shrubs: { x: number; z: number; r: number }[] = [];

    const place = (): { x: number; z: number } | null => {
      for (let attempt = 0; attempt < 24; attempt += 1) {
        const x = rng.range(-BAND_OUTER, level.width + BAND_OUTER);
        const z = rng.range(-BAND_OUTER, level.height + BAND_OUTER);
        const outsideX = x < -BAND_INNER || x > level.width + BAND_INNER;
        const outsideZ = z < -BAND_INNER || z > level.height + BAND_INNER;
        if (outsideX || outsideZ) return { x, z };
      }
      return null;
    };

    for (let i = 0; i < counts.trees; i += 1) {
      const spot = place();
      if (spot === null) continue;
      trees.push({
        x: spot.x,
        z: spot.z,
        h: rng.range(5.5, 10.5),
        r: rng.range(2.2, 3.8),
        // Small lean so a row of trees never looks stamped from one mould.
        tilt: rng.range(-0.08, 0.08),
      });
    }
    for (let i = 0; i < counts.shrubs; i += 1) {
      const spot = place();
      if (spot === null) continue;
      shrubs.push({ x: spot.x, z: spot.z, r: rng.range(0.9, 2.1) });
    }
    return { trees, shrubs };
  }, [level.seed, level.width, level.height, counts.trees, counts.shrubs]);

  const trunkRef = useCallbackRef(layout.trees, (mesh) => {
    layout.trees.forEach((t, i) => {
      P.set(t.x, t.h * 0.5, t.z);
      Q.setFromEuler(new THREE.Euler(t.tilt, 0, t.tilt * 0.5));
      S.set(1, t.h, 1);
      M.compose(P, Q, S);
      mesh.setMatrixAt(i, M);
    });
    mesh.instanceMatrix.needsUpdate = true;
  });

  const canopyRef = useCallbackRef(layout.trees, (mesh) => {
    layout.trees.forEach((t, i) => {
      P.set(t.x, t.h + t.r * 0.35, t.z);
      Q.setFromEuler(new THREE.Euler(t.tilt, t.x, t.tilt));
      S.set(t.r, t.r * 1.18, t.r);
      M.compose(P, Q, S);
      mesh.setMatrixAt(i, M);
    });
    mesh.instanceMatrix.needsUpdate = true;
  });

  const shrubRef = useCallbackRef(layout.shrubs, (mesh) => {
    layout.shrubs.forEach((b, i) => {
      P.set(b.x, b.r * 0.55, b.z);
      Q.setFromEuler(new THREE.Euler(0, b.x, 0));
      S.set(b.r, b.r * 0.8, b.r);
      M.compose(P, Q, S);
      mesh.setMatrixAt(i, M);
    });
    mesh.instanceMatrix.needsUpdate = true;
  });

  if (layout.trees.length === 0 && layout.shrubs.length === 0) return null;

  return (
    <group>
      {layout.trees.length > 0 ? (
        <>
          <instancedMesh
            ref={trunkRef}
            args={[geometries.trunk, materials.trunk, layout.trees.length]}
            castShadow={profile.shadows}
          />
          <instancedMesh
            ref={canopyRef}
            args={[geometries.canopy, materials.canopy, layout.trees.length]}
            castShadow={profile.shadows}
          />
        </>
      ) : null}
      {layout.shrubs.length > 0 ? (
        <instancedMesh
          ref={shrubRef}
          args={[geometries.shrub, materials.shrub, layout.shrubs.length]}
          castShadow={profile.shadows}
        />
      ) : null}
    </group>
  );
}

/** Runs `fill` once the InstancedMesh exists, and again whenever the layout changes. */
function useCallbackRef<T>(
  dep: readonly T[],
  fill: (mesh: THREE.InstancedMesh) => void,
): (mesh: THREE.InstancedMesh | null) => void {
  return useMemo(() => {
    return (mesh: THREE.InstancedMesh | null): void => {
      if (mesh === null) return;
      fill(mesh);
    };
    // `fill` closes over `dep`; rebuilding on dep change is the point.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dep]);
}

export default Scenery;
