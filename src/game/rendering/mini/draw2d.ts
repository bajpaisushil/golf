/**
 * Pure canvas-2d drawing for the "mini board" — a deliberately cheap top-down
 * view of a course.
 *
 * Why this exists: Friend Battle gives every player their OWN course and we want
 * to show all of them live. Eight three.js scenes would melt a phone, so the
 * opponent strip renders each board with a handful of `fillRect` / `arc` calls
 * instead. The same functions back the lobby preview, the round summary and the
 * WebGL-less fallback.
 *
 * Everything here is PRESENTATION: it only ever READS a `LevelSpec`, never
 * mutates it and never feeds anything back into the simulation. Nothing in this
 * file is on the deterministic path, but it still avoids trig so it stays cheap.
 *
 * No DOM lookups, no React, no allocations per obstacle beyond what canvas needs
 * — everything takes a `CanvasRenderingContext2D` and plain data, so it is
 * directly unit-testable with a stub context.
 */

import type { Hex, LevelSpec, Obstacle, Vec2 } from '@/types';
import { PHYSICS } from '@/game/config';
import type { Theme } from '@/game/levels/themes';
import { shadeHex, withAlpha } from '@/game/rendering/palette';

// ---------------------------------------------------------------------------
// Tunables (presentation only — pixel sizes, never gameplay)
// ---------------------------------------------------------------------------

export interface MiniStyleConfig {
  /** Breathing room in CSS px between the board edge and the course felt. */
  readonly PADDING_PX: number;
  /** Corner radius of the felt in CSS px. */
  readonly FELT_RADIUS_PX: number;
  /** Thickness of the outer wall stroke in CSS px. */
  readonly BORDER_PX: number;
  /** A ball is never drawn smaller than this, however tiny the board is. */
  readonly BALL_MIN_PX: number;
  /** Outline width around a ball so light balls stay visible on light sand. */
  readonly BALL_OUTLINE_PX: number;
  /** Extra ring drawn around the local player's ball. */
  readonly SELF_RING_PX: number;
  /** Cup ring thickness. */
  readonly HOLE_RING_PX: number;
  /** Trail polyline width. */
  readonly TRAIL_PX: number;
  /** Opacity of the shot trail. */
  readonly TRAIL_ALPHA: number;
  /** Highlight band on top of wall blocks, as a fraction of the block height. */
  readonly WALL_TOP_SHARE: number;
  /** How much lighter the wall highlight is (-1..1, see palette.shadeHex). */
  readonly WALL_TOP_SHADE: number;
  /** Alpha of hazard (sand/water/boost) fills — they are floor decals, not solids. */
  readonly HAZARD_ALPHA: number;
  /** Alpha of the thin hazard outline. */
  readonly HAZARD_EDGE_ALPHA: number;
  /** Length of one boost chevron in CSS px. */
  readonly BOOST_ARROW_PX: number;
  /** Half-width of one boost chevron in CSS px. */
  readonly BOOST_ARROW_HALF_PX: number;
  /** Smallest board (CSS px) we bother drawing detail into. */
  readonly DETAIL_MIN_PX: number;
  /** Target redraw rate for the live board. 20fps is plenty for a thumbnail. */
  readonly FPS: number;
  /** Device pixel ratio cap for mini boards — they are small, 2 is already sharp. */
  readonly MAX_DPR: number;
}

export const MINI: MiniStyleConfig = {
  PADDING_PX: 3,
  FELT_RADIUS_PX: 8,
  BORDER_PX: 2,
  BALL_MIN_PX: 2.2,
  BALL_OUTLINE_PX: 1,
  SELF_RING_PX: 1.5,
  HOLE_RING_PX: 1.5,
  TRAIL_PX: 1.5,
  TRAIL_ALPHA: 0.55,
  WALL_TOP_SHARE: 0.3,
  WALL_TOP_SHADE: 0.22,
  HAZARD_ALPHA: 0.85,
  HAZARD_EDGE_ALPHA: 0.5,
  BOOST_ARROW_PX: 7,
  BOOST_ARROW_HALF_PX: 3.5,
  DETAIL_MIN_PX: 90,
  FPS: 20,
  MAX_DPR: 2,
};

/** Minimal 2d context surface we rely on — keeps the module testable with a stub. */
export type Ctx2D = CanvasRenderingContext2D;

// ---------------------------------------------------------------------------
// Ball view (structurally compatible with rendering/three/types.BallView)
// ---------------------------------------------------------------------------

/**
 * What the mini board needs to know about a ball.
 *
 * Deliberately a SUPERSET-friendly shape: a `BallView` from
 * `@/game/rendering/three/types` is assignable to this, so callers can pass the
 * same array to the 3D course and to the mini board without mapping it.
 */
export interface MiniBall {
  readonly pos: Vec2;
  readonly color: Hex;
  readonly holed?: boolean;
  readonly isSelf?: boolean;
  readonly label?: string;
  readonly playerId?: string;
}

// ---------------------------------------------------------------------------
// Projection: course units -> pixels
// ---------------------------------------------------------------------------

/** A pixel box in CSS pixels. */
export interface PixelBox {
  readonly width: number;
  readonly height: number;
}

/**
 * Course -> pixel mapping. Aspect ratio preserving ("contain"), so a 64x96
 * course drawn into a square box is letterboxed rather than squashed.
 */
export interface MiniProjection {
  /** CSS pixels per course unit. */
  readonly scale: number;
  /** Left edge of the course inside the box, CSS px. */
  readonly offsetX: number;
  /** Top edge of the course inside the box, CSS px. */
  readonly offsetY: number;
  /** Drawn course size in CSS px. */
  readonly width: number;
  readonly height: number;
}

function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Fits `level` into `box`, centred, preserving aspect ratio.
 * Always returns a usable projection — a degenerate box yields scale 0 rather
 * than NaN, and every draw function no-ops safely on a zero scale.
 */
export function fitProjection(level: LevelSpec, box: PixelBox, padding: number = MINI.PADDING_PX): MiniProjection {
  const boxW = Math.max(0, finite(box.width, 0));
  const boxH = Math.max(0, finite(box.height, 0));
  const pad = Math.max(0, Math.min(finite(padding, 0), Math.min(boxW, boxH) / 2));
  const availW = Math.max(0, boxW - pad * 2);
  const availH = Math.max(0, boxH - pad * 2);
  const levelW = Math.max(1e-6, finite(level.width, 1));
  const levelH = Math.max(1e-6, finite(level.height, 1));
  const scale = Math.max(0, Math.min(availW / levelW, availH / levelH));
  const width = levelW * scale;
  const height = levelH * scale;
  return {
    scale,
    offsetX: pad + (availW - width) / 2,
    offsetY: pad + (availH - height) / 2,
    width,
    height,
  };
}

/** Course x (cu) -> CSS px inside the box. */
export function projectX(p: MiniProjection, x: number): number {
  return p.offsetX + finite(x, 0) * p.scale;
}

/** Course y (cu) -> CSS px inside the box. */
export function projectY(p: MiniProjection, y: number): number {
  return p.offsetY + finite(y, 0) * p.scale;
}

/** Course length (cu) -> CSS px. */
export function projectLen(p: MiniProjection, cu: number): number {
  return Math.max(0, finite(cu, 0)) * p.scale;
}

/**
 * Inverse mapping: CSS px inside the box -> course units.
 * Lets the mini board double as an input surface (it is a valid `toCourse`
 * projection for `useAimControls` once the caller subtracts the canvas origin).
 */
export function unprojectPoint(p: MiniProjection, px: number, py: number): Vec2 {
  if (p.scale <= 0) return { x: 0, y: 0 };
  return {
    x: (finite(px, 0) - p.offsetX) / p.scale,
    y: (finite(py, 0) - p.offsetY) / p.scale,
  };
}

// ---------------------------------------------------------------------------
// Small canvas helpers
// ---------------------------------------------------------------------------

/** Structural view of the optional `roundRect` (missing in jsdom and older Safari). */
interface MaybeRoundRect {
  roundRect?: (x: number, y: number, w: number, h: number, r: number) => void;
}

/** `ctx.roundRect` with a hand-rolled fallback (jsdom / older Safari). */
function roundedRectPath(ctx: Ctx2D, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  if (radius <= 0) {
    ctx.rect(x, y, w, h);
    return;
  }
  const withRoundRect = ctx as unknown as MaybeRoundRect;
  if (typeof withRoundRect.roundRect === 'function') {
    withRoundRect.roundRect(x, y, w, h, radius);
    return;
  }
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.arcTo(x + w, y, x + w, y + radius, radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.arcTo(x + w, y + h, x + w - radius, y + h, radius);
  ctx.lineTo(x + radius, y + h);
  ctx.arcTo(x, y + h, x, y + h - radius, radius);
  ctx.lineTo(x, y + radius);
  ctx.arcTo(x, y, x + radius, y, radius);
  ctx.closePath();
}

function circlePath(ctx: Ctx2D, cx: number, cy: number, r: number): void {
  ctx.beginPath();
  ctx.arc(cx, cy, Math.max(0, r), 0, TAU);
}

/** Full turn in radians. Presentation constant — the simulation never sees it. */
const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------

/** Theme colour for one obstacle. Shared by the canvas and SVG paths. */
export function obstacleFill(o: Obstacle, theme: Theme): Hex {
  switch (o.kind) {
    case 'wall':
      return theme.wall;
    case 'bumper':
      return theme.bumper;
    case 'sand':
      return theme.sand;
    case 'water':
      return theme.water;
    case 'boost':
      return theme.boost;
    default:
      return theme.wall;
  }
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

/**
 * Felt + outer walls. Call this first: it paints the playfield background that
 * everything else sits on. Does NOT clear the canvas (see {@link renderMini}).
 */
export function drawLevel(ctx: Ctx2D, level: LevelSpec, theme: Theme, proj: MiniProjection): void {
  if (proj.scale <= 0) return;
  const radius = Math.min(MINI.FELT_RADIUS_PX, proj.width / 4, proj.height / 4);

  roundedRectPath(ctx, proj.offsetX, proj.offsetY, proj.width, proj.height, radius);
  ctx.fillStyle = theme.felt;
  ctx.fill();

  // A soft inner lip so the board reads as a sunken table, not a flat swatch.
  ctx.strokeStyle = theme.feltEdge;
  ctx.lineWidth = MINI.BORDER_PX;
  ctx.stroke();
}

/** Every obstacle, in creation order (ids 0..n-1), so overlaps look identical everywhere. */
export function drawObstacles(ctx: Ctx2D, level: LevelSpec, theme: Theme, proj: MiniProjection): void {
  if (proj.scale <= 0) return;
  const detailed = Math.min(proj.width, proj.height) >= MINI.DETAIL_MIN_PX;
  for (const o of level.obstacles) {
    drawObstacle(ctx, o, theme, proj, detailed);
  }
}

/** One obstacle. `detailed` adds highlights/arrows that vanish on tiny boards. */
export function drawObstacle(
  ctx: Ctx2D,
  o: Obstacle,
  theme: Theme,
  proj: MiniProjection,
  detailed: boolean = true,
): void {
  if (proj.scale <= 0) return;
  const fill = obstacleFill(o, theme);

  if (o.kind === 'bumper') {
    const cx = projectX(proj, o.cx);
    const cy = projectY(proj, o.cy);
    const r = projectLen(proj, o.r);
    if (r <= 0) return;
    circlePath(ctx, cx, cy, r);
    ctx.fillStyle = fill;
    ctx.fill();
    if (detailed) {
      circlePath(ctx, cx, cy, Math.max(0, r * 0.55));
      ctx.fillStyle = shadeHex(fill, MINI.WALL_TOP_SHADE);
      ctx.fill();
    }
    return;
  }

  const x = projectX(proj, o.x);
  const y = projectY(proj, o.y);
  const w = projectLen(proj, o.w);
  const h = projectLen(proj, o.h);
  if (w <= 0 || h <= 0) return;

  if (o.kind === 'wall') {
    ctx.fillStyle = fill;
    ctx.fillRect(x, y, w, h);
    if (detailed) {
      // Fake extrusion: a lighter band along the top edge, same trick the 3D
      // renderer gets for free from its lighting.
      ctx.fillStyle = shadeHex(theme.wallTop, MINI.WALL_TOP_SHADE);
      ctx.fillRect(x, y, w, Math.max(1, h * MINI.WALL_TOP_SHARE));
    }
    return;
  }

  // Hazards are floor decals: translucent fill + a thin edge.
  ctx.fillStyle = withAlpha(fill, MINI.HAZARD_ALPHA);
  ctx.fillRect(x, y, w, h);
  if (detailed) {
    ctx.strokeStyle = withAlpha(shadeHex(fill, MINI.WALL_TOP_SHADE), MINI.HAZARD_EDGE_ALPHA);
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, Math.max(0, w - 1), Math.max(0, h - 1));
  }

  if (o.kind === 'boost' && detailed) {
    drawBoostArrow(ctx, x + w / 2, y + h / 2, o.dir, theme);
  }
}

/**
 * A single chevron pointing along the pad's baked unit vector.
 * No trig: the perpendicular of a unit vector (x,y) is (-y,x).
 */
function drawBoostArrow(ctx: Ctx2D, cx: number, cy: number, dir: Vec2, theme: Theme): void {
  const dx = finite(dir.x, 0);
  const dy = finite(dir.y, 0);
  if (dx === 0 && dy === 0) return;
  const len = MINI.BOOST_ARROW_PX / 2;
  const half = MINI.BOOST_ARROW_HALF_PX;
  const px = -dy;
  const py = dx;
  const tipX = cx + dx * len;
  const tipY = cy + dy * len;
  const baseX = cx - dx * len;
  const baseY = cy - dy * len;

  ctx.beginPath();
  ctx.moveTo(baseX + px * half, baseY + py * half);
  ctx.lineTo(tipX, tipY);
  ctx.lineTo(baseX - px * half, baseY - py * half);
  ctx.strokeStyle = withAlpha(theme.accent, 0.9);
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.stroke();
}

/** The cup: dark well plus an accent ring so it reads at thumbnail size. */
export function drawHole(ctx: Ctx2D, level: LevelSpec, theme: Theme, proj: MiniProjection): void {
  if (proj.scale <= 0) return;
  const cx = projectX(proj, level.hole.center.x);
  const cy = projectY(proj, level.hole.center.y);
  const r = Math.max(1.5, projectLen(proj, level.hole.radius));

  circlePath(ctx, cx, cy, r);
  ctx.fillStyle = theme.hole;
  ctx.fill();

  circlePath(ctx, cx, cy, r);
  ctx.strokeStyle = withAlpha(theme.accent, 0.85);
  ctx.lineWidth = MINI.HOLE_RING_PX;
  ctx.stroke();
}

/** One ball. Holed balls are drawn hollow so a finished board still reads. */
export function drawBall(
  ctx: Ctx2D,
  ball: MiniBall,
  theme: Theme,
  proj: MiniProjection,
  radiusCu: number = PHYSICS.BALL_RADIUS,
): void {
  if (proj.scale <= 0) return;
  const cx = projectX(proj, ball.pos.x);
  const cy = projectY(proj, ball.pos.y);
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) return;
  const r = Math.max(MINI.BALL_MIN_PX, projectLen(proj, radiusCu));

  if (ball.holed === true) {
    circlePath(ctx, cx, cy, r);
    ctx.strokeStyle = ball.color;
    ctx.lineWidth = MINI.BALL_OUTLINE_PX + 0.5;
    ctx.stroke();
    return;
  }

  if (ball.isSelf === true) {
    circlePath(ctx, cx, cy, r + MINI.SELF_RING_PX + 1);
    ctx.strokeStyle = withAlpha(theme.accent, 0.9);
    ctx.lineWidth = MINI.SELF_RING_PX;
    ctx.stroke();
  }

  circlePath(ctx, cx, cy, r);
  ctx.fillStyle = ball.color;
  ctx.fill();
  ctx.strokeStyle = withAlpha(theme.feltEdge, 0.9);
  ctx.lineWidth = MINI.BALL_OUTLINE_PX;
  ctx.stroke();
}

/** Every ball, self last so it is never hidden under an opponent. */
export function drawBalls(
  ctx: Ctx2D,
  balls: readonly MiniBall[],
  theme: Theme,
  proj: MiniProjection,
  radiusCu: number = PHYSICS.BALL_RADIUS,
): void {
  for (const ball of balls) {
    if (ball.isSelf !== true) drawBall(ctx, ball, theme, proj, radiusCu);
  }
  for (const ball of balls) {
    if (ball.isSelf === true) drawBall(ctx, ball, theme, proj, radiusCu);
  }
}

/** A sampled shot trajectory, drawn as a translucent polyline. */
export function drawTrail(ctx: Ctx2D, path: readonly Vec2[], color: Hex, proj: MiniProjection): void {
  if (proj.scale <= 0 || path.length < 2) return;
  const first = path[0];
  if (first === undefined) return;

  ctx.beginPath();
  ctx.moveTo(projectX(proj, first.x), projectY(proj, first.y));
  for (let i = 1; i < path.length; i += 1) {
    const p = path[i];
    if (p === undefined) continue;
    ctx.lineTo(projectX(proj, p.x), projectY(proj, p.y));
  }
  ctx.strokeStyle = withAlpha(color, MINI.TRAIL_ALPHA);
  ctx.lineWidth = MINI.TRAIL_PX;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.stroke();
}

// ---------------------------------------------------------------------------
// One-call renderer
// ---------------------------------------------------------------------------

export interface MiniScene {
  readonly level: LevelSpec;
  readonly theme: Theme;
  readonly balls: readonly MiniBall[];
  /** Optional sampled trajectory of the most recent shot. */
  readonly trail?: readonly Vec2[] | null;
  /** Colour of the trail; defaults to the theme accent. */
  readonly trailColor?: Hex;
  /** Board size in CSS pixels. */
  readonly box: PixelBox;
  /** Device pixel ratio the backing store was sized with. */
  readonly dpr: number;
  /** Ball radius override in course units. */
  readonly ballRadiusCu?: number;
  /** Padding between board edge and felt, CSS px. */
  readonly padding?: number;
}

/**
 * Draws a whole board in one pass: resets the transform for the given dpr,
 * clears, then felt -> obstacles -> hole -> trail -> balls.
 *
 * Returns the projection it used so callers can hit-test against the same
 * mapping (e.g. to turn a tap into course units).
 */
export function renderMini(ctx: Ctx2D, scene: MiniScene): MiniProjection {
  const dpr = Math.max(0.5, finite(scene.dpr, 1));
  const w = Math.max(0, finite(scene.box.width, 0));
  const h = Math.max(0, finite(scene.box.height, 0));

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const proj = fitProjection(scene.level, scene.box, scene.padding ?? MINI.PADDING_PX);
  if (proj.scale <= 0) return proj;

  drawLevel(ctx, scene.level, scene.theme, proj);

  // Clip to the felt so an obstacle that kisses the border cannot bleed out of
  // the rounded corners.
  ctx.save();
  roundedRectPath(
    ctx,
    proj.offsetX,
    proj.offsetY,
    proj.width,
    proj.height,
    Math.min(MINI.FELT_RADIUS_PX, proj.width / 4, proj.height / 4),
  );
  ctx.clip();

  drawObstacles(ctx, scene.level, scene.theme, proj);
  drawHole(ctx, scene.level, scene.theme, proj);
  if (scene.trail && scene.trail.length > 1) {
    drawTrail(ctx, scene.trail, scene.trailColor ?? scene.theme.accent, proj);
  }
  drawBalls(ctx, scene.balls, scene.theme, proj, scene.ballRadiusCu ?? PHYSICS.BALL_RADIUS);

  ctx.restore();
  return proj;
}

// ---------------------------------------------------------------------------
// SVG helpers (CONTRACTS.md §8 `mini/miniDraw.ts`)
//
// Kept here so the mini renderer has ONE home: the same pure geometry powers the
// canvas board and any inline-SVG preview (the home screen must not pull three.js).
// ---------------------------------------------------------------------------

/** `viewBox` covering the whole course in course units. */
export function courseViewBox(level: LevelSpec): string {
  const w = Math.max(1e-6, finite(level.width, 1));
  const h = Math.max(1e-6, finite(level.height, 1));
  return `0 0 ${w} ${h}`;
}

/** SVG `d` for one obstacle, in COURSE units (pair it with {@link courseViewBox}). */
export function obstacleSvgPath(o: Obstacle): string {
  if (o.kind === 'bumper') {
    const cx = finite(o.cx, 0);
    const cy = finite(o.cy, 0);
    const r = Math.max(0, finite(o.r, 0));
    // Two arcs make a full circle without needing any trig.
    return `M ${cx - r} ${cy} a ${r} ${r} 0 1 0 ${r * 2} 0 a ${r} ${r} 0 1 0 ${-r * 2} 0 Z`;
  }
  const x = finite(o.x, 0);
  const y = finite(o.y, 0);
  const w = Math.max(0, finite(o.w, 0));
  const h = Math.max(0, finite(o.h, 0));
  return `M ${x} ${y} h ${w} v ${h} h ${-w} Z`;
}

/** `"x,y x,y ..."` for an SVG `<polyline points>`. Skips non-finite samples. */
export function pathPolyline(path: readonly Vec2[]): string {
  const parts: string[] = [];
  for (const p of path) {
    if (p === undefined) continue;
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    parts.push(`${p.x},${p.y}`);
  }
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Input bridge
// ---------------------------------------------------------------------------

/**
 * Builds the `toCourse(clientX, clientY)` callback `useAimControls` expects for
 * a 2D board: client pixels -> element-local pixels -> course units, using the
 * exact projection {@link renderMini} drew with.
 *
 * The 3D renderer supplies its own (it has to raycast the camera); this is the
 * cheap flat equivalent, so the mini board can be a playable surface too.
 */
export function courseProjectionFor(
  element: Element | null,
  level: LevelSpec,
  padding: number = MINI.PADDING_PX,
): (clientX: number, clientY: number) => Vec2 {
  return (clientX: number, clientY: number): Vec2 => {
    if (element === null || typeof element.getBoundingClientRect !== 'function') {
      return { x: Number.NaN, y: Number.NaN };
    }
    const rect = element.getBoundingClientRect();
    const proj = fitProjection(level, { width: rect.width, height: rect.height }, padding);
    if (proj.scale <= 0) return { x: Number.NaN, y: Number.NaN };
    return unprojectPoint(proj, clientX - rect.left, clientY - rect.top);
  };
}
