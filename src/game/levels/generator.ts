/**
 * Deterministic course generation.
 *
 * `generateLevel(roomSeed, roundIndex, variantIndex)` is a PURE function of three
 * integers: every peer rebuilds byte-identical geometry from the three numbers in
 * ROUND_STARTED, so a `LevelSpec` never travels over the wire.
 *
 * DETERMINISM CONTRACT: only `+ - * /`, `Math.sqrt`, `Math.abs`, `Math.min`,
 * `Math.max`, `Math.floor`, plus the exact integer PRNG from `./prng`.
 * No `Math.random`, no trig (directions are built with `sqrt` normalisation),
 * no clock.
 *
 * Playability is GUARANTEED, not hoped for: every blocking obstacle is only kept
 * if a breadth-first search on a 1cu grid still finds a ball-wide route from the
 * spawn to the cup. `isLevelPlayable()` re-runs exactly the same checks, so
 * `isLevelPlayable(generateLevel(...))` is true for every input.
 */

import { LEVEL, PHYSICS } from '@/game/config';
import type {
  BoostRect,
  BumperCircle,
  Hole,
  LevelSpec,
  Obstacle,
  Rect,
  SandRect,
  Vec2,
  WallRect,
  WaterRect,
} from '@/types';
import {
  circleIntersectsRect,
  circleOverlapsCircle,
  rectOverlapsCircle,
  rectOverlapsRect,
  rectOverlapsRectPadded,
} from '@/game/physics/collision';
import { createPrng, seedFor } from './prng';
import type { Prng } from './prng';
import { themeForRound } from './themes';

// ---------------------------------------------------------------------------
// Local generation constants
//
// Not in `@/game/config` (owned by the contracts agent). They shape geometry
// only - changing them changes levels, so bump PROTOCOL_VERSION with them.
// ---------------------------------------------------------------------------

/** Smallest side of any rectangular obstacle. Thinner than this and a fast ball could clip a corner. */
export const MIN_OBSTACLE_SIZE = 2.4;
/** Keep-out gap between two obstacles, in cu. Wider than the ball, so no dead pockets form. */
export const OBSTACLE_GAP = 2.6;
/** Route-check grid resolution in course units. */
export const ROUTE_CELL = 1;
/** Geometry is quantised to this fraction of a cu - tidier shapes, tidier numbers. */
const QUANTUM = 4;

const MARGIN = LEVEL.WALL_MARGIN;

/** The five layout archetypes. Picked by the PRNG so rounds never feel the same. */
export const LAYOUT_ARCHETYPES = ['corridor', 'scatter', 'chicane', 'funnel', 'island'] as const;
export type LayoutArchetype = (typeof LAYOUT_ARCHETYPES)[number];

// ---------------------------------------------------------------------------
// Tiny deterministic helpers
// ---------------------------------------------------------------------------

function quantise(value: number): number {
  return Math.floor(value * QUANTUM) / QUANTUM;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** `Math.ceil` without using Math.ceil (kept off the allow-list for clarity). */
function intCeil(value: number): number {
  const floored = Math.floor(value);
  return value > floored ? floored + 1 : floored;
}

function mixTowards(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Unit vector from `fromX,fromY` to `toX,toY`; falls back to "up-course". */
function unitTowards(fromX: number, fromY: number, toX: number, toY: number): Vec2 {
  const dx = toX - fromX;
  const dy = toY - fromY;
  const d2 = dx * dx + dy * dy;
  if (!(d2 > 0)) return { x: 0, y: -1 };
  const d = Math.sqrt(d2);
  return { x: dx / d, y: dy / d };
}

// ---------------------------------------------------------------------------
// Route grid (ball-centre reachability)
// ---------------------------------------------------------------------------

interface RouteGrid {
  readonly cols: number;
  readonly rows: number;
  /** 0 = the ball centre may sit here; > 0 = blocked by N obstacles/borders. */
  readonly cells: Uint8Array;
}

function cellAt(cells: Uint8Array, index: number): number {
  const value = cells[index];
  return value === undefined ? 1 : value;
}

function intAt(array: Int32Array, index: number): number {
  const value = array[index];
  return value === undefined ? -1 : value;
}

function createRouteGrid(width: number, height: number): RouteGrid {
  const cols = intCeil(width / ROUTE_CELL);
  const rows = intCeil(height / ROUTE_CELL);
  const cells = new Uint8Array(cols * rows);
  const radius = PHYSICS.BALL_RADIUS;
  // Border band: the ball centre can never be within one radius of the boundary.
  for (let j = 0; j < rows; j += 1) {
    const cy = j * ROUTE_CELL + ROUTE_CELL / 2;
    for (let i = 0; i < cols; i += 1) {
      const cx = i * ROUTE_CELL + ROUTE_CELL / 2;
      if (cx < radius || cx > width - radius || cy < radius || cy > height - radius) {
        cells[j * cols + i] = 1;
      }
    }
  }
  return { cols, rows, cells };
}

/** Obstacles that physically deny a route: solids, and water (a dry line must exist). */
function isBlockingKind(obstacle: Obstacle): boolean {
  return obstacle.kind === 'wall' || obstacle.kind === 'bumper' || obstacle.kind === 'water';
}

function stampRect(grid: RouteGrid, rect: Rect, delta: number): void {
  const radius = PHYSICS.BALL_RADIUS;
  const i0 = Math.max(0, Math.floor((rect.x - radius) / ROUTE_CELL));
  const i1 = Math.min(grid.cols - 1, Math.floor((rect.x + rect.w + radius) / ROUTE_CELL));
  const j0 = Math.max(0, Math.floor((rect.y - radius) / ROUTE_CELL));
  const j1 = Math.min(grid.rows - 1, Math.floor((rect.y + rect.h + radius) / ROUTE_CELL));
  for (let j = j0; j <= j1; j += 1) {
    const cy = j * ROUTE_CELL + ROUTE_CELL / 2;
    for (let i = i0; i <= i1; i += 1) {
      const cx = i * ROUTE_CELL + ROUTE_CELL / 2;
      if (circleIntersectsRect(cx, cy, radius, rect)) {
        const index = j * grid.cols + i;
        grid.cells[index] = clamp(cellAt(grid.cells, index) + delta, 0, 255);
      }
    }
  }
}

function stampCircle(grid: RouteGrid, cx: number, cy: number, r: number, delta: number): void {
  const radius = PHYSICS.BALL_RADIUS;
  const reach = r + radius;
  const i0 = Math.max(0, Math.floor((cx - reach) / ROUTE_CELL));
  const i1 = Math.min(grid.cols - 1, Math.floor((cx + reach) / ROUTE_CELL));
  const j0 = Math.max(0, Math.floor((cy - reach) / ROUTE_CELL));
  const j1 = Math.min(grid.rows - 1, Math.floor((cy + reach) / ROUTE_CELL));
  for (let j = j0; j <= j1; j += 1) {
    const py = j * ROUTE_CELL + ROUTE_CELL / 2;
    for (let i = i0; i <= i1; i += 1) {
      const px = i * ROUTE_CELL + ROUTE_CELL / 2;
      if (circleOverlapsCircle(px, py, radius, cx, cy, r)) {
        const index = j * grid.cols + i;
        grid.cells[index] = clamp(cellAt(grid.cells, index) + delta, 0, 255);
      }
    }
  }
}

function stampObstacle(grid: RouteGrid, obstacle: Obstacle, delta: number): void {
  if (obstacle.kind === 'bumper') {
    stampCircle(grid, obstacle.cx, obstacle.cy, obstacle.r, delta);
    return;
  }
  if (obstacle.kind === 'wall' || obstacle.kind === 'water') {
    stampRect(grid, { x: obstacle.x, y: obstacle.y, w: obstacle.w, h: obstacle.h }, delta);
  }
  // sand + boost are drivable: they never block a route.
}

interface RouteScratch {
  readonly visited: Uint8Array;
  readonly queue: Int32Array;
}

function createScratch(grid: RouteGrid): RouteScratch {
  const size = grid.cols * grid.rows;
  return { visited: new Uint8Array(size), queue: new Int32Array(size) };
}

/**
 * 4-connected BFS from the spawn cell to the cup cell over free cells.
 * 4-connectivity is deliberately conservative: it never reports a diagonal
 * squeeze that the round ball could not actually take.
 */
function routeExists(grid: RouteGrid, scratch: RouteScratch, from: Vec2, to: Vec2): boolean {
  const { cols, rows, cells } = grid;
  const si = clamp(Math.floor(from.x / ROUTE_CELL), 0, cols - 1);
  const sj = clamp(Math.floor(from.y / ROUTE_CELL), 0, rows - 1);
  const ti = clamp(Math.floor(to.x / ROUTE_CELL), 0, cols - 1);
  const tj = clamp(Math.floor(to.y / ROUTE_CELL), 0, rows - 1);
  const startIndex = sj * cols + si;
  const goalIndex = tj * cols + ti;
  if (cellAt(cells, startIndex) > 0 || cellAt(cells, goalIndex) > 0) return false;
  if (startIndex === goalIndex) return true;

  scratch.visited.fill(0);
  let head = 0;
  let tail = 0;
  scratch.queue[tail] = startIndex;
  tail += 1;
  scratch.visited[startIndex] = 1;

  while (head < tail) {
    const index = intAt(scratch.queue, head);
    head += 1;
    if (index < 0) continue;
    const i = index % cols;
    const j = (index - i) / cols;

    for (let dir = 0; dir < 4; dir += 1) {
      let ni = i;
      let nj = j;
      if (dir === 0) ni = i - 1;
      else if (dir === 1) ni = i + 1;
      else if (dir === 2) nj = j - 1;
      else nj = j + 1;
      if (ni < 0 || ni >= cols || nj < 0 || nj >= rows) continue;
      const neighbour = nj * cols + ni;
      if (scratch.visited[neighbour] === 1) continue;
      if (cellAt(cells, neighbour) > 0) continue;
      if (neighbour === goalIndex) return true;
      scratch.visited[neighbour] = 1;
      scratch.queue[tail] = neighbour;
      tail += 1;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Generation context
// ---------------------------------------------------------------------------

interface GenContext {
  readonly rng: Prng;
  readonly width: number;
  readonly height: number;
  readonly round: number;
  readonly start: Vec2;
  readonly hole: Hole;
  readonly obstacles: Obstacle[];
  readonly grid: RouteGrid;
  readonly scratch: RouteScratch;
  /** Running count of sand + water, capped by LEVEL.HAZARD_SHARE. */
  hazards: number;
  readonly hazardCap: number;
}

/** The open band between spawn and cup where obstacles are allowed to live. */
function fieldRect(ctx: GenContext): Rect {
  const top = ctx.hole.center.y + LEVEL.HOLE_CLEAR_RADIUS + 1;
  const bottom = ctx.start.y - LEVEL.SPAWN_CLEAR_RADIUS - 1;
  return {
    x: MARGIN,
    y: top,
    w: ctx.width - MARGIN * 2,
    h: Math.max(MIN_OBSTACLE_SIZE * 2, bottom - top),
  };
}

function withinBounds(ctx: GenContext, rect: Rect): boolean {
  return (
    rect.x >= MARGIN &&
    rect.y >= MARGIN &&
    rect.x + rect.w <= ctx.width - MARGIN &&
    rect.y + rect.h <= ctx.height - MARGIN &&
    rect.w >= MIN_OBSTACLE_SIZE &&
    rect.h >= MIN_OBSTACLE_SIZE
  );
}

function clearOfKeyAreas(ctx: GenContext, rect: Rect): boolean {
  if (rectOverlapsCircle(rect, ctx.start.x, ctx.start.y, LEVEL.SPAWN_CLEAR_RADIUS)) return false;
  if (rectOverlapsCircle(rect, ctx.hole.center.x, ctx.hole.center.y, LEVEL.HOLE_CLEAR_RADIUS)) return false;
  return true;
}

function clearOfOthers(ctx: GenContext, rect: Rect): boolean {
  for (let i = 0; i < ctx.obstacles.length; i += 1) {
    const other = ctx.obstacles[i];
    if (other === undefined) continue;
    if (other.kind === 'bumper') {
      if (rectOverlapsCircle(
        { x: rect.x - OBSTACLE_GAP, y: rect.y - OBSTACLE_GAP, w: rect.w + OBSTACLE_GAP * 2, h: rect.h + OBSTACLE_GAP * 2 },
        other.cx,
        other.cy,
        other.r,
      )) {
        return false;
      }
      continue;
    }
    if (rectOverlapsRectPadded(rect, { x: other.x, y: other.y, w: other.w, h: other.h }, OBSTACLE_GAP)) {
      return false;
    }
  }
  return true;
}

function circleClearOfOthers(ctx: GenContext, cx: number, cy: number, r: number): boolean {
  for (let i = 0; i < ctx.obstacles.length; i += 1) {
    const other = ctx.obstacles[i];
    if (other === undefined) continue;
    if (other.kind === 'bumper') {
      if (circleOverlapsCircle(cx, cy, r + OBSTACLE_GAP, other.cx, other.cy, other.r)) return false;
      continue;
    }
    if (rectOverlapsCircle({ x: other.x, y: other.y, w: other.w, h: other.h }, cx, cy, r + OBSTACLE_GAP)) {
      return false;
    }
  }
  return true;
}

/** Adds the obstacle, then withdraws it again if it would seal the course off. */
function commit(ctx: GenContext, obstacle: Obstacle): boolean {
  if (isBlockingKind(obstacle)) {
    stampObstacle(ctx.grid, obstacle, 1);
    if (!routeExists(ctx.grid, ctx.scratch, ctx.start, ctx.hole.center)) {
      stampObstacle(ctx.grid, obstacle, -1);
      return false;
    }
  }
  ctx.obstacles.push(obstacle);
  if (obstacle.kind === 'sand' || obstacle.kind === 'water') ctx.hazards += 1;
  return true;
}

type RectKind = 'wall' | 'sand' | 'water';

function buildRect(ctx: GenContext, kind: RectKind, rect: Rect): Obstacle {
  const id = ctx.obstacles.length;
  const x = quantise(rect.x);
  const y = quantise(rect.y);
  const w = quantise(rect.w);
  const h = quantise(rect.h);
  if (kind === 'wall') {
    const wall: WallRect = { kind: 'wall', id, x, y, w, h };
    return wall;
  }
  if (kind === 'sand') {
    const sand: SandRect = { kind: 'sand', id, x, y, w, h };
    return sand;
  }
  const water: WaterRect = { kind: 'water', id, x, y, w, h };
  return water;
}

/**
 * Rejection sampling: ask `make` for a candidate rect up to
 * `LEVEL.MAX_GEN_ATTEMPTS` times and keep the first legal one.
 * Returns false when nothing fitted - a sparser course is fine, a broken one is not.
 */
function tryAddRect(ctx: GenContext, kind: RectKind, make: () => Rect | null): boolean {
  if (ctx.obstacles.length >= LEVEL.MAX_OBSTACLES) return false;
  if ((kind === 'sand' || kind === 'water') && ctx.hazards >= ctx.hazardCap) return false;
  for (let attempt = 0; attempt < LEVEL.MAX_GEN_ATTEMPTS; attempt += 1) {
    const candidate = make();
    if (candidate === null) continue;
    const rect: Rect = {
      x: quantise(candidate.x),
      y: quantise(candidate.y),
      w: quantise(candidate.w),
      h: quantise(candidate.h),
    };
    if (!withinBounds(ctx, rect)) continue;
    if (!clearOfKeyAreas(ctx, rect)) continue;
    if (!clearOfOthers(ctx, rect)) continue;
    if (commit(ctx, buildRect(ctx, kind, rect))) return true;
  }
  return false;
}

function tryAddBumper(ctx: GenContext, make: () => Circleish | null): boolean {
  if (ctx.obstacles.length >= LEVEL.MAX_OBSTACLES) return false;
  for (let attempt = 0; attempt < LEVEL.MAX_GEN_ATTEMPTS; attempt += 1) {
    const candidate = make();
    if (candidate === null) continue;
    const cx = quantise(candidate.cx);
    const cy = quantise(candidate.cy);
    const r = quantise(candidate.r);
    if (r < MIN_OBSTACLE_SIZE / 2) continue;
    if (cx - r < MARGIN || cy - r < MARGIN || cx + r > ctx.width - MARGIN || cy + r > ctx.height - MARGIN) continue;
    if (circleOverlapsCircle(cx, cy, r, ctx.start.x, ctx.start.y, LEVEL.SPAWN_CLEAR_RADIUS)) continue;
    if (circleOverlapsCircle(cx, cy, r, ctx.hole.center.x, ctx.hole.center.y, LEVEL.HOLE_CLEAR_RADIUS)) continue;
    if (!circleClearOfOthers(ctx, cx, cy, r)) continue;
    const bumper: BumperCircle = { kind: 'bumper', id: ctx.obstacles.length, cx, cy, r };
    if (commit(ctx, bumper)) return true;
  }
  return false;
}

interface Circleish {
  readonly cx: number;
  readonly cy: number;
  readonly r: number;
}

/** Boost pads always point at the cup, so they always feel like a gift. */
function tryAddBoost(ctx: GenContext, make: () => Rect | null): boolean {
  if (ctx.obstacles.length >= LEVEL.MAX_OBSTACLES) return false;
  for (let attempt = 0; attempt < LEVEL.MAX_GEN_ATTEMPTS; attempt += 1) {
    const candidate = make();
    if (candidate === null) continue;
    const rect: Rect = {
      x: quantise(candidate.x),
      y: quantise(candidate.y),
      w: quantise(candidate.w),
      h: quantise(candidate.h),
    };
    if (!withinBounds(ctx, rect)) continue;
    if (!clearOfKeyAreas(ctx, rect)) continue;
    if (!clearOfOthers(ctx, rect)) continue;
    const dir = unitTowards(
      rect.x + rect.w / 2,
      rect.y + rect.h / 2,
      ctx.hole.center.x,
      ctx.hole.center.y,
    );
    const pad: BoostRect = {
      kind: 'boost',
      id: ctx.obstacles.length,
      x: rect.x,
      y: rect.y,
      w: rect.w,
      h: rect.h,
      dir,
      strength: quantise(ctx.rng.nextRange(38, 64)),
    };
    if (commit(ctx, pad)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Filler: the mix that gives each round its flavour
// ---------------------------------------------------------------------------

function fillMixed(ctx: GenContext, count: number): void {
  const field = fieldRect(ctx);
  const kinds: ('wall' | 'bumper' | 'sand' | 'water' | 'boost')[] = ['bumper', 'wall', 'sand'];
  if (ctx.round >= 1) kinds.push('water', 'bumper');
  if (ctx.round >= 2) kinds.push('boost', 'wall');
  if (ctx.round >= 4) kinds.push('bumper', 'sand');

  for (let i = 0; i < count; i += 1) {
    const kind = ctx.rng.pick(kinds);
    if (kind === undefined) return;
    if (kind === 'bumper') {
      tryAddBumper(ctx, () => ({
        cx: ctx.rng.nextRange(field.x + 4, field.x + field.w - 4),
        cy: ctx.rng.nextRange(field.y + 3, field.y + field.h - 3),
        r: ctx.rng.nextRange(2.4, 4.2),
      }));
      continue;
    }
    if (kind === 'wall') {
      tryAddRect(ctx, 'wall', () => {
        const vertical = ctx.rng.chance(0.4);
        const w = vertical ? ctx.rng.nextRange(2.6, 4.6) : ctx.rng.nextRange(6, 15);
        const h = vertical ? ctx.rng.nextRange(7, 16) : ctx.rng.nextRange(2.6, 4.6);
        return {
          x: ctx.rng.nextRange(field.x, field.x + field.w - w),
          y: ctx.rng.nextRange(field.y, field.y + field.h - h),
          w,
          h,
        };
      });
      continue;
    }
    if (kind === 'boost') {
      tryAddBoost(ctx, () => {
        const w = ctx.rng.nextRange(5, 9);
        const h = ctx.rng.nextRange(5, 9);
        return {
          x: ctx.rng.nextRange(field.x, field.x + field.w - w),
          y: ctx.rng.nextRange(field.y, field.y + field.h - h),
          w,
          h,
        };
      });
      continue;
    }
    const hazard: RectKind = kind === 'water' ? 'water' : 'sand';
    tryAddRect(ctx, hazard, () => {
      const w = hazard === 'water' ? ctx.rng.nextRange(7, 15) : ctx.rng.nextRange(8, 16);
      const h = hazard === 'water' ? ctx.rng.nextRange(5, 12) : ctx.rng.nextRange(6, 13);
      return {
        x: ctx.rng.nextRange(field.x, field.x + field.w - w),
        y: ctx.rng.nextRange(field.y, field.y + field.h - h),
        w,
        h,
      };
    });
  }
}

// ---------------------------------------------------------------------------
// Layout archetypes
// ---------------------------------------------------------------------------

/** Alternating bars anchored left/right: the ball has to weave up the course. */
function layoutCorridor(ctx: GenContext, budget: number): void {
  const field = fieldRect(ctx);
  const bars = clamp(2 + Math.floor(ctx.round / 2), 2, Math.min(5, budget));
  const bandH = field.h / bars;
  const startLeft = ctx.rng.chance(0.5);
  // Early rounds leave a wide lane; by round 6 the bars reach two thirds across.
  const spread = clamp(ctx.round / 6, 0, 1);
  const minFrac = 0.4 + 0.12 * spread;
  const maxFrac = 0.54 + 0.16 * spread;
  for (let i = 0; i < bars; i += 1) {
    const bandY = field.y + bandH * i;
    const fromLeft = startLeft ? i % 2 === 0 : i % 2 === 1;
    tryAddRect(ctx, 'wall', () => {
      const len = ctx.width * ctx.rng.nextRange(minFrac, maxFrac);
      const thick = ctx.rng.nextRange(2.6, 4.2);
      // 1.5cu of slack top and bottom guarantees adjacent bars keep OBSTACLE_GAP.
      const y = bandY + ctx.rng.nextRange(1.5, Math.max(1.6, bandH - thick - 1.5));
      const x = fromLeft ? MARGIN : ctx.width - MARGIN - len;
      return { x, y, w: len, h: thick };
    });
  }
  fillMixed(ctx, budget - ctx.obstacles.length);
}

/** Full-width walls with an offset gap in each: a slalom. */
function layoutChicane(ctx: GenContext, budget: number): void {
  const field = fieldRect(ctx);
  const rows = clamp(2 + Math.floor(ctx.round / 3), 2, 3);
  const bandH = field.h / rows;
  const spread = clamp(ctx.round / 6, 0, 1);
  for (let i = 0; i < rows; i += 1) {
    const bandY = field.y + bandH * i;
    const thick = quantise(ctx.rng.nextRange(2.6, 4));
    const y = quantise(bandY + ctx.rng.nextRange(1.5, Math.max(1.6, bandH - thick - 1.5)));
    const gapW = ctx.rng.nextRange(14 - 4 * spread, 20 - 5 * spread);
    const gapX = ctx.rng.nextRange(MARGIN + 5, ctx.width - MARGIN - 5 - gapW);
    const leftW = gapX - MARGIN;
    const rightX = gapX + gapW;
    const rightW = ctx.width - MARGIN - rightX;
    if (leftW >= MIN_OBSTACLE_SIZE) {
      tryAddRect(ctx, 'wall', () => ({ x: MARGIN, y, w: leftW, h: thick }));
    }
    if (rightW >= MIN_OBSTACLE_SIZE) {
      tryAddRect(ctx, 'wall', () => ({ x: rightX, y, w: rightW, h: thick }));
    }
  }
  fillMixed(ctx, budget - ctx.obstacles.length);
}

/** A tapering funnel aimed at the cup: generous at the bottom, tight at the top. */
function layoutFunnel(ctx: GenContext, budget: number): void {
  const field = fieldRect(ctx);
  const steps = clamp(2 + Math.floor(ctx.round / 3), 2, 4);
  for (let i = 0; i < steps; i += 1) {
    const t = steps === 1 ? 0 : i / (steps - 1);
    const centre = mixTowards(ctx.start.x, ctx.hole.center.x, t);
    const spread = clamp(ctx.round / 6, 0, 1);
    const halfGap = mixTowards(18 - 2.5 * spread, 10.5 - 3 * spread, t);
    const thick = quantise(ctx.rng.nextRange(2.6, 3.8));
    const y = quantise(field.y + field.h * (1 - t) - thick - ctx.rng.nextRange(0, 3));
    const leftW = centre - halfGap - MARGIN;
    const rightX = centre + halfGap;
    const rightW = ctx.width - MARGIN - rightX;
    if (leftW >= MIN_OBSTACLE_SIZE) {
      tryAddRect(ctx, 'wall', () => ({ x: MARGIN, y, w: leftW, h: thick }));
    }
    if (rightW >= MIN_OBSTACLE_SIZE) {
      tryAddRect(ctx, 'wall', () => ({ x: rightX, y, w: rightW, h: thick }));
    }
  }
  fillMixed(ctx, budget - ctx.obstacles.length);
}

/** A hazard island in the middle of the course, with bumpers guarding the sides. */
function layoutIsland(ctx: GenContext, budget: number): void {
  const field = fieldRect(ctx);
  const midY = field.y + field.h / 2;
  const hazard: RectKind = ctx.round >= 1 && ctx.rng.chance(0.62) ? 'water' : 'sand';
  tryAddRect(ctx, hazard, () => {
    const w = ctx.rng.nextRange(17, 26);
    const h = ctx.rng.nextRange(12, 19);
    return {
      x: ctx.width / 2 - w / 2 + ctx.rng.nextRange(-5, 5),
      y: midY - h / 2 + ctx.rng.nextRange(-4, 4),
      w,
      h,
    };
  });
  const guards = clamp(2 + Math.floor(ctx.round / 3), 2, 4);
  for (let i = 0; i < guards; i += 1) {
    const left = i % 2 === 0;
    tryAddBumper(ctx, () => ({
      cx: left
        ? ctx.rng.nextRange(MARGIN + 3, ctx.width / 2 - 8)
        : ctx.rng.nextRange(ctx.width / 2 + 8, ctx.width - MARGIN - 3),
      cy: ctx.rng.nextRange(field.y + 3, field.y + field.h - 3),
      r: ctx.rng.nextRange(2.6, 4.4),
    }));
  }
  fillMixed(ctx, budget - ctx.obstacles.length);
}

function layoutScatter(ctx: GenContext, budget: number): void {
  fillMixed(ctx, budget);
}

function runLayout(ctx: GenContext, archetype: LayoutArchetype, budget: number): void {
  if (archetype === 'corridor') layoutCorridor(ctx, budget);
  else if (archetype === 'chicane') layoutChicane(ctx, budget);
  else if (archetype === 'funnel') layoutFunnel(ctx, budget);
  else if (archetype === 'island') layoutIsland(ctx, budget);
  else layoutScatter(ctx, budget);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Obstacle target for a round. Grows with the round index and the host's bias. */
export function obstacleCountFor(roundIndex: number, difficultyBias = 0): number {
  const round = Number.isFinite(roundIndex) ? Math.max(0, Math.floor(roundIndex)) : 0;
  const bias = Number.isFinite(difficultyBias) ? clamp(difficultyBias, 0, 1) : 0;
  const extra = Math.floor(round * LEVEL.DIFFICULTY_RAMP * (1 + bias) + bias * 2);
  return clamp(LEVEL.MIN_OBSTACLES + extra, LEVEL.MIN_OBSTACLES, LEVEL.MAX_OBSTACLES);
}

/**
 * Par from the spawn-to-cup distance and how cluttered the course is,
 * clamped to LEVEL.PAR_MIN..PAR_MAX. Fewer hits than this earns bonus points
 * (see `efficiencyPointsFor` in config), so par is the fairness knob of the
 * whole scoring system.
 */
export function parFor(distance: number, obstacleCount: number): number {
  const d = Number.isFinite(distance) ? Math.max(0, distance) : 0;
  const n = Number.isFinite(obstacleCount) ? Math.max(0, Math.floor(obstacleCount)) : 0;
  // Clutter dominates (it is what actually costs strokes); distance nudges it.
  // n=3 -> 3, n=6 -> 4, n=9 -> 5, n=13+ -> 6, with the distance term breaking ties.
  const raw = 2.6 + n / 3.6 + (d - 70) / 60;
  return clamp(Math.floor(raw), LEVEL.PAR_MIN, LEVEL.PAR_MAX);
}

/** Mirrors the whole course left-to-right. Playability is invariant under this. */
function mirrorLevel(level: LevelSpec): LevelSpec {
  const flipX = (x: number, w: number): number => quantise(level.width - (x + w));
  const obstacles: Obstacle[] = [];
  for (let i = 0; i < level.obstacles.length; i += 1) {
    const o = level.obstacles[i];
    if (o === undefined) continue;
    if (o.kind === 'bumper') {
      obstacles.push({ kind: 'bumper', id: o.id, cx: quantise(level.width - o.cx), cy: o.cy, r: o.r });
    } else if (o.kind === 'boost') {
      obstacles.push({
        kind: 'boost',
        id: o.id,
        x: flipX(o.x, o.w),
        y: o.y,
        w: o.w,
        h: o.h,
        dir: { x: -o.dir.x, y: o.dir.y },
        strength: o.strength,
      });
    } else if (o.kind === 'wall') {
      obstacles.push({ kind: 'wall', id: o.id, x: flipX(o.x, o.w), y: o.y, w: o.w, h: o.h });
    } else if (o.kind === 'sand') {
      obstacles.push({ kind: 'sand', id: o.id, x: flipX(o.x, o.w), y: o.y, w: o.w, h: o.h });
    } else {
      obstacles.push({ kind: 'water', id: o.id, x: flipX(o.x, o.w), y: o.y, w: o.w, h: o.h });
    }
  }
  return {
    ...level,
    ballStart: { x: quantise(level.width - level.ballStart.x), y: level.ballStart.y },
    hole: { center: { x: quantise(level.width - level.hole.center.x), y: level.hole.center.y }, radius: level.hole.radius },
    obstacles,
  };
}

/**
 * Fully deterministic course generation.
 * `seed` is the ROOM seed; it is mixed with round + variant internally, so the
 * caller only has to pass the three integers everybody already agrees on.
 */
export function generateLevel(seed: number, roundIndex: number, variantIndex: number): LevelSpec {
  const round = Number.isFinite(roundIndex) ? Math.max(0, Math.floor(roundIndex)) : 0;
  const variant = Number.isFinite(variantIndex) ? Math.max(0, Math.floor(variantIndex)) : 0;
  const levelSeed = seedFor(seed, round, variant);
  const rng = createPrng(levelSeed);

  const width = LEVEL.DEFAULT_WIDTH;
  const height = LEVEL.DEFAULT_HEIGHT;

  // Ball near the bottom, cup near the top. The ranges below guarantee a
  // start-to-hole distance far above LEVEL.MIN_START_HOLE_DIST.
  const start: Vec2 = {
    x: quantise(rng.nextRange(MARGIN + LEVEL.SPAWN_CLEAR_RADIUS, width - MARGIN - LEVEL.SPAWN_CLEAR_RADIUS)),
    y: quantise(height - rng.nextRange(9, 14)),
  };
  const hole: Hole = {
    center: {
      x: quantise(rng.nextRange(MARGIN + LEVEL.HOLE_CLEAR_RADIUS, width - MARGIN - LEVEL.HOLE_CLEAR_RADIUS)),
      y: quantise(rng.nextRange(9, 16)),
    },
    radius: LEVEL.HOLE_RADIUS,
  };

  const budget = obstacleCountFor(round);
  const grid = createRouteGrid(width, height);
  const ctx: GenContext = {
    rng,
    width,
    height,
    round,
    start,
    hole,
    obstacles: [],
    grid,
    scratch: createScratch(grid),
    hazards: 0,
    hazardCap: Math.max(1, Math.floor(budget * LEVEL.HAZARD_SHARE)),
  };

  const archetype = rng.pick(LAYOUT_ARCHETYPES) ?? 'scatter';
  runLayout(ctx, archetype, budget);

  const dx = hole.center.x - start.x;
  const dy = hole.center.y - start.y;
  const distance = Math.sqrt(dx * dx + dy * dy);

  const level: LevelSpec = {
    width,
    height,
    par: parFor(distance, ctx.obstacles.length),
    ballStart: start,
    hole,
    obstacles: ctx.obstacles,
    themeId: themeForRound(round).id,
    seed: levelSeed,
  };

  return rng.chance(0.5) ? mirrorLevel(level) : level;
}

/**
 * Guards: ids sequential, spawn clear, cup clear, min separation, everything
 * inside the walls, no obstacle-obstacle overlap, and an actual ball-wide route
 * from the spawn to the cup.
 */
export function isLevelPlayable(level: LevelSpec): boolean {
  if (!(level.width > 0) || !(level.height > 0)) return false;
  if (!(level.hole.radius > PHYSICS.BALL_RADIUS)) return false;
  if (level.par < LEVEL.PAR_MIN || level.par > LEVEL.PAR_MAX) return false;

  const start = level.ballStart;
  const hole = level.hole.center;
  const inside = (p: Vec2): boolean =>
    p.x >= PHYSICS.BALL_RADIUS &&
    p.y >= PHYSICS.BALL_RADIUS &&
    p.x <= level.width - PHYSICS.BALL_RADIUS &&
    p.y <= level.height - PHYSICS.BALL_RADIUS;
  if (!inside(start) || !inside(hole)) return false;

  const dx = hole.x - start.x;
  const dy = hole.y - start.y;
  if (Math.sqrt(dx * dx + dy * dy) < LEVEL.MIN_START_HOLE_DIST) return false;

  for (let i = 0; i < level.obstacles.length; i += 1) {
    const o = level.obstacles[i];
    if (o === undefined) return false;
    if (o.id !== i) return false;

    if (o.kind === 'bumper') {
      if (!(o.r >= MIN_OBSTACLE_SIZE / 2)) return false;
      if (o.cx - o.r < MARGIN || o.cy - o.r < MARGIN) return false;
      if (o.cx + o.r > level.width - MARGIN || o.cy + o.r > level.height - MARGIN) return false;
      if (circleOverlapsCircle(o.cx, o.cy, o.r, start.x, start.y, LEVEL.SPAWN_CLEAR_RADIUS)) return false;
      if (circleOverlapsCircle(o.cx, o.cy, o.r, hole.x, hole.y, LEVEL.HOLE_CLEAR_RADIUS)) return false;
    } else {
      const rect: Rect = { x: o.x, y: o.y, w: o.w, h: o.h };
      if (!(rect.w >= MIN_OBSTACLE_SIZE) || !(rect.h >= MIN_OBSTACLE_SIZE)) return false;
      if (rect.x < MARGIN || rect.y < MARGIN) return false;
      if (rect.x + rect.w > level.width - MARGIN || rect.y + rect.h > level.height - MARGIN) return false;
      if (rectOverlapsCircle(rect, start.x, start.y, LEVEL.SPAWN_CLEAR_RADIUS)) return false;
      if (rectOverlapsCircle(rect, hole.x, hole.y, LEVEL.HOLE_CLEAR_RADIUS)) return false;
      if (o.kind === 'boost') {
        const len = Math.sqrt(o.dir.x * o.dir.x + o.dir.y * o.dir.y);
        if (Math.abs(len - 1) > 1e-6) return false;
        if (!(o.strength > 0)) return false;
      }
    }

    for (let j = i + 1; j < level.obstacles.length; j += 1) {
      const other = level.obstacles[j];
      if (other === undefined) return false;
      if (o.kind === 'bumper') {
        if (other.kind === 'bumper') {
          if (circleOverlapsCircle(o.cx, o.cy, o.r, other.cx, other.cy, other.r)) return false;
        } else if (rectOverlapsCircle({ x: other.x, y: other.y, w: other.w, h: other.h }, o.cx, o.cy, o.r)) {
          return false;
        }
      } else if (other.kind === 'bumper') {
        if (rectOverlapsCircle({ x: o.x, y: o.y, w: o.w, h: o.h }, other.cx, other.cy, other.r)) return false;
      } else if (
        rectOverlapsRect({ x: o.x, y: o.y, w: o.w, h: o.h }, { x: other.x, y: other.y, w: other.w, h: other.h })
      ) {
        return false;
      }
    }
  }

  return hasClearRoute(level);
}

/** True when a ball-wide, dry route exists from the spawn to the cup. */
export function hasClearRoute(level: LevelSpec): boolean {
  const grid = createRouteGrid(level.width, level.height);
  for (let i = 0; i < level.obstacles.length; i += 1) {
    const obstacle = level.obstacles[i];
    if (obstacle === undefined) continue;
    stampObstacle(grid, obstacle, 1);
  }
  return routeExists(grid, createScratch(grid), level.ballStart, level.hole.center);
}
