'use client';

/**
 * The scene graph. No `<Canvas>` here - `CourseCanvas` owns that.
 *
 * Everything that lives on the course sits inside one group offset by
 * `courseOrigin(level)`, so every child positions itself in raw COURSE UNITS and
 * no component needs to know how big the course is. The camera and lights stay
 * in world space.
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import type { JSX } from 'react';
import * as THREE from 'three';

import { getTheme } from '@/game/levels/themes';
import type { LevelSpec, Vec2 } from '@/types';

import { AimIndicator } from './AimIndicator';
import { Ball, BallRegistryProvider } from './Ball';
import { CourseMesh } from './CourseMesh';
import { Effects, type EffectsApi } from './Effects';
import { Lighting } from './Lighting';
import { Obstacles } from './Obstacles';
import { RENDER3D } from './materials';
import { ShotAnimator } from './ShotAnimator';
import { courseOrigin, type CourseViewProps, type ToCourse } from './types';
import { Scenery } from './Scenery';

const DEG2RAD = Math.PI / 180;

// Module-scope scratch for the screen-to-course projector.
const RAYCASTER = new THREE.Raycaster();
const NDC = new THREE.Vector2();
const GROUND_PLANE = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const HIT_POINT = new THREE.Vector3();

function clampAbs(value: number, limit: number): number {
  if (value > limit) return limit;
  if (value < -limit) return -limit;
  return value;
}

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------

interface CameraRigProps {
  readonly level: LevelSpec;
  /** Course-unit point the camera drifts toward; null parks it on the centre. */
  readonly focus: Vec2 | null;
  readonly reducedMotion: boolean;
}

/**
 * Frames the whole course from a tilted near-top-down angle, whatever the course
 * dimensions and whatever the viewport aspect, then eases gently toward the
 * active ball so the play always sits near the middle of the screen.
 */
function CameraRig({ level, focus, reducedMotion }: CameraRigProps): null {
  const camera = useThree((state) => state.camera);
  const size = useThree((state) => state.size);

  const desired = useMemo(() => new THREE.Vector3(), []);
  const lookTarget = useMemo(() => new THREE.Vector3(), []);
  const currentLook = useMemo(() => new THREE.Vector3(), []);
  const snappedRef = useRef(false);

  const base = useMemo(() => {
    // CourseCanvas creates the default camera with exactly this fov.
    const tanHalf = Math.tan(RENDER3D.CAM_FOV * DEG2RAD * 0.5);
    const tilt = RENDER3D.CAM_TILT_DEG * DEG2RAD;
    const aspect = size.height > 0 ? Math.max(0.25, size.width / size.height) : 1;
    // Vertical need: the course foreshortens by cos(tilt) as the camera tips over.
    const distanceForDepth = (level.height * Math.cos(tilt) * 0.5) / tanHalf;
    const distanceForWidth = (level.width * 0.5) / (tanHalf * aspect);
    const distance = Math.max(distanceForDepth, distanceForWidth) * RENDER3D.CAM_MARGIN;
    return {
      y: distance * Math.cos(tilt),
      z: distance * Math.sin(tilt),
    };
  }, [size.width, size.height, level.width, level.height]);

  useEffect(() => {
    snappedRef.current = false;
  }, [level, base]);

  useFrame((_state, delta) => {
    let offsetX = 0;
    let offsetZ = 0;
    if (focus !== null && !reducedMotion) {
      offsetX = clampAbs((focus.x - level.width * 0.5) * RENDER3D.CAM_FOLLOW, RENDER3D.CAM_FOLLOW_MAX);
      offsetZ = clampAbs((focus.y - level.height * 0.5) * RENDER3D.CAM_FOLLOW, RENDER3D.CAM_FOLLOW_MAX);
    }

    desired.set(offsetX, base.y, base.z + offsetZ);
    lookTarget.set(offsetX, 0, offsetZ);

    if (!snappedRef.current || reducedMotion) {
      snappedRef.current = true;
      camera.position.copy(desired);
      currentLook.copy(lookTarget);
    } else {
      // Frame-rate independent exponential ease - no allocation, no overshoot.
      const k = 1 - Math.exp(-RENDER3D.CAM_EASE * Math.min(0.1, delta));
      camera.position.lerp(desired, k);
      currentLook.lerp(lookTarget, k);
    }
    camera.lookAt(currentLook);
  });

  return null;
}

// ---------------------------------------------------------------------------
// Screen -> course projector
// ---------------------------------------------------------------------------

interface ProjectorProps {
  readonly level: LevelSpec;
  readonly onReady?: (toCourse: ToCourse) => void;
}

/**
 * Hands the aiming hook a screen-to-course mapper. The renderer owns the camera,
 * so it is the only thing that can build this (see CONTRACTS section 11).
 */
function Projector({ level, onReady }: ProjectorProps): null {
  const camera = useThree((state) => state.camera);
  const gl = useThree((state) => state.gl);
  const width = level.width;
  const height = level.height;

  useEffect(() => {
    if (onReady === undefined) return;
    const toCourse: ToCourse = (clientX, clientY) => {
      const element = gl.domElement;
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return { x: 0, y: 0 };
      NDC.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      NDC.y = -((clientY - rect.top) / rect.height) * 2 + 1;
      RAYCASTER.setFromCamera(NDC, camera);
      const hit = RAYCASTER.ray.intersectPlane(GROUND_PLANE, HIT_POINT);
      if (hit === null) return { x: 0, y: 0 };
      return { x: hit.x + width * 0.5, y: hit.z + height * 0.5 };
    };
    onReady(toCourse);
  }, [camera, gl, width, height, onReady]);

  return null;
}

// ---------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------

export function CourseScene(props: CourseViewProps): JSX.Element {
  const {
    level,
    balls,
    playback,
    aim,
    quality,
    reducedMotion,
    onPlaybackEnd,
    onProjectorReady,
  } = props;

  const theme = useMemo(() => getTheme(level.themeId), [level.themeId]);
  const origin = useMemo(() => courseOrigin(level), [level]);

  /** One slot per obstacle id, written by ShotAnimator, read by Obstacles. */
  const pulses = useMemo(() => new Float32Array(level.obstacles.length), [level]);

  const effectsRef = useRef<EffectsApi | null>(null);

  const shooter = useMemo(() => {
    if (playback === null) return null;
    for (const ball of balls) {
      if (ball.playerId === playback.playerId) return ball;
    }
    return null;
  }, [balls, playback]);

  // Follow the ball in flight; otherwise sit on this player's ball.
  const focus = useMemo<Vec2 | null>(() => {
    if (shooter !== null) return shooter.pos;
    for (const ball of balls) {
      if (ball.isSelf) return ball.pos;
    }
    const first = balls[0];
    return first === undefined ? null : first.pos;
  }, [balls, shooter]);

  const handlePlaybackEnd = useCallback(() => {
    onPlaybackEnd?.();
  }, [onPlaybackEnd]);

  return (
    <>
      <Lighting theme={theme} quality={quality} level={level} />
      <CameraRig level={level} focus={focus} reducedMotion={reducedMotion} />
      <Projector level={level} onReady={onProjectorReady} />

      <BallRegistryProvider>
        <group position={origin}>
          {/* Decorative garden. Three draw calls, never collided against. */}
          <Scenery level={level} theme={theme} quality={quality} />
          <CourseMesh
            level={level}
            theme={theme}
            quality={quality}
            reducedMotion={reducedMotion}
          />
          <Obstacles
            level={level}
            theme={theme}
            quality={quality}
            pulses={pulses}
            reducedMotion={reducedMotion}
          />

          {balls.map((ball) => (
            <Ball
              key={ball.playerId}
              view={ball}
              quality={quality}
              reducedMotion={reducedMotion}
            />
          ))}

          {aim !== null ? <AimIndicator aim={aim} quality={quality} /> : null}

          <Effects quality={quality} reducedMotion={reducedMotion} apiRef={effectsRef} />

          <ShotAnimator
            playback={playback}
            onEnd={handlePlaybackEnd}
            level={level}
            pulses={pulses}
            effects={effectsRef}
            burstColor={shooter === null ? theme.accent : shooter.color}
            reducedMotion={reducedMotion}
          />
        </group>
      </BallRegistryProvider>
    </>
  );
}

export default CourseScene;
