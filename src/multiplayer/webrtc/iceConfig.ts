/**
 * ICE configuration for every RTCPeerConnection in the mesh.
 *
 * ---------------------------------------------------------------------------
 * TURN IS DELIBERATELY UNSET.
 * ---------------------------------------------------------------------------
 * STUN is free: a STUN server only tells a browser what its public
 * ip:port looks like from the outside, so the two browsers can then talk
 * DIRECTLY to each other. That costs the STUN operator a few UDP packets, which
 * is why several large operators run open ones.
 *
 * TURN is NOT free: a TURN server RELAYS every byte of the call, so it is billed
 * by the gigabyte. Friend Golf is explicitly a zero-cost, zero-backend project,
 * so the MVP ships with STUN only.
 *
 * The honest trade-off of shipping without TURN: roughly 5-15% of real-world
 * pairs (symmetric NAT, some corporate / carrier-grade-NAT mobile networks)
 * cannot be connected by STUN alone, and those players will see the link fail.
 * Everybody else - home wifi, most mobile networks, tethering - connects fine.
 *
 * If a TURN server is ever added, nothing here needs rewriting: set
 * NEXT_PUBLIC_TURN_URL (+ username/credential) at build time and it is picked up
 * automatically as a FALLBACK after the STUN servers. It stays OPTIONAL forever.
 *
 * This module is pure data. It touches no browser API, so it is safe to import
 * during SSR / static export; `RTCIceServer` and `RTCConfiguration` are
 * types-only (lib.dom) and disappear at runtime.
 */

/**
 * Free, public, no-signup STUN servers.
 *
 * Several are listed on purpose: if one is down or blocked the browser simply
 * uses the next, and host candidates (same-LAN play) work with none of them.
 * These are contacted ONLY to discover our own public address - no game data,
 * no identifiers and no room codes ever reach them.
 */
export const DEFAULT_STUN_URLS: readonly string[] = [
  'stun:stun.l.google.com:19302',
  'stun:stun1.l.google.com:19302',
  'stun:stun.cloudflare.com:3478',
  'stun:stun.nextcloud.com:443',
];

/**
 * Next.js inlines `process.env.NEXT_PUBLIC_*` at BUILD time, and only when the
 * property is written as a full literal. Never build these names dynamically -
 * `process.env['NEXT_PUBLIC_' + x]` would be `undefined` in the static export.
 */
function envValue(raw: string | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Splits a comma / whitespace separated env list into clean entries. */
function parseUrlList(raw: string | undefined): readonly string[] {
  const value = envValue(raw);
  if (value === null) return [];
  const out: string[] = [];
  for (const part of value.split(',')) {
    const url = part.trim();
    if (url.length > 0 && !out.includes(url)) out.push(url);
  }
  return out;
}

/** Extra STUN servers from the environment, appended to the built-in list. */
function extraStunUrls(): readonly string[] {
  return parseUrlList(process.env.NEXT_PUBLIC_STUN_URLS);
}

/** TURN urls from the environment. Empty for the free MVP. */
function turnUrls(): readonly string[] {
  return parseUrlList(process.env.NEXT_PUBLIC_TURN_URL);
}

/** True when this build was given a TURN relay. False for the free MVP. */
export function hasTurn(): boolean {
  return turnUrls().length > 0;
}

/**
 * The ICE server list handed to every RTCPeerConnection.
 *
 * Order matters to browsers only as a hint; candidates from every server are
 * gathered in parallel and the best (host > srflx > relay) pair wins.
 */
export function getIceServers(): RTCIceServer[] {
  const stun: string[] = [];
  for (const url of DEFAULT_STUN_URLS) if (!stun.includes(url)) stun.push(url);
  for (const url of extraStunUrls()) if (!stun.includes(url)) stun.push(url);

  // One entry with many urls keeps the gathering phase cheap.
  const servers: RTCIceServer[] = [{ urls: stun }];

  const turn = turnUrls();
  if (turn.length > 0) {
    // OPTIONAL paid fallback - see the file header. Unset by default.
    const username = envValue(process.env.NEXT_PUBLIC_TURN_USERNAME);
    const credential = envValue(process.env.NEXT_PUBLIC_TURN_CREDENTIAL);
    const server: RTCIceServer = { urls: [...turn] };
    if (username !== null) server.username = username;
    if (credential !== null) server.credential = credential;
    servers.push(server);
  }

  return servers;
}

/**
 * Full RTCConfiguration.
 *
 * - `bundlePolicy: 'max-bundle'` - one transport for everything. We only ever
 *   open a single DataChannel, so this halves the candidates to gather.
 * - `rtcpMuxPolicy: 'require'` - same reason; no separate RTCP port.
 * - `iceCandidatePoolSize: 2` - pre-gathers a couple of candidates before the
 *   offer is created, which shaves a beat off the first connection.
 */
export function getRtcConfiguration(): RTCConfiguration {
  return {
    iceServers: getIceServers(),
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require',
    iceCandidatePoolSize: 2,
    iceTransportPolicy: 'all',
  };
}

/** One-line summary for the diagnostics overlay. Contains no credentials. */
export function describeIceConfig(): string {
  const stunCount = DEFAULT_STUN_URLS.length + extraStunUrls().length;
  return hasTurn() ? `${stunCount} STUN + TURN fallback` : `${stunCount} STUN, no TURN (free mode)`;
}
