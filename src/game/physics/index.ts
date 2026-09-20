/**
 * Deterministic 2D physics.
 *
 * Import from `@/game/physics` everywhere:
 *   import { simulateShot, aimFromDrag, normalize } from '@/game/physics';
 *
 * Nothing in this package touches the DOM, three.js, React or the network, so it
 * is safe to import from the reducer, from tests and from SSR code paths.
 */

export * from './vec';
export * from './collision';
export * from './simulate';
