'use client';

/**
 * Device capability probing and the persisted quality override.
 *
 * Presentation only: nothing here ever touches the deterministic simulation.
 * Deliberately three.js-free so the home screen can render the quality toggle
 * without pulling the 3D bundle into the first load.
 */

import { useCallback, useEffect, useState } from 'react';

import { DEFAULT_QUALITY_TIER, QUALITY, type QualityProfile } from '@/game/config';
import type { QualityTier } from '@/types';
import { loadPrefs, patchPrefs } from '@/utils/storage';

export type { QualityProfile } from '@/game/config';

/** Renderer substrings that mean "software rasteriser" - always the low tier. */
const SOFTWARE_RENDERERS: readonly string[] = ['swiftshader', 'llvmpipe', 'software', 'basic render', 'mesa offscreen'];

/** Probes are expensive-ish (they create a canvas) so each one runs at most once. */
let cachedTier: QualityTier | null = null;
let cachedWebGL: boolean | null = null;
let cachedRenderer: string | null | undefined;

function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}

/** Creates a throwaway context purely to read capability strings, then drops it. */
function probeWebGL(): { supported: boolean; renderer: string | null; webgl2: boolean } {
  if (!isBrowser()) return { supported: false, renderer: null, webgl2: false };
  try {
    const canvas = document.createElement('canvas');
    const gl2 = canvas.getContext('webgl2');
    const gl: WebGLRenderingContext | WebGL2RenderingContext | null =
      gl2 ?? (canvas.getContext('webgl') as WebGLRenderingContext | null);
    if (gl === null) return { supported: false, renderer: null, webgl2: false };

    let renderer: string | null = null;
    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
    if (debugInfo !== null) {
      const raw: unknown = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);
      if (typeof raw === 'string') renderer = raw.toLowerCase();
    }
    if (renderer === null) {
      const raw: unknown = gl.getParameter(gl.RENDERER);
      if (typeof raw === 'string') renderer = raw.toLowerCase();
    }

    const lose = gl.getExtension('WEBGL_lose_context');
    if (lose !== null) lose.loseContext();

    return { supported: true, renderer, webgl2: gl2 !== null };
  } catch {
    return { supported: false, renderer: null, webgl2: false };
  }
}

/** True when this browser can render the 3D course at all. */
export function supportsWebGL(): boolean {
  if (cachedWebGL !== null) return cachedWebGL;
  const probe = probeWebGL();
  cachedWebGL = probe.supported;
  cachedRenderer = probe.renderer;
  return cachedWebGL;
}

interface DeviceHints {
  readonly cores: number;
  readonly memoryGb: number;
  readonly pixels: number;
  readonly dpr: number;
  readonly coarsePointer: boolean;
}

function readDeviceHints(): DeviceHints {
  if (!isBrowser()) {
    return { cores: 4, memoryGb: 4, pixels: 1_000_000, dpr: 1, coarsePointer: false };
  }
  const nav = navigator as Navigator & { deviceMemory?: number };
  const cores = typeof nav.hardwareConcurrency === 'number' && nav.hardwareConcurrency > 0
    ? nav.hardwareConcurrency
    : 4;
  const memoryGb = typeof nav.deviceMemory === 'number' && nav.deviceMemory > 0 ? nav.deviceMemory : 4;
  const dpr = typeof window.devicePixelRatio === 'number' && window.devicePixelRatio > 0
    ? window.devicePixelRatio
    : 1;
  const w = window.screen?.width ?? window.innerWidth ?? 1280;
  const h = window.screen?.height ?? window.innerHeight ?? 720;
  const pixels = Math.max(1, w * h * dpr * dpr);
  let coarsePointer = false;
  try {
    coarsePointer = window.matchMedia('(pointer: coarse)').matches;
  } catch {
    coarsePointer = false;
  }
  return { cores, memoryGb, pixels, dpr, coarsePointer };
}

/**
 * Picks a tier from hardware hints. Conservative on purpose: the user asked for
 * "damn fast", so anything ambiguous lands on `medium` rather than `high`.
 *
 * SSR-safe - returns DEFAULT_QUALITY_TIER when there is no window.
 */
export function detectQualityTier(): QualityTier {
  if (cachedTier !== null) return cachedTier;
  if (!isBrowser()) return DEFAULT_QUALITY_TIER;

  const probe = probeWebGL();
  cachedWebGL = probe.supported;
  cachedRenderer = probe.renderer;

  if (!probe.supported) {
    cachedTier = 'low';
    return cachedTier;
  }

  const renderer = probe.renderer;
  if (renderer !== null) {
    for (const needle of SOFTWARE_RENDERERS) {
      if (renderer.indexOf(needle) >= 0) {
        cachedTier = 'low';
        return cachedTier;
      }
    }
  }

  const hints = readDeviceHints();

  // Score in both directions, then clamp. Each signal is worth roughly one step.
  let score = 0;
  score += hints.cores >= 8 ? 1 : hints.cores <= 3 ? -1 : 0;
  score += hints.memoryGb >= 8 ? 1 : hints.memoryGb <= 2 ? -1 : 0;
  score += probe.webgl2 ? 1 : -2;
  // A huge backbuffer on a phone is the classic "looks powerful, throttles hard" trap.
  score += hints.pixels > 4_500_000 && hints.coarsePointer ? -1 : 0;
  score += hints.pixels > 9_000_000 ? -1 : 0;

  cachedTier = score >= 3 ? 'high' : score <= 0 ? 'low' : 'medium';
  return cachedTier;
}

/** The immutable settings bundle for a tier. Unknown tiers fall back to the default. */
export function resolveQuality(tier: QualityTier): QualityProfile {
  const profile = QUALITY[tier];
  return profile ?? QUALITY[DEFAULT_QUALITY_TIER];
}

/** Renderer pixel ratio, capped by the tier. Always 1 during SSR. */
export function cappedDpr(profile: QualityProfile): number {
  if (!isBrowser()) return 1;
  const dpr = typeof window.devicePixelRatio === 'number' && window.devicePixelRatio > 0
    ? window.devicePixelRatio
    : 1;
  return Math.min(dpr, profile.maxDpr);
}

/** Honours the OS "reduce motion" switch. False during SSR. */
export function prefersReducedMotion(): boolean {
  if (!isBrowser()) return false;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** The unmasked GPU string, when the browser exposes it. Diagnostics only. */
export function detectedRenderer(): string | null {
  if (cachedRenderer === undefined) supportsWebGL();
  return cachedRenderer ?? null;
}

/** Clears the memoised probes. Test-only. */
export function resetQualityProbeCache(): void {
  cachedTier = null;
  cachedWebGL = null;
  cachedRenderer = undefined;
}

export interface UseQualityResult {
  readonly tier: QualityTier;
  readonly profile: QualityProfile;
  readonly reducedMotion: boolean;
  readonly setTier: (tier: QualityTier) => void;
}

/**
 * Resolved quality for the current session.
 *
 * Start deterministic (DEFAULT_QUALITY_TIER) so SSR and the first client render
 * agree, then upgrade/downgrade after mount. A tier stored in localStorage that
 * differs from the default counts as an explicit user override and wins over
 * auto-detection; storing the default means "auto".
 */
export function useQuality(): UseQualityResult {
  const [tier, setTierState] = useState<QualityTier>(DEFAULT_QUALITY_TIER);
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    const stored = loadPrefs().quality;
    if (stored !== DEFAULT_QUALITY_TIER && (stored === 'high' || stored === 'medium' || stored === 'low')) {
      setTierState(stored);
    } else {
      setTierState(detectQualityTier());
    }
  }, []);

  useEffect(() => {
    if (!isBrowser()) return;
    let query: MediaQueryList | null = null;
    try {
      query = window.matchMedia('(prefers-reduced-motion: reduce)');
    } catch {
      query = null;
    }
    if (query === null) return;
    const media = query;
    setReducedMotion(media.matches);
    const onChange = (event: MediaQueryListEvent): void => setReducedMotion(event.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  const setTier = useCallback((next: QualityTier): void => {
    setTierState(next);
    // patchPrefs merges, so sound / haptics / lastName survive a quality change.
    patchPrefs({ quality: next });
  }, []);

  return { tier, profile: resolveQuality(tier), reducedMotion, setTier };
}
