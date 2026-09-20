'use client';

/**
 * PowerMeter — the live readout while the player drags back on the slingshot.
 *
 * It answers three questions in one glance, without covering the ball:
 *   • how hard am I about to hit it?   (the ring gauge + the big number)
 *   • which way will it go?            (the needle — drawn straight from the
 *                                       NORMALISED aim vector, never an angle)
 *   • is this shot going to count?     (below PHYSICS.MIN_POWER it says so)
 *
 * The aim vector arrives already normalised and already flipped to the opposite
 * of the drag, so this component never does any trigonometry: the needle tip is
 * simply `centre + aim * radius`, and the ring fill is a stroke-dasharray.
 *
 * Pure presentation. Mounts only while aiming, so it costs nothing at rest.
 */

import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';

import { PHYSICS } from '@/game/config';
import type { AimState } from '@/game/input/useAimControls';
import { mixHex, withAlpha } from '@/game/rendering/palette';
import type { Hex } from '@/types';
import { cn } from '@/utils/cn';

/** SVG viewbox is 100x100; everything below is in those units. */
const DIAL_CENTER = 50;
const RING_RADIUS = 40;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
const NEEDLE_LENGTH = 30;
const NEEDLE_HEAD = 6;

/** Power at which the gauge switches from "controlled" to "committed" colouring. */
const HOT_POWER = 0.68;

/** Blends the player colour toward the danger tone as power climbs. */
export function powerColor(power: number, base: Hex): Hex {
  const t = power <= HOT_POWER ? 0 : (power - HOT_POWER) / (1 - HOT_POWER);
  return mixHex(base, '#FF6B4A', Math.max(0, Math.min(1, t)) * 0.85);
}

export interface PowerMeterProps {
  /** `null` (or inactive) hides the whole component. */
  readonly aim: AimState | null;
  /** The shooting player's ball colour, so the gauge belongs to them. */
  readonly color: Hex;
  /** Extra copy under the dial, e.g. "Aim with ← → · Enter to putt". */
  readonly hint?: string;
  readonly className?: string;
}

export function PowerMeter({ aim, color, hint, className }: PowerMeterProps): React.JSX.Element {
  const reduced = useReducedMotion() ?? false;
  const visible = aim !== null && aim.active;

  const power = aim ? Math.max(0, Math.min(1, aim.power)) : 0;
  const percent = Math.round(power * 100);
  const valid = aim ? aim.valid : false;
  const tint = powerColor(power, color);

  const needleX = aim ? DIAL_CENTER + aim.aim.x * NEEDLE_LENGTH : DIAL_CENTER;
  const needleY = aim ? DIAL_CENTER + aim.aim.y * NEEDLE_LENGTH : DIAL_CENTER;
  // Perpendicular of the aim vector — still no trig, just a component swap.
  const perpX = aim ? -aim.aim.y : 0;
  const perpY = aim ? aim.aim.x : 0;
  const headTipX = aim ? DIAL_CENTER + aim.aim.x * (NEEDLE_LENGTH + NEEDLE_HEAD) : DIAL_CENTER;
  const headTipY = aim ? DIAL_CENTER + aim.aim.y * (NEEDLE_LENGTH + NEEDLE_HEAD) : DIAL_CENTER;
  const headLeftX = needleX + perpX * (NEEDLE_HEAD * 0.55);
  const headLeftY = needleY + perpY * (NEEDLE_HEAD * 0.55);
  const headRightX = needleX - perpX * (NEEDLE_HEAD * 0.55);
  const headRightY = needleY - perpY * (NEEDLE_HEAD * 0.55);

  const minPercent = Math.round(PHYSICS.MIN_POWER * 100);

  return (
    <AnimatePresence>
      {visible ? (
        <motion.div
          key="power-meter"
          initial={reduced ? { opacity: 0 } : { opacity: 0, y: 14, scale: 0.94 }}
          animate={reduced ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
          exit={reduced ? { opacity: 0 } : { opacity: 0, y: 10, scale: 0.96 }}
          transition={{ type: 'spring', stiffness: 460, damping: 34 }}
          className={cn(
            'pointer-events-none select-none rounded-2xl border border-white/10 bg-black/[0.45] p-3 backdrop-blur-xl',
            className,
          )}
          style={{ boxShadow: `0 10px 40px -18px ${withAlpha(tint, 0.9)}` }}
        >
          <div className="flex items-center gap-3">
            <div className="relative h-[68px] w-[68px] shrink-0">
              <svg viewBox="0 0 100 100" className="h-full w-full -rotate-90" aria-hidden="true">
                <circle
                  cx={DIAL_CENTER}
                  cy={DIAL_CENTER}
                  r={RING_RADIUS}
                  fill="none"
                  stroke="rgba(255,255,255,0.12)"
                  strokeWidth={9}
                />
                <circle
                  cx={DIAL_CENTER}
                  cy={DIAL_CENTER}
                  r={RING_RADIUS}
                  fill="none"
                  stroke={tint}
                  strokeWidth={9}
                  strokeLinecap="round"
                  strokeDasharray={`${power * RING_CIRCUMFERENCE} ${RING_CIRCUMFERENCE}`}
                />
              </svg>

              <svg viewBox="0 0 100 100" className="absolute inset-0 h-full w-full" aria-hidden="true">
                <line
                  x1={DIAL_CENTER}
                  y1={DIAL_CENTER}
                  x2={needleX}
                  y2={needleY}
                  stroke={valid ? tint : 'rgba(255,255,255,0.35)'}
                  strokeWidth={4}
                  strokeLinecap="round"
                />
                <polygon
                  points={`${headTipX},${headTipY} ${headLeftX},${headLeftY} ${headRightX},${headRightY}`}
                  fill={valid ? tint : 'rgba(255,255,255,0.35)'}
                />
                <circle cx={DIAL_CENTER} cy={DIAL_CENTER} r={4.5} fill="rgba(255,255,255,0.9)" />
              </svg>
            </div>

            <div className="min-w-[104px]">
              <div className="flex items-baseline gap-1">
                <span
                  className="font-mono text-[28px] font-bold leading-none tabular-nums"
                  style={{ color: valid ? tint : 'rgba(255,255,255,0.5)' }}
                >
                  {percent}
                </span>
                <span className="text-[13px] font-semibold text-white/40">%</span>
              </div>

              <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                <div
                  className="h-full rounded-full"
                  style={{ width: `${percent}%`, backgroundColor: tint }}
                />
              </div>

              <p
                className="mt-1.5 text-[10.5px] font-semibold uppercase tracking-[0.12em]"
                style={{ color: valid ? 'rgba(255,255,255,0.62)' : '#FFB86B' }}
              >
                {valid ? 'Release to putt' : `Pull past ${minPercent}%`}
              </p>
            </div>
          </div>

          {hint ? <p className="mt-2 text-[10.5px] leading-tight text-white/[0.35]">{hint}</p> : null}

          <span className="sr-only" aria-live="polite">
            {valid ? `Power ${percent} percent` : 'Too soft, the shot will be cancelled'}
          </span>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

export default PowerMeter;
