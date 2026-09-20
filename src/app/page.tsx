'use client';

import { motion } from 'framer-motion';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { Wordmark } from '@/components/brand';
import {
  HowItWorks,
  JoinCodeEntry,
  ModeCard,
  NameFlow,
  BattlePreview,
  TogetherPreview,
} from '@/components/home';
// Direct path, not the lobby barrel: the home route must not pull in the lobby.
import { RoundsSelector } from '@/components/lobby/RoundsSelector';
import {
  Badge,
  Button,
  Card,
  Dialog,
  IconInfo,
  IconSwords,
  IconUsers,
  useToast,
} from '@/components/ui';
import { riseIn, settleIn, staggerContainer } from '@/components/ui/motion';
import { DEFAULT_BATTLE_ROUNDS, PLAYER_COLORS } from '@/game/config';
import { useGameSession } from '@/state/useGameSession';
import { isOk, type GameMode, type Hex, type RoomCode } from '@/types';
import { clampName } from '@/utils/format';
import { randomName } from '@/utils/names';
import { roomCodeFromLocation } from '@/utils/share';
import { lastNamePref, loadIdentity, loadResume, rememberName, type ResumeHint } from '@/utils/storage';

/** Stable first paint, then the real (stored or random) name lands on mount. */
const SEED_NAME = 'Happy Fox';
const FALLBACK_COLOR: Hex = PLAYER_COLORS[0]?.hex ?? '#E69F00';

/**
 * Home. Three decisions at most: who you are, which mode, or a code from a
 * friend. Nothing here may import the 3D renderer — this route has to be the
 * fastest screen in the app.
 */
export default function HomePage(): React.JSX.Element {
  const router = useRouter();
  const toast = useToast();
  const session = useGameSession();

  const [name, setName] = useState<string>(SEED_NAME);
  const [color, setColor] = useState<Hex>(FALLBACK_COLOR);
  const [prefill, setPrefill] = useState<string>('');
  const [battleRounds, setBattleRounds] = useState<number>(DEFAULT_BATTLE_ROUNDS);
  const [creating, setCreating] = useState<GameMode | null>(null);
  const [joining, setJoining] = useState(false);
  const [howOpen, setHowOpen] = useState(false);
  const lastError = useRef<string | null>(null);
  const [storedResume, setStoredResume] = useState<ResumeHint | null>(null);

  // Identity + shared-link code are read after mount so the prerendered HTML
  // stays static (and so a random name never causes a hydration mismatch).
  useEffect(() => {
    setStoredResume(loadResume(Date.now()));
    const remembered = lastNamePref();
    const saved = loadIdentity();
    const chosen = remembered !== '' ? remembered : (saved?.displayName ?? randomName());
    setName(clampName(chosen));
    if (saved !== null && saved.color !== '') setColor(saved.color);

    const linked = roomCodeFromLocation();
    if (linked !== null) {
      setPrefill(linked);
      return;
    }
    if (typeof window === 'undefined') return;
    const code = new URLSearchParams(window.location.search).get('code');
    if (code !== null && code !== '') setPrefill(code);
  }, []);

  // Surface session-level failures once each.
  useEffect(() => {
    const error = session.error;
    if (error === null || error === lastError.current) return;
    lastError.current = error;
    // Not every session error is a network problem. A refused shot ("not your
    // turn", "too gentle") was being reported as "Connection trouble", which
    // sent people hunting for a connection fault that did not exist.
    const networky = /connect|signal|relay|peer|network|timeout|offline/i.test(error);
    toast.push({
      title: networky ? 'Connection trouble' : 'Cannot do that yet',
      description: error,
      tone: 'bad',
    });
  }, [session.error, toast]);

  const busy = creating !== null || joining;
  // A live session wins; otherwise fall back to the expiring localStorage hint so
  // a refresh — or reopening the browser — can still get you back into the game.
  const resumeCode: RoomCode | null =
    session.game !== null ? session.game.roomCode : (storedResume?.roomCode ?? null);

  /** Whatever is in the field, or a fresh friendly name if they cleared it. */
  function finalName(): string {
    const trimmed = name.trim();
    const chosen = clampName(trimmed === '' ? randomName() : trimmed);
    // Harmless, explicitly-allowed preference: it pre-fills the field next time.
    rememberName(chosen);
    return chosen;
  }

  async function openRoom(mode: GameMode): Promise<void> {
    if (busy) return;
    setCreating(mode);
    const result = await session.createRoom({
      name: finalName(),
      mode,
      totalRounds: mode === 'battle' ? battleRounds : null,
    });
    if (isOk(result)) {
      router.push(`/room/?code=${result.value}`);
      return;
    }
    setCreating(null);
    toast.push({ title: 'Could not open a room', description: result.error, tone: 'bad' });
  }

  async function joinRoom(code: RoomCode): Promise<void> {
    if (busy) return;
    setJoining(true);
    const result = await session.joinRoom({ name: finalName(), code });
    if (isOk(result)) {
      router.push(`/room/?code=${code}`);
      return;
    }
    setJoining(false);
    toast.push({
      title: 'Could not join that room',
      description: result.error,
      tone: 'bad',
    });
  }

  return (
    <main className="relative z-10 mx-auto w-full max-w-lg px-safe pt-safe pb-12">
      <motion.div variants={staggerContainer(0.07, 0.04)} initial="hidden" animate="show">
        <motion.header variants={riseIn} className="pt-6 pb-7 text-center">
          <Wordmark size="lg" className="justify-center" />
          <p className="mt-3 text-lg text-muted">Play with friends instantly</p>
          <div className="mt-3 flex items-center justify-center gap-2">
            <Badge tone="good" size="md">
              No account required
            </Badge>
            <button
              type="button"
              onClick={() => setHowOpen(true)}
              className="fg-press inline-flex h-7 items-center gap-1.5 rounded-full border border-line px-2.5 text-xs font-semibold tracking-wide text-muted uppercase hover:text-text"
            >
              <IconInfo size={14} />
              How it works
            </button>
          </div>
        </motion.header>

        {resumeCode === null ? null : (
          <motion.div variants={riseIn} className="mb-4">
            <Card tone="strong" className="flex items-center gap-3">
              <span className="motion-keep size-2.5 shrink-0 animate-fg-pulse rounded-full bg-accent" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">You are still in room {resumeCode}</p>
                <p className="text-xs text-faint">Your friends are waiting for you.</p>
              </div>
              <Button
                variant="primary"
                size="sm"
                onClick={() => router.push(`/room/?code=${resumeCode}`)}
              >
                Rejoin
              </Button>
            </Card>
          </motion.div>
        )}

        <motion.section variants={settleIn} aria-label="Your player">
          <Card tone="default">
            <NameFlow name={name} onNameChange={setName} color={color} onColorChange={setColor} />
          </Card>
        </motion.section>

        <motion.section variants={riseIn} className="mt-4 space-y-3" aria-label="Choose a mode">
          <ModeCard
            mode="together"
            title="Play Together"
            blurb="One shared course, taking turns. No winners, no losers — just a run you build together."
            meta="2-8 friends · Endless"
            accent="#52dfa0"
            icon={<IconUsers size={20} />}
            preview={<TogetherPreview />}
            loading={creating === 'together'}
            disabled={busy && creating !== 'together'}
            onSelect={() => void openRoom('together')}
          />

          <div>
            <ModeCard
              mode="battle"
              title="Friend Battle"
              blurb="Everyone plays their own course at the same time. Fewer hits means more points."
              meta={`2-8 friends · ${battleRounds} ${battleRounds === 1 ? 'round' : 'rounds'}`}
              accent="#ff8a4c"
              icon={<IconSwords size={20} />}
              preview={<BattlePreview />}
              loading={creating === 'battle'}
              disabled={busy && creating !== 'battle'}
              onSelect={() => void openRoom('battle')}
            />

            {/* Set before the room opens, so the host never has to back out later. */}
            <div className="mt-2 flex items-center gap-3 px-1">
              <span className="shrink-0 text-xs font-semibold tracking-[0.12em] text-faint uppercase">
                Battle length
              </span>
              <RoundsSelector
                value={battleRounds}
                onChange={(rounds) => setBattleRounds(rounds ?? DEFAULT_BATTLE_ROUNDS)}
                disabled={busy}
                className="min-w-0 flex-1"
              />
            </div>
          </div>
        </motion.section>

        <motion.section variants={riseIn} className="mt-5">
          <Card tone="default">
            <JoinCodeEntry
              key={prefill}
              initialCode={prefill}
              busy={joining}
              disabled={creating !== null}
              onJoin={(code) => void joinRoom(code)}
            />
          </Card>
        </motion.section>

        <motion.footer variants={riseIn} className="mt-8 text-center">
          <p className="text-xs leading-relaxed text-faint">
            Browser to browser over WebRTC. No servers hold your game, no accounts, no tracking.
          </p>
        </motion.footer>
      </motion.div>

      <Dialog
        open={howOpen}
        onClose={() => setHowOpen(false)}
        title="How Friend Golf works"
        description="Three steps, about ten seconds."
      >
        <HowItWorks />
      </Dialog>
    </main>
  );
}
