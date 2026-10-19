// Small line icons for Mission Control's deck controls (16-unit grid, stroke = currentColor).

import type { ReactNode } from "react";

type P = { size?: number };

const svg = (size: number, body: ReactNode) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {body}
  </svg>
);

export const IcZoomIn = ({ size = 12 }: P) => svg(size, <path d="M8 3.5v9M3.5 8h9" />);
export const IcZoomOut = ({ size = 12 }: P) => svg(size, <path d="M3.5 8h9" />);
export const IcFit = ({ size = 12 }: P) => svg(size, <path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" />);
export const IcMinimap = ({ size = 12 }: P) =>
  svg(
    size,
    <>
      <rect x="2" y="3" width="12" height="10" rx="1.2" />
      <rect x="7.5" y="7" width="4.5" height="4" rx="0.6" />
    </>,
  );
export const IcHand = ({ size = 12 }: P) => svg(size, <path d="M5.5 8V3.8a1 1 0 0 1 2 0V7m0-3.7a1 1 0 0 1 2 0V7m0-2.2a1 1 0 0 1 2 0V9c0 2.6-1.6 4.5-4 4.5-1.8 0-2.6-.8-3.6-2.4L2.6 8.9a1 1 0 0 1 1.6-1.1L5.5 9" />);
export const IcSelect = ({ size = 12 }: P) => svg(size, <path d="M2.5 2.5h3M8 2.5h2M12.5 2.5h1v1M13.5 6v2M2.5 5v2M2.5 9.5v1M2.5 13.5h1M3.5 2.5h-1v1M7 9l6.5 2.2-2.8 1-1 2.8z" />);
export const IcPin = ({ size = 12 }: P) => svg(size, <path d="M6 2.5h4l-.6 4 2.3 2.2H4.3L6.6 6.5zM8 8.7V14" />);
export const IcSpot = ({ size = 12 }: P) =>
  svg(
    size,
    <>
      <circle cx="8" cy="8" r="5.5" />
      <circle cx="8" cy="8" r="2" />
    </>,
  );
export const IcSearch = ({ size = 12 }: P) =>
  svg(
    size,
    <>
      <circle cx="7" cy="7" r="4" />
      <path d="M10 10l3.5 3.5" />
    </>,
  );
export const IcGraph = ({ size = 12 }: P) =>
  svg(
    size,
    <>
      <rect x="5.5" y="2" width="5" height="3.5" rx="0.8" />
      <rect x="1.5" y="10.5" width="5" height="3.5" rx="0.8" />
      <rect x="9.5" y="10.5" width="5" height="3.5" rx="0.8" />
      <path d="M8 5.5v2.5M4 10.5V8h8v2.5" />
    </>,
  );
export const IcBoard = ({ size = 12 }: P) =>
  svg(
    size,
    <>
      <rect x="1.5" y="2.5" width="3.6" height="11" rx="0.8" />
      <rect x="6.2" y="2.5" width="3.6" height="7.5" rx="0.8" />
      <rect x="10.9" y="2.5" width="3.6" height="9.5" rx="0.8" />
    </>,
  );
export const IcTimeline = ({ size = 12 }: P) => svg(size, <path d="M1.5 4h6M4 8h8.5M2.5 12h5M13.5 2v12" />);
export const IcList = ({ size = 12 }: P) => svg(size, <path d="M5.5 4h9M5.5 8h9M5.5 12h9M1.8 4h.4M1.8 8h.4M1.8 12h.4" />);
export const IcPanel = ({ size = 12 }: P) =>
  svg(
    size,
    <>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.2" />
      <path d="M10 2.5v11" />
    </>,
  );
export const IcStars = ({ size = 12 }: P) => svg(size, <path d="M8 2v3M8 11v3M2 8h3M11 8h3M4 4l1.4 1.4M10.6 10.6 12 12M12 4l-1.4 1.4M5.4 10.6 4 12" />);
