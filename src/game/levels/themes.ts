/**
 * Course colour themes - PRESENTATION ONLY. Nothing here ever affects the
 * simulation; a peer on a different theme still gets identical shot outcomes.
 *
 * All palettes are original, hand-tuned and fully procedural: no downloaded
 * assets, no brand colours, no copied colour schemes.
 *
 * Design rule (from the contracts doc): the FELT stays a deep, desaturated
 * teal/charcoal in every theme so that all eight `PLAYER_COLORS` (Okabe-Ito
 * derived) keep a strong contrast ratio against it. Themes differentiate
 * themselves through the sky, the walls, the accent and the hazard hues -
 * never by making the playing surface bright.
 */

import { asThemeId } from '@/types';
import type { Hex, ThemeId } from '@/types';

export interface Theme {
  readonly id: ThemeId;
  readonly name: string;
  /** The mown fairway surface. Bright, sunlit turf - never dark felt. */
  readonly felt: Hex;
  /** Slightly darker felt used for the bevel/edge ring around the course. */
  readonly feltEdge: Hex;
  /** Planted ground outside the course boundary: rough grass, hedging, beds. */
  readonly rough: Hex;
  /** Side faces of walls and the outer border. */
  readonly wall: Hex;
  /** Lit top faces of walls - keep noticeably lighter than `wall` for readability. */
  readonly wallTop: Hex;
  readonly sand: Hex;
  readonly water: Hex;
  readonly boost: Hex;
  readonly bumper: Hex;
  /** The cup itself: near-black, so it reads as a hole rather than a disc. */
  readonly hole: Hex;
  readonly sky: Hex;
  readonly fog: Hex;
  /** UI highlight for this course: aim guide, trail, active-player ring. */
  readonly accent: Hex;
  /** Multiplier applied to the scene's key light. 0.9 = moody, 1.1 = crisp. */
  readonly lightIntensity: number;
}

const MORNING_FAIRWAY: Theme = {
  id: asThemeId('morning-fairway'),
  name: 'Morning Fairway',
  felt: '#5BA84F',
  feltEdge: '#478A3E',
  rough: '#2F6B33',
  wall: '#8A6A44',
  wallTop: '#B78F5E',
  sand: '#EFDCA8',
  water: '#41AEE0',
  boost: '#FFD25A',
  bumper: '#E4573F',
  hole: '#0A0F0A',
  sky: '#9BD8F2',
  fog: '#D6ECF7',
  accent: '#FFC53D',
  lightIntensity: 1.2,
};

const GARDEN_PARK: Theme = {
  id: asThemeId('garden-park'),
  name: 'Garden Park',
  felt: '#63B056',
  feltEdge: '#4E9244',
  rough: '#356F38',
  wall: '#7F8A5C',
  wallTop: '#A9B37C',
  sand: '#EEDCAA',
  water: '#3FA7DC',
  boost: '#FFCE52',
  bumper: '#E8607C',
  hole: '#0A0F0A',
  sky: '#A6DEF0',
  fog: '#DCEFF6',
  accent: '#F2789F',
  lightIntensity: 1.22,
};

const SUMMER_LINKS: Theme = {
  id: asThemeId('summer-links'),
  name: 'Summer Links',
  felt: '#6FB85A',
  feltEdge: '#579B47',
  rough: '#7E9A4E',
  wall: '#A08A5E',
  wallTop: '#C9AE7C',
  sand: '#F2E3B0',
  water: '#2FA4DE',
  boost: '#FFD766',
  bumper: '#E86B45',
  hole: '#0B100B',
  sky: '#A8E0F5',
  fog: '#E0F0F8',
  accent: '#3FA7DC',
  lightIntensity: 1.26,
};

const ORCHARD_LAWN: Theme = {
  id: asThemeId('orchard-lawn'),
  name: 'Orchard Lawn',
  felt: '#5EAC4B',
  feltEdge: '#4A8E3E',
  rough: '#3B6E34',
  wall: '#96694A',
  wallTop: '#C08F65',
  sand: '#EFD9A2',
  water: '#46A9D4',
  boost: '#FFC94F',
  bumper: '#D9534F',
  hole: '#0A0F0A',
  sky: '#B8DCEF',
  fog: '#E4EEF3',
  accent: '#F08C3A',
  lightIntensity: 1.18,
};

const HIGHLAND_GREEN: Theme = {
  id: asThemeId('highland-green'),
  name: 'Highland Green',
  felt: '#52A455',
  feltEdge: '#3F8644',
  rough: '#2E6440',
  wall: '#7C8A82',
  wallTop: '#A6B3AA',
  sand: '#E9DCB2',
  water: '#3C9FCB',
  boost: '#FFD25A',
  bumper: '#DE5B6E',
  hole: '#080D08',
  sky: '#AEDCEC',
  fog: '#DCEBF1',
  accent: '#4FC3A1',
  lightIntensity: 1.16,
};

const PALM_RESORT: Theme = {
  id: asThemeId('palm-resort'),
  name: 'Palm Resort',
  felt: '#68B95A',
  feltEdge: '#519B47',
  rough: '#37785A',
  wall: '#C2A882',
  wallTop: '#E0C79E',
  sand: '#F5E6BC',
  water: '#23B2D8',
  boost: '#FFD766',
  bumper: '#FF7A5C',
  hole: '#0A100C',
  sky: '#9FE2F0',
  fog: '#DDF2F6',
  accent: '#00BFA6',
  lightIntensity: 1.3,
};

const AUTUMN_GROVE: Theme = {
  id: asThemeId('autumn-grove'),
  name: 'Autumn Grove',
  felt: '#6BA84A',
  feltEdge: '#548A3D',
  rough: '#7A6B34',
  wall: '#96714A',
  wallTop: '#C29566',
  sand: '#EFDCA6',
  water: '#4BA5C9',
  boost: '#FFC24F',
  bumper: '#D95F35',
  hole: '#0B0E09',
  sky: '#C3DCE8',
  fog: '#EAE6DC',
  accent: '#E8843A',
  lightIntensity: 1.14,
};

const MEADOW_CLUB: Theme = {
  id: asThemeId('meadow-club'),
  name: 'Meadow Club',
  felt: '#59AB4E',
  feltEdge: '#458D3F',
  rough: '#33703A',
  wall: '#8E7A57',
  wallTop: '#BCA37A',
  sand: '#EDDCA9',
  water: '#3EA8DA',
  boost: '#FFD05A',
  bumper: '#E05C6B',
  hole: '#090E09',
  sky: '#A9DBF0',
  fog: '#DCEEF7',
  accent: '#7FC24A',
  lightIntensity: 1.2,
};

export const THEMES: readonly Theme[] = [
  MORNING_FAIRWAY,
  GARDEN_PARK,
  SUMMER_LINKS,
  ORCHARD_LAWN,
  HIGHLAND_GREEN,
  PALM_RESORT,
  AUTUMN_GROVE,
  MEADOW_CLUB,
];

/** Used whenever a lookup fails; never `undefined`, so callers need no fallback. */
export const DEFAULT_THEME: Theme = MORNING_FAIRWAY;

/** Deterministic: every peer in the room sees the same theme for the same round. */
export function themeForRound(roundIndex: number): Theme {
  const count = THEMES.length;
  if (count === 0) return DEFAULT_THEME;
  const raw = Number.isFinite(roundIndex) ? Math.floor(roundIndex) : 0;
  const index = ((raw % count) + count) % count;
  const theme = THEMES[index];
  return theme === undefined ? DEFAULT_THEME : theme;
}

export function getTheme(id: ThemeId): Theme {
  for (let i = 0; i < THEMES.length; i += 1) {
    const theme = THEMES[i];
    if (theme !== undefined && theme.id === id) return theme;
  }
  return DEFAULT_THEME;
}

/** Convenience for the quality/settings UI. */
export const THEME_IDS: readonly ThemeId[] = THEMES.map((theme) => theme.id);
