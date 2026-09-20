import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

import { AppProviders } from '@/components/ui/AppProviders';

import './globals.css';

/**
 * Root layout. Deliberately almost empty: the home route must boot with the
 * smallest possible amount of JavaScript, so nothing heavy is allowed here.
 * The favicon is an inline data URI of the original mark — zero extra requests,
 * zero downloaded assets.
 */

const ICON_SVG =
  "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 48'>" +
  "<rect width='48' height='48' rx='11' fill='#080f14'/>" +
  "<ellipse cx='32.5' cy='35.5' rx='7.4' ry='3.8' fill='#04070a' stroke='#ff8a4c' stroke-opacity='0.6' stroke-width='1.4'/>" +
  "<path d='M11 34.5C12.8 18 24.5 11.5 31.2 23.4' fill='none' stroke='#ff8a4c' stroke-width='3.2' stroke-linecap='round'/>" +
  "<circle cx='11' cy='34.5' r='6.2' fill='#f6f2e9'/></svg>";

const ICON_HREF = `data:image/svg+xml,${encodeURIComponent(ICON_SVG)}`;

export const metadata: Metadata = {
  title: 'Friend Golf — play with friends instantly',
  description:
    'Serverless mini golf you can start in one tap. Share a six-character code and putt together in the browser — no account, no download, no servers in the middle.',
  applicationName: 'Friend Golf',
  appleWebApp: { capable: true, statusBarStyle: 'black-translucent', title: 'Friend Golf' },
  formatDetection: { telephone: false, address: false, email: false },
  icons: { icon: [{ url: ICON_HREF, type: 'image/svg+xml' }], apple: [{ url: ICON_HREF }] },
  openGraph: {
    title: 'Friend Golf',
    description: 'Play mini golf with friends instantly. No account required.',
    type: 'website',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  // Pinch-zoom would fight the slingshot drag; the layout is fully responsive instead.
  userScalable: false,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#080f14' },
    { media: '(prefers-color-scheme: light)', color: '#f4ece0' },
  ],
};

export default function RootLayout({ children }: { readonly children: ReactNode }): React.JSX.Element {
  return (
    <html lang="en">
      <body className="min-h-dvh antialiased">
        {/* procedural grain, painted once, never scrolls */}
        <div className="fg-grain" aria-hidden="true" />
        <AppProviders>{children}</AppProviders>
      </body>
    </html>
  );
}
