'use client';

import { motion } from 'framer-motion';

import { SPRING_SOFT } from '@/components/ui/motion';

import { LogoMark } from './LogoMark';

export interface BootScreenProps {
  readonly label?: string;
  readonly hint?: string;
}

/**
 * The branded loading state. Used while the 3D course chunk streams in, and as
 * the Suspense fallback for routes that read the query string.
 */
export function BootScreen({
  label = 'Warming up the course…',
  hint,
}: BootScreenProps): React.JSX.Element {
  return (
    <div
      role="status"
      aria-live="polite"
      className="relative z-10 grid min-h-dvh place-items-center px-6 text-center"
    >
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={SPRING_SOFT}
        className="flex flex-col items-center gap-4"
      >
        <LogoMark size={72} animated />
        <p className="text-lg font-semibold tracking-[-0.01em]">{label}</p>
        {hint === undefined ? null : <p className="max-w-xs text-sm text-muted">{hint}</p>}
      </motion.div>
    </div>
  );
}
