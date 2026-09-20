'use client';

/**
 * Key + fill + rim + hemisphere, plus a fully procedural sky/environment.
 *
 * No HDRI is fetched (drei's `<Environment preset>` would download one, which the
 * project forbids). Instead a 4x64 gradient DataTexture doubles as the skybox and
 * as `scene.environment`, which is what gives the ball and the bumpers their
 * glossy fall-off for essentially zero cost.
 */

import { useEffect, useMemo, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import type { JSX } from 'react';
import * as THREE from 'three';

import { resolveQuality } from '@/game/rendering/quality';
import type { Theme } from '@/game/levels/themes';
import type { LevelSpec, QualityTier } from '@/types';

import { RENDER3D, makeSkyTexture, themeColors } from './materials';

export interface LightingProps {
  readonly theme: Theme;
  readonly quality: QualityTier;
  /** Optional: sizes the shadow frustum and the fog to the course. */
  readonly level?: LevelSpec;
}

export function Lighting({ theme, quality, level }: LightingProps): JSX.Element {
  const scene = useThree((state) => state.scene);
  const colors = useMemo(() => themeColors(theme), [theme]);
  const profile = resolveQuality(quality);
  const keyRef = useRef<THREE.DirectionalLight | null>(null);

  const span = level === undefined
    ? 96
    : Math.max(level.width, level.height);

  // Procedural skybox + IBL. Rebuilt only when the theme changes.
  useEffect(() => {
    const texture = makeSkyTexture(colors);
    const previousBackground = scene.background;
    const previousEnvironment = scene.environment;
    scene.background = texture;
    scene.environment = texture;
    scene.environmentIntensity = RENDER3D.ENV_INTENSITY;
    return () => {
      scene.background = previousBackground;
      scene.environment = previousEnvironment;
      texture.dispose();
    };
  }, [scene, colors]);

  // Shadow frustum has to cover the whole course, otherwise the far end is unlit.
  useEffect(() => {
    const light = keyRef.current;
    if (light === null || !profile.shadows) return;
    const half = span * 0.62;
    const camera = light.shadow.camera;
    camera.left = -half;
    camera.right = half;
    camera.top = half;
    camera.bottom = -half;
    camera.near = 1;
    camera.far = span * 3;
    camera.updateProjectionMatrix();
    light.shadow.bias = -0.0012;
    light.shadow.normalBias = 0.35;
  }, [span, profile.shadows]);

  const intensity = theme.lightIntensity;

  return (
    <>
      <fog
        attach="fog"
        args={[colors.fog.getHex(), span * RENDER3D.FOG_NEAR_MULT, span * RENDER3D.FOG_FAR_MULT]}
      />

      {/* Ambient bounce: warm sky above, course-coloured light from below. */}
      <hemisphereLight
        args={[colors.sky.getHex(), colors.rough.getHex(), intensity * 0.95]}
      />

      {/* Key. The only shadow caster, and only on the high tier. */}
      <directionalLight
        ref={keyRef}
        position={[-span * 0.45, span * 0.95, -span * 0.35]}
        intensity={intensity * 1.35}
        color={0xfff4e0}
        castShadow={profile.shadows}
        shadow-mapSize-width={RENDER3D.SHADOW_MAP_SIZE}
        shadow-mapSize-height={RENDER3D.SHADOW_MAP_SIZE}
      />

      {/* Fill from the opposite side so the wall interiors never go pure black. */}
      <directionalLight
        position={[span * 0.6, span * 0.3, span * 0.25]}
        intensity={intensity * 0.45}
        color={colors.sky.getHex()}
      />

      {/* Rim from behind the course: separates the walls from the background. */}
      <directionalLight
        position={[0, span * 0.18, -span * 0.9]}
        intensity={intensity * 0.08}
        color={colors.accent.getHex()}
      />
    </>
  );
}

export default Lighting;
