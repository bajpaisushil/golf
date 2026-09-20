'use client';

/**
 * GameScreen — the in-game shell. Everything a player sees once a round starts.
 *
 * Responsibilities, in order of importance:
 *
 *  1. LAZY-LOAD THE 3D. three.js is pulled in here and nowhere else, through
 *     `next/dynamic(..., { ssr: false })`, so the home screen never pays for it.
 *     The import literal is static so the bundler can split it cleanly.
 *
 *  2. OWN THE STAGE GEOMETRY. The canvas is placed inside a box fitted to the
 *     course's exact aspect ratio, and the invisible aim surface sits on top of
 *     that same box. Because both share one rectangle, screen -> course units is
 *     an exact linear mapping and the renderer never has to hand back a camera
 *     projection. (A real projection can still be injected via `toCourse` if the
 *     renderer ever exposes one.)
 *
 *  3. WIRE INPUT. Pointer slingshot via `useAimControls`, plus a full keyboard
 *     path (arrows to aim and set power, Enter to putt) so the game is playable
 *     without a pointer at all.
 *
 *  4. LAY OUT THE MODE. 'together' = one shared course + turn banner + player
 *     rail. 'battle' = your big course + a live grid of opponent mini boards.
 *
 * Everything in the overlay is `pointer-events-none` except the controls
 * themselves, so a drag that starts anywhere over the felt reaches the ball.
 */

import { motion, useReducedMotion } from 'framer-motion';
import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { LIMITS, PHYSICS } from '@/game/config';
import type { AimState } from '@/game/input/useAimControls';
import { useAimControls } from '@/game/input/useAimControls';
import { useQuality } from '@/game/rendering/quality';
import type { AimPreview, BallView } from '@/game/rendering/three/types';
import { friendshipTierFor } from '@/game/rules/friendship';
import { canShoot, playersStillPlaying } from '@/game/rules/competitive';
import { projectedScore, summariseRound } from '@/game/rules/scoring';
import {
  selectActivePlayer,
  selectBallViews,
  selectIsMyTurn,
  selectLeaderboard,
  selectMyLevel,
  selectOrderedPlayers,
  selectSelf,
} from '@/state/selectors';
import { useGameStore } from '@/state/store';
import { useGameSession } from '@/state/useGameSession';
import type { GameState, LevelSpec, PlayerId, PlayerState, Vec2 } from '@/types';
import { cn } from '@/utils/cn';
import { loadPrefs, savePrefs } from '@/utils/storage';
import { initAudio, setSoundEnabled } from '@/utils/sound';

import type { ConnectionNotice } from './ConnectionBadge';
import { ConnectionBadge } from './ConnectionBadge';
import { EndGameDialog } from './EndGameDialog';
import { GameOverScreen } from './GameOverScreen';
import { Hud } from './Hud';
import type { OpponentBoard } from './OpponentGrid';
import { OpponentGrid } from './OpponentGrid';
import { PlayerRail } from './PlayerRail';
import { PowerMeter } from './PowerMeter';
import { RoundSummary } from './RoundSummary';
import { TurnBanner } from './TurnBanner';
import { Confetti } from './Confetti';
import { TEAM_META, groupIdFor, groupsOf, playersInGroup } from '@/game/rules/teams';
import type { TeamId } from '@/types';

/** Synthetic drag length (px) reported for keyboard aiming at full power. */
const KEYBOARD_DRAG_PIXELS = 160;

// --- the one and only three.js entry point ---------------------------------
const CourseCanvas = dynamic(() => import('@/game/rendering/three/CourseCanvas'), {
  ssr: false,
  loading: () => <StageFallback />,
});

// --- keyboard aiming (presentation-side input; trig is fine here) -----------
/** Radians per arrow-key press. ~6 degrees: fine enough to thread a gap. */
const KEY_ROTATE_STEP = 0.10472;
/** Power change per up/down press. */
const KEY_POWER_STEP = 0.05;
/** Power a keyboard shot starts at. */
const KEY_POWER_DEFAULT = 0.55;
/** Pointer must start within this many course units of the ball to grab it. */
const GRAB_RADIUS_CU = 12;

const ORIGIN: Vec2 = { x: 0, y: 0 };

function StageFallback(): React.JSX.Element {
  return (
    <div className="flex h-full w-full items-center justify-center rounded-2xl bg-white/[0.03]">
      <div className="flex flex-col items-center gap-2">
        <motion.span
          className="h-3 w-3 rounded-full bg-white/50"
          animate={{ scale: [1, 1.5, 1], opacity: [0.4, 1, 0.4] }}
          transition={{ duration: 1.1, repeat: Infinity, ease: 'easeInOut' }}
        />
        <span className="text-[11px] font-medium uppercase tracking-[0.2em] text-white/30">
          Building the course
        </span>
      </div>
    </div>
  );
}

/** Unit vector from the ball toward the cup — the friendliest keyboard default. */
function defaultAimFor(level: LevelSpec | null, from: Vec2): Vec2 {
  if (!level) return { x: 0, y: -1 };
  const dx = level.hole.center.x - from.x;
  const dy = level.hole.center.y - from.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (!(len > 0)) return { x: 0, y: -1 };
  return { x: dx / len, y: dy / len };
}

function rotate(v: Vec2, radians: number): Vec2 {
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  const x = v.x * c - v.y * s;
  const y = v.x * s + v.y * c;
  const len = Math.sqrt(x * x + y * y);
  if (!(len > 0)) return v;
  return { x: x / len, y: y / len };
}

function ballViewFor(player: PlayerState, selfId: PlayerId): BallView {
  return {
    playerId: player.id,
    color: player.color,
    pos: player.currentPos,
    isSelf: player.id === selfId,
    holed: player.holed,
    label: player.displayName,
  };
}

function hostNameOf(game: GameState, players: readonly PlayerState[]): string {
  for (const player of players) if (player.id === game.hostPlayerId) return player.displayName;
  return 'the host';
}

export interface GameScreenProps {
  /**
   * Exact screen -> course-unit projection. Supply it when the renderer can
   * expose its camera; otherwise the fitted-stage mapping below is used.
   */
  readonly toCourse?: (clientX: number, clientY: number) => Vec2;
  readonly className?: string;
}

export function GameScreen({ toCourse: toCourseProp, className }: GameScreenProps = {}): React.JSX.Element {
  const session = useGameSession();
  const sessionRef = useRef(session);
  sessionRef.current = session;

  const playback = useGameStore((state) => state.playback);
  const setPlayback = useGameStore((state) => state.setPlayback);
  const quality = useQuality();
  const reduced = useReducedMotion() ?? false;

  const game = session.game;
  const selfId = session.identity?.playerId ?? null;

  // --- preferences --------------------------------------------------------
  const [soundOn, setSoundOn] = useState(true);
  useEffect(() => {
    const prefs = loadPrefs();
    setSoundOn(prefs.sound);
    setSoundEnabled(prefs.sound);
  }, []);

  const toggleSound = useCallback(() => {
    setSoundOn((previous) => {
      const next = !previous;
      setSoundEnabled(next);
      savePrefs({ sound: next, quality: quality.tier });
      return next;
    });
  }, [quality.tier]);

  // --- dialogs ------------------------------------------------------------
  const [endDialogOpen, setEndDialogOpen] = useState(false);

  // --- connection notices (host migration, drops, returns) ----------------
  const [notice, setNotice] = useState<ConnectionNotice | null>(null);
  const prevHostRef = useRef<PlayerId | null>(null);
  const prevConnectedRef = useRef<ReadonlyMap<PlayerId, boolean>>(new Map());

  const players = useMemo<readonly PlayerState[]>(
    () => (game ? selectOrderedPlayers(game) : []),
    [game],
  );

  useEffect(() => {
    if (!game) return;
    const host = game.hostPlayerId;
    const previous = prevHostRef.current;
    prevHostRef.current = host;
    if (previous === null || previous === host) return;
    let name = 'Someone';
    for (const player of players) if (player.id === host) name = player.displayName;
    setNotice({
      id: `host:${host}:${Date.now()}`,
      kind: 'host-migrated',
      message: `${name} is now hosting`,
    });
  }, [game, players]);

  useEffect(() => {
    if (players.length === 0) return;
    const previous = prevConnectedRef.current;
    const next = new Map<PlayerId, boolean>();
    let dropped: PlayerState | null = null;
    let returned: PlayerState | null = null;

    for (const player of players) {
      next.set(player.id, player.connected);
      const before = previous.get(player.id);
      if (before === undefined) continue;
      if (before && !player.connected) dropped = player;
      if (!before && player.connected) returned = player;
    }
    prevConnectedRef.current = next;

    if (dropped) {
      setNotice({
        id: `drop:${dropped.id}:${Date.now()}`,
        kind: 'player-dropped',
        message: `${dropped.displayName} dropped — holding their spot`,
      });
    } else if (returned) {
      setNotice({
        id: `back:${returned.id}:${Date.now()}`,
        kind: 'player-returned',
        message: `${returned.displayName} is back`,
      });
    }
  }, [players]);

  const dismissNotice = useCallback(() => setNotice(null), []);

  // --- derived game facts -------------------------------------------------
  const self = useMemo(
    () => (game && selfId ? selectSelf(game, selfId) : null),
    [game, selfId],
  );
  const level = useMemo(
    () => (game && selfId ? selectMyLevel(game, selfId) : null),
    [game, selfId],
  );
  const activePlayer = useMemo(() => (game ? selectActivePlayer(game) : null), [game]);
  const isMyTurn = useMemo(
    () => (game && selfId ? selectIsMyTurn(game, selfId) : false),
    [game, selfId],
  );
  const stillPutting = useMemo(() => (game ? playersStillPlaying(game).length : 0), [game]);
  const maxStrokes = game?.settings.maxStrokes ?? LIMITS.MAX_STROKES;
  const mode = game?.mode ?? 'together';
  const busy = playback !== null;

  const balls = useMemo<readonly BallView[]>(() => {
    if (!game || !selfId) return [];
    const round = game.roundState;

    // Co-op is ONE ball for the whole group. It is tinted with the colour of
    // whoever is up, so you can see at a glance whose hit is coming next.
    if (round !== null && round.mode !== 'battle') {
      // One ball per group: a single ball in co-op, one per team in team play.
      const active = round.activePlayerId === null ? null : game.players[round.activePlayerId];
      const activeGroup = groupIdFor(active ?? null, game.mode);
      return groupsOf(game).map((group) => {
        const meta = TEAM_META[group as TeamId];
        const members = playersInGroup(game, group);
        const tint = meta?.color ?? members[0]?.color ?? self?.color ?? '#F7F7F2';
        return {
          playerId: members[0]?.id ?? selfId,
          color: tint as BallView['color'],
          pos: round.balls[group] ?? round.level.ballStart,
          isSelf: group === activeGroup,
          holed: round.ballsHoled[group] === true,
          label: meta ? `${meta.name} team` : 'Our ball',
        };
      });
    }

    // Battle shares one course now, so show EVERY player's ball on it. Seeing
    // the others' balls beside yours is the difference between a group game and
    // several people playing solo in the same room.
    return selectBallViews(game, selfId);
  }, [game, selfId, self]);

  const opponentBoards = useMemo<readonly OpponentBoard[]>(() => {
    if (!game || !selfId) return [];
    const round = game.roundState;
    if (!round || round.mode !== 'battle') return [];
    const boards: OpponentBoard[] = [];
    for (const player of players) {
      if (player.id === selfId) continue;
      boards.push({ player, level: round.levels[player.id] ?? null });
    }
    return boards;
  }, [game, players, selfId]);

  /**
   * Fires the confetti once per sink.
   *
   * Co-op celebrates the shared ball dropping — that is a group achievement, so
   * everybody's screen celebrates. Battle celebrates YOUR ball dropping; you
   * then stay in the round and watch the others finish.
   */
  const celebrateKey = useMemo<string | null>(() => {
    if (!game || !selfId) return null;
    const round = game.roundState;
    if (round === null) return null;
    if (round.mode !== 'battle') {
      // Celebrate when YOUR group's ball drops.
      const group = groupIdFor(self ?? null, game.mode);
      return round.ballsHoled[group] === true ? `r${round.roundIndex}:${group}` : null;
    }
    return self?.holed === true ? `r${round.roundIndex}:${selfId}` : null;
  }, [game, self, selfId]);

  const celebrateColors = useMemo<readonly string[]>(
    () => players.map((player) => player.color),
    [players],
  );

  const mayShoot =
    game !== null && selfId !== null && !busy && game.status === 'playing' && canShoot(game, selfId);

  // --- stage geometry -----------------------------------------------------
  const stageRef = useRef<HTMLDivElement | null>(null);
  const aimSurfaceRef = useRef<HTMLDivElement | null>(null);
  const [stageSize, setStageSize] = useState<{ readonly w: number; readonly h: number }>({ w: 0, h: 0 });

  useEffect(() => {
    const element = stageRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const rect = entry.contentRect;
      setStageSize({ w: rect.width, h: rect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const fitted = useMemo(() => {
    if (!level || stageSize.w <= 0 || stageSize.h <= 0) return null;
    const scale = Math.min(stageSize.w / level.width, stageSize.h / level.height);
    return { w: level.width * scale, h: level.height * scale };
  }, [level, stageSize]);

  const toCourse = useCallback(
    (clientX: number, clientY: number): Vec2 => {
      if (toCourseProp) return toCourseProp(clientX, clientY);
      const element = aimSurfaceRef.current;
      if (!element || !level) return ORIGIN;
      const rect = element.getBoundingClientRect();
      if (!(rect.width > 0) || !(rect.height > 0)) return ORIGIN;
      return {
        x: ((clientX - rect.left) / rect.width) * level.width,
        y: ((clientY - rect.top) / rect.height) * level.height,
      };
    },
    [level, toCourseProp],
  );

  // --- shooting -----------------------------------------------------------
  const onShoot = useCallback((aim: Vec2, power: number) => {
    sessionRef.current.submitShot(aim, power);
  }, []);

  const aimControls = useAimControls({
    ballPos: self?.currentPos ?? ORIGIN,
    enabled: mayShoot,
    toCourse,
    onShoot,
    grabRadius: GRAB_RADIUS_CU,
    // Drag from ANYWHERE on the course, not just from on top of the ball.
    // Requiring the drag to start within the grab radius meant every drag that
    // began a little wide did nothing at all, with no feedback explaining why —
    // it read as "dragging is broken". The shot still launches from the ball;
    // only the place you are allowed to start the gesture changed.
    allowAnywhere: true,
  });

  // --- keyboard aiming ----------------------------------------------------
  const [keyAim, setKeyAim] = useState<{ readonly dir: Vec2; readonly power: number } | null>(null);

  // Drop the keyboard aim whenever it stops being this player's move.
  useEffect(() => {
    if (!mayShoot) setKeyAim(null);
  }, [mayShoot]);

  const onStageKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (!mayShoot || !self) return;
      const key = event.key;

      if (key === 'Escape') {
        setKeyAim(null);
        aimControls.cancel();
        return;
      }

      const engage = () =>
        keyAim ?? { dir: defaultAimFor(level, self.currentPos), power: KEY_POWER_DEFAULT };

      if (key === 'ArrowLeft' || key === 'ArrowRight') {
        event.preventDefault();
        const current = engage();
        setKeyAim({
          dir: rotate(current.dir, key === 'ArrowLeft' ? -KEY_ROTATE_STEP : KEY_ROTATE_STEP),
          power: current.power,
        });
        return;
      }

      if (key === 'ArrowUp' || key === 'ArrowDown') {
        event.preventDefault();
        const current = engage();
        const delta = key === 'ArrowUp' ? KEY_POWER_STEP : -KEY_POWER_STEP;
        setKeyAim({
          dir: current.dir,
          power: Math.max(0, Math.min(1, current.power + delta)),
        });
        return;
      }

      if (key === 'Enter' || key === ' ' || key === 'Spacebar') {
        event.preventDefault();
        const current = engage();
        if (current.power < PHYSICS.MIN_POWER) {
          setKeyAim(current);
          return;
        }
        setKeyAim(null);
        onShoot(current.dir, current.power);
      }
    },
    [aimControls, keyAim, level, mayShoot, onShoot, self],
  );

  /** The pointer drag wins; the keyboard aim shows when no drag is in flight. */
  const effectiveAim = useMemo<AimState | null>(() => {
    const pointer = aimControls.aim;
    if (pointer && pointer.active) return pointer;
    if (!keyAim || !self) return null;
    return {
      active: true,
      origin: self.currentPos,
      drag: {
        x: -keyAim.dir.x * keyAim.power * PHYSICS.MAX_DRAG_CU,
        y: -keyAim.dir.y * keyAim.power * PHYSICS.MAX_DRAG_CU,
      },
      aim: keyAim.dir,
      power: keyAim.power,
      valid: keyAim.power >= PHYSICS.MIN_POWER,
      // Keyboard aiming has no real pointer drag. Report a synthetic pixel
      // length proportional to power so a pixel-space power meter still reads
      // correctly, and tag the source so the UI can show key hints, not drag hints.
      dragPixels: keyAim.power * KEYBOARD_DRAG_PIXELS,
      pointerType: 'keyboard',
    };
  }, [aimControls.aim, keyAim, self]);

  const aimPreview = useMemo<AimPreview | null>(() => {
    if (!effectiveAim || !self || !effectiveAim.valid) return null;
    return {
      origin: effectiveAim.origin,
      aim: effectiveAim.aim,
      power: effectiveAim.power,
      color: self.color,
    };
  }, [effectiveAim, self]);

  const onPlaybackEnd = useCallback(() => setPlayback(null), [setPlayback]);

  // Audio contexts need a gesture; this is the first one a player ever makes.
  const audioStartedRef = useRef(false);
  const onSurfacePointerDown = useCallback(
    (event: React.PointerEvent) => {
      if (!audioStartedRef.current) {
        audioStartedRef.current = true;
        initAudio();
      }
      aimControls.handlers.onPointerDown(event);
    },
    [aimControls.handlers],
  );

  // --- summaries ----------------------------------------------------------
  const summary = useMemo(() => {
    if (!game || game.currentRoundIndex < 0) return null;
    if (game.status !== 'round-summary') return null;
    return summariseRound(game, game.currentRoundIndex);
  }, [game]);

  const standings = useMemo(() => (game ? selectLeaderboard(game) : []), [game]);

  const onContinue = useCallback(() => {
    sessionRef.current.startNextRound();
  }, []);
  const onFinish = useCallback(() => {
    sessionRef.current.endGame();
  }, []);
  const onPlayAgain = useCallback(() => {
    sessionRef.current.leave();
  }, []);
  const confirmEndGame = useCallback(() => {
    setEndDialogOpen(false);
    sessionRef.current.endGame();
  }, []);

  // --- render -------------------------------------------------------------
  if (!game || !selfId || !self) {
    return (
      <main className={cn('flex h-[100dvh] w-full items-center justify-center bg-[#070A0E]', className)}>
        <StageFallback />
      </main>
    );
  }

  const hostName = hostNameOf(game, players);
  const roundIndex = Math.max(0, game.currentRoundIndex);
  const par = level?.par ?? 0;

  if (game.status === 'finished' && game.results) {
    return (
      <main
        className={cn('h-[100dvh] w-full overflow-y-auto bg-[#070A0E] text-white', className)}
        aria-label="Game complete"
      >
        <GameOverScreen
          results={game.results}
          players={players}
          selfId={selfId}
          onPlayAgain={onPlayAgain}
        />
      </main>
    );
  }

  if (game.status === 'round-summary' && summary) {
    return (
      <main
        className={cn('h-[100dvh] w-full overflow-y-auto bg-[#070A0E] text-white', className)}
        aria-label={`Round ${roundIndex + 1} summary`}
      >
        <RoundSummary
          summary={summary}
          players={players}
          selfId={selfId}
          isHost={session.isHost}
          hostName={hostName}
          totalRounds={game.totalRounds}
          standings={game.mode === 'battle' ? standings : undefined}
          onContinue={onContinue}
          onFinish={onFinish}
          ballSmoothing={game.settings.ballSmoothing}
          onChangeSmoothing={
            session.isHost
              ? (value: number) => session.changeSettings({ ballSmoothing: value })
              : null
          }
        />
      </main>
    );
  }

  const tier = mode === 'together' ? friendshipTierFor(roundIndex + 1) : null;
  const projected =
    mode === 'battle' && level && !self.holed ? projectedScore(self.strokes + 1, level.par) : null;

  const connectionSlot = (
    <ConnectionBadge
      connection={session.connection}
      peers={session.peers}
      notice={notice}
      onDismissNotice={dismissNotice}
    />
  );

  return (
    <main
      className={cn('relative flex h-[100dvh] w-full overflow-hidden bg-[#070A0E] text-white', className)}
    >
      {/* Sinking a putt is the whole point of the game, so it gets a party. */}
      <Confetti trigger={celebrateKey} colors={celebrateColors} />
      {/* ---- course column ---- */}
      <div className="relative flex min-w-0 flex-1 flex-col">
        <div ref={stageRef} className="absolute inset-0 flex items-center justify-center p-1">
          {level ? (
            <div
              className="relative"
              style={
                fitted
                  ? { width: `${fitted.w}px`, height: `${fitted.h}px` }
                  : { width: '100%', height: '100%' }
              }
            >
              <CourseCanvas
                level={level}
                balls={balls}
                playback={playback}
                aim={aimPreview}
                quality={quality.tier}
                reducedMotion={quality.reducedMotion || reduced}
                onPlaybackEnd={onPlaybackEnd}
                className="absolute inset-0 h-full w-full"
              />

              <div
                ref={aimSurfaceRef}
                role="application"
                tabIndex={mayShoot ? 0 : -1}
                aria-label={
                  mayShoot
                    ? 'Course. Drag back from your ball to putt, or use the arrow keys to aim and Enter to putt.'
                    : 'Course'
                }
                aria-disabled={!mayShoot}
                onKeyDown={onStageKeyDown}
                onPointerDown={onSurfacePointerDown}
                onPointerMove={aimControls.handlers.onPointerMove}
                onPointerUp={aimControls.handlers.onPointerUp}
                onPointerCancel={aimControls.handlers.onPointerCancel}
                className={cn(
                  'absolute inset-0 touch-none select-none rounded-xl',
                  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/50',
                  mayShoot ? 'cursor-grab active:cursor-grabbing' : 'cursor-default',
                )}
              />
            </div>
          ) : (
            <StageFallback />
          )}
        </div>

        {/* ---- overlay ---- */}
        <div className="pointer-events-none relative z-10 flex h-full w-full flex-col">
          <Hud
            mode={mode}
            roundIndex={roundIndex}
            totalRounds={game.totalRounds}
            strokes={self.strokes}
            par={par}
            maxStrokes={maxStrokes}
            tier={tier}
            projectedPoints={projected}
            selfColor={self.color}
            isHost={session.isHost}
            soundOn={soundOn}
            onToggleSound={toggleSound}
            onEndGame={session.isHost ? () => setEndDialogOpen(true) : undefined}
            connectionSlot={connectionSlot}
          />

          <div className="mt-2 px-3">
            <TurnBanner
              mode={mode}
              isMyTurn={isMyTurn}
              activeName={activePlayer ? activePlayer.displayName : null}
              activeColor={activePlayer ? activePlayer.color : null}
              selfHoled={self.holed}
              selfDnf={!self.holed && self.strokes >= maxStrokes}
              stillPutting={stillPutting}
              selfStrokes={self.strokes}
              alreadyFinishedBy={
                mode === 'battle' && !self.holed
                  ? (players.find((p) => p.holed && p.id !== selfId)?.displayName ?? null)
                  : null
              }
              busy={busy}
              roundOver={game.roundState?.completed ?? false}
              selfColor={self.color}
            />
          </div>

          {/* the aiming zone — deliberately empty so drags pass through */}
          <div className="min-h-0 flex-1" />

          <div className="flex flex-col gap-2 px-3 pb-[max(0.6rem,env(safe-area-inset-bottom))]">
            {/* PowerMeter owns its own enter/exit animation and renders nothing at rest. */}
            <div className="flex justify-start">
              <PowerMeter
                aim={effectiveAim}
                color={self.color}
                hint={keyAim ? 'Arrows aim · ↑↓ power · Enter to putt' : undefined}
              />
            </div>

            {mode === 'battle' ? (
              <div className="pointer-events-auto lg:hidden">
                <OpponentGrid boards={opponentBoards} maxStrokes={maxStrokes} />
              </div>
            ) : null}

            <div className="pointer-events-auto">
              <PlayerRail
                players={players}
                selfId={selfId}
                activePlayerId={
                  game.roundState && game.roundState.mode === 'together'
                    ? game.roundState.activePlayerId
                    : null
                }
                maxStrokes={maxStrokes}
                mode={mode}
              />
            </div>
          </div>
        </div>
      </div>

      {/* ---- battle: opponents as a proper sidebar on wide screens ---- */}
      {mode === 'battle' ? (
        <aside className="hidden w-[190px] shrink-0 overflow-y-auto border-l border-white/[0.07] bg-black/25 p-2 lg:block">
          <h2 className="mb-2 px-1 text-[10px] font-bold uppercase tracking-[0.18em] text-white/[0.35]">
            Everyone else
          </h2>
          <OpponentGrid boards={opponentBoards} maxStrokes={maxStrokes} />
        </aside>
      ) : null}

      <EndGameDialog
        open={endDialogOpen}
        onCancel={() => setEndDialogOpen(false)}
        onConfirm={confirmEndGame}
        playerCount={players.length}
        roundsPlayed={game.status === 'lobby' ? 0 : roundIndex + (game.roundState?.completed ? 1 : 0)}
      />
    </main>
  );
}

export default GameScreen;
