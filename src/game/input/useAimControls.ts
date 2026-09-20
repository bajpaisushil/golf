'use client';

/**
 * useAimControls — the slingshot shot input.
 *
 * Pointer down ON or NEAR the ball, drag AWAY from it, release: the ball fires
 * in the OPPOSITE direction, with power proportional to how far you dragged.
 * One code path for mouse, touch and pen (Pointer Events + setPointerCapture),
 * so there is no separate mobile branch to keep in sync.
 *
 * The hook is renderer-agnostic: it never touches a camera. The caller supplies
 * `toCourse(clientX, clientY)`, which is the only thing that knows how screen
 * pixels map to course units — so the same hook drives the 3D course and the 2D
 * mini board.
 *
 * It produces exactly what the network needs and nothing else: a NORMALISED aim
 * vector and a 0..1 power. No angles (trig is not bit-identical across JS
 * engines, and these two numbers go into a lockstep-replayed ShotInput), and
 * never a NaN — every value is validated before it leaves the hook.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent, MouseEvent as ReactMouseEvent } from 'react';

import type { Vec2 } from '@/types';
import { PHYSICS } from '@/game/config';
import { ZERO, distance, length, sub } from '@/game/physics/vec';
import { aimFromDrag, powerFromDrag } from '@/game/physics/simulate';

// ---------------------------------------------------------------------------
// Tunables (input feel — presentation only, never part of the simulation)
// ---------------------------------------------------------------------------

export interface AimInputConfig {
  /** How close to the ball (cu) a mouse press must start. */
  readonly GRAB_RADIUS_CU: number;
  /** Fingers are fat and hide the ball: touch/pen get a bigger target. */
  readonly TOUCH_GRAB_MULT: number;
  /** Screen-pixel dead zone. Below this a drag is treated as a tap, not a shot. */
  readonly DEAD_ZONE_PX: number;
  /** Skip a re-render when neither power nor aim moved by more than this. */
  readonly UPDATE_EPSILON: number;
}

export const AIM_INPUT: AimInputConfig = {
  GRAB_RADIUS_CU: 12,
  TOUCH_GRAB_MULT: 1.75,
  DEAD_ZONE_PX: 6,
  UPDATE_EPSILON: 0.002,
};

/**
 * Spread onto the element the handlers are attached to. `touch-action: none` is
 * what stops the browser scrolling/zooming the page mid-drag on mobile, and
 * `user-select: none` stops a long press selecting UI text.
 */
export const AIM_SURFACE_STYLE: CSSProperties = {
  touchAction: 'none',
  userSelect: 'none',
  WebkitUserSelect: 'none',
  WebkitTouchCallout: 'none',
};

// ---------------------------------------------------------------------------
// Public types (CONTRACTS.md §11)
// ---------------------------------------------------------------------------

export interface AimState {
  readonly active: boolean;
  /** Ball position the shot will start from, course units. */
  readonly origin: Vec2;
  /** Drag vector in course units, measured from where the pointer went down. */
  readonly drag: Vec2;
  /** Normalised, already the OPPOSITE of the drag. ZERO inside the dead zone. */
  readonly aim: Vec2;
  /** 0..1, clamped. */
  readonly power: number;
  /** power >= PHYSICS.MIN_POWER — releasing now would actually fire. */
  readonly valid: boolean;
  /** Raw screen-pixel drag length; handy for a pixel-space power meter. */
  readonly dragPixels: number;
  /** 'mouse' | 'touch' | 'pen' — lets the UI size its hints. */
  readonly pointerType: string;
}

export interface UseAimControlsOptions {
  /** Current ball position in course units. The shot always starts here. */
  readonly ballPos: Vec2;
  /** False when it is not this player's turn, a shot is animating, etc. */
  readonly enabled: boolean;
  /** Screen -> course units. Provided by the renderer (it owns the camera). */
  readonly toCourse: (clientX: number, clientY: number) => Vec2;
  /** Fired on release with a normalised aim and a 0..1 power. Never called with NaN. */
  readonly onShoot: (aim: Vec2, power: number) => void;
  /** Pointer must start within this many cu of the ball. Default AIM_INPUT.GRAB_RADIUS_CU. */
  readonly grabRadius?: number;
  /** Override for touch/pen. Default grabRadius * AIM_INPUT.TOUCH_GRAB_MULT. */
  readonly touchGrabRadius?: number;
  /** Allow starting a drag anywhere on the surface, not just near the ball. Default false. */
  readonly allowAnywhere?: boolean;
  /** Called when a drag starts (sfx / "pull back" hint). */
  readonly onAimStart?: () => void;
  /** Called when a drag is abandoned (escape, right-click, dead-zone release). */
  readonly onAimCancel?: () => void;
  /** Fire a short vibration on grab/release for touch pointers. Default true. */
  readonly haptics?: boolean;
}

export interface AimPointerHandlers {
  readonly onPointerDown: (e: ReactPointerEvent) => void;
  readonly onPointerMove: (e: ReactPointerEvent) => void;
  readonly onPointerUp: (e: ReactPointerEvent) => void;
  readonly onPointerCancel: (e: ReactPointerEvent) => void;
  readonly onLostPointerCapture: (e: ReactPointerEvent) => void;
  readonly onContextMenu: (e: ReactMouseEvent) => void;
}

export interface UseAimControlsResult {
  /** Full state, or null when no drag is in progress. */
  readonly aim: AimState | null;
  /** Convenience mirrors of `aim` for simple consumers (power meter, cursor). */
  readonly isAiming: boolean;
  /** Normalised shot direction; ZERO when not aiming or inside the dead zone. */
  readonly aimVector: Vec2;
  readonly power: number;
  readonly dragPixels: number;
  /** Spread onto the course surface element. */
  readonly handlers: AimPointerHandlers;
  /** Abandon the current drag without firing. Safe to call any time. */
  readonly cancel: () => void;
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

function isFiniteVec(v: Vec2 | null | undefined): v is Vec2 {
  return v !== null && v !== undefined && Number.isFinite(v.x) && Number.isFinite(v.y);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/** `value` when it is a usable positive number, otherwise `fallback`. */
function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Internal record of the drag in flight. */
interface DragSession {
  readonly pointerId: number;
  readonly pointerType: string;
  /** Ball position when the drag started — the shot origin, frozen for the drag. */
  readonly origin: Vec2;
  /** Course-unit point under the pointer at pointerdown. */
  readonly startCourse: Vec2;
  /** Screen pixels at pointerdown, for the dead zone and the pixel power meter. */
  readonly startClientX: number;
  readonly startClientY: number;
  /** Element we captured the pointer on, so we can release it on any exit path. */
  readonly target: Element | null;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useAimControls(options: UseAimControlsOptions): UseAimControlsResult {
  const [aim, setAim] = useState<AimState | null>(null);

  // Latest options, read inside event handlers so they are never stale and the
  // handler identities stay stable (no re-binding listeners on every frame).
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  const sessionRef = useRef<DragSession | null>(null);
  const aimRef = useRef<AimState | null>(null);

  const publish = useCallback((next: AimState | null): void => {
    const prev = aimRef.current;
    if (prev === null && next === null) return;
    if (prev !== null && next !== null) {
      const eps = AIM_INPUT.UPDATE_EPSILON;
      const same =
        Math.abs(prev.power - next.power) < eps &&
        Math.abs(prev.aim.x - next.aim.x) < eps &&
        Math.abs(prev.aim.y - next.aim.y) < eps &&
        prev.valid === next.valid &&
        prev.origin.x === next.origin.x &&
        prev.origin.y === next.origin.y;
      if (same) return;
    }
    aimRef.current = next;
    setAim(next);
  }, []);

  const releaseCapture = useCallback((session: DragSession): void => {
    const target = session.target;
    if (target === null) return;
    try {
      if (typeof target.hasPointerCapture === 'function' && !target.hasPointerCapture(session.pointerId)) {
        return;
      }
      target.releasePointerCapture(session.pointerId);
    } catch {
      // Pointer already gone (element unmounted, pointer cancelled) — nothing to do.
    }
  }, []);

  const endSession = useCallback(
    (notifyCancel: boolean): void => {
      const session = sessionRef.current;
      sessionRef.current = null;
      if (session !== null) releaseCapture(session);
      publish(null);
      if (notifyCancel && session !== null) optionsRef.current.onAimCancel?.();
    },
    [publish, releaseCapture],
  );

  const cancel = useCallback((): void => {
    endSession(true);
  }, [endSession]);

  /** Recomputes the drag from a live pointer event. Returns null when unusable. */
  const measure = useCallback((session: DragSession, clientX: number, clientY: number): AimState | null => {
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;

    const point = optionsRef.current.toCourse(clientX, clientY);
    if (!isFiniteVec(point)) return null;

    const dx = clientX - session.startClientX;
    const dy = clientY - session.startClientY;
    const dragPixels = Math.sqrt(dx * dx + dy * dy);

    // Inside the dead zone this is a tap, not a shot: keep the drag live so the
    // player can pull further, but report zero power so nothing can fire.
    if (dragPixels < AIM_INPUT.DEAD_ZONE_PX) {
      return {
        active: true,
        origin: session.origin,
        drag: ZERO,
        aim: ZERO,
        power: 0,
        valid: false,
        dragPixels,
        pointerType: session.pointerType,
      };
    }

    const drag = sub(point, session.startCourse);
    if (!isFiniteVec(drag)) return null;

    const dragLength = length(drag);
    if (!Number.isFinite(dragLength) || dragLength <= 0) return null;

    // Both of these come from the deterministic core, so the preview the player
    // sees and the shot every peer replays cannot drift apart.
    const power = clamp01(powerFromDrag(dragLength));
    const shotAim = aimFromDrag(drag);
    const aimOk = isFiniteVec(shotAim) && (shotAim.x !== 0 || shotAim.y !== 0);

    return {
      active: true,
      origin: session.origin,
      drag,
      aim: aimOk ? shotAim : ZERO,
      power: aimOk ? power : 0,
      valid: aimOk && power >= PHYSICS.MIN_POWER,
      dragPixels,
      pointerType: session.pointerType,
    };
  }, []);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent): void => {
      const opts = optionsRef.current;
      if (!opts.enabled) return;
      if (sessionRef.current !== null) return;

      // Right / middle mouse button never starts a shot (and cancels a stray one).
      if (e.pointerType === 'mouse' && e.button !== 0) return;

      const point = opts.toCourse(e.clientX, e.clientY);
      if (!isFiniteVec(point)) return;
      if (!isFiniteVec(opts.ballPos)) return;

      const baseRadius = positiveOr(opts.grabRadius, AIM_INPUT.GRAB_RADIUS_CU);
      // Fingers and pen tips cover the ball, so they get a much bigger target.
      const coarse = e.pointerType !== 'mouse';
      const radius = coarse
        ? positiveOr(opts.touchGrabRadius, baseRadius * AIM_INPUT.TOUCH_GRAB_MULT)
        : baseRadius;

      if (opts.allowAnywhere !== true && distance(point, opts.ballPos) > radius) return;

      // Stops the page scrolling / rubber-banding while the finger is down.
      e.preventDefault();

      const target: Element | null = e.currentTarget instanceof Element ? e.currentTarget : null;
      if (target !== null) {
        try {
          target.setPointerCapture(e.pointerId);
        } catch {
          // Capture is an optimisation; the drag still works through the element.
        }
      }

      const session: DragSession = {
        pointerId: e.pointerId,
        pointerType: e.pointerType,
        origin: opts.ballPos,
        startCourse: point,
        startClientX: e.clientX,
        startClientY: e.clientY,
        target,
      };
      sessionRef.current = session;

      publish({
        active: true,
        origin: session.origin,
        drag: ZERO,
        aim: ZERO,
        power: 0,
        valid: false,
        dragPixels: 0,
        pointerType: session.pointerType,
      });

      if (coarse && opts.haptics !== false) triggerHaptic('grab');
      opts.onAimStart?.();
    },
    [publish],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent): void => {
      const session = sessionRef.current;
      if (session === null || session.pointerId !== e.pointerId) return;
      e.preventDefault();
      const next = measure(session, e.clientX, e.clientY);
      if (next === null) return;
      publish(next);
    },
    [measure, publish],
  );

  const onPointerUp = useCallback(
    (e: ReactPointerEvent): void => {
      const session = sessionRef.current;
      if (session === null || session.pointerId !== e.pointerId) return;
      e.preventDefault();

      const opts = optionsRef.current;
      const final = measure(session, e.clientX, e.clientY) ?? aimRef.current;

      sessionRef.current = null;
      releaseCapture(session);
      publish(null);

      // A too-short drag is a cancel, not a nudge — firing a 2% shot by accident
      // would cost a stroke, and strokes are the score.
      if (final === null || !final.valid || !opts.enabled) {
        opts.onAimCancel?.();
        return;
      }

      const power = clamp01(final.power);
      const shotAim = final.aim;
      if (!isFiniteVec(shotAim) || (shotAim.x === 0 && shotAim.y === 0) || power < PHYSICS.MIN_POWER) {
        opts.onAimCancel?.();
        return;
      }

      if (session.pointerType !== 'mouse' && opts.haptics !== false) triggerHaptic('release');
      opts.onShoot(shotAim, power);
    },
    [measure, publish, releaseCapture],
  );

  const onPointerCancel = useCallback(
    (e: ReactPointerEvent): void => {
      const session = sessionRef.current;
      if (session === null || session.pointerId !== e.pointerId) return;
      endSession(true);
    },
    [endSession],
  );

  const onLostPointerCapture = useCallback(
    (e: ReactPointerEvent): void => {
      const session = sessionRef.current;
      if (session === null || session.pointerId !== e.pointerId) return;
      // The browser took the pointer away mid-drag (scroll gesture, system UI).
      endSession(true);
    },
    [endSession],
  );

  const onContextMenu = useCallback(
    (e: ReactMouseEvent): void => {
      // Right-click is the mouse escape hatch: no menu, no shot.
      e.preventDefault();
      if (sessionRef.current !== null) endSession(true);
    },
    [endSession],
  );

  const isAiming = aim !== null;

  // Escape / window blur / tab hide abandon the shot. Only bound while dragging,
  // and keyed off a boolean so a 120Hz drag does not re-bind listeners.
  useEffect(() => {
    if (!isAiming) return;
    if (typeof window === 'undefined') return;

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' || event.key === 'Esc') {
        event.preventDefault();
        endSession(true);
      }
    };
    const onBlur = (): void => endSession(true);
    const onVisibility = (): void => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') endSession(true);
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('blur', onBlur);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibility);
    }
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('blur', onBlur);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility);
      }
    };
  }, [isAiming, endSession]);

  // Losing the turn (or unmounting) must never leave a half-pulled slingshot.
  useEffect(() => {
    if (options.enabled) return;
    if (sessionRef.current === null && aimRef.current === null) return;
    endSession(true);
  }, [options.enabled, endSession]);

  useEffect(
    () => () => {
      const session = sessionRef.current;
      sessionRef.current = null;
      aimRef.current = null;
      if (session !== null) releaseCapture(session);
    },
    [releaseCapture],
  );

  const handlers = useMemo<AimPointerHandlers>(
    () => ({
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
      onLostPointerCapture,
      onContextMenu,
    }),
    [onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onLostPointerCapture, onContextMenu],
  );

  return {
    aim,
    isAiming,
    aimVector: aim === null ? ZERO : aim.aim,
    power: aim === null ? 0 : aim.power,
    dragPixels: aim === null ? 0 : aim.dragPixels,
    handlers,
    cancel,
  };
}

// ---------------------------------------------------------------------------
// Haptics — hook-free, so any module (input, HUD, sfx) can call it
// ---------------------------------------------------------------------------

export type HapticKind = 'grab' | 'release' | 'bounce' | 'holed' | 'error';

/** Vibration patterns in ms. Short on purpose: this is texture, not an alarm. */
export const HAPTIC_PATTERNS: Readonly<Record<HapticKind, readonly number[]>> = {
  grab: [8],
  release: [14],
  bounce: [5],
  holed: [12, 40, 24],
  error: [18, 60, 18],
};

/**
 * Fires a vibration if the device supports it. Always safe: no-ops during SSR,
 * on desktop, when the user asked for reduced motion, or if the browser throws
 * because the page is not visible. Returns whether anything was triggered.
 */
export function triggerHaptic(kind: HapticKind): boolean {
  if (typeof navigator === 'undefined') return false;
  const vibrate = (navigator as Navigator & { vibrate?: (p: number | number[]) => boolean }).vibrate;
  if (typeof vibrate !== 'function') return false;
  if (prefersReducedMotionSafe()) return false;
  const pattern = HAPTIC_PATTERNS[kind];
  if (pattern === undefined) return false;
  try {
    return vibrate.call(navigator, [...pattern]);
  } catch {
    return false;
  }
}

/** Local, dependency-free reduced-motion probe (the renderer has its own). */
function prefersReducedMotionSafe(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}
