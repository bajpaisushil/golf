'use client';

/**
 * MiniBoard — a deliberately lightweight 2D canvas view of ONE player's course.
 *
 * Friend Battle gives every player their own course and we want to watch all of
 * them live. Eight three.js scenes would torch a phone; eight of these cost a
 * few dozen canvas calls each, at most 20fps, and only when something actually
 * changed. This is also the lobby preview and the WebGL-less fallback.
 *
 * It only READS simulation state — it never writes back, never simulates and
 * never imports three.js, so a screen that shows it stays cheap to load.
 *
 * Redraw policy: a dirty flag + a single rAF. Props change -> mark dirty ->
 * schedule one frame -> draw at most every 1000 / MINI.FPS ms. When nothing
 * changes, zero frames are drawn and no timer is left running.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import clsx from 'clsx';

import type { Hex, LevelSpec, Vec2 } from '@/types';
import { getTheme } from '@/game/levels/themes';
import type { Theme } from '@/game/levels/themes';
import {
  MINI,
  courseViewBox,
  obstacleFill,
  obstacleSvgPath,
  pathPolyline,
  renderMini,
} from './draw2d';
import type { MiniBall } from './draw2d';

// ---------------------------------------------------------------------------
// Sizing
// ---------------------------------------------------------------------------

/**
 * Compact presets, expressed as a WIDTH in CSS px. Height always follows the
 * course aspect ratio, so the board is never letterboxed or squashed.
 * 'fluid' fills the parent and re-measures with a ResizeObserver.
 */
export type MiniBoardSize = 'xs' | 'sm' | 'md' | 'lg' | 'fluid';

export const MINI_BOARD_WIDTHS: Readonly<Record<Exclude<MiniBoardSize, 'fluid'>, number>> = {
  xs: 72,
  sm: 104,
  md: 140,
  lg: 196,
};

function aspectOf(level: LevelSpec): number {
  const w = Number.isFinite(level.width) && level.width > 0 ? level.width : 1;
  const h = Number.isFinite(level.height) && level.height > 0 ? level.height : 1;
  return h / w;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface MiniBoardProps {
  /** The course to draw. Regenerated locally from the seed — never sent over the wire. */
  readonly level: LevelSpec;
  /** Ball positions to draw. A `BallView[]` from the 3D layer is assignable as-is. */
  readonly balls: readonly MiniBall[];
  /** Strokes taken so far this round; shown in the badge. */
  readonly strokes?: number;
  /** Par for this course; shown next to the strokes when present. */
  readonly par?: number;
  /** Whose board this is. */
  readonly playerName?: string;
  /** That player's colour (PLAYER_COLORS). Drives the name dot and the trail. */
  readonly color?: Hex;
  /** Compact preset, or 'fluid' to fill the parent. Default 'md'. */
  readonly size?: MiniBoardSize;
  /** Explicit width in CSS px; overrides `size`. */
  readonly width?: number;
  /** Optional sampled trajectory of this player's most recent shot. */
  readonly trail?: readonly Vec2[] | null;
  /** Theme override; defaults to the level's own theme. */
  readonly theme?: Theme;
  /** True once this player holed out — shown as a tick instead of a stroke count. */
  readonly holed?: boolean;
  /** True when the player hit MAX_STROKES without holing out. */
  readonly dnf?: boolean;
  /** Highlight ring: their turn (co-op) or "currently swinging" (battle). */
  readonly active?: boolean;
  /** Set false to render just the board with no name/score row. Default true. */
  readonly showHeader?: boolean;
  /**
   * Cap on the backing-store pixel ratio. Pass the active quality profile's
   * `maxDpr` so low-end devices do not pay for retina thumbnails.
   * Defaults to MINI.MAX_DPR.
   */
  readonly maxDpr?: number;
  readonly className?: string;
}

/** Everything one frame needs, snapshotted outside the render phase. */
interface MiniSceneRef {
  level: LevelSpec;
  balls: readonly MiniBall[];
  theme: Theme;
  trail: readonly Vec2[] | null;
  color: Hex | undefined;
  boardWidth: number;
  boardHeight: number;
  maxDpr: number;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

function MiniBoardImpl(props: MiniBoardProps): ReactElement {
  const {
    level,
    balls,
    strokes,
    par,
    playerName,
    color,
    size = 'md',
    width,
    trail,
    theme: themeProp,
    holed = false,
    dnf = false,
    active = false,
    showHeader = true,
    maxDpr,
    className,
  } = props;

  const dprCap =
    typeof maxDpr === 'number' && Number.isFinite(maxDpr) && maxDpr > 0
      ? Math.min(maxDpr, MINI.MAX_DPR)
      : MINI.MAX_DPR;

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);

  const theme = useMemo(() => themeProp ?? getTheme(level.themeId), [themeProp, level.themeId]);
  const aspect = aspectOf(level);

  const presetWidth = size === 'fluid' ? null : MINI_BOARD_WIDTHS[size];
  const explicitWidth =
    typeof width === 'number' && Number.isFinite(width) && width > 0 ? width : presetWidth;

  /** Measured width for the 'fluid' size; null until the observer reports. */
  const [measuredWidth, setMeasuredWidth] = useState<number | null>(null);

  const boardWidth = explicitWidth ?? measuredWidth ?? MINI_BOARD_WIDTHS.md;
  const boardHeight = Math.max(1, Math.round(boardWidth * aspect));

  // --- the scene the next frame should draw -------------------------------
  // Held in a ref so the rAF callback never closes over stale props and we do
  // not re-create the loop on every position update. It is refreshed in an
  // effect, never during render.
  const sceneRef = useRef<MiniSceneRef>({
    level,
    balls,
    theme,
    trail: trail ?? null,
    color,
    boardWidth,
    boardHeight,
    maxDpr: dprCap,
  });

  const dirtyRef = useRef(true);
  const rafRef = useRef<number | null>(null);
  const lastDrawRef = useRef(0);
  const aliveRef = useRef(true);

  const draw = useCallback((): void => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const scene = sceneRef.current;
    const cssW = scene.boardWidth;
    const cssH = scene.boardHeight;
    if (cssW <= 0 || cssH <= 0) return;

    const rawDpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
    const dpr = Math.max(1, Math.min(rawDpr, scene.maxDpr));
    const bufferW = Math.max(1, Math.round(cssW * dpr));
    const bufferH = Math.max(1, Math.round(cssH * dpr));

    // Resizing the backing store clears it and resets context state — only do it
    // when the size actually changed.
    if (canvas.width !== bufferW) canvas.width = bufferW;
    if (canvas.height !== bufferH) canvas.height = bufferH;

    const ctx = canvas.getContext('2d');
    if (ctx === null) return;

    renderMini(ctx, {
      level: scene.level,
      theme: scene.theme,
      balls: scene.balls,
      trail: scene.trail ?? null,
      trailColor: scene.color ?? scene.theme.accent,
      box: { width: cssW, height: cssH },
      dpr,
    });
  }, []);

  // Explicitly typed because the callback refers to itself (re-arming the frame
  // when the throttle window has not elapsed yet).
  const schedule: () => void = useCallback((): void => {
    if (rafRef.current !== null) return;
    if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
      // No rAF (SSR / jsdom): draw straight away so tests and the first paint work.
      dirtyRef.current = false;
      draw();
      return;
    }
    rafRef.current = window.requestAnimationFrame((now: number) => {
      rafRef.current = null;
      if (!aliveRef.current) return;
      if (!dirtyRef.current) return;
      const minInterval = 1000 / MINI.FPS;
      if (now - lastDrawRef.current < minInterval) {
        // Too soon — keep the dirty flag and come back next frame. This is what
        // caps a live board at ~20fps without a setInterval hanging around.
        schedule();
        return;
      }
      lastDrawRef.current = now;
      dirtyRef.current = false;
      draw();
    });
  }, [draw]);

  const invalidate = useCallback((): void => {
    dirtyRef.current = true;
    schedule();
  }, [schedule]);

  // Mark dirty whenever anything visible changed. `balls` and `trail` are new
  // array identities each time the simulation produces a new rest position, so
  // identity comparison is exactly the signal we want.
  useEffect(() => {
    sceneRef.current = {
      level,
      balls,
      theme,
      trail: trail ?? null,
      color,
      boardWidth,
      boardHeight,
      maxDpr: dprCap,
    };
    invalidate();
  }, [invalidate, level, balls, theme, trail, color, boardWidth, boardHeight, dprCap]);

  // Fluid sizing: measure the host element.
  useEffect(() => {
    if (explicitWidth !== null) return;
    const host = hostRef.current;
    if (host === null) return;

    const apply = (next: number): void => {
      if (!Number.isFinite(next) || next <= 0) return;
      setMeasuredWidth((prev) => (prev !== null && Math.abs(prev - next) < 0.5 ? prev : next));
    };

    apply(host.clientWidth);

    if (typeof ResizeObserver === 'undefined') {
      // Old browser / jsdom: fall back to window resize.
      if (typeof window === 'undefined') return;
      const onResize = (): void => apply(host.clientWidth);
      window.addEventListener('resize', onResize);
      return () => window.removeEventListener('resize', onResize);
    }

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry === undefined) return;
      const box = entry.contentRect;
      apply(box.width);
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, [explicitWidth]);

  // Redraw when the device pixel ratio changes (moving a window between a
  // retina and a non-retina display), otherwise the board goes blurry.
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    const onChange = (): void => invalidate();
    if (typeof query.addEventListener === 'function') {
      query.addEventListener('change', onChange);
      return () => query.removeEventListener('change', onChange);
    }
    return undefined;
  }, [invalidate]);

  // Teardown: never leave a frame queued against an unmounted canvas.
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      if (rafRef.current !== null && typeof window !== 'undefined') {
        window.cancelAnimationFrame(rafRef.current);
      }
      rafRef.current = null;
    };
  }, []);

  const strokeText = formatStrokeBadge(strokes, holed, dnf);
  const label = buildAriaLabel(playerName, strokes, par, holed, dnf);

  return (
    <div
      ref={hostRef}
      className={clsx('flex flex-col gap-1 select-none', size === 'fluid' && 'w-full', className)}
      style={explicitWidth !== null ? { width: explicitWidth } : undefined}
    >
      {showHeader && (
        <div className="flex items-center justify-between gap-2 text-[11px] leading-none">
          <span className="flex min-w-0 items-center gap-1.5">
            {color !== undefined && (
              <span
                aria-hidden="true"
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: color }}
              />
            )}
            <span className="truncate font-medium text-white/80">{playerName ?? ''}</span>
          </span>
          {strokeText !== null && (
            <span
              className={clsx(
                'shrink-0 rounded-full px-1.5 py-0.5 font-semibold tabular-nums',
                dnf ? 'bg-white/5 text-white/40' : 'bg-white/10 text-white/90',
              )}
            >
              {strokeText}
            </span>
          )}
        </div>
      )}

      <div
        role="img"
        aria-label={label}
        className={clsx(
          'relative overflow-hidden rounded-lg',
          active ? 'ring-2 ring-white/70' : 'ring-1 ring-white/10',
        )}
        style={{ width: boardWidth, height: boardHeight }}
      >
        <canvas
          ref={canvasRef}
          aria-hidden="true"
          className="block h-full w-full"
          style={{ width: boardWidth, height: boardHeight }}
        />
      </div>
    </div>
  );
}

function formatStrokeBadge(
  strokes: number | undefined,
  holed: boolean,
  dnf: boolean,
): string | null {
  if (dnf) return 'DNF';
  if (strokes === undefined || !Number.isFinite(strokes)) return holed ? '✓' : null;
  const n = Math.max(0, Math.floor(strokes));
  return holed ? `✓ ${n}` : String(n);
}

function buildAriaLabel(
  playerName: string | undefined,
  strokes: number | undefined,
  par: number | undefined,
  holed: boolean,
  dnf: boolean,
): string {
  const who = playerName === undefined || playerName === '' ? 'Player' : playerName;
  const parts: string[] = [`${who}'s course`];
  if (strokes !== undefined && Number.isFinite(strokes)) {
    const n = Math.max(0, Math.floor(strokes));
    parts.push(`${n} ${n === 1 ? 'hit' : 'hits'}`);
  }
  if (par !== undefined && Number.isFinite(par)) parts.push(`par ${Math.max(1, Math.floor(par))}`);
  if (dnf) parts.push('did not finish');
  else if (holed) parts.push('holed out');
  return parts.join(', ');
}

/**
 * Memoised: in an 8-player battle the opponent strip re-renders on every state
 * push, and only the boards whose props actually changed should repaint.
 */
export const MiniBoard = memo(MiniBoardImpl);
MiniBoard.displayName = 'MiniBoard';

export default MiniBoard;

// ---------------------------------------------------------------------------
// MiniCourse — inline SVG twin (CONTRACTS.md §8)
//
// Same geometry, zero canvas, zero effects: safe for the home screen and for
// any server-rendered/static preview where a canvas would just be a blank box.
// ---------------------------------------------------------------------------

export interface MiniCourseProps {
  readonly level: LevelSpec;
  readonly balls: readonly MiniBall[];
  readonly trail?: readonly Vec2[];
  readonly theme?: Theme;
  readonly ballRadius?: number;
  readonly className?: string;
}

export function MiniCourse(props: MiniCourseProps): ReactElement {
  const { level, balls, trail, theme: themeProp, ballRadius, className } = props;
  const theme = themeProp ?? getTheme(level.themeId);
  const r = ballRadius !== undefined && ballRadius > 0 ? ballRadius : level.hole.radius * 0.5;

  return (
    <svg
      className={className}
      viewBox={courseViewBox(level)}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label="Course preview"
    >
      <rect x={0} y={0} width={level.width} height={level.height} fill={theme.felt} />
      {level.obstacles.map((o) => (
        <path key={`${o.kind}-${o.id}`} d={obstacleSvgPath(o)} fill={obstacleFill(o, theme)} />
      ))}
      <circle
        cx={level.hole.center.x}
        cy={level.hole.center.y}
        r={level.hole.radius}
        fill={theme.hole}
        stroke={theme.accent}
        strokeWidth={0.4}
      />
      {trail !== undefined && trail.length > 1 && (
        <polyline
          points={pathPolyline(trail)}
          fill="none"
          stroke={theme.accent}
          strokeWidth={0.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity={MINI.TRAIL_ALPHA}
        />
      )}
      {balls.map((ball, index) => (
        <circle
          key={ball.playerId ?? `ball-${index}`}
          cx={ball.pos.x}
          cy={ball.pos.y}
          r={r}
          fill={ball.holed === true ? 'none' : ball.color}
          stroke={ball.color}
          strokeWidth={0.4}
        />
      ))}
      <rect
        x={0}
        y={0}
        width={level.width}
        height={level.height}
        fill="none"
        stroke={theme.wall}
        strokeWidth={1}
      />
    </svg>
  );
}
