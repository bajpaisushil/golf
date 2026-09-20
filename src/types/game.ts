/**
 * Game domain types: level description, shot input/output, player and room state.
 *
 * IMPORTANT: everything in this file is DATA ONLY and must be JSON-serialisable,
 * because pieces of it travel over WebRTC DataChannels verbatim (see
 * `src/multiplayer/protocol/messages.ts`). No class instances, no Map/Set, no
 * functions, no `undefined`-as-meaningful (use `null`).
 */

import type { Hex, PlayerId, PlayerMap, RoomCode, ThemeId, Timestamp, Vec2 } from './core';

// ---------------------------------------------------------------------------
// Modes & lifecycle
// ---------------------------------------------------------------------------

/**
 * 'together' - Friendship Journey: ONE shared course, rotating turns, no winner.
 * 'battle'   - Friend Battle: every player gets their OWN course, all play at once.
 */
export type GameMode = 'together' | 'battle' | 'teams';

/**
 * Which shared ball a player putts.
 *
 * 'together' is ONE group (everybody), 'teams' is one group per team. Modelling
 * both as "a ball per group" means co-op and team play share a single code path
 * instead of forking every rule.
 */
export type GroupId = string;

/** The single group used by 'together', where the whole room shares one ball. */
export const SOLO_GROUP: GroupId = 'all';

/** Team identifiers. Teams are just groups with a name and a colour. */
export type TeamId = 'A' | 'B' | 'C' | 'D';
export const TEAM_IDS: readonly TeamId[] = ['A', 'B', 'C', 'D'];

/**
 * 'lobby'          - room open, waiting for the host to start
 * 'playing'        - a round is live
 * 'round-summary'  - round finished, summary on screen
 * 'finished'       - game over (round limit reached or host ended it)
 */
export type GameStatus = 'lobby' | 'playing' | 'round-summary' | 'finished';

/** How a competitive round is ranked. Configured once in `src/game/config.ts`. */
/**
 * How a competitive round is ranked.
 *
 * 'strokes'            fewest hits wins; EQUAL HITS TIE (the default).
 * 'strokes-then-time'  fewest hits, ties broken by who holed out first.
 * 'time'               who holed out first, ties broken by hits.
 *
 * Note that 'strokes-then-time' is unfair in turn-based play: player 1 always
 * shoots before player 2, so on equal hits the earlier joiner always holes out
 * first and always wins the tie. Kept for rooms that want it, but not default.
 */
export type RankBy = 'strokes' | 'strokes-then-time' | 'time';

/**
 * One link in the tiebreak chain. Every criterion is "lower is better".
 *
 *  'strokes'      hits taken, penalties included. Always the primary.
 *  'thinkTime'    total wall-clock spent on YOUR OWN turns. The fair timing
 *                 measure: it says who played more decisively, and unlike
 *                 hole-out order it does not depend on where you sit in the
 *                 rotation.
 *  'penalties'    penalty strokes (water). Rewards the cleaner round.
 *  'holeOutOrder' who dropped first. HONEST WARNING: in turn-based play this is
 *                 really turn position — player 1 shoots before player 2 every
 *                 rotation, so on equal hits the earlier joiner always wins.
 *                 Offered for rooms that want it, never in the default chain.
 */
export type TiebreakCriterion = 'strokes' | 'thinkTime' | 'penalties' | 'holeOutOrder';

// ---------------------------------------------------------------------------
// Level geometry
// ---------------------------------------------------------------------------

/** Discriminator for {@link Obstacle}. */
export type ObstacleKind = 'wall' | 'bumper' | 'sand' | 'water' | 'boost';

/** Solid axis-aligned block. The ball bounces with PHYSICS.WALL_RESTITUTION. */
export interface WallRect {
  readonly kind: 'wall';
  readonly id: number;
  /** Top-left corner, course units. */
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** Optional per-obstacle override of PHYSICS.WALL_RESTITUTION. */
  readonly restitution?: number;
}

/** Round bumper: reflects the ball and ADDS energy (restitution > 1). */
export interface BumperCircle {
  readonly kind: 'bumper';
  readonly id: number;
  readonly cx: number;
  readonly cy: number;
  readonly r: number;
  /** Optional per-obstacle override of PHYSICS.BUMPER_RESTITUTION. */
  readonly restitution?: number;
}

/** Sand trap: not solid, multiplies friction by PHYSICS.SAND_FRICTION_MULT while the ball centre is inside. */
export interface SandRect {
  readonly kind: 'sand';
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** Optional override of PHYSICS.SAND_FRICTION_MULT. */
  readonly frictionMult?: number;
}

/** Water: entering it resets the ball to the shot origin and costs a penalty stroke. */
export interface WaterRect {
  readonly kind: 'water';
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * Boost pad: while the ball centre is inside, velocity gains `strength * dt`
 * along `dir`. `dir` MUST be a unit vector baked by the generator (no trig at runtime).
 */
export interface BoostRect {
  readonly kind: 'boost';
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** Unit vector, precomputed with sqrt only. */
  readonly dir: Vec2;
  /** Acceleration in course units per second squared. */
  readonly strength: number;
}

/** Everything that can sit on a course. Narrow on `kind`. */
export type Obstacle = WallRect | BumperCircle | SandRect | WaterRect | BoostRect;

/** Narrowing helper mirroring the discriminated union. */
export type ObstacleOfKind<K extends ObstacleKind> = Extract<Obstacle, { kind: K }>;

/** The cup. Capture requires the centre inside `radius` AND speed < PHYSICS.CAPTURE_SPEED. */
export interface Hole {
  readonly center: Vec2;
  readonly radius: number;
}

/**
 * A fully described, deterministic course. Produced by
 * `generateLevel(seed, roundIndex, variantIndex)` - NEVER transmitted over the
 * wire (peers regenerate it from the same three numbers).
 */
export interface LevelSpec {
  /** Playfield width in course units (outer walls are implicit at x=0 and x=width). */
  readonly width: number;
  /** Playfield height in course units. */
  readonly height: number;
  /** Expected stroke count for a competent player. Drives efficiency scoring. */
  readonly par: number;
  /** Ball spawn (centre of the ball). */
  readonly ballStart: Vec2;
  readonly hole: Hole;
  readonly obstacles: readonly Obstacle[];
  /** Visual theme; presentation only, never affects simulation. */
  readonly themeId: ThemeId;
  /** The exact 32-bit seed this level was generated from (room seed mixed with round + variant). */
  readonly seed: number;
}

// ---------------------------------------------------------------------------
// Shots
// ---------------------------------------------------------------------------

/**
 * One stroke. This is the ONLY gameplay payload sent over the network:
 * every peer replays it through the identical deterministic simulation.
 */
export interface ShotInput {
  readonly playerId: PlayerId;
  readonly roundIndex: number;
  /** 1-based stroke number for this player in this round (dedupe key together with roundIndex). */
  readonly strokeNumber: number;
  /** NORMALISED direction the ball travels (already the opposite of the drag). */
  readonly aim: Vec2;
  /** 0..1, clamped. Real speed = power * PHYSICS.MAX_SHOT_SPEED. */
  readonly power: number;
}

/** Why a shot ended. Presentation + audio hook. */
export type ShotEndReason = 'holed' | 'stopped' | 'timeout' | 'water-reset';

/** Sampled event along a trajectory so the renderer can trigger sfx/particles without re-simulating. */
export interface ShotEvent {
  /** Simulation time in seconds from the start of the shot. */
  readonly t: number;
  readonly kind: 'wall' | 'bumper' | 'sand-enter' | 'water' | 'boost' | 'hole';
  readonly at: Vec2;
  /** Impact speed in cu/s (0 for non-impact events). */
  readonly speed: number;
}

/**
 * The deterministic outcome of a shot. Identical on every peer given identical
 * {@link LevelSpec} + {@link ShotInput}; the host still confirms it via SHOT_RESOLVED.
 */
export interface ShotResult {
  /** Trajectory sampled every PHYSICS.PATH_SAMPLE_EVERY steps, first entry = start position. */
  readonly path: readonly Vec2[];
  /** Where the ball came to rest (or the hole centre when holed, or the reset point after water). */
  readonly restPos: Vec2;
  readonly holed: boolean;
  /** Extra strokes added by hazards (water). 0 normally. */
  readonly penaltyStrokes: number;
  /** Wall-clock length of the animation the renderer should play, derived from simulated time. */
  readonly durationMs: number;
  readonly reason: ShotEndReason;
  /** May be empty; renderers must not depend on any specific event being present. */
  readonly events: readonly ShotEvent[];
}

// ---------------------------------------------------------------------------
// Players
// ---------------------------------------------------------------------------

export interface PlayerState {
  readonly id: PlayerId;
  readonly displayName: string;
  /** Assigned from PLAYER_COLORS by join order. */
  readonly color: Hex;
  /** 0-based join order; drives turn order, colour and battle level variant. */
  readonly joinSeq: number;
  /** False while the peer is gone but still inside TIMING.RECONNECT_GRACE_MS. */
  readonly connected: boolean;
  readonly isHost: boolean;
  /** Current ball position in course units (rest position between shots). */
  readonly currentPos: Vec2;
  /** Strokes taken in the CURRENT round, including penalty strokes. */
  readonly strokes: number;
  /** True once the ball dropped in this round. */
  readonly holed: boolean;
  /** 1-based order in which this player holed out this round; null while not holed. */
  readonly holeOutOrder: number | null;
  /** Points scored in the current round (placement + efficiency). */
  readonly roundScore: number;
  /** Sum of roundScore across completed rounds. */
  readonly totalScore: number;
  /** Number of rounds this player finished 1st (battle mode only). */
  readonly roundWins: number;
  /** Variant index fed to generateLevel(). Pinned to 0 so every player shares one course. */
  readonly levelSeedVariant: number;
  /** Team play only: which team this player putts for. null in the other modes. */
  readonly teamId: TeamId | null;
  /**
   * Total milliseconds this player spent on their own turns this round.
   * Measured from the moment the turn was handed to them until their shot
   * resolved, so it reflects deliberation only — never other people's turns.
   */
  readonly thinkTimeMs: number;
  /** Penalty strokes taken this round (water). Included in `strokes`. */
  readonly penaltyStrokes: number;
}

// ---------------------------------------------------------------------------
// Round state (per mode)
// ---------------------------------------------------------------------------

/** Cooperative round: one shared level, strict turn rotation. */
export interface TogetherRoundState {
  /** 'together' = one ball for the room. 'teams' = one ball per team. */
  readonly mode: 'together' | 'teams';
  readonly roundIndex: number;
  /** Everyone plays this one course. */
  readonly level: LevelSpec;
  /**
   * A ball per GROUP, keyed by {@link GroupId}.
   *
   * Co-op and team play are both "a shared ball that a group takes turns
   * hitting", so the ball lives on the round rather than on any player. In
   * 'together' there is exactly one entry ({@link SOLO_GROUP}); in 'teams' there
   * is one per team. Per-player `strokes` record who contributed which hits.
   */
  readonly balls: Readonly<Record<GroupId, Vec2>>;
  readonly ballsHoled: Readonly<Record<GroupId, boolean>>;
  /** Join-order rotation; players who holed out or are DNF are skipped. */
  readonly turnOrder: readonly PlayerId[];
  /** Index into turnOrder of whose turn it is. */
  readonly turnCursor: number;
  /** null while a shot is animating or the round is over. */
  readonly activePlayerId: PlayerId | null;
  /** Wall-clock start (host's clock); presentation only. */
  readonly startedAt: Timestamp;
  /** Monotonic counter used to assign holeOutOrder. */
  readonly holeOutCounter: number;
  readonly completed: boolean;
}

/** Competitive round: one private level per player, everyone plays simultaneously. */
export interface BattleRoundState {
  readonly mode: 'battle';
  readonly roundIndex: number;
  /** playerId -> that player's course. Every entry is the SAME course: an equal
   *  contest is the only way stroke counts are comparable. */
  readonly levels: PlayerMap<LevelSpec>;
  /** Join-order rotation; players who holed out or are DNF are skipped. */
  readonly turnOrder: readonly PlayerId[];
  /** Index into turnOrder of whose turn it is. */
  readonly turnCursor: number;
  /** null while a shot is animating or the round is over. */
  readonly activePlayerId: PlayerId | null;
  readonly startedAt: Timestamp;
  readonly holeOutCounter: number;
  readonly completed: boolean;
}

export type RoundState = TogetherRoundState | BattleRoundState;

// ---------------------------------------------------------------------------
// Results & summaries
// ---------------------------------------------------------------------------

/** One player's outcome for one round. Produced by `rules/scoring.scoreRound`. */
export interface PlayerRoundResult {
  readonly playerId: PlayerId;
  readonly strokes: number;
  readonly par: number;
  readonly holed: boolean;
  readonly holeOutOrder: number | null;
  /** 1-based rank; DNF players share the last rank. Always 0 in 'together' mode (no ranking). */
  readonly rank: number;
  readonly placementPoints: number;
  /** Fewer strokes => more points. See SCORING.efficiency. */
  readonly efficiencyPoints: number;
  /** placementPoints + efficiencyPoints (or SCORING.dnfPoints when DNF). */
  readonly roundScore: number;
  readonly totalScore: number;
  /** True when the player hit LIMITS.MAX_STROKES without holing out. */
  readonly dnf: boolean;
}

/** Everything the round summary screen and ROUND_COMPLETED need. */
export interface RoundSummary {
  readonly roundIndex: number;
  readonly mode: GameMode;
  readonly results: readonly PlayerRoundResult[];
  /** Sum of every player's strokes this round (the co-op headline number). */
  readonly collectiveStrokes: number;
  /** Sum of every par this round, for "x under/over together". */
  readonly collectivePar: number;
  /** Co-op tier reached after this round; null in battle mode. */
  readonly friendshipTier: FriendshipTier | null;
}

/** Final standings row. */
export interface FinalStanding {
  readonly playerId: PlayerId;
  readonly displayName: string;
  readonly totalScore: number;
  readonly totalStrokes: number;
  readonly roundWins: number;
  /** 1-based; ties share a rank. 0 in 'together' mode. */
  readonly rank: number;
}

/** Why the game stopped. */
export type GameEndReason = 'rounds-complete' | 'host-ended' | 'everyone-left';

export interface GameResults {
  readonly mode: GameMode;
  readonly roundsPlayed: number;
  readonly reason: GameEndReason;
  readonly standings: readonly FinalStanding[];
  /** Co-op only: total strokes by everyone across all rounds. */
  readonly collectiveStrokes: number;
  readonly friendshipTier: FriendshipTier | null;
  readonly endedAt: Timestamp;
}

/** A co-op progression badge. Defined in `src/game/config.ts` (FRIENDSHIP_TIERS). */
export interface FriendshipTier {
  /** Round number this tier is reached at (1-based) within one cycle. */
  readonly round: number;
  readonly emoji: string;
  readonly title: string;
  /** One short encouraging line for the summary screen. */
  readonly subtitle: string;
  /**
   * How many times the tier list has wrapped. 0 on the first pass; the UI shows
   * "Stronger Together x2" for cycle 1 and so on.
   */
  readonly cycle: number;
}

// ---------------------------------------------------------------------------
// Settings & room state
// ---------------------------------------------------------------------------

/** Host-owned, broadcast with SETTINGS_CHANGED. Changing these mid-round is rejected. */
export interface GameSettings {
  /** Team play only: how many teams the room splits into (2-4). */
  readonly teamCount?: number;
  /** null = endless (the co-op default). */
  readonly totalRounds: number | null;
  /** Strokes after which a player is DNF for the round. */
  readonly maxStrokes: number;
  readonly rankBy: RankBy;
  /** 0..1 extra difficulty on top of the round ramp; 0 = default curve. */
  readonly difficultyBias: number;
  /** Whether players may still join after the first round started. */
  readonly allowLateJoin: boolean;
}

/** The whole room, mirrored on every peer. The host's copy is authoritative. */
export interface GameState {
  readonly roomCode: RoomCode;
  readonly mode: GameMode;
  readonly hostPlayerId: PlayerId;
  readonly players: PlayerMap<PlayerState>;
  /** Join order; the canonical iteration order for UI and turn rotation. */
  readonly playerOrder: readonly PlayerId[];
  /** 0-based index of the live (or just finished) round. -1 while in the lobby. */
  readonly currentRoundIndex: number;
  /** Mirror of settings.totalRounds; null = endless. */
  readonly totalRounds: number | null;
  readonly roundState: RoundState | null;
  readonly status: GameStatus;
  /** 32-bit unsigned room seed; every level derives from it. Chosen once by the host. */
  readonly roomSeed: number;
  readonly settings: GameSettings;
  /** Bumped by the host on every authoritative mutation; used to reject stale STATE_SYNC. */
  readonly stateVersion: number;
  /** Set when status === 'finished'. */
  readonly results: GameResults | null;
}

// ---------------------------------------------------------------------------
// Wire-friendly snapshots
// ---------------------------------------------------------------------------

/**
 * Which level variant a player plays this round. Peers call
 * generateLevel(roomSeed, roundIndex, variantIndex) to rebuild the course, so
 * full LevelSpecs never travel over the network.
 */
export interface PlayerVariant {
  readonly playerId: PlayerId;
  readonly variantIndex: number;
  /**
   * Team play only. Carried in ROUND_STARTED so every peer agrees on the teams
   * without a second message — the host decides once, everyone rebuilds it.
   */
  readonly teamId?: TeamId | null;
}

/** Array-shaped, JSON-safe version of {@link RoundState} for WELCOME / STATE_SYNC. */
export interface RoundSnapshot {
  readonly mode: GameMode;
  readonly roundIndex: number;
  readonly startedAt: Timestamp;
  readonly turnOrder: readonly PlayerId[];
  readonly turnCursor: number;
  readonly activePlayerId: PlayerId | null;
  readonly variants: readonly PlayerVariant[];
  readonly holeOutCounter: number;
  readonly completed: boolean;
  /** Shared-ball modes: each group's ball. Omitted means "still on the tee". */
  readonly balls?: Readonly<Record<GroupId, Vec2>>;
  readonly ballsHoled?: Readonly<Record<GroupId, boolean>>;
}

/** Array-shaped, JSON-safe version of {@link GameState}. Sent in WELCOME and STATE_SYNC. */
export interface GameSnapshot {
  readonly roomCode: RoomCode;
  readonly mode: GameMode;
  readonly hostPlayerId: PlayerId;
  readonly status: GameStatus;
  readonly roomSeed: number;
  readonly currentRoundIndex: number;
  readonly totalRounds: number | null;
  readonly settings: GameSettings;
  /** Ordered by joinSeq ascending. */
  readonly players: readonly PlayerState[];
  readonly round: RoundSnapshot | null;
  readonly stateVersion: number;
  readonly results: GameResults | null;
}
