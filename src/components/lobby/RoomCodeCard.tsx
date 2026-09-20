'use client';

import clsx from 'clsx';
import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useState } from 'react';

import { Button, IconCheck, IconCopy, IconShare, useToast } from '@/components/ui';
import { SPRING_SNAPPY } from '@/components/ui/motion';
import type { RoomCode } from '@/types';
import { buildJoinUrl, canNativeShare, copyToClipboard, shareResult } from '@/utils/share';

export interface RoomCodeCardProps {
  readonly code: RoomCode;
  readonly className?: string;
}

/**
 * The hero of the lobby: the room code, big enough to read across a room and
 * tappable anywhere to copy. Share uses the Web Share API when the browser has
 * it and falls back to copying the join link.
 */
export function RoomCodeCard({ code, className }: RoomCodeCardProps): React.JSX.Element {
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const [canShare, setCanShare] = useState(false);

  // The Web Share API is feature-detected after mount so SSR and hydration agree.
  useEffect(() => {
    setCanShare(canNativeShare());
  }, []);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copyCode(): Promise<void> {
    const done = await copyToClipboard(code);
    setCopied(done);
    toast.push(
      done
        ? { title: 'Room code copied', description: code, tone: 'good' }
        : { title: 'Could not copy', description: `Read it out instead: ${code}`, tone: 'warn' },
    );
  }

  async function share(): Promise<void> {
    const url = buildJoinUrl(code);
    const text = `Join my Friend Golf room — code ${code}`;
    // shareResult opens the OS sheet when there is one and copies otherwise.
    // A cancelled share sheet returns false, which is a normal outcome, so the
    // toast only claims success for the clipboard path.
    const shared = await shareResult(url === '' ? text : `${text}\n${url}`, url === '' ? undefined : url);
    if (canNativeShare()) return;
    toast.push(
      shared
        ? { title: 'Invite link copied', description: 'Paste it anywhere', tone: 'good' }
        : { title: 'Could not copy the link', description: url === '' ? code : url, tone: 'warn' },
    );
  }

  return (
    <div className={clsx('fg-panel relative overflow-hidden rounded-2xl p-4', className)}>
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage:
            'radial-gradient(90% 70% at 50% -20%, color-mix(in oklab, var(--color-accent) 22%, transparent), transparent 70%)',
        }}
      />

      <div className="relative">
        <p className="text-center text-xs font-semibold tracking-[0.18em] text-faint uppercase">
          Room code
        </p>

        <button
          type="button"
          onClick={() => void copyCode()}
          className="fg-press mx-auto mt-2 flex w-full items-center justify-center gap-1.5 rounded-xl py-1"
          aria-label={`Room code ${Array.from(code).join(' ')}. Tap to copy.`}
        >
          {Array.from(code).map((character, index) => (
            <span
              key={`${character}-${index}`}
              aria-hidden="true"
              className="fg-well fg-code grid h-14 w-[clamp(2.1rem,11vw,3.25rem)] place-items-center rounded-md text-[clamp(1.4rem,7vw,2rem)] font-black text-text"
            >
              {character}
            </span>
          ))}
        </button>

        <div className="mt-3 flex items-center justify-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void copyCode()}
            leading={
              <AnimatePresence mode="wait" initial={false}>
                <motion.span
                  key={copied ? 'done' : 'copy'}
                  initial={{ scale: 0.6, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  exit={{ scale: 0.6, opacity: 0 }}
                  transition={SPRING_SNAPPY}
                  className="grid place-items-center"
                >
                  {copied ? <IconCheck size={18} /> : <IconCopy size={18} />}
                </motion.span>
              </AnimatePresence>
            }
          >
            {copied ? 'Copied' : 'Copy code'}
          </Button>

          <Button
            variant="secondary"
            size="sm"
            onClick={() => void share()}
            leading={<IconShare size={18} />}
          >
            {canShare ? 'Share' : 'Copy link'}
          </Button>
        </div>
      </div>
    </div>
  );
}
