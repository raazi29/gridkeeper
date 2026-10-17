// Output-rate sparkline (last 60 one-second samples of real bytes/s). Scale floor 2 KB/s so idle noise
// stays flat; the peak is in the tooltip.

import { memo } from "react";
import type { SessionId } from "../../lib/types";
import { formatRate, useRates } from "../../store/rates";

const POINTS = 60;
const FLOOR = 2048;
const W = 120;
const H = 14;

/** SVG path for a series (pure; exported for tests). Returns "" for fewer than two points. */
export function sparkPath(values: number[], w = W, h = H, floor = FLOOR): { line: string; area: string; peak: number } {
  const v = values.slice(-POINTS);
  if (v.length < 2) return { line: "", area: "", peak: v[0] ?? 0 };
  const peak = Math.max(...v);
  const max = Math.max(floor, peak);
  const step = w / (POINTS - 1);
  const x0 = w - (v.length - 1) * step;
  const pts = v.map((y, i) => `${(x0 + i * step).toFixed(1)},${(h - 1 - (y / max) * (h - 2)).toFixed(1)}`);
  const line = `M${pts.join("L")}`;
  return { line, area: `${line}L${w},${h}L${x0.toFixed(1)},${h}Z`, peak };
}

export const Sparkline = memo(function Sparkline({ id }: { id: SessionId }) {
  const hist = useRates((s) => s.hist[id]);
  if (!hist || hist.length < 2) return <span className="mc-spark-none">{hist ? "sampling…" : "no data"}</span>;
  const { line, area, peak } = sparkPath(hist);
  return (
    <svg className="mc-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`Output rate, last 60 s, peak ${formatRate(peak)}`}>
      <title>{`Terminal output, last ${Math.min(POINTS, hist.length)} s · peak ${formatRate(peak)}`}</title>
      <path d={area} fill="currentColor" opacity={0.14} />
      <path d={line} fill="none" stroke="currentColor" strokeWidth={1} vectorEffect="non-scaling-stroke" />
    </svg>
  );
});
