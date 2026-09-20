/**
 * Single entry point of the 3D bundle.
 *
 * Import ONLY through `next/dynamic(() => import('@/game/rendering/three'), { ssr: false })`
 * (or the equivalent import of `./CourseCanvas`). Anything that pulls this module
 * eagerly drags three.js, R3F and the whole renderer into the first load, which
 * is exactly what the performance budget forbids.
 */

export { default, default as CourseCanvas } from './CourseCanvas';
export { CourseScene } from './CourseScene';
export { CourseMesh } from './CourseMesh';
export { CourseGround } from './CourseGround';
export { HoleMarker } from './HoleMarker';
export { Obstacles } from './Obstacles';
export { Ball, BallRegistryProvider, useBallRegistry } from './Ball';
export type { BallRegistry } from './Ball';
export { AimIndicator } from './AimIndicator';
export { ShotAnimator } from './ShotAnimator';
export { Lighting } from './Lighting';
export { Effects } from './Effects';
export type { EffectsApi, EffectsProps } from './Effects';

export {
  RENDER3D,
  themeColors,
  makeSkyTexture,
  unitBox,
  unitSphere,
  unitCylinder,
  taperedCylinder,
  openTube,
  flatDisc,
  flatRing,
  unitCone,
  chevron,
  pennant,
  disposeAll,
} from './materials';
export type { ThemeColors } from './materials';

export { toWorld, worldX, worldZ, courseOrigin } from './types';
export type {
  AimPreview,
  BallView,
  CourseViewProps,
  ShotPlayback,
  ToCourse,
} from './types';
