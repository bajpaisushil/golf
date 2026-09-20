/**
 * EVERY tunable in the game lives here. Nothing else hard-codes a number.
 *
 * Determinism note: these values are baked into the simulation, so changing any
 * PHYSICS or LEVEL value changes shot outcomes. Bump PROTOCOL_VERSION whenever
 * you touch them, otherwise two peers on different builds will desync.
 */

import type { GameSettings, RankBy, TiebreakCriterion } from '@/types';
import type { Hex, QualityTier } from '@/types';

// ---------------------------------------------------------------------------
// PHYSICS - deterministic simulation constants (course units "cu", seconds)
// ---------------------------------------------------------------------------

export interface PhysicsConfig {
  /** Fixed simulation step. 1/120 s: small enough that a fast ball cannot tunnel a 2cu wall. */
  readonly DT: number;
  /** Linear damping per second on fairway: v *= (1 - FRICTION * DT) each step. */
  readonly FRICTION: number;
  /** Energy kept when bouncing off a wall (0..1). */
  readonly WALL_RESTITUTION: number;
  /** Energy multiplier off a bumper. > 1 means the bumper ADDS energy. */
  readonly BUMPER_RESTITUTION: number;
  /** FRICTION is multiplied by this while the ball centre is inside sand. */
  readonly SAND_FRICTION_MULT: number;
  /** Below this speed (cu/s) the ball is considered at rest and the shot ends. */
  readonly STOP_SPEED: number;
  /** Max speed (cu/s) at which the hole can capture the ball; faster balls lip out. */
  readonly CAPTURE_SPEED: number;
  /** Hard cap on simulated time for one shot; prevents infinite bumper loops. */
  readonly MAX_SIM_SECONDS: number;
  /** Speed (cu/s) at power === 1. */
  readonly MAX_SHOT_SPEED: number;
  /** Drag length in course units that maps to power 1. Longer drags clamp. */
  readonly MAX_DRAG_CU: number;
  /** Ball collision radius in course units. */
  readonly BALL_RADIUS: number;
  /** Store one trajectory sample every N steps. 2 @ DT=1/120 gives a 60Hz path. */
  readonly PATH_SAMPLE_EVERY: number;
  /** Safety cap on path length (MAX_SIM_SECONDS / DT / PATH_SAMPLE_EVERY, rounded up). */
  readonly MAX_PATH_SAMPLES: number;
  /** Strokes added when the ball enters water. */
  readonly WATER_PENALTY_STROKES: number;
  /** Drags shorter than this fraction of MAX_DRAG_CU cancel the shot instead of firing. */
  readonly MIN_POWER: number;
}

export const PHYSICS: PhysicsConfig = {
  DT: 1 / 120,
  FRICTION: 1.15,
  WALL_RESTITUTION: 0.78,
  BUMPER_RESTITUTION: 1.15,
  SAND_FRICTION_MULT: 3.6,
  STOP_SPEED: 1.1,
  CAPTURE_SPEED: 26,
  MAX_SIM_SECONDS: 12,
  MAX_SHOT_SPEED: 120,
  MAX_DRAG_CU: 26,
  BALL_RADIUS: 1.1,
  PATH_SAMPLE_EVERY: 2,
  MAX_PATH_SAMPLES: 768,
  WATER_PENALTY_STROKES: 1,
  MIN_POWER: 0.05,
};

// ---------------------------------------------------------------------------
// LEVEL - deterministic generator constants
// ---------------------------------------------------------------------------

export interface LevelConfig {
  /** Course width in cu. Portrait on purpose: it fits a phone screen without panning. */
  readonly DEFAULT_WIDTH: number;
  /** Course height in cu. */
  readonly DEFAULT_HEIGHT: number;
  /** Cup radius. Must stay > BALL_RADIUS or the ball can never drop. */
  readonly HOLE_RADIUS: number;
  /** Obstacle count at roundIndex 0. */
  readonly MIN_OBSTACLES: number;
  /** Absolute ceiling on obstacles regardless of round. */
  readonly MAX_OBSTACLES: number;
  /** Extra obstacles per round: count = MIN_OBSTACLES + floor(roundIndex * DIFFICULTY_RAMP). */
  readonly DIFFICULTY_RAMP: number;
  /** Inset from the outer walls that obstacles may not cross. */
  readonly WALL_MARGIN: number;
  /** No obstacle may overlap a circle of this radius around the ball start. */
  readonly SPAWN_CLEAR_RADIUS: number;
  /** No obstacle may overlap a circle of this radius around the hole. */
  readonly HOLE_CLEAR_RADIUS: number;
  /** Minimum start-to-hole distance, so a round is never a tap-in. */
  readonly MIN_START_HOLE_DIST: number;
  /** Clamp range for the generated par. */
  readonly PAR_MIN: number;
  readonly PAR_MAX: number;
  /** Rejection-sampling budget per obstacle before the generator gives up on it. */
  readonly MAX_GEN_ATTEMPTS: number;
  /** Fraction of obstacles that may be hazards (water/sand) rather than walls/bumpers. */
  readonly HAZARD_SHARE: number;
}

export const LEVEL: LevelConfig = {
  DEFAULT_WIDTH: 64,
  DEFAULT_HEIGHT: 96,
  HOLE_RADIUS: 2.2,
  MIN_OBSTACLES: 3,
  MAX_OBSTACLES: 14,
  DIFFICULTY_RAMP: 0.75,
  WALL_MARGIN: 2,
  SPAWN_CLEAR_RADIUS: 7,
  HOLE_CLEAR_RADIUS: 5,
  MIN_START_HOLE_DIST: 42,
  PAR_MIN: 2,
  PAR_MAX: 6,
  MAX_GEN_ATTEMPTS: 24,
  HAZARD_SHARE: 0.4,
};

// ---------------------------------------------------------------------------
// LIMITS
// ---------------------------------------------------------------------------

export interface LimitsConfig {
  /** A room needs two humans to start. */
  readonly MIN_PLAYERS: number;
  /** Full mesh is O(n^2) connections; 8 is the comfortable ceiling for WebRTC. */
  readonly MAX_PLAYERS: number;
  /** Strokes after which a player is DNF for the round. */
  readonly MAX_STROKES: number;
  readonly ROOM_CODE_LENGTH: number;
  readonly MAX_NAME_LENGTH: number;
  /** Highest custom round count the host may pick. */
  readonly MAX_ROUNDS: number;
  /** Reject any DataChannel frame larger than this (defensive). */
  readonly MAX_MESSAGE_BYTES: number;
}

export const LIMITS: LimitsConfig = {
  MIN_PLAYERS: 2,
  MAX_PLAYERS: 8,
  MAX_STROKES: 10,
  ROOM_CODE_LENGTH: 6,
  MAX_NAME_LENGTH: 14,
  MAX_ROUNDS: 99,
  MAX_MESSAGE_BYTES: 16384,
};

/** Room codes use an unambiguous alphabet (no O/0, I/1) so they can be read aloud. */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// ---------------------------------------------------------------------------
// TIMING - wall-clock only, never simulation
// ---------------------------------------------------------------------------

export interface TimingConfig {
  /** How often every peer broadcasts HEARTBEAT. */
  readonly HEARTBEAT_MS: number;
  /** Silence from the host for this long starts a host election. */
  readonly HOST_TIMEOUT_MS: number;
  /** ICE/DataChannel must be up within this or the link is 'failed'. */
  readonly CONNECT_TIMEOUT_MS: number;
  /** A dropped player keeps their slot (and score) for this long. */
  readonly RECONNECT_GRACE_MS: number;
  /** PING cadence for the latency pill. */
  readonly PING_INTERVAL_MS: number;
  /** How often we re-announce ourselves on the signaling plane while connecting. */
  readonly SIGNALING_ANNOUNCE_MS: number;
  /** Signaling envelopes older than this are discarded (replay protection). */
  readonly SIGNALING_TTL_MS: number;
  /** Host STATE_SYNC cadence while a round is live. */
  readonly STATE_SYNC_MS: number;
  /** Minimum time the round summary stays on screen. */
  readonly ROUND_SUMMARY_MIN_MS: number;
  /** 'together' mode: a player who does not shoot within this is skipped. */
  readonly TURN_TIMEOUT_MS: number;
  /** Debounce for host-side rate limiting of REQUEST_STATE replies. */
  readonly STATE_REPLY_COOLDOWN_MS: number;
}

export const TIMING: TimingConfig = {
  HEARTBEAT_MS: 2000,
  HOST_TIMEOUT_MS: 6000,
  CONNECT_TIMEOUT_MS: 15000,
  RECONNECT_GRACE_MS: 30000,
  PING_INTERVAL_MS: 5000,
  SIGNALING_ANNOUNCE_MS: 4000,
  SIGNALING_TTL_MS: 120000,
  STATE_SYNC_MS: 5000,
  ROUND_SUMMARY_MIN_MS: 2500,
  TURN_TIMEOUT_MS: 45000,
  STATE_REPLY_COOLDOWN_MS: 1000,
};

// ---------------------------------------------------------------------------
// SCORING - "fewer hits => higher score" lives HERE and nowhere else
// ---------------------------------------------------------------------------

export interface EfficiencyConfig {
  /** Turn hit-efficiency scoring off to score on placement alone. */
  readonly enabled: boolean;
  /** Points for finishing exactly on par. */
  readonly base: number;
  /** Points lost per stroke ABOVE par. */
  readonly perStrokeOverPar: number;
  /** Floor: no matter how many strokes, a holed-out player keeps at least this. */
  readonly min: number;
  /** Extra points per stroke UNDER par. */
  readonly underParBonus: number;
}

export interface ScoringConfig {
  /** Points by finishing position, index 0 = 1st place. Used for 3+ players. */
  readonly placementPoints: readonly number[];
  /** Flatter table for head-to-head rooms, so one bad round is recoverable. */
  readonly placementPointsTwoPlayer: readonly number[];
  readonly efficiency: EfficiencyConfig;
  /**
   * 'strokes-then-time' - fewest strokes wins, holeOutOrder breaks ties (default).
   * 'time'             - pure race: first to hole out wins regardless of strokes.
   */
  readonly rankBy: RankBy;
  readonly tiebreakers: readonly TiebreakCriterion[];
  /** Awarded to a player who hit MAX_STROKES without holing out. */
  readonly dnfPoints: number;
}

/**
 * THE SCORING RULE (user requirement: fewer hits = more score).
 *
 *   roundScore = placementPointsFor(rank, playerCount) + efficiencyPointsFor(strokes, par)
 *
 * efficiencyPointsFor is monotonically NON-INCREASING in `strokes`:
 *   strokes < par : base + (par - strokes) * underParBonus     (best)
 *   strokes = par : base
 *   strokes > par : max(min, base - (strokes - par) * perStrokeOverPar)
 *
 * With the defaults below and par 3: 2 hits = 13, 3 hits = 10, 4 = 8, 5 = 6,
 * 6 = 4, 7 = 2, 8+ = 1 (floor). Two players on the same floor are then separated
 * by placement points, so taking fewer hits is ALWAYS at least as good and
 * usually strictly better. Change these six numbers to retune the whole game.
 */
export const SCORING: ScoringConfig = {
  placementPoints: [3, 2, 1],
  placementPointsTwoPlayer: [2, 1],
  efficiency: {
    enabled: true,
    base: 10,
    perStrokeOverPar: 2,
    min: 1,
    underParBonus: 3,
  },
  // Equal hits tie. Anything that falls back to hole-out order hands the player
  // who shoots first a permanent advantage now that battle is turn-based.
  rankBy: 'strokes',
  /**
   * Tiebreak chain, applied in order, each one "lower is better".
   *
   * Hits decide it first. Equal hits fall to THINK TIME — wall-clock spent on
   * your own turns — which rewards playing decisively and, unlike hole-out
   * order, does not depend on whether you shoot first in the rotation. Fewest
   * penalties settles anything still level. Players equal on all three are
   * genuinely tied and share the placement points.
   *
   * Reorder or shorten this to taste; an empty array means "hits only, then tie".
   */
  tiebreakers: ['strokes', 'thinkTime', 'penalties'],
  dnfPoints: 0,
};

/**
 * Placement points for a 1-based rank. Ranks past the table score 0.
 * Rooms of 2 use the flatter two-player table.
 */
export function placementPointsFor(rank: number, playerCount: number): number {
  if (!Number.isFinite(rank) || rank < 1) return 0;
  const table = playerCount <= 2 ? SCORING.placementPointsTwoPlayer : SCORING.placementPoints;
  const points = table[Math.floor(rank) - 1];
  return points === undefined ? 0 : points;
}

/**
 * Hit-efficiency points. Fewer strokes => more points, always.
 * `strokes` must INCLUDE penalty strokes. Returns 0 when efficiency is disabled.
 */
export function efficiencyPointsFor(strokes: number, par: number): number {
  const cfg = SCORING.efficiency;
  if (!cfg.enabled) return 0;
  const s = Math.max(1, Math.floor(Number.isFinite(strokes) ? strokes : 1));
  const p = Math.max(1, Math.floor(Number.isFinite(par) ? par : 1));
  const over = s - p;
  if (over <= 0) return cfg.base + -over * cfg.underParBonus;
  return Math.max(cfg.min, cfg.base - over * cfg.perStrokeOverPar);
}

// ---------------------------------------------------------------------------
// FRIENDSHIP_TIERS - co-op progression (no winners, only milestones)
// ---------------------------------------------------------------------------

export interface FriendshipTierSpec {
  /** 1-based round at which this tier is reached. */
  readonly round: number;
  readonly emoji: string;
  readonly title: string;
  readonly subtitle: string;
}

/**
 * Tiers 1-10 are explicit. For round R > 10 the list CYCLES over the tail:
 *
 *   index = FRIENDSHIP_CYCLE_FROM + ((R - 1 - FRIENDSHIP_CYCLE_FROM) mod (10 - FRIENDSHIP_CYCLE_FROM))
 *   cycle = 1 + floor((R - 1 - FRIENDSHIP_CYCLE_FROM) / (10 - FRIENDSHIP_CYCLE_FROM))
 *
 * so rounds 11+ replay tiers 6-10 with a rising `cycle`, shown as "Unbreakable x2".
 * `rules/friendship.friendshipTierFor()` implements exactly this.
 */
export const FRIENDSHIP_TIERS: readonly FriendshipTierSpec[] = [
  { round: 1, emoji: '\u{1F331}', title: 'Starting Together', subtitle: 'Every journey begins with one putt.' },
  { round: 2, emoji: '\u{1F33F}', title: 'Growing Together', subtitle: 'You are finding your rhythm.' },
  { round: 3, emoji: '\u{1F333}', title: 'Stronger Together', subtitle: 'Roots down, spirits up.' },
  { round: 4, emoji: '\u{1F338}', title: 'Great Teamwork', subtitle: 'That was genuinely lovely to watch.' },
  { round: 5, emoji: '✨', title: 'Friendship Level Up', subtitle: 'Something special is happening here.' },
  { round: 6, emoji: '\u{1F31F}', title: 'In Perfect Sync', subtitle: 'You barely need to talk any more.' },
  { round: 7, emoji: '\u{1F30A}', title: 'Unstoppable Flow', subtitle: 'One after another, effortlessly.' },
  { round: 8, emoji: '\u{1F525}', title: 'Legendary Duo Energy', subtitle: 'The course is not ready for you.' },
  { round: 9, emoji: '\u{1F48E}', title: 'Rare and Precious', subtitle: 'Friendships like this do not just happen.' },
  { round: 10, emoji: '\u{1F451}', title: 'Unbreakable', subtitle: 'Ten rounds deep and still laughing.' },
];

/** Zero-based index into FRIENDSHIP_TIERS where the repeating tail starts (tier 6). */
export const FRIENDSHIP_CYCLE_FROM = 5;

// ---------------------------------------------------------------------------
// PLAYER_COLORS - 8 colour-blind-safe ball colours (Okabe-Ito derived)
// ---------------------------------------------------------------------------

export interface PlayerColorSpec {
  readonly hex: Hex;
  readonly name: string;
}

/**
 * Assigned by joinSeq. These hues stay distinguishable under protanopia,
 * deuteranopia and tritanopia, and all read clearly against the deep desaturated
 * teal/charcoal course felt the palette module must use (never bright green).
 */
export const PLAYER_COLORS: readonly PlayerColorSpec[] = [
  { hex: '#E69F00', name: 'Amber' },
  { hex: '#56B4E9', name: 'Sky' },
  { hex: '#009E73', name: 'Jade' },
  { hex: '#F0E442', name: 'Lemon' },
  { hex: '#0072B2', name: 'Cobalt' },
  { hex: '#D55E00', name: 'Ember' },
  { hex: '#CC79A7', name: 'Orchid' },
  { hex: '#F2F4F8', name: 'Snow' },
];

/** Colour for a join order, wrapping if it somehow exceeds MAX_PLAYERS. */
export function playerColorFor(joinSeq: number): Hex {
  const index = ((Math.floor(joinSeq) % PLAYER_COLORS.length) + PLAYER_COLORS.length) % PLAYER_COLORS.length;
  const spec = PLAYER_COLORS[index];
  return spec === undefined ? '#F2F4F8' : spec.hex;
}

/** Curated reactions; EMOTE messages carrying anything else are ignored. */
export const EMOTES: readonly string[] = ['\u{1F44D}', '\u{1F602}', '\u{1F62E}', '\u{1F525}', '\u{1F49A}', '\u{1F3AF}'];

// ---------------------------------------------------------------------------
// QUALITY - rendering defaults per tier (presentation only)
// ---------------------------------------------------------------------------

export interface QualityProfile {
  readonly tier: QualityTier;
  /** Hard cap on renderer pixel ratio. */
  readonly maxDpr: number;
  readonly antialias: boolean;
  readonly shadows: boolean;
  /** Radial segments for procedural circles/spheres. */
  readonly circleSegments: number;
  /** Points kept in the ball trail ribbon. */
  readonly trailPoints: number;
  readonly particles: boolean;
  /** Any screen-space effect (vignette/bloom). Off below 'high'. */
  readonly postFx: boolean;
  /** Decorative instanced scenery around the course. */
  readonly decor: boolean;
  readonly targetFps: number;
}

export const QUALITY: Readonly<Record<QualityTier, QualityProfile>> = {
  high: {
    tier: 'high',
    maxDpr: 2,
    antialias: true,
    shadows: true,
    circleSegments: 48,
    trailPoints: 48,
    particles: true,
    postFx: true,
    decor: true,
    targetFps: 60,
  },
  medium: {
    tier: 'medium',
    maxDpr: 1.5,
    antialias: true,
    shadows: false,
    circleSegments: 28,
    trailPoints: 28,
    particles: true,
    postFx: false,
    decor: true,
    targetFps: 60,
  },
  low: {
    tier: 'low',
    maxDpr: 1,
    antialias: false,
    shadows: false,
    circleSegments: 16,
    trailPoints: 12,
    particles: false,
    postFx: false,
    decor: false,
    targetFps: 30,
  },
};

/** Used before device probing finishes, and whenever probing is inconclusive. */
export const DEFAULT_QUALITY_TIER: QualityTier = 'medium';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Round counts offered in the host UI. `null` = endless (co-op default). */
export const ROUND_OPTIONS: readonly number[] = [3, 5, 10];

/** Slider midpoint: a little damping, still crisp. 0 = rigid, 1 = volatile. */
export const DEFAULT_BALL_SMOOTHING = 0.32;

export const DEFAULT_SETTINGS: GameSettings = {
  totalRounds: null,
  maxStrokes: LIMITS.MAX_STROKES,
  rankBy: SCORING.rankBy,
  difficultyBias: 0,
  allowLateJoin: true,
  ballSmoothing: DEFAULT_BALL_SMOOTHING,
};

/** Battle rooms default to 5 rounds; co-op rooms stay endless. */
export const DEFAULT_BATTLE_ROUNDS = 5;

/**
 * The ONLY browser-storage keys in the app.
 * `fg.identity` is sessionStorage (reconnect identity), `fg.prefs` is
 * localStorage (sound + quality tier). Nothing else may be stored, ever.
 */
export const STORAGE_KEYS = {
  identity: 'fg.identity',
  /** localStorage resume hint so a closed tab can rejoin. Carries an expiry. */
  resume: 'fg.resume',
  prefs: 'fg.prefs',
} as const;
