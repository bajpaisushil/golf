/**
 * Human-facing string formatting.
 *
 * Two vocabularies live here on purpose:
 *
 *   - Friend Battle talks about **hits** ("4 hits") — it is a scored game and
 *     the whole scoring rule is "fewer hits, more points".
 *   - The Friendship Journey talks about **steps** ("4 steps") — same number,
 *     softer framing, because that mode has no winner and no ranking.
 *
 * Pure functions, no `Intl` (its output differs per locale and would make the
 * shared result text look different for each player), no `window`, no state.
 */

import { LIMITS } from '@/game/config';

// ---------------------------------------------------------------------------
// Numbers & plurals
// ---------------------------------------------------------------------------

/** Coerces anything to a safe non-negative integer. */
function safeCount(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

/**
 * `pluralise(1, 'hit')` → "1 hit", `pluralise(4, 'hit')` → "4 hits".
 * Pass `plural` for irregular words ("1 try" / "3 tries").
 */
export function pluralise(count: number, singular: string, plural?: string): string {
  const value = Number.isFinite(count) ? Math.floor(count) : 0;
  return `${value} ${pluralWord(value, singular, plural)}`;
}

/** Just the word, without the number. */
export function pluralWord(count: number, singular: string, plural?: string): string {
  return Math.abs(count) === 1 ? singular : (plural ?? `${singular}s`);
}

/**
 * English ordinal: 1st, 2nd, 3rd, 4th … 11th, 12th, 13th, 21st.
 * Values below 1 or non-finite come back as "—" so a rank of 0 (co-op, where
 * ranking is deliberately absent) never renders as "0th".
 */
export function ordinal(n: number): string {
  if (!Number.isFinite(n) || n < 1) return '—';
  const value = Math.floor(n);
  const lastTwo = value % 100;
  if (lastTwo >= 11 && lastTwo <= 13) return `${value}th`;
  switch (value % 10) {
    case 1:
      return `${value}st`;
    case 2:
      return `${value}nd`;
    case 3:
      return `${value}rd`;
    default:
      return `${value}th`;
  }
}

// ---------------------------------------------------------------------------
// Golf vocabulary
// ---------------------------------------------------------------------------

/** Competitive wording: "1 hit" / "4 hits". Includes penalty strokes. */
export function strokeLabel(n: number): string {
  return pluralise(safeCount(n), 'hit');
}

/** Cooperative wording: "1 step" / "4 steps". Same number, gentler frame. */
export function stepLabel(n: number): string {
  return pluralise(safeCount(n), 'step');
}

/** "3 points" / "1 point". */
export function pointsLabel(n: number): string {
  return pluralise(safeCount(n), 'point');
}

/** "Round 3" / "Round 3 of 5". */
export function roundLabel(roundIndex: number, totalRounds: number | null): string {
  const round = safeCount(roundIndex) + 1;
  return totalRounds === null || !Number.isFinite(totalRounds)
    ? `Round ${round}`
    : `Round ${round} of ${Math.max(round, Math.floor(totalRounds))}`;
}

/**
 * Score relative to par: "-1", "E", "+2". Used on the HUD and the scoreboard,
 * where the sign is the whole point — so "E" (level par) is spelled out rather
 * than shown as "0".
 */
export function relativeToPar(strokes: number, par: number): string {
  const s = safeCount(strokes);
  const p = safeCount(par);
  const delta = s - p;
  if (delta === 0) return 'E';
  return delta > 0 ? `+${delta}` : `${delta}`;
}

/** Long form of {@link relativeToPar}: "1 under par", "level par", "2 over par". */
export function relativeToParWords(strokes: number, par: number): string {
  const delta = safeCount(strokes) - safeCount(par);
  if (delta === 0) return 'level par';
  const magnitude = Math.abs(delta);
  return `${magnitude} ${delta > 0 ? 'over' : 'under'} par`;
}

/**
 * Classic golf names for a single hole, used only as a flourish on the round
 * summary. Anything worse than triple bogey just reports the number.
 */
export function shotNameFor(strokes: number, par: number): string {
  const s = safeCount(strokes);
  if (s === 1) return 'Hole in one';
  const delta = s - safeCount(par);
  if (delta <= -3) return 'Albatross';
  if (delta === -2) return 'Eagle';
  if (delta === -1) return 'Birdie';
  if (delta === 0) return 'Par';
  if (delta === 1) return 'Bogey';
  if (delta === 2) return 'Double bogey';
  if (delta === 3) return 'Triple bogey';
  return strokeLabel(s);
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/**
 * Makes a typed nickname safe to store and to send: strips control characters,
 * collapses runs of whitespace, removes leading whitespace and caps the length
 * at `LIMITS.MAX_NAME_LENGTH`.
 *
 * It deliberately does NOT trim the trailing space — this runs on every
 * keystroke of the name field, and trimming the end would make it impossible to
 * type a space between two words.
 */
export function clampName(name: string): string {
  if (typeof name !== 'string') return '';
  let cleaned = '';
  let lastWasSpace = true; // true so leading whitespace is dropped
  for (const char of name) {
    const code = char.codePointAt(0);
    if (code === undefined) continue;
    // Drop C0/C1 control characters and the bidi/zero-width troublemakers.
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) continue;
    if (code === 0x200b || code === 0x200c || code === 0x200d || code === 0xfeff) continue;
    if (code >= 0x202a && code <= 0x202e) continue;
    if (code >= 0x2066 && code <= 0x2069) continue;

    const isSpace = char === ' ' || char === ' ' || char === '\t';
    if (isSpace) {
      if (lastWasSpace) continue;
      cleaned += ' ';
      lastWasSpace = true;
      continue;
    }
    cleaned += char;
    lastWasSpace = false;
  }
  return cleaned.slice(0, LIMITS.MAX_NAME_LENGTH);
}

/**
 * The committed form of a name: {@link clampName} plus a trailing trim and a
 * fallback for players who cleared the field entirely. Call this when the name
 * leaves the input (on submit / on blur), not on every keystroke.
 */
export function finaliseName(name: string, fallback = 'Player'): string {
  const cleaned = clampName(name).trim();
  return cleaned.length > 0 ? cleaned : fallback;
}

/**
 * Shortens a name for tight UI (a chip, a leaderboard row) with a real ellipsis.
 * `max` counts characters INCLUDING the ellipsis.
 */
export function truncateName(name: string, max = LIMITS.MAX_NAME_LENGTH): string {
  if (typeof name !== 'string') return '';
  const limit = Math.max(1, Math.floor(max));
  const chars = Array.from(name);
  if (chars.length <= limit) return name;
  return `${chars.slice(0, Math.max(1, limit - 1)).join('')}…`;
}

/** First grapheme-ish character, uppercased — the fallback avatar glyph. */
export function initialOf(name: string): string {
  const chars = Array.from(typeof name === 'string' ? name.trim() : '');
  const first = chars[0];
  return first === undefined ? '?' : first.toUpperCase();
}

/**
 * Joins names the way a person would: "Ada", "Ada and Bo", "Ada, Bo and Cy".
 * Used by the cooperative share text, which never ranks anybody.
 */
export function joinNames(names: readonly string[], conjunction = 'and'): string {
  const list = names.filter((n) => typeof n === 'string' && n.length > 0);
  if (list.length === 0) return '';
  if (list.length === 1) return list[0] ?? '';
  const last = list[list.length - 1] ?? '';
  return `${list.slice(0, -1).join(', ')} ${conjunction} ${last}`;
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/**
 * Compact clock for elapsed time: "8s", "1:04", "1:02:30".
 * Wall-clock only — never used inside the simulation.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  const totalSeconds = Math.floor(ms / 1000);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  if (minutes > 0) {
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
  }
  return `${seconds}s`;
}

/** Long form for the results card: "12 minutes", "1 hour 5 minutes", "48 seconds". */
export function formatDurationWords(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0 seconds';
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return pluralise(totalSeconds, 'second');
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return pluralise(minutes, 'minute');
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? pluralise(hours, 'hour') : `${pluralise(hours, 'hour')} ${pluralise(rest, 'minute')}`;
}

/** Round-trip latency pill: "42 ms", "1.2 s", "—" while unknown. */
export function formatLatency(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

/** Percentage with no decimals: 0.732 → "73%". */
export function formatPercent(fraction: number): string {
  if (!Number.isFinite(fraction)) return '0%';
  const clamped = Math.max(0, Math.min(1, fraction));
  return `${Math.round(clamped * 100)}%`;
}

/** Signed points for a scoreboard delta: "+3", "0", "-1". */
export function formatSigned(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const value = Math.floor(n);
  return value > 0 ? `+${value}` : `${value}`;
}
