'use client';

/**
 * Confetti burst for sinking a putt.
 *
 * Fires when `trigger` changes to a new non-null value, so the caller just
 * passes something that changes once per celebration (a round index + player id
 * works well) rather than juggling booleans.
 *
 * Deliberately a plain 2D canvas, not three.js: it must be able to draw OVER the
 * whole screen including the HUD, it costs nothing to mount, and it is the one
 * effect that should still work if the 3D scene is unmounting behind it.
 *
 * No asset files — every particle is a rotated rounded rect drawn procedurally.
 * Honours `prefers-reduced-motion` by dropping to a brief, calm fade.
 */
import { useEffect, useRef } from 'react';

export interface ConfettiProps {
  /** Change this to fire a burst. `null` never fires. */
  readonly trigger: string | null;
  /** Ribbon colours — pass the players' colours so the celebration feels personal. */
  readonly colors: readonly string[];
  /** Roughly how many ribbons at full quality. */
  readonly count?: number;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  w: number;
  h: number;
  spin: number;
  angle: number;
  color: string;
  life: number;
}

const GRAVITY = 900; // px/s²
const DRAG = 0.86;
const LIFE_SECONDS = 2.6;

export function Confetti({ trigger, colors, count = 140 }: ConfettiProps): React.JSX.Element | null {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const particlesRef = useRef<Particle[]>([]);
  const lastRef = useRef<number>(0);
  const firedRef = useRef<string | null>(null);

  useEffect(() => {
    if (trigger === null || trigger === firedRef.current) return;
    firedRef.current = trigger;

    const canvas = canvasRef.current;
    if (canvas === null) return;
    const ctx = canvas.getContext('2d');
    if (ctx === null) return;

    const reduced =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const dpr = Math.min(2, typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1);
    const w = canvas.clientWidth || 1;
    const h = canvas.clientHeight || 1;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const palette = colors.length > 0 ? colors : ['#FFC53D', '#3FA7DC', '#7FC24A', '#F2789F'];
    const total = reduced ? Math.min(28, count) : count;

    // Two launchers, angled inward, so the burst reads as a celebration rather
    // than rain. Randomness here is presentation only — never simulation.
    const particles: Particle[] = [];
    for (let i = 0; i < total; i += 1) {
      const fromLeft = i % 2 === 0;
      const spread = (Math.random() - 0.5) * 1.1;
      const speed = 620 + Math.random() * 520;
      const angle = (fromLeft ? -Math.PI / 3 : (-Math.PI * 2) / 3) + spread;
      particles.push({
        x: fromLeft ? w * 0.08 : w * 0.92,
        y: h * 0.86,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        w: 6 + Math.random() * 7,
        h: 9 + Math.random() * 12,
        spin: (Math.random() - 0.5) * 12,
        angle: Math.random() * Math.PI,
        color: palette[i % palette.length] ?? '#FFC53D',
        life: LIFE_SECONDS * (reduced ? 0.55 : 0.8 + Math.random() * 0.5),
      });
    }
    particlesRef.current = particles;
    lastRef.current = 0;

    const frame = (now: number): void => {
      const last = lastRef.current === 0 ? now : lastRef.current;
      lastRef.current = now;
      const dt = Math.min(0.05, (now - last) / 1000);

      ctx.clearRect(0, 0, w, h);
      let alive = 0;

      for (const p of particlesRef.current) {
        if (p.life <= 0) continue;
        p.life -= dt;
        p.vy += GRAVITY * dt;
        p.vx *= 1 - (1 - DRAG) * dt * 6;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.angle += p.spin * dt;
        if (p.y > h + 40) continue;
        alive += 1;

        const fade = Math.max(0, Math.min(1, p.life / 0.6));
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.angle);
        ctx.globalAlpha = fade;
        ctx.fillStyle = p.color;
        // Flip the ribbon on its axis as it spins, so it reads as paper.
        const squash = Math.abs(Math.cos(p.angle * 1.7));
        ctx.fillRect(-p.w / 2, (-p.h / 2) * squash, p.w, Math.max(1.5, p.h * squash));
        ctx.restore();
      }

      if (alive > 0) {
        rafRef.current = requestAnimationFrame(frame);
      } else {
        ctx.clearRect(0, 0, w, h);
        rafRef.current = null;
      }
    };

    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(frame);
  }, [trigger, colors, count]);

  useEffect(
    () => () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    },
    [],
  );

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-50 h-full w-full"
    />
  );
}

export default Confetti;
