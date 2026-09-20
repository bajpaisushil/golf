/**
 * App chrome colour tokens + pure hex maths.
 *
 * This module is intentionally FREE of three.js and of React so it can be
 * imported by the home screen, the Tailwind theme mirror in `globals.css` and
 * the SVG mini-renderer without dragging the 3D bundle into the first load.
 *
 * Course colours do NOT live here - they come from a `Theme`
 * (`src/game/levels/themes.ts`). This file only owns the UI shell.
 */

import type { Hex } from '@/types';

export interface RgbColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export interface UiPalette {
  readonly bg: Hex;
  readonly surface: Hex;
  readonly surfaceAlt: Hex;
  readonly border: Hex;
  readonly text: Hex;
  readonly textMuted: Hex;
  readonly accent: Hex;
  readonly accentAlt: Hex;
  readonly good: Hex;
  readonly warn: Hex;
  readonly bad: Hex;
}

/**
 * Dark, low-chroma shell so the eight PLAYER_COLORS stay the brightest thing on
 * screen. Every value is an original choice - no brand palette is copied.
 */
export const UI: UiPalette = {
  bg: '#090F13',
  surface: '#111A20',
  surfaceAlt: '#18242C',
  border: '#27363F',
  text: '#E9F1F5',
  textMuted: '#93A6B2',
  accent: '#3DD6B0',
  accentAlt: '#7C9CFF',
  good: '#4ADE80',
  warn: '#FBBF24',
  bad: '#F87171',
};

// ---------------------------------------------------------------------------
// Hex maths (presentation only - never used by the simulation)
// ---------------------------------------------------------------------------

const HEX_CHARS = '0123456789abcdef';

function clampByte(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 255) return 255;
  return Math.round(value);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function byteToHex(value: number): string {
  const v = clampByte(value);
  const hi = HEX_CHARS[(v >> 4) & 0xf];
  const lo = HEX_CHARS[v & 0xf];
  return (hi ?? '0') + (lo ?? '0');
}

/** Strips `#`, expands `#rgb` to `rrggbb`, lowercases. Returns null when unusable. */
function normaliseHex(hex: Hex): string | null {
  if (typeof hex !== 'string') return null;
  let body = hex.trim().toLowerCase();
  if (body.startsWith('#')) body = body.slice(1);
  if (body.length === 3) {
    const r = body[0];
    const g = body[1];
    const b = body[2];
    if (r === undefined || g === undefined || b === undefined) return null;
    body = r + r + g + g + b + b;
  }
  if (body.length !== 6) return null;
  for (let i = 0; i < 6; i += 1) {
    const c = body[i];
    if (c === undefined || HEX_CHARS.indexOf(c) < 0) return null;
  }
  return body;
}

/** `#rrggbb` (or `#rgb`) to 0-255 channels. Unparseable input yields black. */
export function hexToRgb(hex: Hex): RgbColor {
  const body = normaliseHex(hex);
  if (body === null) return { r: 0, g: 0, b: 0 };
  const value = Number.parseInt(body, 16);
  return {
    r: (value >> 16) & 0xff,
    g: (value >> 8) & 0xff,
    b: value & 0xff,
  };
}

/** 0-255 channels to `#rrggbb`. Values are clamped and rounded. */
export function rgbToHex(r: number, g: number, b: number): Hex {
  return '#' + byteToHex(r) + byteToHex(g) + byteToHex(b);
}

/** Linear blend in sRGB space. `t` 0 returns `a`, 1 returns `b`. */
export function mixHex(a: Hex, b: Hex, t: number): Hex {
  const k = clamp01(t);
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  return rgbToHex(
    ca.r + (cb.r - ca.r) * k,
    ca.g + (cb.g - ca.g) * k,
    ca.b + (cb.b - ca.b) * k,
  );
}

/** `amount` -1 fully darkens to black, +1 fully lightens to white, 0 is a no-op. */
export function shadeHex(hex: Hex, amount: number): Hex {
  const a = Number.isFinite(amount) ? Math.max(-1, Math.min(1, amount)) : 0;
  const c = hexToRgb(hex);
  if (a >= 0) {
    return rgbToHex(
      c.r + (255 - c.r) * a,
      c.g + (255 - c.g) * a,
      c.b + (255 - c.b) * a,
    );
  }
  const k = 1 + a;
  return rgbToHex(c.r * k, c.g * k, c.b * k);
}

/** CSS `rgba(...)` string - handy for shadows and scrims where Tailwind cannot help. */
export function withAlpha(hex: Hex, alpha: number): string {
  const c = hexToRgb(hex);
  const a = clamp01(alpha);
  return 'rgba(' + c.r + ', ' + c.g + ', ' + c.b + ', ' + (Math.round(a * 1000) / 1000) + ')';
}

/** WCAG relative luminance (0 black .. 1 white). */
export function relativeLuminance(hex: Hex): number {
  const c = hexToRgb(hex);
  const channel = (raw: number): number => {
    const s = raw / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
}

/** Picks the readable foreground token for a filled surface. */
export function contrastTextFor(bg: Hex): Hex {
  return relativeLuminance(bg) > 0.42 ? UI.bg : UI.text;
}

/** Contrast ratio between two colours, 1..21. Used by the colour unit tests. */
export function contrastRatio(a: Hex, b: Hex): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const light = Math.max(la, lb);
  const dark = Math.min(la, lb);
  return (light + 0.05) / (dark + 0.05);
}
