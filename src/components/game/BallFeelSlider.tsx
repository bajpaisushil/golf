'use client';

import { ballFeelFromSlider, sliderFromBallFeel } from '@/game/config';

/**
 * Ball feel, most rigid to most volatile.
 *
 * This DOES change how the ball behaves — rolling resistance and how much bite
 * the rails have — not just how it looks. It is a room-wide rule set by the
 * host and synced to everyone, so all players share identical physics; it is
 * never a private advantage.
 *
 * Both ends stay playable by construction: full force crosses the whole course
 * at either end, most volatile keeps working the walls, and the gentlest tap
 * still moves on most rigid. See FEEL_PHYSICS and feel.test.ts.
 *
 * Deliberately shows NO number — it is a feel, not a statistic, and a number
 * invites people to hunt for a "best" value that does not exist.
 */
export function BallFeelSlider({
  value,
  onChange,
}: {
  readonly value: number;
  readonly onChange: ((value: number) => void) | null;
}): React.JSX.Element | null {
  if (onChange === null) return null;
  return (
    <div className="mt-4">
      <label
        htmlFor="fg-smoothness"
        className="mb-1.5 block text-[10.5px] font-bold uppercase tracking-[0.16em] text-white/[0.35]"
      >
        Ball feel
      </label>
      <input
        id="fg-smoothness"
        type="range"
        min={0}
        max={100}
        step={1}
        value={Math.round(sliderFromBallFeel(value) * 100)}
        onChange={(event) => onChange(ballFeelFromSlider(Number(event.target.value) / 100))}
        className="h-2 w-full cursor-pointer appearance-none rounded-full bg-white/10 accent-[#4FD1C5]"
        aria-describedby="fg-smoothness-help"
      />
      <div className="mt-1 flex justify-between text-[10px] font-medium text-white/[0.35]">
        <span>Most rigid</span>
        <span>Most volatile</span>
      </div>
      <p id="fg-smoothness-help" className="mt-1 text-[10.5px] leading-snug text-white/[0.3]">
        How the ball rolls and how much the walls bite. Same for everyone in the room.
      </p>
    </div>
  );
}

export default BallFeelSlider;
