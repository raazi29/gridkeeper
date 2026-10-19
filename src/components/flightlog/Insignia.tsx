// Flight log insignia (one per rank) and medal glyphs: small inline SVGs drawn in currentColor, so the
// theme's colours apply. Chevrons for the first ranks, bars for the officers, stars for the flag ranks.

import type { MedalId } from "../../lib/flightlog";

/** Points of a five-pointed star centred at (cx, cy). */
function star(cx: number, cy: number, r: number): string {
  const pts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 === 0 ? r : r * 0.45;
    pts.push(`${(cx + rr * Math.cos(a)).toFixed(2)},${(cy + rr * Math.sin(a)).toFixed(2)}`);
  }
  return pts.join(" ");
}

const chevron = (y: number) => <path key={y} d={`M3 ${y + 3} L8 ${y} L13 ${y + 3}`} />;

function rankShapes(index: number) {
  switch (index) {
    case 0:
      return [chevron(7)];
    case 1:
      return [chevron(5), chevron(9)];
    case 2:
      return [chevron(3.5), chevron(7), chevron(10.5)];
    case 3:
      // Wings with a centre disc.
      return [<path key="w" d="M1.5 7 L6 9 M14.5 7 L10 9 M3 10 L6 10.5 M13 10 L10 10.5" />, <circle key="c" cx="8" cy="9" r="1.8" className="fl-fill" />];
    case 4:
      return [<rect key="a" x="3" y="4.5" width="10" height="2.4" rx="0.6" className="fl-fill" />, <rect key="b" x="3" y="9.1" width="10" height="2.4" rx="0.6" className="fl-fill" />];
    case 5:
      return [<polygon key="s" points={star(8, 8.4, 5.6)} className="fl-fill" />];
    case 6:
      return [<polygon key="a" points={star(4.6, 8.4, 3.6)} className="fl-fill" />, <polygon key="b" points={star(11.4, 8.4, 3.6)} className="fl-fill" />];
    default:
      return [
        <polygon key="a" points={star(8, 5.2, 3.3)} className="fl-fill" />,
        <polygon key="b" points={star(3.8, 11, 2.9)} className="fl-fill" />,
        <polygon key="c" points={star(12.2, 11, 2.9)} className="fl-fill" />,
      ];
  }
}

export function Insignia({ index, size = 14, title }: { index: number; size?: number; title?: string }) {
  return (
    <svg className="fl-insignia" width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" role={title ? "img" : undefined} aria-hidden={title ? undefined : true}>
      {title && <title>{title}</title>}
      {rankShapes(index)}
    </svg>
  );
}

function medalShapes(id: MedalId) {
  switch (id) {
    case "first-jump":
      return <path d="M5 13 L11 7 M7.5 7 H11 V10.5 M4 9.5 L6 7.5 M8.5 14 L10.5 12" />;
    case "full-squadron":
      return (
        <g className="fl-fill" stroke="none">
          <circle cx="8" cy="5" r="1.3" />
          <circle cx="5.5" cy="8" r="1.3" />
          <circle cx="10.5" cy="8" r="1.3" />
          <circle cx="3" cy="11" r="1.3" />
          <circle cx="13" cy="11" r="1.3" />
        </g>
      );
    case "clean-landing":
      return <path d="M3 12 H13 M4.5 6 Q8 6 10 10.5 M10 10.5 L11.5 8.6" />;
    case "night-shift":
      return <path d="M10.5 3.5 A5 5 0 1 0 12.5 10.5 A4 4 0 1 1 10.5 3.5 Z" />;
    case "seven-suns":
      return (
        <g className="fl-fill" stroke="none">
          {Array.from({ length: 7 }, (_, i) => {
            const a = -Math.PI / 2 + (i * 2 * Math.PI) / 7;
            return <circle key={i} cx={8 + 4.6 * Math.cos(a)} cy={8 + 4.6 * Math.sin(a)} r="1.2" />;
          })}
        </g>
      );
    case "hyperspace":
      return <path d="M8 8 L2.5 4 M8 8 L1.5 8.5 M8 8 L3 12.5 M8 8 L13.5 4 M8 8 L14.5 8.5 M8 8 L13 12.5 M8 8 L8 2 M8 8 L8 14" />;
    case "long-patrol":
      return <path d="M2.5 8 C2.5 3 13.5 3 13.5 8 C13.5 13 2.5 13 2.5 8 Z M12 5 L13.5 8 L15 5.5" />;
    case "outer-rim":
      return (
        <>
          <circle cx="8" cy="8" r="2.6" className="fl-fill" stroke="none" />
          <ellipse cx="8" cy="8" rx="6.2" ry="2.4" transform="rotate(-20 8 8)" />
        </>
      );
    case "ten-campaigns":
      return <path d="M4.5 4.5 L11.5 11.5 M11.5 4.5 L4.5 11.5 M3 14 H13" />;
    case "supply-line":
      return (
        <>
          <path d="M2 8 H14" />
          <g className="fl-fill" stroke="none">
            <circle cx="4" cy="8" r="1.6" />
            <circle cx="8" cy="8" r="1.6" />
            <circle cx="12" cy="8" r="1.6" />
          </g>
        </>
      );
    default:
      return null;
  }
}

export function MedalGlyph({ id, size = 28 }: { id: MedalId; size?: number }) {
  return (
    <svg className="fl-medal-glyph" width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {medalShapes(id)}
    </svg>
  );
}

/** Shield for the streak's missed-day cover; `filled` = available. */
export function ShieldIcon({ filled, size = 14 }: { filled: boolean; size?: number }) {
  return (
    <svg className={`fl-shield${filled ? " is-on" : ""}`} width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinejoin="round" aria-hidden="true">
      <path d="M8 1.8 L13.2 3.8 V8 C13.2 11 11 13.2 8 14.4 C5 13.2 2.8 11 2.8 8 V3.8 Z" className={filled ? "fl-fill" : undefined} />
    </svg>
  );
}
