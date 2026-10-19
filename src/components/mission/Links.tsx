// Connector lines between Mission Control nodes, drawn from measured DOM positions. The SVG lives inside
// the scrolling content (positions are relative to it, so scrolling changes nothing); a ResizeObserver
// (container + every node) triggers re-measurement. Lines sit behind the nodes, so crossings are hidden.
// Two nodes side by side (the mission board and the lead box on wide windows) are joined edge to edge.
// With effects on, each line also carries a flowing energy path and real events send a comet along it
// (`pulses`, CSS-animated; each one reports its end so the parent drops it).

import { useLayoutEffect, useRef, useState } from "react";
import type { Pulse } from "./derive";
import { layoutRect } from "./layout";

export interface LinkSpec {
  key: string;
  from: string; // data-node id
  to: string;
  cls: string; // "" | "is-active" | "is-needs" | "is-review"
}

interface Path {
  key: string;
  d: string;
  cls: string;
}

/** Vertical S-curve from the bottom centre of `a` to the top centre of `b` (pure; exported for tests). */
export function linkPath(a: { x: number; y: number }, b: { x: number; y: number }): string {
  const my = (a.y + b.y) / 2;
  return `M${a.x.toFixed(1)},${a.y.toFixed(1)} C${a.x.toFixed(1)},${my.toFixed(1)} ${b.x.toFixed(1)},${my.toFixed(1)} ${b.x.toFixed(1)},${b.y.toFixed(1)}`;
}

/** Horizontal S-curve from the right edge of `a` to the left edge of `b` (side-by-side nodes; pure). */
export function linkPathH(a: { x: number; y: number }, b: { x: number; y: number }): string {
  const mx = (a.x + b.x) / 2;
  return `M${a.x.toFixed(1)},${a.y.toFixed(1)} C${mx.toFixed(1)},${a.y.toFixed(1)} ${mx.toFixed(1)},${b.y.toFixed(1)} ${b.x.toFixed(1)},${b.y.toFixed(1)}`;
}

/** Rendered as the first child of the positioned content element whose descendants carry `data-node`. */
export function Links({ links, version, pulses = [], onPulseEnd }: { links: LinkSpec[]; version: string; pulses?: Pulse[]; onPulseEnd?: (id: number) => void }) {
  const [paths, setPaths] = useState<Path[]>([]);
  // The parent's ref is not attached yet when this child's layout effect runs: use our own SVG's parent.
  const svg = useRef<SVGSVGElement>(null);

  useLayoutEffect(() => {
    const root = svg.current?.parentElement;
    if (!root) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      // Layout coordinates inside the canvas: the same at every zoom, and unaffected by running transforms
      // (FLIP, the entry assembly).
      const rect = (id: string) => {
        const el = root.querySelector<HTMLElement>(`[data-node="${CSS.escape(id)}"]`);
        const r = el ? layoutRect(el, root) : null;
        return r ? { left: r.x, top: r.y, right: r.x + r.w, bottom: r.y + r.h, width: r.w } : null;
      };
      const next: Path[] = [];
      for (const l of links) {
        const a = rect(l.from);
        const b = rect(l.to);
        if (!a || !b) continue;
        // Side by side (b starts right of a and overlaps it vertically): join the facing edges near the top.
        const beside = b.left >= a.right - 1 && b.top < a.bottom && a.top < b.bottom;
        next.push({
          key: l.key,
          cls: l.cls,
          d: beside
            ? linkPathH({ x: a.right, y: Math.max(a.top, b.top) + 24 }, { x: b.left, y: Math.max(a.top, b.top) + 24 })
            : linkPath({ x: a.left + a.width / 2, y: a.bottom }, { x: b.left + b.width / 2, y: b.top }),
        });
      }
      setPaths((prev) => (prev.length === next.length && prev.every((p, i) => p.d === next[i].d && p.cls === next[i].cls && p.key === next[i].key) ? prev : next));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    const ro = new ResizeObserver(schedule);
    ro.observe(root);
    // The entry assembly moves nodes with transforms (no resize): measure again once they have landed.
    const onAnim = (e: AnimationEvent) => e.animationName === "mc-assemble" && schedule();
    root.addEventListener("animationend", onAnim);
    for (const el of root.querySelectorAll<HTMLElement>("[data-node]")) ro.observe(el);
    measure();
    return () => {
      ro.disconnect();
      root.removeEventListener("animationend", onAnim);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [links, version]);

  return (
    <svg ref={svg} className="mc-links" aria-hidden="true">
      {paths.map((p) => (
        <g key={p.key}>
          <path d={p.d} className={`mc-link ${p.cls}`} />
          <path d={p.d} className={`mc-link-energy ${p.cls}`} />
          {pulses
            .filter((c) => c.key === p.key)
            .map((c) => (
              <g key={c.id} className={`mc-comet is-${c.tone}`} onAnimationEnd={(e) => e.target === e.currentTarget.lastChild && onPulseEnd?.(c.id)}>
                <path d={p.d} pathLength={1} className="mc-comet-tail" />
                <path d={p.d} pathLength={1} className="mc-comet-head" />
              </g>
            ))}
        </g>
      ))}
    </svg>
  );
}
