/**
 * "Is another tab already playing as this player?"
 *
 * The resume hint lives in localStorage so a CLOSED tab can rejoin. But
 * localStorage is shared by every tab, so without a check a second tab would
 * adopt the first tab's playerId, both would claim one seat, and the room would
 * show one player instead of two.
 *
 * So before adopting a hint we ask out loud. Every live session answers probes
 * for the id it is using; if anyone answers, the newcomer mints a fresh identity
 * instead. BroadcastChannel is same-origin and instant, and it is already how
 * same-browser tabs find each other, so this costs nothing.
 *
 * If BroadcastChannel is unavailable the probe simply reports "not in use" —
 * degrading to the old behaviour rather than blocking a legitimate rejoin.
 */

const CHANNEL = 'fg.tabclaim';

interface ProbeMessage {
  readonly kind: 'probe' | 'held';
  readonly playerId: string;
}

function open(): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  try {
    return new BroadcastChannel(CHANNEL);
  } catch {
    return null;
  }
}

/**
 * Answer probes for `playerId` until the returned function is called.
 * Call this as soon as a session adopts an identity.
 */
export function holdIdentity(playerId: string): () => void {
  const channel = open();
  if (channel === null) return () => undefined;

  const onMessage = (event: MessageEvent): void => {
    const data = event.data as ProbeMessage | null;
    if (data === null || typeof data !== 'object') return;
    if (data.kind !== 'probe' || data.playerId !== playerId) return;
    try {
      channel.postMessage({ kind: 'held', playerId } satisfies ProbeMessage);
    } catch {
      // A closing channel is not worth reporting.
    }
  };

  channel.addEventListener('message', onMessage);
  return () => {
    try {
      channel.removeEventListener('message', onMessage);
      channel.close();
    } catch {
      // Ditto.
    }
  };
}

/**
 * True when a live tab answers for `playerId` within `timeoutMs`.
 *
 * Kept short: this sits directly in the join path, and a false "free" only costs
 * a duplicate-seat edge case, whereas a slow probe costs every joiner.
 */
export async function isIdentityHeld(playerId: string, timeoutMs = 220): Promise<boolean> {
  const channel = open();
  if (channel === null) return false;

  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (held: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        channel.removeEventListener('message', onMessage);
        channel.close();
      } catch {
        // Ignore.
      }
      resolve(held);
    };

    const onMessage = (event: MessageEvent): void => {
      const data = event.data as ProbeMessage | null;
      if (data === null || typeof data !== 'object') return;
      if (data.kind === 'held' && data.playerId === playerId) finish(true);
    };

    const timer = setTimeout(() => finish(false), timeoutMs);
    channel.addEventListener('message', onMessage);
    try {
      channel.postMessage({ kind: 'probe', playerId } satisfies ProbeMessage);
    } catch {
      finish(false);
    }
  });
}
