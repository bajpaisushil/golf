/**
 * Barrel for the in-game UI.
 *
 * Import from '@/components/game' everywhere:
 *   import { GameScreen } from '@/components/game';
 *
 * NOTE: this barrel re-exports `GameScreen`, which owns the
 * `next/dynamic(..., { ssr: false })` import of the three.js canvas. Pulling any
 * symbol from here into the home screen would put three.js on the critical path,
 * so the home/lobby surfaces must import the components they need directly, or
 * not at all.
 */

export { ConnectionBadge, linkQualityFor, livePeerCount, medianRtt } from './ConnectionBadge';
export type { ConnectionBadgeProps, ConnectionNotice, LinkQuality } from './ConnectionBadge';

export { EndGameDialog } from './EndGameDialog';
export type { EndGameDialogProps } from './EndGameDialog';

export { GameOverScreen } from './GameOverScreen';
export type { GameOverScreenProps } from './GameOverScreen';

export { GameScreen } from './GameScreen';
export type { GameScreenProps } from './GameScreen';

export { Hud } from './Hud';
export type { HudProps } from './Hud';

export { OpponentGrid, holeProgress } from './OpponentGrid';
export type { OpponentBoard, OpponentGridProps } from './OpponentGrid';

export { PlayerRail } from './PlayerRail';
export type { PlayerRailProps } from './PlayerRail';

export { PowerMeter, powerColor } from './PowerMeter';
export type { PowerMeterProps } from './PowerMeter';

export { RoundSummary } from './RoundSummary';
export type { RoundSummaryProps } from './RoundSummary';

export { Scoreboard, medalFor } from './Scoreboard';
export type { ScoreboardProps } from './Scoreboard';

export { ShareSheet, canNativeShare, renderResultImage } from './ShareSheet';
export type { ShareSheetProps } from './ShareSheet';

export { TurnBanner, turnBannerModel } from './TurnBanner';
export type { TurnBannerModel, TurnBannerProps } from './TurnBanner';
