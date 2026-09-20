'use client';

/**
 * The single lazy entry point of the 3D layer.
 *
 * `src/modes/GameScreen.tsx` is the only module allowed to import this, and it
 * must do so through `next/dynamic(..., { ssr: false })` so that three.js never
 * reaches the home-screen bundle.
 *
 * This component owns the `<Canvas>`, the dpr cap, the WebGL settings that come
 * from the quality tier, the pointer surface for the slingshot, and the
 * no-WebGL fallback. Everything else lives in `CourseScene`.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import type { CSSProperties, JSX } from 'react';
import * as THREE from 'three';

import { UI } from '@/game/rendering/palette';
import { cappedDpr, resolveQuality, supportsWebGL } from '@/game/rendering/quality';

import { CourseScene } from './CourseScene';
import { RENDER3D } from './materials';
import type { CourseViewProps } from './types';

/**
 * three.js r155+ defaults to `ColorManagement` on, which is what we want: the
 * theme hex values are authored in sRGB and the renderer works in linear.
 */
THREE.ColorManagement.enabled = true;

export default function CourseCanvas(props: CourseViewProps): JSX.Element {
  const {
    quality,
    className,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    fallback,
  } = props;

  const profile = resolveQuality(quality);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // WebGL support is a client-only fact; assume yes until mounted so SSR output
  // and the first client render agree.
  const [webgl, setWebgl] = useState(true);
  useEffect(() => {
    setWebgl(supportsWebGL());
  }, []);

  const dpr = useMemo<[number, number]>(() => {
    const capped = cappedDpr(profile);
    return [1, Math.max(1, capped)];
  }, [profile]);

  const glOptions = useMemo(
    () => ({
      antialias: profile.antialias,
      alpha: false,
      stencil: false,
      depth: true,
      powerPreference: (profile.tier === 'low' ? 'low-power' : 'high-performance') as
        | 'low-power'
        | 'high-performance',
      preserveDrawingBuffer: false,
    }),
    [profile],
  );

  const cameraOptions = useMemo(
    () => ({
      fov: RENDER3D.CAM_FOV,
      near: RENDER3D.CAM_NEAR,
      far: RENDER3D.CAM_FAR,
      position: [0, 120, 70] as [number, number, number],
    }),
    [],
  );

  const style = useMemo<CSSProperties>(
    () => ({
      // The slingshot needs raw pointer events: no scrolling, no double-tap zoom.
      touchAction: 'none' as const,
      width: '100%',
      height: '100%',
      background: UI.bg,
      userSelect: 'none' as const,
      WebkitUserSelect: 'none' as const,
      WebkitTapHighlightColor: 'transparent',
    }),
    [],
  );

  if (!webgl) {
    return (
      <div ref={containerRef} className={className} style={style}>
        {fallback ?? null}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={className}
      style={style}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      <Canvas
        dpr={dpr}
        gl={glOptions}
        camera={cameraOptions}
        shadows={profile.shadows}
        frameloop="always"
        onCreated={(state) => {
          state.gl.setClearColor(UI.bg, 1);
          state.gl.toneMapping = THREE.ACESFilmicToneMapping;
          state.gl.toneMappingExposure = 1.05;
          if (profile.shadows) {
            state.gl.shadowMap.enabled = true;
            state.gl.shadowMap.type = THREE.PCFSoftShadowMap;
          }
        }}
      >
        <CourseScene {...props} />
      </Canvas>
    </div>
  );
}
