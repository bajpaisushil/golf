'use client';

import { MotionConfig } from 'framer-motion';
import type { ReactNode } from 'react';

import { ToastProvider } from './Toast';

/**
 * The one client boundary the root layout opens.
 *
 * `reducedMotion="user"` makes framer-motion drop transform/layout animation for
 * anyone who asked their OS for less motion; the CSS layer clamps the rest.
 */
export function AppProviders({ children }: { readonly children: ReactNode }): React.JSX.Element {
  return (
    <MotionConfig reducedMotion="user">
      <ToastProvider>{children}</ToastProvider>
    </MotionConfig>
  );
}
