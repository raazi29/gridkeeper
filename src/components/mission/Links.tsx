// Connector lines between Mission Control nodes, drawn from measured DOM positions. The SVG lives inside
// the scrolling content, so scrolling never invalidates paths; a ResizeObserver (container + every node)
// triggers re-measurement. Lines sit behind the nodes, so crossings are hidden.

import { useLayoutEffect, useRef, useState } from "react";

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

/** Rendered as the first child of the positioned content element whose descendants carry `data-node`. */
export function Links({ links, version }: { links: LinkSpec[]; version: string }) {
  const [paths, setPaths] = useState<Path[]>([]);
  // The parent's ref is not attached yet when this child's layout effect runs: use our own SVG's parent.
  const svg = useRef<SVGSVGElement>(null);

  useLayoutEffect(() => {
    const root = svg.current?.parentElement;
    if (!root) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const base = root.getBoundingClientRect();
      const rect = (id: string) => root.querySelector<HTMLElement>(`[data-node="${CSS.escape(id)}"]`)?.getBoundingClientRect();
      const next: Path[] = [];
      for (const l of links) {
        const a = rect(l.from);
        const b = rect(l.to);
        if (!a || !b) continue;
        next.push({
          key: l.key,
          cls: l.cls,
          d: linkPath({ x: a.left + a.width / 2 - base.left, y: a.bottom - base.top }, { x: b.left + b.width / 2 - base.left, y: b.top - base.top }),
        });
      }
      setPaths((prev) => (prev.length === next.length && prev.every((p, i) => p.d === next[i].d && p.cls === next[i].cls && p.key === next[i].key) ? prev : next));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    const ro = new ResizeObserver(schedule);
    ro.observe(root);
    for (const el of root.querySelectorAll<HTMLElement>("[data-node]")) ro.observe(el);
    measure();
    return () => {
      ro.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [links, version]);

  return (
    <svg ref={svg} className="mc-links" aria-hidden="true">
      {paths.map((p) => (
        <path key={p.key} d={p.d} className={`mc-link ${p.cls}`} />
      ))}
    </svg>
  );
}
