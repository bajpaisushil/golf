/**
 * Turning a finished game into something you can send a friend.
 *
 * Everything here is LOCAL. There is no upload, no shortener, no image host, no
 * address book, no "who did you share with" callback. The text is built in
 * memory, handed to the clipboard or to the OS share sheet, and forgotten. The
 * mailto: link opens the player's own mail app with the body pre-filled — this
 * app never sees, asks for or stores an email address.
 *
 * Two voices, because the game has two modes:
 *   - `buildCooperativeResult` — the Friendship Journey. No ranks, no winner, no
 *     comparison between players. Collective totals and a tier.
 *   - `buildCompetitiveResult` — Friend Battle. Ranked, with points, and it says
 *     out loud that fewer hits is what earns them.
 */

import type { FinalStanding, GameResults, PlayerState, RoomCode } from '@/types';
import { ordinal, pluralise, stepLabel, strokeLabel } from './format';

/** Medals for the first three places in Friend Battle. Co-op never uses them. */
const MEDALS: readonly string[] = ['\u{1F947}', '\u{1F948}', '\u{1F949}'];

/** Wordmark used at the top of the competitive text. */
const COMPETITIVE_HEADER = '\u{1F3CC}️ FRIEND GOLF';

/** Sprout: the Friendship Journey's mark. */
const COOPERATIVE_HEADER = 'Friendship Journey \u{1F331}';

/**
 * Everything the share helpers need. `url` defaults to {@link buildGameUrl}, and
 * is omitted from the text entirely when it cannot be determined (SSR, a
 * `file://` page).
 */
export interface ResultState {
  readonly results: GameResults;
  readonly players: readonly PlayerState[];
  /** Invite link to append. Defaults to the current page's URL. */
  readonly url?: string;
}

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

/**
 * `origin` + directory of the current page, always with a trailing slash, or ''
 * when there is no usable location (server render, sandboxed iframe with a null
 * origin, a page opened straight off disk).
 */
function siteBase(): string {
  if (typeof window === 'undefined') return '';
  try {
    const loc = window.location;
    const origin = typeof loc.origin === 'string' ? loc.origin : '';
    if (origin.length === 0 || origin === 'null') return '';
    let path = typeof loc.pathname === 'string' && loc.pathname.length > 0 ? loc.pathname : '/';
    // Static export deploys as directories; drop an explicit index file.
    path = path.replace(/index\.html?$/i, '');
    if (!path.endsWith('/')) path = `${path}/`;
    return `${origin}${path}`;
  } catch {
    return '';
  }
}

/** The plain game URL, with no room attached. '' when unavailable. */
export function buildGameUrl(): string {
  return siteBase();
}

/**
 * A link that drops the recipient straight into the room:
 * `https://…/?room=K7PQ3M`. Returns '' when there is no usable origin, so
 * callers can simply skip rendering the link.
 */
export function buildJoinUrl(code: RoomCode | string): string {
  const base = siteBase();
  const clean = String(code).toUpperCase();
  if (base.length === 0) return '';
  return `${base}?room=${encodeURIComponent(clean)}`;
}

/** Reads `?room=` off the current URL, for the "open an invite link" flow. */
export function roomCodeFromLocation(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const params = new URLSearchParams(window.location.search);
    const value = params.get('room');
    return value === null || value.length === 0 ? null : value;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Result text
// ---------------------------------------------------------------------------

/** Standings keyed for quick lookup, since co-op prints them in join order. */
function standingFor(results: GameResults, playerId: string): FinalStanding | undefined {
  return results.standings.find((row) => row.playerId === playerId);
}

/** Drops empty leading/trailing lines and collapses runs of blank lines to one. */
function tidy(lines: readonly string[]): string {
  const out: string[] = [];
  for (const line of lines) {
    const isBlank = line.length === 0;
    const prev = out[out.length - 1];
    if (isBlank && (out.length === 0 || prev === '')) continue;
    out.push(line);
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}

/**
 * The Friendship Journey summary. Deliberately contains no rank, no medal, no
 * "winner" and no comparison — only what the group did together.
 */
export function buildCooperativeResult(state: ResultState): string {
  const { results, players } = state;
  const url = state.url ?? buildGameUrl();
  const rounds = Math.max(0, Math.floor(results.roundsPlayed));

  const lines: string[] = [COOPERATIVE_HEADER, ''];

  lines.push(rounds === 1 ? 'We played 1 round together!' : `We played ${rounds} rounds together!`);
  lines.push('');

  // Join order, never score order: this mode does not rank people.
  const ordered = [...players].sort((a, b) => a.joinSeq - b.joinSeq);
  for (const player of ordered) {
    const row = standingFor(results, player.id);
    const steps = row === undefined ? player.strokes : row.totalStrokes;
    lines.push(`${player.displayName} · ${stepLabel(steps)}`);
  }
  if (ordered.length === 0) {
    for (const row of results.standings) {
      lines.push(`${row.displayName} · ${stepLabel(row.totalStrokes)}`);
    }
  }
  lines.push('');

  lines.push(`Rounds completed: ${rounds}`);
  lines.push(`Together: ${stepLabel(Math.max(0, Math.floor(results.collectiveStrokes)))}`);

  const everyoneHoled = players.length > 0 && players.every((player) => player.holed);
  if (everyoneHoled) lines.push('Everyone reached the goal!');

  const tier = results.friendshipTier;
  if (tier !== null) {
    lines.push('');
    const suffix = tier.cycle > 0 ? ` ×${tier.cycle + 1}` : '';
    lines.push(`${tier.emoji} ${tier.title}${suffix}`);
    if (tier.subtitle.length > 0) lines.push(tier.subtitle);
  }

  if (url.length > 0) {
    lines.push('');
    lines.push('Play a round with us:');
    lines.push(url);
  }

  return tidy(lines);
}

/**
 * The Friend Battle summary. Ranked, with points, and it states the scoring rule
 * plainly — the user's headline requirement is that fewer hits scores higher, so
 * the share text says so rather than leaving it to be inferred.
 */
export function buildCompetitiveResult(state: ResultState): string {
  const { results } = state;
  const url = state.url ?? buildGameUrl();
  const rounds = Math.max(0, Math.floor(results.roundsPlayed));

  const lines: string[] = [COMPETITIVE_HEADER, ''];
  lines.push(`${pluralise(rounds, 'round')} · fewer hits = more points`);
  lines.push('');

  const ranked = [...results.standings].sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    return b.totalScore - a.totalScore;
  });

  for (let i = 0; i < ranked.length; i += 1) {
    const row = ranked[i];
    if (row === undefined) continue;
    const medal = row.rank >= 1 && row.rank <= MEDALS.length ? MEDALS[row.rank - 1] : undefined;
    const badge = medal ?? `${ordinal(row.rank)}`;
    const parts: string[] = [`${pluralise(row.totalScore, 'pt')}`];
    if (row.roundWins > 0) parts.push(`${pluralise(row.roundWins, 'round win')}`);
    parts.push(strokeLabel(row.totalStrokes));
    lines.push(`${badge} ${row.displayName} — ${parts.join(' · ')}`);
  }

  if (url.length > 0) {
    lines.push('');
    lines.push('Think you can do it in fewer?');
    lines.push(url);
  }

  return tidy(lines);
}

/**
 * The single source of truth for share wording (docs/CONTRACTS.md §37).
 * Dispatches on the mode so no caller has to know which voice to use.
 */
export function buildResultText(
  results: GameResults,
  players: readonly PlayerState[],
  url?: string,
): string {
  const state: ResultState = url === undefined ? { results, players } : { results, players, url };
  return results.mode === 'together' ? buildCooperativeResult(state) : buildCompetitiveResult(state);
}

/** Short one-liner for a toast or a document title. */
export function buildResultHeadline(results: GameResults): string {
  const rounds = Math.max(0, Math.floor(results.roundsPlayed));
  if (results.mode === 'together') {
    return `${pluralise(rounds, 'round')} together · ${stepLabel(results.collectiveStrokes)}`;
  }
  const leader = results.standings.find((row) => row.rank === 1);
  return leader === undefined
    ? `${pluralise(rounds, 'round')} of Friend Golf`
    : `${leader.displayName} took it in ${pluralise(rounds, 'round')} · ${pluralise(leader.totalScore, 'pt')}`;
}

// ---------------------------------------------------------------------------
// Clipboard / share / mail
// ---------------------------------------------------------------------------

/**
 * Copies `text`, preferring the async Clipboard API and falling back to a
 * hidden textarea + `document.execCommand('copy')` for older Safari, insecure
 * origins and browsers that deny clipboard permission.
 *
 * Returns whether it worked, so the UI can offer "select the text below"
 * instead of lying about success. Never throws.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (typeof text !== 'string' || text.length === 0) return false;

  if (typeof navigator !== 'undefined') {
    try {
      const clipboard = navigator.clipboard;
      if (clipboard !== undefined && typeof clipboard.writeText === 'function') {
        await clipboard.writeText(text);
        return true;
      }
    } catch {
      // Permission denied or not a secure context — try the legacy path.
    }
  }

  return legacyCopy(text);
}

/** `document.execCommand('copy')` via an off-screen textarea. */
function legacyCopy(text: string): boolean {
  if (typeof document === 'undefined') return false;
  let area: HTMLTextAreaElement | null = null;
  try {
    area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.setAttribute('aria-hidden', 'true');
    area.style.position = 'fixed';
    area.style.top = '0';
    area.style.left = '0';
    area.style.width = '1px';
    area.style.height = '1px';
    area.style.padding = '0';
    area.style.border = 'none';
    area.style.opacity = '0';
    document.body.appendChild(area);

    area.focus({ preventScroll: true });
    area.select();
    area.setSelectionRange(0, text.length);

    // Deprecated, but it is the only copy path on a few real browsers.
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    if (area !== null && area.parentNode !== null) area.parentNode.removeChild(area);
  }
}

/** True only in a browser that actually implements the Web Share API. */
export function canNativeShare(): boolean {
  if (typeof navigator === 'undefined') return false;
  return typeof navigator.share === 'function';
}

/**
 * Hands `text` (and optionally a `url`) to the OS share sheet, falling back to
 * the clipboard when the Web Share API is missing.
 *
 * Returns false when the player cancelled the sheet — cancelling is a normal
 * outcome, not an error, so it does NOT fall back to a surprise clipboard write.
 */
export async function shareResult(text: string, url?: string): Promise<boolean> {
  if (typeof text !== 'string' || text.length === 0) return false;

  if (canNativeShare()) {
    const data: ShareData = { text };
    if (url !== undefined && url.length > 0) data.url = url;
    data.title = 'Friend Golf';
    try {
      await navigator.share(data);
      return true;
    } catch (error) {
      // AbortError = the player dismissed the sheet. Anything else means the
      // sheet is unusable here, so fall through to the clipboard.
      const name = error instanceof Error ? error.name : '';
      if (name === 'AbortError') return false;
    }
  }

  return copyToClipboard(text);
}

/** Contract alias of {@link shareResult} (docs/CONTRACTS.md §37). */
export async function shareResults(text: string): Promise<boolean> {
  return shareResult(text);
}

/**
 * A `mailto:` URL with the subject and body correctly percent-encoded.
 *
 * No recipient is ever filled in: the player picks who to send it to inside
 * their own mail client. This app collects no addresses and sends no mail.
 */
export function mailtoLink(subject: string, body: string, to = ''): string {
  const recipient = encodeURIComponent(to).replace(/%40/g, '@');
  const params = [`subject=${encodeURIComponent(subject)}`, `body=${encodeURIComponent(body)}`];
  return `mailto:${recipient}?${params.join('&')}`;
}
