/**
 * Class-name joiner used across every component.
 *
 * Thin wrapper over `clsx` so the whole UI has one import path for conditional
 * classes. Kept separate from `utils/index` because components import it on a
 * hot path and it must stay free of any browser-only dependency.
 */
import clsx, { type ClassValue } from 'clsx';

export function cn(...inputs: readonly ClassValue[]): string {
  return clsx(inputs);
}

export type { ClassValue };
export default cn;
