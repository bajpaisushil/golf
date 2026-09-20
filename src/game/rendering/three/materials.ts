'use client';

/**
 * Shared, procedurally built three.js resources.
 *
 * Everything the 3D layer draws is generated here from numbers - there is not a
 * single downloaded texture, model, font or HDRI anywhere in the renderer.
 *
 * Geometry caches are module singletons on purpose: a course draws the same unit
 * box thousands of times, and sharing the buffers keeps both memory and draw
 * setup cost flat. They are never disposed, because they outlive any one mount
 * and are tiny (a handful of KB in total).
 */

import * as THREE from 'three';

import type { Theme } from '@/game/levels/themes';

/**
 * Presentation-only geometry constants, in course units unless noted.
 *
 * NOTE: `src/game/config.ts` owns every gameplay tunable but deliberately has no
 * 3D-geometry section, and config.ts belongs to another agent, so the renderer's
 * own shape constants live here rather than being scattered as magic numbers.
 * None of these values can affect the simulation.
 */
export const RENDER3D = {
  /** Fairway slab: its TOP face sits at y = 0, which is the play plane. */
  FELT_THICKNESS: 1.4,
  /** Apron of rough extending past the border walls. */
  ROUGH_MARGIN: 30,
  ROUGH_Y: -0.85,
  /** Mown stripes drawn as thin lighter slabs on top of the felt. */
  STRIPE_COUNT: 11,
  STRIPE_LIFT: 0.014,
  /** Border walls that ring the playfield (outside the play area). */
  RIM_WIDTH: 1.9,
  RIM_HEIGHT: 3.1,
  RIM_CAP_HEIGHT: 0.42,
  /** Obstacle walls. */
  WALL_HEIGHT: 2.4,
  WALL_CAP_HEIGHT: 0.34,
  BUMPER_HEIGHT: 2.1,
  BUMPER_TAPER: 0.86,
  SAND_HEIGHT: 0.18,
  SAND_LIFT: 0.02,
  WATER_DEPTH: 0.9,
  WATER_LIFT: -0.1,
  BOOST_HEIGHT: 0.1,
  BOOST_LIFT: 0.035,
  CHEVRONS_PER_PAD: 3,
  CHEVRON_LIFT: 0.09,
  /** Cup. */
  HOLE_DEPTH: 3.2,
  HOLE_RIM_SCALE: 1.45,
  FLAG_POLE_HEIGHT: 9.5,
  FLAG_POLE_RADIUS: 0.16,
  FLAG_WIDTH: 3.4,
  FLAG_HEIGHT: 2.0,
  FLAG_SWAY_HZ: 0.9,
  /** Ball. */
  BALL_SHADOW_SCALE: 1.25,
  TRAIL_MIN_STEP: 0.35,
  TRAIL_RESET_JUMP: 9,
  SQUASH_MS: 190,
  SQUASH_AMOUNT: 0.3,
  /** Obstacle feedback. */
  PULSE_MS: 420,
  /** Aim indicator. */
  AIM_MAX_LENGTH: 48,
  AIM_DOTS: 16,
  AIM_DOT_RADIUS: 0.5,
  AIM_DOT_LIFT: 0.06,
  AIM_GAP: 2.4,
  AIM_ARC_SEGMENTS: 26,
  AIM_ARC_RADIUS: 3.6,
  AIM_ARC_DOT: 0.32,
  AIM_ARROW_LENGTH: 2.6,
  AIM_ARROW_RADIUS: 1.0,
  AIM_BAND_WIDTH: 0.34,
  /** Camera. */
  CAM_FOV: 42,
  CAM_TILT_DEG: 38,
  CAM_MARGIN: 1.24,
  CAM_NEAR: 1,
  CAM_FAR: 900,
  CAM_FOLLOW: 0.24,
  CAM_FOLLOW_MAX: 9,
  CAM_EASE: 3.4,
  /** Effects. */
  BURST_PARTICLES: 56,
  BURST_LIFE_MS: 1150,
  BURST_SPEED: 26,
  BURST_GRAVITY: 58,
  BURST_SIZE: 0.42,
  RIPPLE_POOL: 4,
  RIPPLE_LIFE_MS: 900,
  RIPPLE_MAX_RADIUS: 6,
  /** Lighting / atmosphere. */
  ENV_INTENSITY: 0.6,
  FOG_NEAR_MULT: 1.6,
  FOG_FAR_MULT: 4.5,
  SHADOW_MAP_SIZE: 1024,
} as const;

// ---------------------------------------------------------------------------
// Shared geometry cache
// ---------------------------------------------------------------------------

let unitBoxGeometry: THREE.BoxGeometry | null = null;
const sphereCache = new Map<number, THREE.SphereGeometry>();
const cylinderCache = new Map<number, THREE.CylinderGeometry>();
const taperedCache = new Map<number, THREE.CylinderGeometry>();
const tubeCache = new Map<number, THREE.CylinderGeometry>();
const discCache = new Map<number, THREE.CircleGeometry>();
const ringCache = new Map<number, THREE.RingGeometry>();
const coneCache = new Map<number, THREE.ConeGeometry>();
let chevronGeometry: THREE.BufferGeometry | null = null;
let flagGeometry: THREE.BufferGeometry | null = null;

/** 1x1x1 box centred on its own origin. The workhorse of every instanced mesh. */
export function unitBox(): THREE.BoxGeometry {
  if (unitBoxGeometry === null) unitBoxGeometry = new THREE.BoxGeometry(1, 1, 1);
  return unitBoxGeometry;
}

/** Unit sphere. `segments` comes from the quality profile. */
export function unitSphere(segments: number): THREE.SphereGeometry {
  const seg = Math.max(6, Math.floor(segments));
  const cached = sphereCache.get(seg);
  if (cached !== undefined) return cached;
  const geometry = new THREE.SphereGeometry(1, seg, Math.max(4, Math.floor(seg * 0.5)));
  sphereCache.set(seg, geometry);
  return geometry;
}

/** Unit-radius, unit-height capped cylinder, axis along +Y. */
export function unitCylinder(segments: number): THREE.CylinderGeometry {
  const seg = Math.max(6, Math.floor(segments));
  const cached = cylinderCache.get(seg);
  if (cached !== undefined) return cached;
  const geometry = new THREE.CylinderGeometry(1, 1, 1, seg);
  cylinderCache.set(seg, geometry);
  return geometry;
}

/** Slightly tapered cylinder - reads as a moulded bumper rather than a tin can. */
export function taperedCylinder(segments: number): THREE.CylinderGeometry {
  const seg = Math.max(6, Math.floor(segments));
  const cached = taperedCache.get(seg);
  if (cached !== undefined) return cached;
  const geometry = new THREE.CylinderGeometry(RENDER3D.BUMPER_TAPER, 1, 1, seg);
  taperedCache.set(seg, geometry);
  return geometry;
}

/** Open-ended cylinder used for the inside wall of the cup. */
export function openTube(segments: number): THREE.CylinderGeometry {
  const seg = Math.max(6, Math.floor(segments));
  const cached = tubeCache.get(seg);
  if (cached !== undefined) return cached;
  const geometry = new THREE.CylinderGeometry(1, 1, 1, seg, 1, true);
  tubeCache.set(seg, geometry);
  return geometry;
}

/** Unit-radius disc already lying in the XZ plane, facing +Y. */
export function flatDisc(segments: number): THREE.CircleGeometry {
  const seg = Math.max(6, Math.floor(segments));
  const cached = discCache.get(seg);
  if (cached !== undefined) return cached;
  const geometry = new THREE.CircleGeometry(1, seg);
  geometry.rotateX(-Math.PI * 0.5);
  discCache.set(seg, geometry);
  return geometry;
}

/** Unit-outer-radius ring in the XZ plane, facing +Y. */
export function flatRing(segments: number): THREE.RingGeometry {
  const seg = Math.max(6, Math.floor(segments));
  const cached = ringCache.get(seg);
  if (cached !== undefined) return cached;
  const geometry = new THREE.RingGeometry(0.78, 1, seg);
  geometry.rotateX(-Math.PI * 0.5);
  ringCache.set(seg, geometry);
  return geometry;
}

/** Unit cone, axis along +Y, apex at +0.5. */
export function unitCone(segments: number): THREE.ConeGeometry {
  const seg = Math.max(6, Math.floor(segments));
  const cached = coneCache.get(seg);
  if (cached !== undefined) return cached;
  const geometry = new THREE.ConeGeometry(1, 1, seg);
  coneCache.set(seg, geometry);
  return geometry;
}

/**
 * Flat chevron in the XZ plane pointing along +X, spanning roughly -0.5..0.5 in
 * both axes. Six vertices, two triangles - cheap enough to instance freely.
 */
export function chevron(): THREE.BufferGeometry {
  if (chevronGeometry !== null) return chevronGeometry;
  const geometry = new THREE.BufferGeometry();
  const t = 0.34; // arm thickness along +X
  const positions = new Float32Array([
    // upper arm
    -0.5, 0, -0.5,
    0.5, 0, 0,
    -0.5 + t, 0, -0.5,
    -0.5 + t, 0, -0.5,
    0.5, 0, 0,
    0.5 - t, 0, 0,
    // lower arm
    -0.5, 0, 0.5,
    -0.5 + t, 0, 0.5,
    0.5, 0, 0,
    -0.5 + t, 0, 0.5,
    0.5 - t, 0, 0,
    0.5, 0, 0,
  ]);
  const normals = new Float32Array(positions.length);
  for (let i = 1; i < normals.length; i += 3) normals[i] = 1;
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.computeBoundingSphere();
  chevronGeometry = geometry;
  return geometry;
}

/**
 * Pennant flag: a double-sided triangle in the XY plane, hanging off a pole at
 * local x = 0. Two triangles so it is lit from both sides without `side: Double`
 * forcing the material off the fast path.
 */
export function pennant(): THREE.BufferGeometry {
  if (flagGeometry !== null) return flagGeometry;
  const w = RENDER3D.FLAG_WIDTH;
  const h = RENDER3D.FLAG_HEIGHT;
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array([
    0, 0, 0, w, -h * 0.5, 0, 0, -h, 0,
    0, 0, 0.001, 0, -h, 0.001, w, -h * 0.5, 0.001,
  ]);
  const normals = new Float32Array([
    0, 0, -1, 0, 0, -1, 0, 0, -1,
    0, 0, 1, 0, 0, 1, 0, 0, 1,
  ]);
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.computeBoundingSphere();
  flagGeometry = geometry;
  return geometry;
}

// ---------------------------------------------------------------------------
// Theme -> three.js colours
// ---------------------------------------------------------------------------

export interface ThemeColors {
  readonly felt: THREE.Color;
  readonly feltStripe: THREE.Color;
  readonly feltEdge: THREE.Color;
  readonly rough: THREE.Color;
  readonly wall: THREE.Color;
  readonly wallTop: THREE.Color;
  readonly sand: THREE.Color;
  readonly water: THREE.Color;
  readonly boost: THREE.Color;
  readonly bumper: THREE.Color;
  readonly hole: THREE.Color;
  readonly holeInterior: THREE.Color;
  readonly sky: THREE.Color;
  readonly fog: THREE.Color;
  readonly accent: THREE.Color;
}

const themeColorCache = new WeakMap<Theme, ThemeColors>();

function shaded(hex: string, factor: number): THREE.Color {
  const color = new THREE.Color(hex);
  color.multiplyScalar(factor);
  return color;
}

/**
 * Memoised per Theme object. Themes are module constants, so the WeakMap holds
 * at most `THEMES.length` entries for the life of the page.
 */
export function themeColors(theme: Theme): ThemeColors {
  const cached = themeColorCache.get(theme);
  if (cached !== undefined) return cached;
  const colors: ThemeColors = {
    felt: new THREE.Color(theme.felt),
    feltStripe: shaded(theme.felt, 1.26),
    feltEdge: new THREE.Color(theme.feltEdge),
    rough: new THREE.Color(theme.rough),
    wall: new THREE.Color(theme.wall),
    wallTop: new THREE.Color(theme.wallTop),
    sand: new THREE.Color(theme.sand),
    water: new THREE.Color(theme.water),
    boost: new THREE.Color(theme.boost),
    bumper: new THREE.Color(theme.bumper),
    hole: new THREE.Color(theme.hole),
    holeInterior: shaded(theme.hole, 0.18),
    sky: new THREE.Color(theme.sky),
    fog: new THREE.Color(theme.fog),
    accent: new THREE.Color(theme.accent),
  };
  themeColorCache.set(theme, colors);
  return colors;
}

// ---------------------------------------------------------------------------
// Procedural sky / environment texture
// ---------------------------------------------------------------------------

const SKY_TEX_WIDTH = 4;
const SKY_TEX_HEIGHT = 64;

/**
 * Builds a tiny equirectangular vertical gradient (sky -> horizon -> ground) and
 * returns it ready to be used as BOTH `scene.background` and `scene.environment`.
 *
 * This replaces drei's `<Environment preset>` deliberately: presets fetch an HDRI
 * from a CDN, and the project forbids downloaded assets. 4x64 bytes of RGBA is
 * enough because the gradient is smooth and linear-filtered.
 *
 * The caller owns the texture and must dispose it.
 */
export function makeSkyTexture(colors: ThemeColors): THREE.DataTexture {
  const data = new Uint8Array(SKY_TEX_WIDTH * SKY_TEX_HEIGHT * 4);
  const top = colors.sky;
  const horizon = colors.fog;
  const bottom = colors.rough;
  for (let row = 0; row < SKY_TEX_HEIGHT; row += 1) {
    const v = row / (SKY_TEX_HEIGHT - 1); // 0 = top of the sphere
    let r: number;
    let g: number;
    let b: number;
    if (v < 0.5) {
      const t = v / 0.5;
      r = top.r + (horizon.r - top.r) * t;
      g = top.g + (horizon.g - top.g) * t;
      b = top.b + (horizon.b - top.b) * t;
    } else {
      const t = (v - 0.5) / 0.5;
      r = horizon.r + (bottom.r - horizon.r) * t;
      g = horizon.g + (bottom.g - horizon.g) * t;
      b = horizon.b + (bottom.b - horizon.b) * t;
    }
    for (let col = 0; col < SKY_TEX_WIDTH; col += 1) {
      const i = (row * SKY_TEX_WIDTH + col) * 4;
      data[i] = Math.round(Math.max(0, Math.min(1, r)) * 255);
      data[i + 1] = Math.round(Math.max(0, Math.min(1, g)) * 255);
      data[i + 2] = Math.round(Math.max(0, Math.min(1, b)) * 255);
      data[i + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, SKY_TEX_WIDTH, SKY_TEX_HEIGHT, THREE.RGBAFormat);
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return texture;
}

// ---------------------------------------------------------------------------
// Disposal helper
// ---------------------------------------------------------------------------

interface Disposable {
  dispose(): void;
}

/** Disposes every non-null argument. Used by every `useMemo`-owned resource. */
export function disposeAll(...items: readonly (Disposable | null | undefined)[]): void {
  for (const item of items) {
    if (item !== null && item !== undefined) item.dispose();
  }
}
