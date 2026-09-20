'use client';

/**
 * ShareSheet — four ways to take the result with you, zero of them leave the device.
 *
 *   Copy result   — clipboard, via utils/share.copyToClipboard
 *   Share         — navigator.share, feature-detected, falls back to copy
 *   Save as image — a PNG drawn on a <canvas> right here and handed to a download
 *                   link; no screenshot service, no upload, no third-party script
 *   Email         — a plain `mailto:` link, so the user's own mail app composes it
 *
 * The result text itself comes from `utils/share.buildResultText`, which is the
 * single source of truth for the wording in both modes.
 *
 * The "nothing is uploaded" line at the bottom is not decoration: this whole game
 * is peer-to-peer with no backend, and the share sheet is the one place a player
 * might reasonably assume otherwise.
 */

import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { UI, withAlpha } from '@/game/rendering/palette';
import type { GameResults, Hex, PlayerState } from '@/types';
import { cn } from '@/utils/cn';
import { buildResultText, copyToClipboard, shareResults } from '@/utils/share';

// --- image card geometry (device-independent CSS-ish pixels) ----------------
const CARD_W = 1080;
const CARD_H = 1350;
const CARD_PAD = 90;
const LINE_HEIGHT = 52;
const BODY_FONT_PX = 38;
const TITLE_FONT_PX = 64;

const SYSTEM_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Apple Color Emoji", "Segoe UI Emoji", sans-serif';

type ShareStatus = 'idle' | 'copied' | 'shared' | 'saved' | 'busy' | 'error';

export interface ShareSheetProps {
  readonly results: GameResults;
  readonly players: readonly PlayerState[];
  /** Accent used by the generated image and the primary button. */
  readonly accent?: Hex;
  /** Subject line for the mailto: draft. */
  readonly emailSubject?: string;
  readonly className?: string;
}

/** True only in a browser that actually implements the Web Share API. */
export function canNativeShare(): boolean {
  if (typeof navigator === 'undefined') return false;
  return typeof navigator.share === 'function';
}

function wrapLine(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): readonly string[] {
  if (text.length === 0) return [''];
  const words = text.split(' ');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (ctx.measureText(candidate).width <= maxWidth || current.length === 0) {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
    }
  }
  lines.push(current);
  return lines;
}

/**
 * Draws the result card entirely with canvas primitives — no fonts to download,
 * no images to fetch, nothing sent anywhere. Returns `null` when canvas is
 * unavailable (SSR, or a browser that refuses toBlob).
 */
export async function renderResultImage(text: string, accent: Hex): Promise<Blob | null> {
  if (typeof document === 'undefined') return null;

  const canvas = document.createElement('canvas');
  canvas.width = CARD_W;
  canvas.height = CARD_H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  // Background: flat base + one soft radial wash in the accent.
  ctx.fillStyle = '#0B0F14';
  ctx.fillRect(0, 0, CARD_W, CARD_H);

  const wash = ctx.createRadialGradient(CARD_W * 0.5, 0, 0, CARD_W * 0.5, 0, CARD_H * 0.9);
  wash.addColorStop(0, withAlpha(accent, 0.22));
  wash.addColorStop(1, 'rgba(11,15,20,0)');
  ctx.fillStyle = wash;
  ctx.fillRect(0, 0, CARD_W, CARD_H);

  // Accent rule under the title.
  ctx.fillStyle = accent;
  ctx.fillRect(CARD_PAD, CARD_PAD + TITLE_FONT_PX + 34, 128, 6);

  ctx.textBaseline = 'top';
  ctx.fillStyle = '#FFFFFF';
  ctx.font = `700 ${TITLE_FONT_PX}px ${SYSTEM_STACK}`;
  ctx.fillText('Friend Golf', CARD_PAD, CARD_PAD);

  ctx.font = `400 ${BODY_FONT_PX}px ${SYSTEM_STACK}`;
  const maxWidth = CARD_W - CARD_PAD * 2;
  let y = CARD_PAD + TITLE_FONT_PX + 82;

  for (const raw of text.split('\n')) {
    if (y > CARD_H - CARD_PAD - LINE_HEIGHT * 2) break;
    if (raw.trim().length === 0) {
      y += LINE_HEIGHT * 0.5;
      continue;
    }
    const emphasised = /^[A-Z0-9 \u{1F300}-\u{1FAFF}☀-➿!?.'-]+$/u.test(raw.trim());
    ctx.font = `${emphasised ? 700 : 400} ${BODY_FONT_PX}px ${SYSTEM_STACK}`;
    ctx.fillStyle = emphasised ? '#FFFFFF' : 'rgba(255,255,255,0.78)';
    for (const line of wrapLine(ctx, raw, maxWidth)) {
      if (y > CARD_H - CARD_PAD - LINE_HEIGHT * 2) break;
      ctx.fillText(line, CARD_PAD, y);
      y += LINE_HEIGHT;
    }
  }

  ctx.font = `500 28px ${SYSTEM_STACK}`;
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.fillText('Played browser-to-browser. No servers, no accounts.', CARD_PAD, CARD_H - CARD_PAD - 30);

  return new Promise<Blob | null>((resolve) => {
    canvas.toBlob((blob) => resolve(blob), 'image/png');
  });
}

interface ActionProps {
  readonly label: string;
  readonly icon: string;
  readonly onClick: () => void;
  readonly primary?: boolean;
  readonly accent: Hex;
  readonly disabled?: boolean;
}

function ShareAction({ label, icon, onClick, primary, accent, disabled }: ActionProps): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'flex flex-1 items-center justify-center gap-2 rounded-xl px-3 py-2.5 text-[13px] font-semibold transition-colors',
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/80',
        'disabled:cursor-not-allowed disabled:opacity-45',
        primary ? '' : 'border border-white/[0.12] bg-white/[0.06] text-white/[0.85] hover:bg-white/10',
      )}
      style={primary ? { backgroundColor: accent, color: '#0B0F14' } : undefined}
    >
      <span aria-hidden="true" className="text-[14px] leading-none">
        {icon}
      </span>
      {label}
    </button>
  );
}

export function ShareSheet({
  results,
  players,
  accent = UI.accent,
  emailSubject = 'Our Friend Golf results',
  className,
}: ShareSheetProps): React.JSX.Element {
  const reduced = useReducedMotion() ?? false;
  const [status, setStatus] = useState<ShareStatus>('idle');
  const [message, setMessage] = useState<string>('');
  const [nativeShare, setNativeShare] = useState(false);

  const text = useMemo(() => buildResultText(results, players), [results, players]);

  useEffect(() => {
    setNativeShare(canNativeShare());
  }, []);

  useEffect(() => {
    if (status === 'idle' || status === 'busy') return undefined;
    const handle = window.setTimeout(() => {
      setStatus('idle');
      setMessage('');
    }, 2600);
    return () => window.clearTimeout(handle);
  }, [status, message]);

  const announce = useCallback((next: ShareStatus, copy: string) => {
    setStatus(next);
    setMessage(copy);
  }, []);

  const onCopy = useCallback(() => {
    void copyToClipboard(text).then((done) => {
      announce(done ? 'copied' : 'error', done ? 'Copied to your clipboard' : 'Could not copy — select the text below');
    });
  }, [announce, text]);

  const onShare = useCallback(() => {
    void shareResults(text).then((done) => {
      announce(done ? 'shared' : 'error', done ? 'Shared' : 'Share was cancelled');
    });
  }, [announce, text]);

  const onDownload = useCallback(() => {
    announce('busy', 'Drawing your card…');
    void renderResultImage(text, accent)
      .then((blob) => {
        if (!blob || typeof document === 'undefined') {
          announce('error', 'Could not create the image on this device');
          return;
        }
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `friend-golf-${results.mode}-${results.roundsPlayed}-rounds.png`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        // Give the browser a tick to start the download before revoking.
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
        announce('saved', 'Saved to your downloads');
      })
      .catch(() => announce('error', 'Could not create the image on this device'));
  }, [accent, announce, results.mode, results.roundsPlayed, text]);

  const mailtoHref = useMemo(
    () => `mailto:?subject=${encodeURIComponent(emailSubject)}&body=${encodeURIComponent(text)}`,
    [emailSubject, text],
  );

  return (
    <section
      className={cn('w-full rounded-2xl border border-white/10 bg-white/[0.035] p-3', className)}
      aria-label="Share these results"
    >
      <h3 className="mb-2.5 text-[10.5px] font-bold uppercase tracking-[0.16em] text-white/40">
        Take it with you
      </h3>

      <div className="flex flex-col gap-2">
        <div className="flex gap-2">
          <ShareAction label="Copy result" icon={'\u{1F4CB}'} onClick={onCopy} primary accent={accent} />
          {nativeShare ? (
            <ShareAction label="Share" icon={'\u{1F517}'} onClick={onShare} accent={accent} />
          ) : null}
        </div>

        <div className="flex gap-2">
          <ShareAction
            label="Save as image"
            icon={'\u{1F5BC}️'}
            onClick={onDownload}
            accent={accent}
            disabled={status === 'busy'}
          />
          <a
            href={mailtoHref}
            className="flex flex-1 items-center justify-center gap-2 rounded-xl border border-white/[0.12] bg-white/[0.06] px-3 py-2.5 text-[13px] font-semibold text-white/[0.85] transition-colors hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/80"
          >
            <span aria-hidden="true" className="text-[14px] leading-none">
              {'✉️'}
            </span>
            Email results
          </a>
        </div>
      </div>

      <AnimatePresence initial={false}>
        {message ? (
          <motion.p
            key={message}
            role="status"
            aria-live="polite"
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="mt-2 text-[11.5px] font-medium"
            style={{ color: status === 'error' ? UI.warn : UI.good }}
          >
            {message}
          </motion.p>
        ) : null}
      </AnimatePresence>

      <details className="mt-2.5 group">
        <summary className="cursor-pointer list-none text-[11px] font-medium text-white/[0.35] transition-colors hover:text-white/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/70">
          Preview the text
        </summary>
        <pre className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg border border-white/[0.08] bg-black/40 p-2.5 font-mono text-[11px] leading-relaxed text-white/[0.65]">
          {text}
        </pre>
      </details>

      <p className="mt-2.5 flex items-start gap-1.5 text-[10.5px] leading-snug text-white/30">
        <span aria-hidden="true">{'\u{1F512}'}</span>
        <span>
          Everything here happens on your device. The image is drawn in your browser and the text never
          touches a server &mdash; this game has none.
        </span>
      </p>
    </section>
  );
}

export default ShareSheet;
