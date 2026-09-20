/**
 * Shot input barrel.
 *
 * One hook owns every way a human can take a shot (mouse, touch, pen), and it
 * emits exactly what the lockstep network sends: a normalised aim vector and a
 * 0..1 power. Import from '@/game/input'.
 */

export { AIM_INPUT, AIM_SURFACE_STYLE, HAPTIC_PATTERNS, triggerHaptic, useAimControls } from './useAimControls';

export type {
  AimInputConfig,
  AimPointerHandlers,
  AimState,
  HapticKind,
  UseAimControlsOptions,
  UseAimControlsResult,
} from './useAimControls';
