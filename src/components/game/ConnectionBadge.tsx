'use client';

/**
 * ConnectionBadge — live peer-to-peer health, at a glance.
 *
 * Shows three things and nothing more:
 *   1. link quality (derived from the median RTT of live peer links),
 *   2. how many peers are actually connected right now,
 *   3. a calm, non-alarming banner when the room reshuffles itself
 *      ("Rahul is now hosting", "Priya dropped out").
 *
 * Host migration is a NORMAL event in this architecture — everyone is already
 * connected to everyone, so a new host is a hand-off, not a crash. The copy and
 * the colours deliberately avoid red for migration; red is reserved for "we are
 * actually offline".
 *
 * Presentation only: no network access, no store access, everything via props.
 */

import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useEffect } from 'react';

import { UI } from '@/game/rendering/palette';
import type { ConnectionState, PeerInfo, SignalingStatus } from '@/types';
import { isLiveConnection } from '@/types';
import { cn } from '@/utils/cn';

// --- presentation thresholds (UI only; not gameplay tunables) ---------------
/** Median RTT at or below this reads as a "strong" link. */
const RTT_STRONG_MS = 90;
/** Median RTT at or below this reads as a "good" link. */
const RTT_GOOD_MS = 220;
/** How long a connection notice stays on screen before it dismisses itself. */
const NOTICE_TTL_MS = 5200;

export type LinkQuality = 'offline' | 'connecting' | 'weak' | 'good' | 'strong';

/** A one-line, non-alarming status message about the mesh. */
export interface ConnectionNotice {
  /** Stable id so re-renders do not restart the exit animation. */
  readonly id: string;
  readonly kind: 'host-migrated' | 'player-dropped' | 'player-returned' | 'info';
  /** Already-humanised copy, e.g. "Rahul is now hosting". */
  readonly message: string;
}

export interface ConnectionBadgeProps {
  readonly connection: ConnectionState;
  readonly peers: readonly PeerInfo[];
  readonly signaling?: SignalingStatus;
  /** Rendered as a dismissible banner under the pill. */
  readonly notice?: ConnectionNotice | null;
  /** Called when the notice auto-dismisses or the viewer dismisses it. */
  readonly onDismissNotice?: () => void;
  /** Set false to keep the pill only (used in tight layouts). */
  readonly showNotice?: boolean;
  readonly className?: string;
}

const QUALITY_COPY: Readonly<Record<LinkQuality, string>> = {
  offline: 'Offline',
  connecting: 'Connecting',
  weak: 'Weak link',
  good: 'Connected',
  strong: 'Strong link',
};

const QUALITY_BARS: Readonly<Record<LinkQuality, number>> = {
  offline: 0,
  connecting: 1,
  weak: 1,
  good: 2,
  strong: 3,
};

function qualityColor(quality: LinkQuality): string {
  if (quality === 'offline') return UI.bad;
  if (quality === 'weak') return UI.warn;
  if (quality === 'connecting') return UI.textMuted;
  return UI.good;
}

/** Median round-trip time across peers that have reported one. `null` when nobody has. */
export function medianRtt(peers: readonly PeerInfo[]): number | null {
  const samples: number[] = [];
  for (const peer of peers) {
    const rtt = peer.rttMs;
    if (rtt !== null && Number.isFinite(rtt)) samples.push(rtt);
  }
  if (samples.length === 0) return null;
  samples.sort((a, b) => a - b);
  const mid = Math.floor(samples.length / 2);
  const upper = samples[mid];
  if (upper === undefined) return null;
  if (samples.length % 2 === 1) return upper;
  const lower = samples[mid - 1];
  return lower === undefined ? upper : (lower + upper) / 2;
}

/** How many peer links can carry a message right now. */
export function livePeerCount(peers: readonly PeerInfo[]): number {
  let live = 0;
  for (const peer of peers) if (isLiveConnection(peer.state)) live += 1;
  return live;
}

/** Pure, unit-testable mapping from transport facts to the five display states. */
export function linkQualityFor(
  connection: ConnectionState,
  peers: readonly PeerInfo[],
  signaling?: SignalingStatus,
): LinkQuality {
  if (connection === 'failed' || connection === 'closed' || connection === 'disconnected') return 'offline';
  if (connection === 'idle' || connection === 'signaling' || connection === 'connecting') return 'connecting';
  if (connection === 'reconnecting') return 'weak';

  const live = livePeerCount(peers);
  if (peers.length > 0 && live === 0) return 'offline';
  if (live < peers.length) return 'weak';
  if (signaling === 'error') return 'weak';

  const rtt = medianRtt(peers);
  if (rtt === null) return signaling === 'degraded' ? 'good' : 'strong';
  if (rtt <= RTT_STRONG_MS) return 'strong';
  if (rtt <= RTT_GOOD_MS) return 'good';
  return 'weak';
}

function noticeAccent(kind: ConnectionNotice['kind']): string {
  if (kind === 'player-dropped') return UI.warn;
  if (kind === 'player-returned') return UI.good;
  return UI.accent;
}

function noticeIcon(kind: ConnectionNotice['kind']): string {
  if (kind === 'host-migrated') return '\u{1F451}';
  if (kind === 'player-dropped') return '\u{1F4E1}';
  if (kind === 'player-returned') return '\u{1F44B}';
  return 'ℹ️';
}

export function ConnectionBadge({
  connection,
  peers,
  signaling,
  notice,
  onDismissNotice,
  showNotice = true,
  className,
}: ConnectionBadgeProps): React.JSX.Element {
  const reduced = useReducedMotion() ?? false;
  const quality = linkQualityFor(connection, peers, signaling);
  const live = livePeerCount(peers);
  const rtt = medianRtt(peers);
  const color = qualityColor(quality);
  const filledBars = QUALITY_BARS[quality];

  const noticeId = notice?.id ?? null;
  useEffect(() => {
    if (noticeId === null || onDismissNotice === undefined) return undefined;
    const handle = window.setTimeout(onDismissNotice, NOTICE_TTL_MS);
    return () => window.clearTimeout(handle);
  }, [noticeId, onDismissNotice]);

  const peerLabel = live === 1 ? '1 peer' : `${live} peers`;
  const srLabel =
    rtt === null
      ? `${QUALITY_COPY[quality]}, ${peerLabel} connected`
      : `${QUALITY_COPY[quality]}, ${peerLabel} connected, ${Math.round(rtt)} milliseconds`;

  return (
    <div className={cn('flex flex-col items-end gap-1.5', className)}>
      <div
        className="flex items-center gap-2 rounded-full border border-white/10 bg-black/[0.35] px-2.5 py-1 backdrop-blur-md"
        title={srLabel}
      >
        <span className="sr-only" role="status">
          {srLabel}
        </span>

        <span aria-hidden="true" className="flex h-3.5 items-end gap-[2px]">
          {[0, 1, 2].map((index) => {
            const on = index < filledBars;
            return (
              <motion.span
                key={index}
                className="w-[3px] rounded-[1px]"
                style={{
                  height: `${5 + index * 4}px`,
                  backgroundColor: on ? color : 'rgba(255,255,255,0.18)',
                }}
                animate={
                  quality === 'connecting' && !reduced
                    ? { opacity: [0.35, 1, 0.35] }
                    : { opacity: 1 }
                }
                transition={
                  quality === 'connecting' && !reduced
                    ? { duration: 1.1, repeat: Infinity, delay: index * 0.12, ease: 'easeInOut' }
                    : { duration: 0.2 }
                }
              />
            );
          })}
        </span>

        <span aria-hidden="true" className="text-[11px] font-semibold tracking-wide" style={{ color }}>
          {QUALITY_COPY[quality]}
        </span>

        <span aria-hidden="true" className="text-[11px] font-medium text-white/40">
          {live > 0 ? `· ${peerLabel}` : '· solo'}
        </span>
      </div>

      {showNotice ? (
        <AnimatePresence initial={false}>
          {notice ? (
            <motion.div
              key={notice.id}
              role="status"
              aria-live="polite"
              initial={reduced ? { opacity: 0 } : { opacity: 0, y: -6, scale: 0.96 }}
              animate={reduced ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
              exit={reduced ? { opacity: 0 } : { opacity: 0, y: -4, scale: 0.98 }}
              transition={{ type: 'spring', stiffness: 420, damping: 32 }}
              className="flex max-w-[78vw] items-center gap-2 rounded-xl border px-3 py-1.5 backdrop-blur-md"
              style={{
                borderColor: `${noticeAccent(notice.kind)}44`,
                backgroundColor: `${noticeAccent(notice.kind)}1f`,
              }}
            >
              <span aria-hidden="true" className="text-sm leading-none">
                {noticeIcon(notice.kind)}
              </span>
              <span className="truncate text-[12px] font-medium text-white/90">{notice.message}</span>
              {onDismissNotice ? (
                <button
                  type="button"
                  onClick={onDismissNotice}
                  className="ml-1 shrink-0 rounded-md px-1 text-[12px] leading-none text-white/[0.45] transition-colors hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/60"
                  aria-label="Dismiss connection notice"
                >
                  {'×'}
                </button>
              ) : null}
            </motion.div>
          ) : null}
        </AnimatePresence>
      ) : null}
    </div>
  );
}

export default ConnectionBadge;
