'use client';

import dynamic from 'next/dynamic';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';

import { BootScreen, Wordmark } from '@/components/brand';
import { NameFlow } from '@/components/home';
import { Lobby } from '@/components/lobby';
import { Button, Card, useToast } from '@/components/ui';
import { LIMITS, PLAYER_COLORS } from '@/game/config';
import { useGameStore } from '@/state/store';
import { useGameSession } from '@/state/useGameSession';
import {
  asRoomCode,
  isOk,
  type GameSettings,
  type Hex,
  type PlayerState,
  type RoomCode,
} from '@/types';
import { clampName } from '@/utils/format';
import { randomName } from '@/utils/names';
import { parseRoomCode } from '@/utils/roomCode';
import { lastNamePref, loadIdentity, loadIdentityForRoom, rememberName } from '@/utils/storage';

/**
 * The 3D game is the ONLY heavy chunk in the app and it is never part of the
 * initial download: it streams in here, client-side only, once a round starts.
 */
const GameScreen = dynamic(
  () => import('@/components/game/GameScreen').then((module) => module.GameScreen),
  {
    ssr: false,
    loading: () => (
      <BootScreen label="Building your course…" hint="Shaping the felt and the bumpers." />
    ),
  },
);

const FALLBACK_COLOR: Hex = PLAYER_COLORS[0]?.hex ?? '#E69F00';

/**
 * Room route.
 *
 * The code arrives as a QUERY PARAM (`/room/?code=AB7K9P`) rather than a dynamic
 * segment, because `output: 'export'` cannot prerender unknown params. React
 * requires useSearchParams to sit under a Suspense boundary, hence the split.
 */
export default function RoomPage(): React.JSX.Element {
  return (
    <Suspense fallback={<BootScreen label="Finding your room…" />}>
      <RoomRoute />
    </Suspense>
  );
}

function RoomRoute(): React.JSX.Element {
  const router = useRouter();
  const toast = useToast();
  const params = useSearchParams();

  // `?code=` is ours; `?room=` is what utils/share.buildJoinUrl produces. Accept both.
  const rawCode = (params.get('code') ?? params.get('room') ?? '').toUpperCase();
  const parsed = parseRoomCode(rawCode);
  const valid = parsed !== null;
  const code: RoomCode = parsed ?? asRoomCode(rawCode);

  // `changeSettings` is not in the UseGameSession contract yet; treat it as an
  // optional capability so the lobby degrades instead of breaking.
  const session: ReturnType<typeof useGameSession> & {
    readonly changeSettings?: (patch: Partial<GameSettings>) => void;
  } = useGameSession();

  const signaling = useGameStore((state) => state.signaling);

  const [name, setName] = useState<string>('Happy Fox');
  const [color, setColor] = useState<Hex>(FALLBACK_COLOR);
  const [joining, setJoining] = useState(false);
  const [starting, setStarting] = useState(false);
  const autoJoined = useRef(false);
  const lastError = useRef<string | null>(null);

  const game = session.game;
  const inThisRoom = game !== null && game.roomCode.toUpperCase() === rawCode;

  useEffect(() => {
    const remembered = lastNamePref();
    const saved = loadIdentity();
    setName(clampName(remembered !== '' ? remembered : (saved?.displayName ?? randomName())));
    if (saved !== null && saved.color !== '') setColor(saved.color);
  }, []);

  useEffect(() => {
    const error = session.error;
    if (error === null || error === lastError.current) return;
    lastError.current = error;
    toast.push({ title: 'Connection trouble', description: error, tone: 'bad' });
  }, [session.error, toast]);

  // A refresh (or a reopened link) rejoins silently when this browser already
  // has an identity for this room. Guarded so StrictMode cannot double-join.
  const sessionRef = useRef(session);
  sessionRef.current = session;
  useEffect(() => {
    if (!valid || inThisRoom || autoJoined.current) return;
    const saved = loadIdentityForRoom(rawCode);
    if (saved === null) return;
    autoJoined.current = true;
    setJoining(true);
    void (async () => {
      const result = await sessionRef.current.joinRoom({ name: saved.displayName, code });
      setJoining(false);
      if (!isOk(result)) {
        toast.push({ title: 'Could not rejoin', description: result.error, tone: 'bad' });
      }
    })();
  }, [valid, inThisRoom, rawCode, code, toast]);

  // Never leave the start button spinning if the host action does not land.
  useEffect(() => {
    if (!starting) return;
    const timer = setTimeout(() => setStarting(false), 4000);
    return () => clearTimeout(timer);
  }, [starting]);

  async function joinNow(): Promise<void> {
    if (joining) return;
    setJoining(true);
    if (game !== null && !inThisRoom) session.leave();
    const trimmed = name.trim();
    const chosen = clampName(trimmed === '' ? randomName() : trimmed);
    rememberName(chosen);
    const result = await session.joinRoom({ name: chosen, code });
    setJoining(false);
    if (!isOk(result)) {
      toast.push({ title: 'Could not join', description: result.error, tone: 'bad' });
    }
  }

  function leave(): void {
    session.leave();
    router.push('/');
  }

  if (!valid) {
    return (
      <main className="relative z-10 mx-auto grid min-h-dvh w-full max-w-md place-items-center px-safe">
        <Card tone="strong" className="w-full text-center">
          <Wordmark size="sm" className="justify-center" />
          <h1 className="mt-4 text-xl font-bold">That link has no room code</h1>
          <p className="mt-2 text-sm text-muted">
            A room code is {LIMITS.ROOM_CODE_LENGTH} characters, like AB7K9P. Ask your friend to
            share theirs again.
          </p>
          <Button variant="primary" size="md" fullWidth className="mt-5" onClick={() => router.push('/')}>
            Back to the start
          </Button>
        </Card>
      </main>
    );
  }

  // Silent rejoin after a refresh: show the branded boot screen, not a form.
  if (!inThisRoom && autoJoined.current && joining) {
    return <BootScreen label="Rejoining your room…" hint={`Room ${code}`} />;
  }

  if (!inThisRoom || game === null) {
    return (
      <main className="relative z-10 mx-auto flex min-h-dvh w-full max-w-lg flex-col justify-center gap-5 px-safe py-10">
        <header className="text-center">
          <Wordmark size="md" className="justify-center" />
          <p className="mt-4 text-sm font-semibold tracking-[0.18em] text-faint uppercase">
            Joining room
          </p>
          <p className="fg-code mt-1 text-4xl font-black">{code}</p>
        </header>

        <Card tone="default">
          <NameFlow
            name={name}
            onNameChange={setName}
            color={color}
            onColorChange={setColor}
            compact
          />
        </Card>

        <div className="space-y-2">
          <Button
            variant="primary"
            size="lg"
            fullWidth
            loading={joining}
            onClick={() => void joinNow()}
          >
            Join the room
          </Button>
          <Button variant="quiet" size="sm" fullWidth onClick={() => router.push('/')}>
            Not this one — take me home
          </Button>
        </div>
      </main>
    );
  }

  if (game.status === 'lobby') {
    const players: readonly PlayerState[] = game.playerOrder
      .map((id) => game.players[id])
      .filter((player): player is PlayerState => player !== undefined);

    const changeSettings = session.changeSettings;
    const canChangeSettings = session.isHost && typeof changeSettings === 'function';

    return (
      <Lobby
        roomCode={game.roomCode}
        mode={game.mode}
        players={players}
        selfId={session.identity?.playerId ?? null}
        isHost={session.isHost}
        totalRounds={game.totalRounds}
        connection={session.connection}
        signaling={signaling}
        peers={session.peers}
        starting={starting}
        onStart={() => {
          setStarting(true);
          session.startGame();
        }}
        onLeave={leave}
        onChangeRounds={
          canChangeSettings && changeSettings !== undefined
            ? (rounds) => changeSettings({ totalRounds: rounds })
            : null
        }
      />
    );
  }

  return <GameScreen />;
}
