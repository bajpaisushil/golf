'use client';

/**
 * The entire icon set, drawn inline. Original geometry, stroke = currentColor,
 * no icon font and no SVG sprite download. Keep every path on a 24x24 grid.
 */

import type { SVGProps } from 'react';

export interface IconProps extends SVGProps<SVGSVGElement> {
  readonly size?: number;
}

function Svg({ size = 20, children, ...rest }: IconProps): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export function IconDice(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <rect x="3.5" y="3.5" width="17" height="17" rx="5" />
      <circle cx="8.6" cy="8.6" r="1.25" fill="currentColor" stroke="none" />
      <circle cx="15.4" cy="15.4" r="1.25" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.25" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function IconCopy(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <rect x="9" y="9" width="11.5" height="11.5" rx="3.5" />
      <path d="M15 5.6A2.6 2.6 0 0 0 12.4 3H6.6A3.6 3.6 0 0 0 3 6.6v5.8A2.6 2.6 0 0 0 5.6 15" />
    </Svg>
  );
}

export function IconShare(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M12 15.5V3.8" />
      <path d="M8.3 7.4 12 3.7l3.7 3.7" />
      <path d="M6 11.5H5.2A2.2 2.2 0 0 0 3 13.7v5.1A2.2 2.2 0 0 0 5.2 21h13.6a2.2 2.2 0 0 0 2.2-2.2v-5.1a2.2 2.2 0 0 0-2.2-2.2H18" />
    </Svg>
  );
}

export function IconClose(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="m6.5 6.5 11 11M17.5 6.5l-11 11" />
    </Svg>
  );
}

export function IconBack(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M20 12H4.6" />
      <path d="m10.4 5.6-6 6.4 6 6.4" />
    </Svg>
  );
}

export function IconCheck(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="m4.8 12.6 4.6 4.6L19.2 7.4" />
    </Svg>
  );
}

export function IconPlay(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M8 5.6 18.4 12 8 18.4z" fill="currentColor" />
    </Svg>
  );
}

export function IconUsers(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <circle cx="9.2" cy="8.4" r="3.4" />
      <path d="M3.4 19.4c.6-3.2 3-5 5.8-5s5.2 1.8 5.8 5" />
      <path d="M16.4 6.1a3.2 3.2 0 0 1 0 6" />
      <path d="M18 14.9c1.6.7 2.4 2.3 2.7 4.5" />
    </Svg>
  );
}

export function IconFlag(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M6.4 21V3.6" />
      <path d="M6.4 4.6h9.9l-2.1 3.6 2.1 3.6H6.4" />
      <ellipse cx="12.4" cy="20.4" rx="6" ry="1.6" />
    </Svg>
  );
}

export function IconSpark(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M12 3.4c.7 4.3 2.3 5.9 6.6 6.6-4.3.7-5.9 2.3-6.6 6.6-.7-4.3-2.3-5.9-6.6-6.6 4.3-.7 5.9-2.3 6.6-6.6Z" />
      <path d="M18.4 16.2c.3 1.9 1 2.6 2.9 2.9-1.9.3-2.6 1-2.9 2.9-.3-1.9-1-2.6-2.9-2.9 1.9-.3 2.6-1 2.9-2.9Z" />
    </Svg>
  );
}

export function IconPlus(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M12 5v14M5 12h14" />
    </Svg>
  );
}

export function IconMinus(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M5 12h14" />
    </Svg>
  );
}

export function IconInfo(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5.4" />
      <circle cx="12" cy="7.9" r="1.1" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function IconBolt(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M13.4 2.8 4.8 13.4h6L9.8 21.2l8.8-10.8h-6.2z" />
    </Svg>
  );
}

export function IconSwords(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M3.4 3.4h3.4l10 10-3.4 3.4z" />
      <path d="M20.6 3.4h-3.4l-4.2 4.2 3.4 3.4z" />
      <path d="M5.4 20.6 8.8 17.2" />
      <path d="M18.6 20.6 15.2 17.2" />
    </Svg>
  );
}

export function IconTarget(props: IconProps): React.JSX.Element {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="8.6" />
      <circle cx="12" cy="12" r="4.4" />
      <circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" />
    </Svg>
  );
}
