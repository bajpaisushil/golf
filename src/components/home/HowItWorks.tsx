'use client';

import { LogoMark } from '@/components/brand';

const STEPS: readonly { readonly title: string; readonly body: string }[] = [
  {
    title: 'Pick a mode',
    body: 'Play Together shares one course and counts nobody out. Friend Battle gives everyone their own course at the same time.',
  },
  {
    title: 'Send the room code',
    body: 'Your friends type the six characters (or open your link). Their browser connects straight to yours — nothing goes through a server.',
  },
  {
    title: 'Drag back, let go',
    body: 'Pull away from your ball like a slingshot and release. Fewer hits means a higher score, so the calm shot usually wins.',
  },
];

/** Body of the "How it works" sheet. Three steps, no jargon. */
export function HowItWorks(): React.JSX.Element {
  return (
    <div className="pt-1">
      <ol className="space-y-4">
        {STEPS.map((step, index) => (
          <li key={step.title} className="flex gap-3">
            <span
              aria-hidden="true"
              className="grid size-8 shrink-0 place-items-center rounded-full bg-accent/15 text-sm font-black text-accent-hi"
            >
              {index + 1}
            </span>
            <div className="min-w-0">
              <p className="font-semibold">{step.title}</p>
              <p className="mt-0.5 text-sm leading-relaxed text-muted">{step.body}</p>
            </div>
          </li>
        ))}
      </ol>

      <div className="mt-5 flex items-start gap-3 rounded-lg border border-line bg-raised/40 p-3">
        <LogoMark size={28} />
        <p className="text-sm leading-relaxed text-muted">
          No account, no download, no database. The room lives in your browsers and disappears when
          you close the tab.
        </p>
      </div>
    </div>
  );
}
