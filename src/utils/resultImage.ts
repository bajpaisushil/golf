/**
 * The shareable result card, drawn entirely with canvas primitives.
 *
 * ZERO downloaded assets: no image, no icon font, no webfont, no logo file. The
 * wordmark, the ball, the flag, the gradients and the score bars are all drawn
 * from rectangles, arcs and system-stack text. That keeps the promise in the
 * brief (nothing copyrighted, nothing fetched) and it means the card works
 * offline, on a plane, on a phone that has never loaded this page before.
 *
 * Rendered at 2x for retina and handed straight to a download — the bytes never
 * leave the device. There is no image host here because there is no server here.
 *
 * Degrades gracefully: on a server render, in a browser with no 2D context, or
 * when `toBlob` is unavailable, `downloadResultImage` returns false instead of
 * throwing, and the caller falls back to the copyable text.
 */

import { PLAYER_COLORS } from '@/game/config';
import { UI, mixHex, withAlpha } from '@/game/rendering/palette';
import type { GameResults, Hex, PlayerState } from '@/types';
import { pluralise, stepLabel, strokeLabel, truncateName } from './format';
import type { ResultState } from './share';
import { buildGameUrl } from './share';

/** System stack only — nothing to download, and it renders emoji on every OS. */
const FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif';

/** Logical card size. The backing canvas is this times {@link CARD_SCALE}. */
export interface CardSize {
  readonly width: number;
  readonly height: number;
}

/** 4:5 portrait — the shape that survives every messaging app's crop. */
export const RESULT_CARD_SIZE: CardSize = { width: 1080, height: 1350 };

/** Device pixel multiplier. 2 is retina-sharp without a 16MB PNG. */
export const CARD_SCALE = 2;

const PAD = 84;

/** Input for the card: the share state plus an optional accent override. */
export interface ResultCardState extends ResultState {
  readonly accent?: Hex;
}

// ---------------------------------------------------------------------------
// Low-level drawing helpers
// ---------------------------------------------------------------------------

/** Rounded-rect path built from arcs, because `roundRect` is not universal. */
function roundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
): void {
  const r = Math.max(0, Math.min(radius, Math.min(w, h) / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

function fillRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
  fill: string,
): void {
  roundedRectPath(ctx, x, y, w, h, radius);
  ctx.fillStyle = fill;
  ctx.fill();
}

function fillCircle(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, fill: string): void {
  ctx.beginPath();
  ctx.arc(cx, cy, Math.max(0, r), 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
}

function setFont(ctx: CanvasRenderingContext2D, weight: number, size: number): void {
  ctx.font = `${weight} ${size}px ${FONT_STACK}`;
}

/** Truncates with an ellipsis until the text fits `maxWidth`. */
function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  const chars = Array.from(text);
  for (let length = chars.length - 1; length > 0; length -= 1) {
    const candidate = `${chars.slice(0, length).join('')}…`;
    if (ctx.measureText(candidate).width <= maxWidth) return candidate;
  }
  return '…';
}

/** Draws text with manual letter spacing (`ctx.letterSpacing` is not universal). */
function drawTracked(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  tracking: number,
): number {
  let cursor = x;
  for (const char of text) {
    ctx.fillText(char, cursor, y);
    cursor += ctx.measureText(char).width + tracking;
  }
  return cursor - tracking;
}

/**
 * The Friend Golf mark: a ball with three dimples and a pennant on a pin.
 * Entirely original, entirely made of arcs and triangles.
 */
function drawLogoMark(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, accent: Hex): void {
  const ballR = size * 0.3;
  const ballCx = x + ballR;
  const ballCy = y + size - ballR;

  // Pin.
  ctx.strokeStyle = withAlpha(UI.text, 0.55);
  ctx.lineWidth = Math.max(2, size * 0.055);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x + size * 0.72, y + size * 0.04);
  ctx.lineTo(x + size * 0.72, y + size * 0.92);
  ctx.stroke();

  // Pennant.
  ctx.beginPath();
  ctx.moveTo(x + size * 0.72, y + size * 0.06);
  ctx.lineTo(x + size * 0.14, y + size * 0.26);
  ctx.lineTo(x + size * 0.72, y + size * 0.46);
  ctx.closePath();
  ctx.fillStyle = accent;
  ctx.fill();

  // Ball + dimples.
  fillCircle(ctx, ballCx, ballCy, ballR, UI.text);
  const dimple = withAlpha(UI.bg, 0.22);
  fillCircle(ctx, ballCx - ballR * 0.28, ballCy - ballR * 0.2, ballR * 0.17, dimple);
  fillCircle(ctx, ballCx + ballR * 0.24, ballCy - ballR * 0.3, ballR * 0.14, dimple);
  fillCircle(ctx, ballCx + ballR * 0.05, ballCy + ballR * 0.3, ballR * 0.15, dimple);

  ctx.lineCap = 'butt';
}

/** Colour for a player id, falling back to the palette by index. */
function colorForPlayer(players: readonly PlayerState[], playerId: string, fallbackIndex: number): Hex {
  const match = players.find((player) => player.id === playerId);
  if (match !== undefined && typeof match.color === 'string' && match.color.length > 0) return match.color;
  const spec = PLAYER_COLORS[fallbackIndex % PLAYER_COLORS.length];
  return spec === undefined ? UI.accent : spec.hex;
}

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

/**
 * Draws the whole card into `ctx` in LOGICAL pixels (`size`). The caller is
 * responsible for the device-pixel scale — see {@link renderResultCanvas}.
 */
export function renderResultCard(
  ctx: CanvasRenderingContext2D,
  state: ResultCardState,
  size: CardSize = RESULT_CARD_SIZE,
): void {
  const { results } = state;
  const accent = state.accent ?? (results.mode === 'together' ? UI.accent : UI.accentAlt);
  const W = size.width;
  const H = size.height;
  const inner = W - PAD * 2;

  // --- background -----------------------------------------------------------
  const base = ctx.createLinearGradient(0, 0, 0, H);
  base.addColorStop(0, mixHex(UI.bg, accent, 0.1));
  base.addColorStop(0.55, UI.bg);
  base.addColorStop(1, mixHex(UI.bg, '#000000', 0.35));
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, W, H);

  const wash = ctx.createRadialGradient(W * 0.82, H * 0.06, 0, W * 0.82, H * 0.06, H * 0.62);
  wash.addColorStop(0, withAlpha(accent, 0.26));
  wash.addColorStop(1, withAlpha(accent, 0));
  ctx.fillStyle = wash;
  ctx.fillRect(0, 0, W, H);

  const floor = ctx.createRadialGradient(W * 0.2, H * 0.98, 0, W * 0.2, H * 0.98, H * 0.5);
  floor.addColorStop(0, withAlpha(UI.accentAlt, 0.12));
  floor.addColorStop(1, withAlpha(UI.accentAlt, 0));
  ctx.fillStyle = floor;
  ctx.fillRect(0, 0, W, H);

  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';

  // --- header ---------------------------------------------------------------
  drawLogoMark(ctx, PAD, PAD, 78, accent);

  ctx.fillStyle = UI.text;
  setFont(ctx, 800, 50);
  drawTracked(ctx, 'FRIEND GOLF', PAD + 108, PAD + 6, 3.5);

  ctx.fillStyle = withAlpha(UI.textMuted, 0.95);
  setFont(ctx, 600, 25);
  const modeLine =
    results.mode === 'together'
      ? 'Friendship Journey — played together'
      : 'Friend Battle — fewer hits, more points';
  ctx.fillText(modeLine, PAD + 110, PAD + 62);

  ctx.fillStyle = withAlpha(accent, 0.9);
  ctx.fillRect(PAD, PAD + 132, 96, 5);

  const bodyTop = PAD + 180;

  if (results.mode === 'together') {
    drawCooperativeBody(ctx, state, { x: PAD, y: bodyTop, w: inner, h: H - bodyTop - PAD - 96 }, accent);
  } else {
    drawCompetitiveBody(ctx, state, { x: PAD, y: bodyTop, w: inner, h: H - bodyTop - PAD - 96 }, accent);
  }

  // --- footer ---------------------------------------------------------------
  const url = state.url ?? buildGameUrl();
  const footerY = H - PAD - 58;

  ctx.fillStyle = withAlpha(UI.border, 0.9);
  ctx.fillRect(PAD, footerY - 26, inner, 1);

  ctx.fillStyle = withAlpha(UI.text, 0.82);
  setFont(ctx, 600, 25);
  ctx.fillText(fitText(ctx, url.length > 0 ? url : 'Play it in any browser', inner), PAD, footerY);

  ctx.fillStyle = withAlpha(UI.textMuted, 0.7);
  setFont(ctx, 500, 21);
  ctx.fillText('Browser to browser. No servers, no accounts, no sign-up.', PAD, footerY + 34);
}

interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** Co-op body: collective totals, a tier badge, and every player in join order. */
function drawCooperativeBody(
  ctx: CanvasRenderingContext2D,
  state: ResultCardState,
  box: Box,
  accent: Hex,
): void {
  const { results, players } = state;
  const rounds = Math.max(0, Math.floor(results.roundsPlayed));

  // Headline.
  ctx.fillStyle = UI.text;
  setFont(ctx, 800, 76);
  ctx.fillText(fitText(ctx, `${rounds}`, box.w * 0.4), box.x, box.y);
  const numberWidth = ctx.measureText(`${rounds}`).width;

  ctx.fillStyle = withAlpha(UI.text, 0.92);
  setFont(ctx, 700, 34);
  ctx.fillText(rounds === 1 ? 'round' : 'rounds', box.x + numberWidth + 16, box.y + 34);

  ctx.fillStyle = withAlpha(UI.textMuted, 0.95);
  setFont(ctx, 600, 27);
  ctx.fillText('played together', box.x, box.y + 96);

  // Two stat tiles.
  const tileY = box.y + 148;
  const tileH = 108;
  const gap = 20;
  const tileW = (box.w - gap) / 2;

  drawStatTile(ctx, box.x, tileY, tileW, tileH, 'Together', stepLabel(results.collectiveStrokes), accent);
  const everyoneHoled = players.length > 0 && players.every((player) => player.holed);
  drawStatTile(
    ctx,
    box.x + tileW + gap,
    tileY,
    tileW,
    tileH,
    'Friends',
    pluralise(Math.max(players.length, results.standings.length), 'player'),
    accent,
  );

  // Tier badge.
  let cursorY = tileY + tileH + 26;
  const tier = results.friendshipTier;
  if (tier !== null) {
    const badgeH = 96;
    fillRoundedRect(ctx, box.x, cursorY, box.w, badgeH, 22, withAlpha(accent, 0.13));
    roundedRectPath(ctx, box.x + 0.5, cursorY + 0.5, box.w - 1, badgeH - 1, 22);
    ctx.strokeStyle = withAlpha(accent, 0.34);
    ctx.lineWidth = 1;
    ctx.stroke();

    setFont(ctx, 500, 40);
    ctx.fillStyle = UI.text;
    ctx.fillText(tier.emoji, box.x + 26, cursorY + 26);

    const suffix = tier.cycle > 0 ? ` ×${tier.cycle + 1}` : '';
    ctx.fillStyle = UI.text;
    setFont(ctx, 700, 28);
    ctx.fillText(fitText(ctx, `${tier.title}${suffix}`, box.w - 110), box.x + 86, cursorY + 22);

    ctx.fillStyle = withAlpha(UI.textMuted, 0.95);
    setFont(ctx, 500, 22);
    ctx.fillText(fitText(ctx, tier.subtitle, box.w - 110), box.x + 86, cursorY + 58);

    cursorY += badgeH + 26;
  }

  if (everyoneHoled) {
    ctx.fillStyle = withAlpha(UI.good, 0.95);
    setFont(ctx, 700, 25);
    ctx.fillText('Everyone reached the goal!', box.x, cursorY);
    cursorY += 44;
  }

  // Player rows — join order, no ranking anywhere in this mode.
  const ordered = [...players].sort((a, b) => a.joinSeq - b.joinSeq);
  const rows =
    ordered.length > 0
      ? ordered.map((player, index) => ({
          name: player.displayName,
          color: player.color,
          steps:
            results.standings.find((row) => row.playerId === player.id)?.totalStrokes ?? player.strokes,
          index,
        }))
      : results.standings.map((row, index) => ({
          name: row.displayName,
          color: colorForPlayer(players, row.playerId, index),
          steps: row.totalStrokes,
          index,
        }));

  const rowH = 54;
  const available = box.y + box.h - cursorY;
  const visible = Math.max(0, Math.min(rows.length, Math.floor(available / rowH)));

  for (let i = 0; i < visible; i += 1) {
    const row = rows[i];
    if (row === undefined) continue;
    const y = cursorY + i * rowH;
    fillCircle(ctx, box.x + 11, y + 18, 11, row.color);

    ctx.fillStyle = withAlpha(UI.text, 0.94);
    setFont(ctx, 600, 27);
    ctx.fillText(fitText(ctx, truncateName(row.name, 18), box.w - 240), box.x + 36, y);

    const steps = stepLabel(row.steps);
    ctx.fillStyle = withAlpha(UI.textMuted, 0.95);
    setFont(ctx, 600, 25);
    ctx.textAlign = 'right';
    ctx.fillText(steps, box.x + box.w, y + 2);
    ctx.textAlign = 'left';
  }

  if (visible < rows.length) {
    ctx.fillStyle = withAlpha(UI.textMuted, 0.8);
    setFont(ctx, 500, 22);
    ctx.fillText(`+${rows.length - visible} more`, box.x + 36, cursorY + visible * rowH);
  }
}

/** Battle body: ranked rows, points bars, and the scoring rule spelled out. */
function drawCompetitiveBody(
  ctx: CanvasRenderingContext2D,
  state: ResultCardState,
  box: Box,
  accent: Hex,
): void {
  const { results, players } = state;
  const rounds = Math.max(0, Math.floor(results.roundsPlayed));

  ctx.fillStyle = UI.text;
  setFont(ctx, 800, 56);
  ctx.fillText(pluralise(rounds, 'round'), box.x, box.y);

  ctx.fillStyle = withAlpha(accent, 0.95);
  setFont(ctx, 700, 26);
  ctx.fillText('Fewer hits = more points', box.x, box.y + 74);

  const ranked = [...results.standings].sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    return b.totalScore - a.totalScore;
  });

  let best = 1;
  for (const row of ranked) best = Math.max(best, row.totalScore);

  const rowH = 96;
  const listTop = box.y + 128;
  const available = box.y + box.h - listTop;
  const visible = Math.max(0, Math.min(ranked.length, Math.floor(available / rowH)));

  for (let i = 0; i < visible; i += 1) {
    const row = ranked[i];
    if (row === undefined) continue;
    const y = listTop + i * rowH;
    const color = colorForPlayer(players, row.playerId, i);
    const leader = row.rank === 1;

    fillRoundedRect(ctx, box.x, y, box.w, rowH - 14, 20, withAlpha(color, leader ? 0.16 : 0.08));

    // Rank chip.
    fillCircle(ctx, box.x + 38, y + 41, 24, withAlpha(color, leader ? 0.95 : 0.3));
    ctx.fillStyle = leader ? UI.bg : UI.text;
    setFont(ctx, 800, 24);
    ctx.textAlign = 'center';
    ctx.fillText(row.rank >= 1 ? `${row.rank}` : '—', box.x + 38, y + 28);
    ctx.textAlign = 'left';

    // Name.
    ctx.fillStyle = UI.text;
    setFont(ctx, 700, 30);
    ctx.fillText(fitText(ctx, truncateName(row.displayName, 16), box.w - 320), box.x + 78, y + 14);

    // Secondary line: hits + round wins, i.e. WHY the points look like that.
    const detail =
      row.roundWins > 0
        ? `${strokeLabel(row.totalStrokes)} · ${pluralise(row.roundWins, 'round win')}`
        : strokeLabel(row.totalStrokes);
    ctx.fillStyle = withAlpha(UI.textMuted, 0.95);
    setFont(ctx, 500, 22);
    ctx.fillText(fitText(ctx, detail, box.w - 320), box.x + 78, y + 50);

    // Points.
    ctx.textAlign = 'right';
    ctx.fillStyle = leader ? color : withAlpha(UI.text, 0.9);
    setFont(ctx, 800, 38);
    ctx.fillText(`${Math.max(0, Math.floor(row.totalScore))}`, box.x + box.w - 22, y + 10);
    ctx.fillStyle = withAlpha(UI.textMuted, 0.85);
    setFont(ctx, 600, 18);
    ctx.fillText('PTS', box.x + box.w - 22, y + 54);
    ctx.textAlign = 'left';

    // Points bar, scaled to the leader.
    const barW = box.w - 130;
    const barY = y + rowH - 26;
    fillRoundedRect(ctx, box.x + 78, barY, barW, 6, 3, withAlpha(UI.text, 0.08));
    const ratio = Math.max(0.03, Math.min(1, row.totalScore / best));
    fillRoundedRect(ctx, box.x + 78, barY, barW * ratio, 6, 3, withAlpha(color, 0.9));
  }

  if (visible < ranked.length) {
    ctx.fillStyle = withAlpha(UI.textMuted, 0.8);
    setFont(ctx, 500, 22);
    ctx.fillText(`+${ranked.length - visible} more`, box.x + 78, listTop + visible * rowH);
  }

  if (ranked.length === 0) {
    ctx.fillStyle = withAlpha(UI.textMuted, 0.9);
    setFont(ctx, 500, 26);
    ctx.fillText('No rounds were finished.', box.x, listTop);
  }
}

/** One labelled stat tile used by the co-op body. */
function drawStatTile(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  label: string,
  value: string,
  accent: Hex,
): void {
  fillRoundedRect(ctx, x, y, w, h, 20, withAlpha(UI.surface, 0.85));
  roundedRectPath(ctx, x + 0.5, y + 0.5, w - 1, h - 1, 20);
  ctx.strokeStyle = withAlpha(accent, 0.22);
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.fillStyle = withAlpha(UI.textMuted, 0.9);
  setFont(ctx, 700, 18);
  drawTracked(ctx, label.toUpperCase(), x + 22, y + 22, 1.6);

  ctx.fillStyle = UI.text;
  setFont(ctx, 700, 34);
  ctx.fillText(fitText(ctx, value, w - 44), x + 22, y + 52);
}

// ---------------------------------------------------------------------------
// Canvas + download
// ---------------------------------------------------------------------------

/**
 * Creates an offscreen canvas at `CARD_SCALE`x and renders the card into it.
 * Returns null when there is no DOM or no 2D context.
 */
export function renderResultCanvas(
  state: ResultCardState,
  size: CardSize = RESULT_CARD_SIZE,
): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(size.width * CARD_SCALE);
    canvas.height = Math.round(size.height * CARD_SCALE);
    const ctx = canvas.getContext('2d');
    if (ctx === null) return null;
    ctx.scale(CARD_SCALE, CARD_SCALE);
    renderResultCard(ctx, state, size);
    return canvas;
  } catch {
    return null;
  }
}

/** The card as a PNG Blob, or null when the browser cannot produce one. */
export async function renderResultBlob(
  state: ResultCardState,
  size: CardSize = RESULT_CARD_SIZE,
): Promise<Blob | null> {
  const canvas = renderResultCanvas(state, size);
  if (canvas === null) return null;

  if (typeof canvas.toBlob === 'function') {
    try {
      return await new Promise<Blob | null>((resolve) => {
        canvas.toBlob((blob) => resolve(blob), 'image/png');
      });
    } catch {
      return null;
    }
  }

  // Very old WebKit: rebuild a Blob from the data URL by hand.
  try {
    const dataUrl = canvas.toDataURL('image/png');
    const comma = dataUrl.indexOf(',');
    if (comma < 0) return null;
    const binary = atob(dataUrl.slice(comma + 1));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i) & 0xff;
    return new Blob([bytes], { type: 'image/png' });
  } catch {
    return null;
  }
}

/** A filesystem-safe default name for the downloaded PNG. */
function defaultFileName(results: GameResults): string {
  const mode = results.mode === 'together' ? 'friendship' : 'battle';
  const rounds = Math.max(0, Math.floor(results.roundsPlayed));
  return `friend-golf-${mode}-${rounds}-rounds.png`;
}

/**
 * Draws the card and hands it to the browser as a download. Returns false — and
 * never throws — when canvas, Blob URLs or programmatic downloads are
 * unavailable, so the caller can fall back to the copyable text.
 */
export async function downloadResultImage(state: ResultCardState, fileName?: string): Promise<boolean> {
  if (typeof document === 'undefined' || typeof URL === 'undefined') return false;

  const blob = await renderResultBlob(state);
  if (blob === null) return false;

  let objectUrl: string | null = null;
  try {
    if (typeof URL.createObjectURL !== 'function') return false;
    objectUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    if (!('download' in link)) return false;
    link.href = objectUrl;
    link.download = fileName ?? defaultFileName(state.results);
    link.rel = 'noopener';
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
    return true;
  } catch {
    return false;
  } finally {
    if (objectUrl !== null && typeof URL.revokeObjectURL === 'function') {
      const toRevoke = objectUrl;
      // Give the download a tick to start before the URL disappears.
      if (typeof window !== 'undefined') {
        window.setTimeout(() => URL.revokeObjectURL(toRevoke), 1000);
      } else {
        URL.revokeObjectURL(toRevoke);
      }
    }
  }
}

/** Exposed for a preview <img>; null when canvas is unavailable. */
export function resultImageDataUrl(state: ResultCardState): string | null {
  const canvas = renderResultCanvas(state);
  if (canvas === null) return null;
  try {
    return canvas.toDataURL('image/png');
  } catch {
    return null;
  }
}
