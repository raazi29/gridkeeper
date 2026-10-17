// Small monochrome inline icons for pane chrome (stroke = currentColor).

import type { ReactNode } from "react";
import type { AgentKind } from "../lib/types";

type P = { size?: number };

const svg = (size: number, children: ReactNode, viewBox = "0 0 16 16") => (
  <svg
    width={size}
    height={size}
    viewBox={viewBox}
    fill="none"
    stroke="currentColor"
    strokeWidth={1.4}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {children}
  </svg>
);

export function AgentGlyph({ agent, size = 12 }: { agent: AgentKind; size?: number }) {
  switch (agent) {
    case "powershell":
      return svg(
        size,
        <>
          <path d="M3 4.5 6.5 8 3 11.5" />
          <path d="M8 11.5h5" />
        </>,
      );
    case "claude":
      // Generic eight-ray spark.
      return svg(
        size,
        <>
          <path d="M8 2.5v11M2.5 8h11" />
          <path d="M4.1 4.1l7.8 7.8M11.9 4.1l-7.8 7.8" strokeWidth={1.1} />
        </>,
      );
    case "codex":
      // Hexagon with a prompt chevron.
      return svg(
        size,
        <>
          <path d="M8 1.8 13.4 4.9v6.2L8 14.2 2.6 11.1V4.9z" />
          <path d="M6.2 6.4 8 8l-1.8 1.6M8.8 10h1.6" strokeWidth={1.2} />
        </>,
      );
    default:
      return svg(
        size,
        <>
          <rect x="2" y="3" width="12" height="10" rx="1.5" />
          <path d="M4.8 6.5 6.6 8 4.8 9.5" />
        </>,
      );
  }
}

export const IconMaximize = ({ size = 12 }: P) => svg(size, <rect x="3" y="3" width="10" height="10" rx="1.2" />);
export const IconRestore = ({ size = 12 }: P) =>
  svg(
    size,
    <>
      <rect x="2.5" y="5.5" width="8" height="8" rx="1.2" />
      <path d="M5.5 5.5V3.7c0-.66.54-1.2 1.2-1.2h5.6c.66 0 1.2.54 1.2 1.2v5.6c0 .66-.54 1.2-1.2 1.2H10.5" />
    </>,
  );
export const IconRestart = ({ size = 12 }: P) =>
  svg(
    size,
    <>
      <path d="M13 8a5 5 0 1 1-1.46-3.54" />
      <path d="M13 2.8v2.7h-2.7" />
    </>,
  );
export const IconClose = ({ size = 12 }: P) => svg(size, <path d="M4 4l8 8M12 4l-8 8" />);
export const IconStop = ({ size = 12 }: P) => svg(size, <rect x="4" y="4" width="8" height="8" rx="1" />);
export const IconPlay = ({ size = 12 }: P) => svg(size, <path d="M5 3.5v9l7-4.5z" />);
export const IconMore = ({ size = 12 }: P) =>
  svg(
    size,
    <>
      <circle cx="3.5" cy="8" r="0.6" fill="currentColor" />
      <circle cx="8" cy="8" r="0.6" fill="currentColor" />
      <circle cx="12.5" cy="8" r="0.6" fill="currentColor" />
    </>,
  );
export const IconBranch = ({ size = 10 }: P) =>
  svg(
    size,
    <>
      <circle cx="4.5" cy="3.5" r="1.5" />
      <circle cx="4.5" cy="12.5" r="1.5" />
      <circle cx="11.5" cy="5.5" r="1.5" />
      <path d="M4.5 5v6M11.5 7c0 2.5-2 3-7 4" />
    </>,
  );
export const IconGlobe = ({ size = 12 }: P) =>
  svg(
    size,
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M2.5 8h11M8 2.5c1.6 1.6 2.4 3.4 2.4 5.5S9.6 11.9 8 13.5M8 2.5C6.4 4.1 5.6 5.9 5.6 8s.8 3.9 2.4 5.5" />
    </>,
  );
export const IconBack = ({ size = 12 }: P) => svg(size, <path d="M9.5 3.5 5 8l4.5 4.5" />);
export const IconForward = ({ size = 12 }: P) => svg(size, <path d="M6.5 3.5 11 8l-4.5 4.5" />);
export const IconPopout = ({ size = 12 }: P) =>
  svg(
    size,
    <>
      <path d="M9 2.5h4.5V7M13.5 2.5 8 8" />
      <path d="M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3" />
    </>,
  );
export const IconExternal = ({ size = 12 }: P) =>
  svg(
    size,
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M6 10l4-4M7 6h3v3" />
    </>,
  );
export const IconCode = ({ size = 12 }: P) => svg(size, <path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5" />);
export const IconHome = ({ size = 12 }: P) => svg(size, <path d="M2.5 7.5 8 3l5.5 4.5M4 6.5v6h8v-6" />);
