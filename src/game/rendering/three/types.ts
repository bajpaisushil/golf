/**
 * Shared view-model types for the 3D presentation layer.
 *
 * Nothing here imports three.js, so UI modules may `import type` from this file
 * (and even call `toWorld`) without pulling the 3D bundle into the first load.
 *
 * The renderer only ever READS simulation output - it never produces gameplay
 * state, and none of these values ever travel over the network.
 */

import type * as React from 'react';

import type { Hex, LevelSpec, PlayerId, QualityTier, ShotEvent, Vec2 } from '@/types';

/** One ball as the renderer sees it. Derived from PlayerState by `state/selectors`. */
export interface BallView {
  readonly playerId: PlayerId;
  readonly color: Hex;
  /** Rest position in course units. During playback ShotAnimator overrides this. */
  readonly pos: Vec2;
  readonly isSelf: boolean;
  readonly holed: boolean;
  readonly label: string;
}

/**
 * A shot being animated. Produced from a `ShotResult` the moment playback starts.
 * `startedAt` is `performance.now()` at playback start (wall clock, presentation only).
 */
export interface ShotPlayback {
  readonly playerId: PlayerId;
  readonly path: readonly Vec2[];
  readonly durationMs: number;
  readonly holed: boolean;
  readonly startedAt: number;
  /**
   * Optional passthrough of `ShotResult.events`, used to drive bumper pulses,
   * water ripples and the hole-in burst. Renderers must cope with it missing.
   */
  readonly events?: readonly ShotEvent[];
}

/** Live slingshot preview while the player is dragging. */
export interface AimPreview {
  readonly origin: Vec2;
  /** Already normalised and already the OPPOSITE of the drag. */
  readonly aim: Vec2;
  /** 0..1. Below PHYSICS.MIN_POWER the indicator hides itself. */
  readonly power: number;
  readonly color: Hex;
}

/** Screen pixels to course units. Supplied by the renderer, consumed by `useAimControls`. */
export type ToCourse = (clientX: number, clientY: number) => Vec2;

/**
 * Props shared by `CourseCanvas` (owns the `<Canvas>`) and `CourseScene`
 * (scene graph only).
 *
 * The first block is the contract from `docs/CONTRACTS.md` verbatim. The second
 * block is additive and entirely optional: the contract has no way for the
 * aiming hook to reach the camera, and no way to forward pointer events to the
 * canvas surface, so those are offered here without changing the required shape.
 */
export interface CourseViewProps {
  readonly level: LevelSpec;
  readonly balls: readonly BallView[];
  readonly playback: ShotPlayback | null;
  readonly aim: AimPreview | null;
  readonly quality: QualityTier;
  readonly reducedMotion: boolean;
  readonly onPlaybackEnd?: () => void;
  readonly className?: string;

  // --- additive, all optional -------------------------------------------------
  /** Pointer handlers for the slingshot; forwarded to the canvas wrapper element. */
  readonly onPointerDown?: (event: React.PointerEvent<HTMLDivElement>) => void;
  readonly onPointerMove?: (event: React.PointerEvent<HTMLDivElement>) => void;
  readonly onPointerUp?: (event: React.PointerEvent<HTMLDivElement>) => void;
  readonly onPointerCancel?: (event: React.PointerEvent<HTMLDivElement>) => void;
  /**
   * Called once the camera exists with a screen-to-course projector. Feed it
   * straight into `useAimControls({ toCourse })`.
   */
  readonly onProjectorReady?: (toCourse: ToCourse) => void;
  /** Rendered instead of the canvas when WebGL is unavailable (use `MiniCourse`). */
  readonly fallback?: React.ReactNode;
}

// ---------------------------------------------------------------------------
// Course space <-> world space
// ---------------------------------------------------------------------------

/**
 * THE mapping, used by every module: course `+x` is world `+x`, course `+y`
 * (which points DOWN the screen) is world `+z`, and world `+y` is up. The course
 * is centred on the origin so the camera framing maths stays symmetrical.
 */
export function toWorld(p: Vec2, level: LevelSpec): [number, number, number] {
  return [p.x - level.width * 0.5, 0, p.y - level.height * 0.5];
}

/** Allocation-free component accessors for hot paths. */
export function worldX(courseX: number, level: LevelSpec): number {
  return courseX - level.width * 0.5;
}

export function worldZ(courseY: number, level: LevelSpec): number {
  return courseY - level.height * 0.5;
}

/**
 * Offset of the "course space" group. Everything inside it is positioned in raw
 * course units, which keeps every child free of level-size maths and makes
 * `ShotAnimator` independent of the level.
 */
export function courseOrigin(level: LevelSpec): [number, number, number] {
  return [-level.width * 0.5, 0, -level.height * 0.5];
}
