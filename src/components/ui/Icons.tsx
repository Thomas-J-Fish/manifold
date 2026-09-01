/* A hand-rolled icon set.
 *
 * An icon library would be a megabyte of dependency for the fifteen glyphs this
 * app uses, and every one of them would still need restyling to match a 1.6px
 * stroke on a dark surface. These are drawn on a 24-unit grid with a common
 * stroke so they sit consistently in the toolbar and the panels.
 */

import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 16, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const IconPlus = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);

export const IconClose = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Svg>
);

export const IconTrash = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a1 1 0 001 1h8a1 1 0 001-1l1-12M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2" />
  </Svg>
);

export const IconEye = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2 12s3.8-6.5 10-6.5S22 12 22 12s-3.8 6.5-10 6.5S2 12 2 12z" />
    <circle cx="12" cy="12" r="2.6" />
  </Svg>
);

export const IconEyeOff = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 3l18 18M10.6 6.1A9.9 9.9 0 0112 6c6.2 0 10 6 10 6a17 17 0 01-3.3 3.8M6.3 8.3A17.4 17.4 0 002 12s3.8 6.5 10 6.5a9.9 9.9 0 003.4-.6" />
    <path d="M9.9 9.9a3 3 0 004.2 4.2" />
  </Svg>
);

export const IconPlay = (p: IconProps) => (
  <Svg {...p}>
    <path d="M7 4.8v14.4l12-7.2z" fill="currentColor" stroke="none" />
  </Svg>
);

export const IconPause = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 5v14M16 5v14" strokeWidth={2.4} />
  </Svg>
);

export const IconSkipBack = (p: IconProps) => (
  <Svg {...p}>
    <path d="M18 5v14L8 12zM6 5v14" />
  </Svg>
);

export const IconStepForward = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 5v14l10-7zM18 5v14" />
  </Svg>
);

export const IconRefresh = (p: IconProps) => (
  <Svg {...p}>
    <path d="M20 11a8 8 0 10-1.6 5.6M20 5v6h-6" />
  </Svg>
);

export const IconDice = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3.5" y="3.5" width="17" height="17" rx="3.5" />
    <circle cx="8.5" cy="8.5" r="1.15" fill="currentColor" stroke="none" />
    <circle cx="15.5" cy="15.5" r="1.15" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.15" fill="currentColor" stroke="none" />
  </Svg>
);

export const IconChevronDown = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 9l6 6 6-6" />
  </Svg>
);

export const IconChevronRight = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 6l6 6-6 6" />
  </Svg>
);

export const IconSidebar = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2.5" />
    <path d="M10 4v16" />
  </Svg>
);

export const IconGrid = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 9h18M3 15h18M9 3v18M15 3v18" />
  </Svg>
);

export const IconTarget = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <circle cx="12" cy="12" r="3.5" />
    <path d="M12 1.5v3M12 19.5v3M1.5 12h3M19.5 12h3" />
  </Svg>
);

export const IconDownload = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3v12M7.5 10.5L12 15l4.5-4.5M4 19h16" />
  </Svg>
);

export const IconUpload = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 16V4M7.5 8.5L12 4l4.5 4.5M4 20h16" />
  </Svg>
);

export const IconCopy = (p: IconProps) => (
  <Svg {...p}>
    <rect x="9" y="9" width="12" height="12" rx="2.5" />
    <path d="M6 15H4.5A1.5 1.5 0 013 13.5v-9A1.5 1.5 0 014.5 3h9A1.5 1.5 0 0115 4.5V6" />
  </Svg>
);

export const IconFunction = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 20c1.8 0 2.4-1.3 2.8-3.6L11 4.6C11.4 2.3 12.2 1 14 1M6.5 9.5h7.5" />
    <path d="M14.5 13.5l5 6M19.5 13.5l-5 6" />
  </Svg>
);

export const IconSigma = (p: IconProps) => (
  <Svg {...p}>
    <path d="M18 4H6l6 8-6 8h12" />
  </Svg>
);

export const IconMatrix = (p: IconProps) => (
  <Svg {...p}>
    <path d="M7 3H4v18h3M17 3h3v18h-3" />
    <circle cx="10" cy="9" r="1" fill="currentColor" stroke="none" />
    <circle cx="14" cy="9" r="1" fill="currentColor" stroke="none" />
    <circle cx="10" cy="15" r="1" fill="currentColor" stroke="none" />
    <circle cx="14" cy="15" r="1" fill="currentColor" stroke="none" />
  </Svg>
);

export const IconWave = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2 12c2.5-6 5-6 7.5 0s5 6 7.5 0 3.5-3 5-1.5" />
  </Svg>
);

export const IconScatter = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 4v16h16" />
    <circle cx="8.5" cy="15" r="1.3" fill="currentColor" stroke="none" />
    <circle cx="12" cy="11" r="1.3" fill="currentColor" stroke="none" />
    <circle cx="15.5" cy="12.5" r="1.3" fill="currentColor" stroke="none" />
    <circle cx="18" cy="7.5" r="1.3" fill="currentColor" stroke="none" />
  </Svg>
);

export const IconCube = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 2.8l8 4.4v9.6l-8 4.4-8-4.4V7.2z" />
    <path d="M4 7.2l8 4.4 8-4.4M12 11.6V21" />
  </Svg>
);

export const IconSpiral = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 12a2 2 0 112 2 4 4 0 11-4-4 6 6 0 116 6 8 8 0 11-8-8" />
  </Svg>
);

export const IconInfo = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5M12 7.6v.4" />
  </Svg>
);

export const IconWarning = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3.6L21.4 20H2.6z" />
    <path d="M12 10v4.5M12 17.4v.3" />
  </Svg>
);

export const IconCheck = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4.5 12.5l5 5 10-11" />
  </Svg>
);

export const IconLock = (p: IconProps) => (
  <Svg {...p}>
    <rect x="4.5" y="10.5" width="15" height="10" rx="2.5" />
    <path d="M8 10.5V7.5a4 4 0 018 0v3" />
  </Svg>
);

export const IconSearch = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="10.5" cy="10.5" r="6.5" />
    <path d="M15.5 15.5L21 21" />
  </Svg>
);
