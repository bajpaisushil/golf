/**
 * Procedural sound effects. ZERO audio files.
 *
 * Every sound is synthesised on the fly from oscillators, a short noise buffer
 * and envelopes — nothing is downloaded, nothing is licensed, nothing is cached.
 * That is a hard requirement of the brief, and it also means the first shot
 * makes a noise before a sample could even have finished loading.
 *
 * AUTOPLAY POLICY: browsers refuse to start an AudioContext outside a user
 * gesture, so the context is created LAZILY. Call {@link initAudio} from the
 * first pointerdown/keydown (it is idempotent and cheap); every `play*` function
 * also tries to resume a suspended context, and all of them are no-ops when
 * audio is unavailable or muted. Nothing here ever throws, and nothing runs at
 * import time — this module is safe to pull into a server render.
 *
 * The sound palette (all presentation, so trig/random are fine here):
 *   putt      — filtered noise transient + a pitch-swept body, harder = brighter
 *   bounce    — short wooden click, pitch rises with impact speed
 *   sand      — dull low-passed thud
 *   water     — a rising "plop" with a fast decay
 *   holed     — a small major arpeggio, the only genuinely happy sound
 *   round     — a five-note flourish for the end of a round
 *   ui        — a tiny tick for taps, and a soft chime for your turn
 */

import { loadPrefs, patchPrefs } from './storage';

/** Master trim so the game never blasts anybody: everything sits under this. */
const MASTER_GAIN = 0.32;

/** Frames of white noise reused by every noisy sound (0.35 s is plenty). */
const NOISE_SECONDS = 0.35;

interface AudioGlobals {
  readonly AudioContext?: typeof AudioContext;
  readonly webkitAudioContext?: typeof AudioContext;
}

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let noiseBuffer: AudioBuffer | null = null;
let enabled = true;
let prefsLoaded = false;
let unavailable = false;

// ---------------------------------------------------------------------------
// Context lifecycle
// ---------------------------------------------------------------------------

/** Reads the stored mute preference once, lazily (storage is SSR-unsafe eagerly). */
function ensurePrefs(): void {
  if (prefsLoaded) return;
  prefsLoaded = true;
  try {
    enabled = loadPrefs().sound;
  } catch {
    enabled = true;
  }
}

/** Creates (or returns) the AudioContext. Null when audio is impossible here. */
function ensureContext(): AudioContext | null {
  if (unavailable) return null;
  if (ctx !== null) return ctx;
  if (typeof window === 'undefined') return null;

  try {
    const globals = window as unknown as AudioGlobals;
    const Ctor = globals.AudioContext ?? globals.webkitAudioContext;
    if (Ctor === undefined) {
      unavailable = true;
      return null;
    }
    const created = new Ctor();
    const gain = created.createGain();
    gain.gain.value = MASTER_GAIN;
    gain.connect(created.destination);
    ctx = created;
    master = gain;
    return ctx;
  } catch {
    unavailable = true;
    return null;
  }
}

/** Nudges a context that the browser suspended (tab blur, autoplay policy). */
function resumeIfNeeded(context: AudioContext): void {
  if (context.state !== 'suspended') return;
  try {
    void context.resume();
  } catch {
    // Nothing to do — the next user gesture will try again.
  }
}

/**
 * Prepares audio. Safe (and free) to call on every user gesture; the first call
 * creates the context, the rest just resume it. Returns whether audio is usable.
 */
export function initAudio(): boolean {
  ensurePrefs();
  const context = ensureContext();
  if (context === null) return false;
  resumeIfNeeded(context);
  return true;
}

/** True when a context exists and the player has not muted the game. */
export function isAudioReady(): boolean {
  ensurePrefs();
  return enabled && !unavailable && ctx !== null;
}

/** Current mute preference. */
export function isSoundEnabled(): boolean {
  ensurePrefs();
  return enabled;
}

/**
 * Turns sound on or off and remembers the choice in localStorage.
 * Turning it on from a user gesture also boots the context.
 */
export function setSoundEnabled(on: boolean): void {
  ensurePrefs();
  enabled = on === true;
  try {
    patchPrefs({ sound: enabled });
  } catch {
    // Preference is in-memory only when storage is blocked; the game still works.
  }

  if (enabled) initAudio();

  // `bus()` already refuses to start new voices while muted; this fades the
  // master bus so a sound already in flight does not ring out after the tap.
  if (ctx !== null && master !== null) {
    try {
      const now = ctx.currentTime;
      master.gain.cancelScheduledValues(now);
      master.gain.setValueAtTime(master.gain.value, now);
      master.gain.linearRampToValueAtTime(enabled ? MASTER_GAIN : 0, now + 0.04);
    } catch {
      // ignore
    }
  }
}

/** Releases the AudioContext. Call on unmount of the game screen, not on route change. */
export function disposeAudio(): void {
  const context = ctx;
  ctx = null;
  master = null;
  noiseBuffer = null;
  if (context === null) return;
  try {
    void context.close();
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Synthesis primitives
// ---------------------------------------------------------------------------

/** The live context + master bus, or null when a sound must be skipped. */
function bus(): { context: AudioContext; out: GainNode } | null {
  ensurePrefs();
  if (!enabled) return null;
  const context = ensureContext();
  if (context === null || master === null) return null;
  resumeIfNeeded(context);
  if (context.state === 'suspended') return null; // no gesture yet — stay silent
  return { context, out: master };
}

/** Shared white-noise buffer, generated once. `Math.random` is fine: presentation. */
function noise(context: AudioContext): AudioBuffer | null {
  if (noiseBuffer !== null) return noiseBuffer;
  try {
    const frames = Math.floor(context.sampleRate * NOISE_SECONDS);
    const buffer = context.createBuffer(1, Math.max(1, frames), context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) {
      data[i] = Math.random() * 2 - 1;
    }
    noiseBuffer = buffer;
    return noiseBuffer;
  } catch {
    return null;
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * One enveloped tone. `type` picks the timbre, the frequency sweeps from
 * `fromHz` to `toHz`, and the gain does a fast attack + exponential decay.
 */
function tone(
  context: AudioContext,
  out: GainNode,
  options: {
    readonly type: OscillatorType;
    readonly fromHz: number;
    readonly toHz: number;
    readonly gain: number;
    readonly attack: number;
    readonly duration: number;
    readonly delay?: number;
  },
): void {
  try {
    const start = context.currentTime + (options.delay ?? 0);
    const osc = context.createOscillator();
    const env = context.createGain();

    osc.type = options.type;
    osc.frequency.setValueAtTime(Math.max(20, options.fromHz), start);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, options.toHz), start + options.duration);

    env.gain.setValueAtTime(0.0001, start);
    env.gain.exponentialRampToValueAtTime(Math.max(0.0002, options.gain), start + options.attack);
    env.gain.exponentialRampToValueAtTime(0.0001, start + options.duration);

    osc.connect(env);
    env.connect(out);
    osc.start(start);
    osc.stop(start + options.duration + 0.02);
  } catch {
    // A single failed voice must never break a shot.
  }
}

/** One enveloped noise burst through a filter — the "material" of an impact. */
function burst(
  context: AudioContext,
  out: GainNode,
  options: {
    readonly filter: BiquadFilterType;
    readonly fromHz: number;
    readonly toHz: number;
    readonly q: number;
    readonly gain: number;
    readonly duration: number;
    readonly delay?: number;
  },
): void {
  const buffer = noise(context);
  if (buffer === null) return;
  try {
    const start = context.currentTime + (options.delay ?? 0);
    const source = context.createBufferSource();
    const filter = context.createBiquadFilter();
    const env = context.createGain();

    source.buffer = buffer;
    filter.type = options.filter;
    filter.Q.value = options.q;
    filter.frequency.setValueAtTime(Math.max(40, options.fromHz), start);
    filter.frequency.exponentialRampToValueAtTime(Math.max(40, options.toHz), start + options.duration);

    env.gain.setValueAtTime(Math.max(0.0002, options.gain), start);
    env.gain.exponentialRampToValueAtTime(0.0001, start + options.duration);

    source.connect(filter);
    filter.connect(env);
    env.connect(out);
    source.start(start);
    source.stop(start + options.duration + 0.02);
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// The sound palette
// ---------------------------------------------------------------------------

/**
 * The putt. A tight noise transient (club face) plus a short pitch-swept body
 * (ball leaving). `power` is the 0..1 shot power: harder putts are brighter,
 * louder and a touch longer.
 */
export function playPutt(power: number): void {
  const b = bus();
  if (b === null) return;
  const p = clamp01(power);

  burst(b.context, b.out, {
    filter: 'bandpass',
    fromHz: 1600 + p * 2600,
    toHz: 700 + p * 900,
    q: 1.1,
    gain: 0.22 + p * 0.3,
    duration: 0.05 + p * 0.03,
  });

  tone(b.context, b.out, {
    type: 'triangle',
    fromHz: 340 + p * 320,
    toHz: 110 + p * 50,
    gain: 0.16 + p * 0.22,
    attack: 0.004,
    duration: 0.1 + p * 0.09,
  });
}

/**
 * A wall bounce. `speed` is the impact speed in course units per second; it is
 * normalised against a typical fast impact so loud hits stay in range.
 */
export function playBounce(speed: number): void {
  const b = bus();
  if (b === null) return;
  const s = clamp01(speed / 70);

  burst(b.context, b.out, {
    filter: 'bandpass',
    fromHz: 900 + s * 1500,
    toHz: 420 + s * 500,
    q: 2.4,
    gain: 0.1 + s * 0.24,
    duration: 0.035,
  });

  tone(b.context, b.out, {
    type: 'square',
    fromHz: 240 + s * 420,
    toHz: 150 + s * 160,
    gain: 0.05 + s * 0.1,
    attack: 0.003,
    duration: 0.05,
  });
}

/** A bumper kick: brighter and springier than a wall, because it adds energy. */
export function playBumper(speed: number): void {
  const b = bus();
  if (b === null) return;
  const s = clamp01(speed / 70);

  tone(b.context, b.out, {
    type: 'sine',
    fromHz: 420 + s * 260,
    toHz: 880 + s * 520,
    gain: 0.16 + s * 0.16,
    attack: 0.004,
    duration: 0.13,
  });
  burst(b.context, b.out, {
    filter: 'highpass',
    fromHz: 2200,
    toHz: 5200,
    q: 0.7,
    gain: 0.1 + s * 0.12,
    duration: 0.05,
  });
}

/** Sand: a dull, dark thud with no tone in it at all. */
export function playSand(): void {
  const b = bus();
  if (b === null) return;
  burst(b.context, b.out, {
    filter: 'lowpass',
    fromHz: 900,
    toHz: 220,
    q: 0.6,
    gain: 0.26,
    duration: 0.18,
  });
}

/** Water: the classic plop — a fast UPWARD sweep with a very short tail. */
export function playWater(): void {
  const b = bus();
  if (b === null) return;
  tone(b.context, b.out, {
    type: 'sine',
    fromHz: 180,
    toHz: 900,
    gain: 0.3,
    attack: 0.006,
    duration: 0.14,
  });
  burst(b.context, b.out, {
    filter: 'bandpass',
    fromHz: 1800,
    toHz: 600,
    q: 1.8,
    gain: 0.14,
    duration: 0.1,
    delay: 0.02,
  });
}

/** A boost pad: a short upward whoosh. */
export function playBoost(): void {
  const b = bus();
  if (b === null) return;
  burst(b.context, b.out, {
    filter: 'bandpass',
    fromHz: 600,
    toHz: 3400,
    q: 1.2,
    gain: 0.18,
    duration: 0.22,
  });
}

/**
 * Holing out: a small major arpeggio (root, third, fifth, octave). The happiest
 * sound in the game, and the only one that lasts more than a quarter of a second.
 */
export function playHoled(): void {
  const b = bus();
  if (b === null) return;
  const notes: readonly number[] = [523.25, 659.25, 783.99, 1046.5];
  for (let i = 0; i < notes.length; i += 1) {
    const hz = notes[i];
    if (hz === undefined) continue;
    tone(b.context, b.out, {
      type: 'sine',
      fromHz: hz,
      toHz: hz,
      gain: 0.2 - i * 0.02,
      attack: 0.008,
      duration: 0.3,
      delay: i * 0.075,
    });
  }
  burst(b.context, b.out, {
    filter: 'lowpass',
    fromHz: 700,
    toHz: 200,
    q: 0.5,
    gain: 0.12,
    duration: 0.09,
  });
}

/** End of a round: a five-note flourish with a soft shimmer underneath. */
export function playRoundComplete(): void {
  const b = bus();
  if (b === null) return;
  const notes: readonly number[] = [392.0, 523.25, 659.25, 783.99, 1046.5];
  for (let i = 0; i < notes.length; i += 1) {
    const hz = notes[i];
    if (hz === undefined) continue;
    tone(b.context, b.out, {
      type: 'triangle',
      fromHz: hz,
      toHz: hz,
      gain: 0.17,
      attack: 0.01,
      duration: 0.42,
      delay: i * 0.1,
    });
  }
  tone(b.context, b.out, {
    type: 'sine',
    fromHz: 196,
    toHz: 261.63,
    gain: 0.1,
    attack: 0.05,
    duration: 0.9,
  });
}

/** Your turn, in co-op: two gentle rising notes, never startling. */
export function playYourTurn(): void {
  const b = bus();
  if (b === null) return;
  tone(b.context, b.out, {
    type: 'sine',
    fromHz: 587.33,
    toHz: 587.33,
    gain: 0.14,
    attack: 0.01,
    duration: 0.2,
  });
  tone(b.context, b.out, {
    type: 'sine',
    fromHz: 880,
    toHz: 880,
    gain: 0.12,
    attack: 0.01,
    duration: 0.24,
    delay: 0.11,
  });
}

/** A tiny UI tick for buttons and taps. */
export function playTick(): void {
  const b = bus();
  if (b === null) return;
  burst(b.context, b.out, {
    filter: 'highpass',
    fromHz: 2600,
    toHz: 3400,
    q: 0.8,
    gain: 0.07,
    duration: 0.02,
  });
}

/** Something went wrong (bad room code, refused shot): one low, soft blip. */
export function playError(): void {
  const b = bus();
  if (b === null) return;
  tone(b.context, b.out, {
    type: 'sine',
    fromHz: 300,
    toHz: 170,
    gain: 0.16,
    attack: 0.006,
    duration: 0.18,
  });
}

/** A player joined the room: two quick friendly notes. */
export function playJoin(): void {
  const b = bus();
  if (b === null) return;
  tone(b.context, b.out, {
    type: 'triangle',
    fromHz: 660,
    toHz: 660,
    gain: 0.12,
    attack: 0.008,
    duration: 0.13,
  });
  tone(b.context, b.out, {
    type: 'triangle',
    fromHz: 990,
    toHz: 990,
    gain: 0.1,
    attack: 0.008,
    duration: 0.16,
    delay: 0.08,
  });
}

/** Names of every sound, for a generic `play(name)` dispatch from the renderer. */
export type SoundName =
  | 'putt'
  | 'bounce'
  | 'bumper'
  | 'sand'
  | 'water'
  | 'boost'
  | 'holed'
  | 'round-complete'
  | 'your-turn'
  | 'tick'
  | 'error'
  | 'join';

/**
 * Generic dispatch, so a shot-event loop can do `play(event.kind)` without a
 * switch of its own. `intensity` is the 0..1 power for a putt, or the impact
 * speed for a bounce.
 */
export function play(name: SoundName, intensity = 0.5): void {
  switch (name) {
    case 'putt':
      playPutt(intensity);
      return;
    case 'bounce':
      playBounce(intensity);
      return;
    case 'bumper':
      playBumper(intensity);
      return;
    case 'sand':
      playSand();
      return;
    case 'water':
      playWater();
      return;
    case 'boost':
      playBoost();
      return;
    case 'holed':
      playHoled();
      return;
    case 'round-complete':
      playRoundComplete();
      return;
    case 'your-turn':
      playYourTurn();
      return;
    case 'tick':
      playTick();
      return;
    case 'error':
      playError();
      return;
    case 'join':
      playJoin();
      return;
    default:
      return;
  }
}
