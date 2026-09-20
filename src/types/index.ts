/**
 * Barrel for every shared type. Import from '@/types' everywhere:
 *   import type { GameState, ShotInput, PlayerId } from '@/types';
 *
 * Runtime helpers exported here (ok/err/asPlayerId/isLiveConnection) are tiny and
 * dependency-free, so importing the barrel never drags in three.js or React.
 */

export * from './core';
export * from './game';
export * from './multiplayer';
