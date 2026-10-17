// Small inline stroke icons (16px grid, 1.5px stroke, currentColor).

import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 16, children, ...rest }: P) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
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

export const IconPlus = (p: P) => (
  <Svg {...p}>
    <path d="M8 3.5v9M3.5 8h9" />
  </Svg>
);
export const IconClose = (p: P) => (
  <Svg {...p}>
    <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
  </Svg>
);
export const IconGrid = (p: P) => (
  <Svg {...p}>
    <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" />
    <path d="M8 2.5v11M2.5 8h11" />
  </Svg>
);
export const IconColumns = (p: P) => (
  <Svg {...p}>
    <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" />
    <path d="M6.2 2.5v11M9.8 2.5v11" />
  </Svg>
);
export const IconRows = (p: P) => (
  <Svg {...p}>
    <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" />
    <path d="M2.5 6.2h11M2.5 9.8h11" />
  </Svg>
);
export const IconSidebar = (p: P) => (
  <Svg {...p}>
    <rect x="2.5" y="3" width="11" height="10" rx="1.5" />
    <path d="M6 3v10" />
  </Svg>
);
export const IconInspector = (p: P) => (
  <Svg {...p}>
    <rect x="2.5" y="3" width="11" height="10" rx="1.5" />
    <path d="M10 3v10" />
  </Svg>
);
export const IconSettings = (p: P) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="2" />
    <path d="M8 1.8v1.6M8 12.6v1.6M14.2 8h-1.6M3.4 8H1.8M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1M12.4 12.4l-1.1-1.1M4.7 4.7L3.6 3.6" />
  </Svg>
);
export const IconUsers = (p: P) => (
  <Svg {...p}>
    <circle cx="6" cy="5.5" r="2.2" />
    <path d="M2 13c.4-2.2 2-3.4 4-3.4s3.6 1.2 4 3.4" />
    <path d="M10.5 3.6a2.1 2.1 0 010 3.9M12 9.9c1 .5 1.7 1.5 2 3.1" />
  </Svg>
);
export const IconActivity = (p: P) => (
  <Svg {...p}>
    <path d="M1.8 8.5h2.6l1.8-4.5 3.2 8 1.8-3.5h3" />
  </Svg>
);
export const IconTerminal = (p: P) => (
  <Svg {...p}>
    <rect x="2" y="3" width="12" height="10" rx="1.5" />
    <path d="M4.8 6.5L6.8 8l-2 1.5M8.5 10h2.7" />
  </Svg>
);
export const IconChevronDown = (p: P) => (
  <Svg {...p}>
    <path d="M4.5 6.5L8 10l3.5-3.5" />
  </Svg>
);
export const IconChevronRight = (p: P) => (
  <Svg {...p}>
    <path d="M6.5 4.5L10 8l-3.5 3.5" />
  </Svg>
);
export const IconChevronLeft = (p: P) => (
  <Svg {...p}>
    <path d="M9.5 4.5L6 8l3.5 3.5" />
  </Svg>
);
export const IconCopy = (p: P) => (
  <Svg {...p}>
    <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
    <path d="M10.5 5.5V4a1.5 1.5 0 00-1.5-1.5H4A1.5 1.5 0 002.5 4v5A1.5 1.5 0 004 10.5h1.5" />
  </Svg>
);
export const IconPlay = (p: P) => (
  <Svg {...p}>
    <path d="M5 3.5v9l7.5-4.5z" />
  </Svg>
);
export const IconStop = (p: P) => (
  <Svg {...p}>
    <rect x="4" y="4" width="8" height="8" rx="1" />
  </Svg>
);
export const IconRestart = (p: P) => (
  <Svg {...p}>
    <path d="M13 8a5 5 0 11-1.5-3.6" />
    <path d="M13 2.8v2.6h-2.6" />
  </Svg>
);
export const IconFolder = (p: P) => (
  <Svg {...p}>
    <path d="M2.5 4.5A1.5 1.5 0 014 3h2.6l1.4 1.5h4A1.5 1.5 0 0113.5 6v5.5A1.5 1.5 0 0112 13H4a1.5 1.5 0 01-1.5-1.5z" />
  </Svg>
);
export const IconBranch = (p: P) => (
  <Svg {...p}>
    <circle cx="5" cy="3.8" r="1.4" />
    <circle cx="5" cy="12.2" r="1.4" />
    <circle cx="11" cy="5.8" r="1.4" />
    <path d="M5 5.2v5.6M11 7.2c0 2.3-2.2 2.6-6 3.6" />
  </Svg>
);
export const IconCheck = (p: P) => (
  <Svg {...p}>
    <path d="M3.5 8.5l3 3 6-7" />
  </Svg>
);
export const IconWarn = (p: P) => (
  <Svg {...p}>
    <path d="M8 2.5l6 10.5H2z" />
    <path d="M8 6.5v3M8 11.3v.1" />
  </Svg>
);
export const IconInfo = (p: P) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="5.8" />
    <path d="M8 7.3v3.6M8 5.2v.1" />
  </Svg>
);
export const IconSearch = (p: P) => (
  <Svg {...p}>
    <circle cx="7" cy="7" r="4.2" />
    <path d="M10.2 10.2L13.5 13.5" />
  </Svg>
);
export const IconMaximize = (p: P) => (
  <Svg {...p}>
    <path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5L9 7M2.5 13.5L7 9" />
  </Svg>
);
export const IconEye = (p: P) => (
  <Svg {...p}>
    <path d="M1.8 8S4 3.8 8 3.8 14.2 8 14.2 8 12 12.2 8 12.2 1.8 8 1.8 8z" />
    <circle cx="8" cy="8" r="1.8" />
  </Svg>
);
export const IconEyeOff = (p: P) => (
  <Svg {...p}>
    <path d="M6.3 4a6.4 6.4 0 011.7-.2c4 0 6.2 4.2 6.2 4.2a10.8 10.8 0 01-1.6 2.1M4.2 4.9A10.6 10.6 0 001.8 8S4 12.2 8 12.2a6 6 0 003-.8" />
    <path d="M2.5 2.5l11 11" />
  </Svg>
);
export const IconTrash = (p: P) => (
  <Svg {...p}>
    <path d="M2.8 4.5h10.4M6.3 4.5V3h3.4v1.5M4.2 4.5l.6 8.5h6.4l.6-8.5" />
  </Svg>
);
export const IconMore = (p: P) => (
  <Svg {...p} strokeWidth={2.2}>
    <path d="M3.5 8h.01M8 8h.01M12.5 8h.01" />
  </Svg>
);
export const IconEdit = (p: P) => (
  <Svg {...p}>
    <path d="M10.5 2.8l2.7 2.7-7.4 7.4H3.1v-2.7z" />
  </Svg>
);
export const IconExternal = (p: P) => (
  <Svg {...p}>
    <path d="M9 2.5h4.5V7M13.5 2.5L7.5 8.5M11.5 9.5v3a1 1 0 01-1 1h-7a1 1 0 01-1-1v-7a1 1 0 011-1h3" />
  </Svg>
);
export const IconKeyboard = (p: P) => (
  <Svg {...p}>
    <rect x="1.8" y="4" width="12.4" height="8" rx="1.5" />
    <path d="M4.5 6.6h.01M7 6.6h.01M9.5 6.6h.01M12 6.6h.01M5 9.4h6" />
  </Svg>
);

/** The app mark: a precise, small glyph — two offset panes. */
/** Focus mode: four corner brackets (frame the terminal, drop the chrome). */
export const IconFocus = (p: P) => (
  <Svg {...p}>
    <path d="M2.5 6V3.5a1 1 0 0 1 1-1H6M10 2.5h2.5a1 1 0 0 1 1 1V6M13.5 10v2.5a1 1 0 0 1-1 1H10M6 13.5H3.5a1 1 0 0 1-1-1V10" />
  </Svg>
);

/**
 * Brand mark: a delta / "A" over a broken horizon line, an attitude indicator reduced to two strokes.
 * Ink follows the theme text colour; the horizon carries the theme's signal colour.
 */
export const AppMark = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 18 18" aria-hidden="true" focusable="false" fill="none" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3.6 15 9 3.2 14.4 15" stroke="var(--text-0)" strokeWidth="1.7" />
    <path d="M1.2 11.2h3.1M13.7 11.2h3.1M7.2 11.2h3.6" stroke="var(--accent)" strokeWidth="1.5" />
    <circle cx="9" cy="3.2" r="1.15" fill="var(--accent)" />
  </svg>
);
