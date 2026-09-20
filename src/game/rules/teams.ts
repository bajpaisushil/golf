/**
 * Team play.
 *
 * A team is just a GROUP that shares one ball: inside a team you cooperate
 * exactly like Play Together (take turns nudging the same ball toward the hole),
 * while the teams race each other on the same course. That is why this module is
 * small — it maps players to groups and totals them up, and the existing
 * shared-ball machinery does the rest.
 *
 * Every function here is pure and takes state explicitly, so the rules stay
 * testable without React or a network.
 */
import { SOLO_GROUP, TEAM_IDS } from '@/types';
import type { GameMode, GameState, GroupId, PlayerId, PlayerState, TeamId } from '@/types';
import { playersInJoinOrder } from './competitive';

/** Display metadata. Colours are distinct from the per-player ball colours. */
export interface TeamMeta {
  readonly id: TeamId;
  readonly name: string;
  readonly color: string;
}

export const TEAM_META: Readonly<Record<TeamId, TeamMeta>> = {
  A: { id: 'A', name: 'Green', color: '#4CAF63' },
  B: { id: 'B', name: 'Blue', color: '#3E8FD6' },
  C: { id: 'C', name: 'Amber', color: '#E8A33D' },
  D: { id: 'D', name: 'Rose', color: '#DD5D7A' },
};

/** Default number of teams a fresh room plays with. */
export const DEFAULT_TEAM_COUNT = 2;

/**
 * Which ball this player putts.
 *
 * 'together' collapses everybody onto one group, which is what makes co-op and
 * team play one code path instead of two.
 */
export function groupIdFor(player: PlayerState | null, mode: GameMode): GroupId {
  if (mode !== 'teams') return SOLO_GROUP;
  return player?.teamId ?? TEAM_IDS[0]!;
}

/** The groups that have a ball this round, in stable order. */
export function groupsOf(state: GameState): readonly GroupId[] {
  if (state.mode !== 'teams') return [SOLO_GROUP];
  const seen = new Set<GroupId>();
  const out: GroupId[] = [];
  for (const id of TEAM_IDS) {
    for (const player of playersInJoinOrder(state)) {
      if (player.teamId === id && !seen.has(id)) {
        seen.add(id);
        out.push(id);
        break;
      }
    }
  }
  return out.length > 0 ? out : [TEAM_IDS[0]!];
}

/** Everyone putting for a group, in join order. */
export function playersInGroup(state: GameState, group: GroupId): readonly PlayerState[] {
  return playersInJoinOrder(state).filter((player) => groupIdFor(player, state.mode) === group);
}

/** A team's hit count for the current round: the sum of its members' hits. */
export function groupStrokes(state: GameState, group: GroupId): number {
  return playersInGroup(state, group).reduce((sum, p) => sum + Math.max(0, p.strokes), 0);
}

/** True once this group's ball is in the cup. */
export function groupHoled(state: GameState, group: GroupId): boolean {
  const round = state.roundState;
  if (round === null || round.mode === 'battle') return false;
  return round.ballsHoled[group] === true;
}

export interface TeamStanding {
  readonly group: GroupId;
  readonly meta: TeamMeta | null;
  readonly strokes: number;
  readonly holed: boolean;
  readonly players: readonly PlayerState[];
  /** 1-based; ties share a rank. */
  readonly rank: number;
}

/**
 * Teams ranked for the round: holed teams first, then fewest hits.
 *
 * A team that has not holed out cannot outrank one that has, however few hits it
 * has taken — otherwise a team could "win" by simply not finishing.
 */
export function teamStandings(state: GameState): readonly TeamStanding[] {
  const rows = groupsOf(state).map((group) => ({
    group,
    meta: TEAM_META[group as TeamId] ?? null,
    strokes: groupStrokes(state, group),
    holed: groupHoled(state, group),
    players: playersInGroup(state, group),
  }));

  const sorted = rows.slice().sort((a, b) => {
    if (a.holed !== b.holed) return a.holed ? -1 : 1;
    if (a.strokes !== b.strokes) return a.strokes - b.strokes;
    return a.group < b.group ? -1 : a.group > b.group ? 1 : 0;
  });

  const out: TeamStanding[] = [];
  let rank = 0;
  let previous: { holed: boolean; strokes: number } | null = null;
  sorted.forEach((row, index) => {
    const ties = previous !== null && previous.holed === row.holed && previous.strokes === row.strokes;
    if (!ties) rank = index + 1;
    previous = { holed: row.holed, strokes: row.strokes };
    out.push({ ...row, rank });
  });
  return out;
}

/**
 * Even teams, assigned by join order.
 *
 * Round-robin rather than "first half / second half" so that friends who join
 * together are split up instead of stacking one team.
 */
export function autoAssignTeams(
  players: readonly PlayerState[],
  teamCount: number,
): Readonly<Record<PlayerId, TeamId>> {
  const count = Math.max(2, Math.min(TEAM_IDS.length, Math.floor(teamCount) || DEFAULT_TEAM_COUNT));
  const out: Record<PlayerId, TeamId> = {};
  players.forEach((player, index) => {
    out[player.id] = TEAM_IDS[index % count] ?? TEAM_IDS[0]!;
  });
  return out;
}

/** True when every team has at least one player — required before starting. */
export function teamsAreViable(state: GameState, teamCount: number): boolean {
  if (state.mode !== 'teams') return true;
  const count = Math.max(2, Math.min(TEAM_IDS.length, Math.floor(teamCount) || DEFAULT_TEAM_COUNT));
  for (let i = 0; i < count; i += 1) {
    const id = TEAM_IDS[i];
    if (id === undefined) continue;
    if (playersInGroup(state, id).length === 0) return false;
  }
  return true;
}


/**
 * Turn order that alternates between teams: A1, B1, A2, B2, …
 *
 * Playing one team's whole roster before the other's would feel like two
 * separate games spliced together; alternating keeps both sides watching.
 * Uneven teams simply run out and are skipped.
 */
export function interleaveByTeam(
  players: readonly PlayerState[],
  assigned: Readonly<Record<PlayerId, TeamId>>,
): readonly PlayerId[] {
  const lanes = new Map<TeamId, PlayerId[]>();
  for (const player of players) {
    const team = player.teamId ?? assigned[player.id] ?? TEAM_IDS[0]!;
    const lane = lanes.get(team);
    if (lane === undefined) lanes.set(team, [player.id]);
    else lane.push(player.id);
  }

  const ordered = TEAM_IDS.map((id) => lanes.get(id)).filter(
    (lane): lane is PlayerId[] => lane !== undefined && lane.length > 0,
  );
  const longest = ordered.reduce((max, lane) => Math.max(max, lane.length), 0);

  const out: PlayerId[] = [];
  for (let i = 0; i < longest; i += 1) {
    for (const lane of ordered) {
      const id = lane[i];
      if (id !== undefined) out.push(id);
    }
  }
  return out.length > 0 ? out : players.map((player) => player.id);
}
