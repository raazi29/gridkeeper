// Message comets on the graph canvas: when a message flows (broadcast, hand-off, lead control delivery, brief), a
// small glowing dot with a soft trail travels from the sender (its card, the mission board or the top of the
// canvas) to the receiving card in the sender's role colour, ~700 ms. Event driven (activity store), CSS
// animated (stroke dash along the path, transform-free SVG), each comet removes itself when its animation ends;
// nothing runs between events. Positions are layout coordinates (layoutRect): right at any zoom.

import { memo, useEffect, useRef, useState } from "react";
import { roleInfo } from "../../lib/roles";
import { slugify } from "../../lib/missionDoc";
import type { SessionId } from "../../lib/types";
import { useActivity } from "../../store/activity";
import { useApp } from "../../store/appStore";
import { cometFor, type CometEnd } from "./cometRoute";
import { layoutRect } from "./layout";
import type { Rect } from "./viewport";

interface Comet {
  id: number;
  d: string;
  color: string;
}

const MAX = 10;
let seq = 1;

function endRect(root: HTMLElement, end: CometEnd | { session: SessionId }, homeOf: (id: SessionId) => string | null): Rect | null {
  if ("session" in end) {
    const card = root.querySelector<HTMLElement>(`[data-card="${CSS.escape(end.session)}"]`);
    if (card) return layoutRect(card, root);
    const home = homeOf(end.session);
    const box = home && root.querySelector<HTMLElement>(`[data-node="${CSS.escape(home === "lead" ? "lead" : `lane:${home}`)}"]`);
    return box ? layoutRect(box, root) : null;
  }
  if (end.node === "top") {
    const top = root.querySelector<HTMLElement>('[data-node="top"]');
    const r = top ? layoutRect(top, root) : null;
    return r ? { x: r.x + r.w / 2 - 1, y: Math.max(0, r.y - 12), w: 2, h: 2 } : null;
  }
  const el = root.querySelector<HTMLElement>(`[data-node="${end.node}"]`);
  return el ? layoutRect(el, root) : null;
}

/** A gentle arc from a to b (control point off the straight line, toward the top). */
export function arcPath(a: { x: number; y: number }, b: { x: number; y: number }): string {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const bend = Math.min(120, len * 0.22);
  // Perpendicular, flipped so the arc bows upward.
  let nx = -dy / len;
  let ny = dx / len;
  if (ny > 0) {
    nx = -nx;
    ny = -ny;
  }
  return `M${a.x.toFixed(1)},${a.y.toFixed(1)} Q${(mx + nx * bend).toFixed(1)},${(my + ny * bend).toFixed(1)} ${b.x.toFixed(1)},${b.y.toFixed(1)}`;
}

export const Comets = memo(function Comets({ enabled, homeOf }: { enabled: boolean; homeOf: (id: SessionId) => string | null }) {
  const [comets, setComets] = useState<Comet[]>([]);
  const svg = useRef<SVGSVGElement>(null);
  const home = useRef(homeOf);
  home.current = homeOf;

  useEffect(() => {
    if (!enabled) return;
    const seen = useActivity.getState().events;
    let last = seen[seen.length - 1]?.seq ?? 0;
    return useActivity.subscribe((s) => {
      const fresh = s.events.filter((e) => e.seq > last);
      if (!fresh.length) return;
      last = fresh[fresh.length - 1].seq;
      const root = svg.current?.parentElement;
      if (!root || document.visibilityState === "hidden") return;
      const sessions = useApp.getState().persisted.sessions;
      const resolve = (token: string): SessionId | null => {
        const t = token.toLowerCase();
        const m = sessions.find((x) => x.name.toLowerCase() === t || slugify(x.name) === t) ?? (t === "lead" ? sessions.find((x) => x.role === "lead" && home.current(x.id)) : undefined);
        return m && home.current(m.id) ? m.id : null;
      };
      const add: Comet[] = [];
      for (const e of fresh) {
        const route = cometFor(e, resolve);
        if (!route || !home.current(route.to)) continue;
        const a = endRect(root, route.from, home.current);
        const b = endRect(root, { session: route.to }, home.current);
        if (!a || !b) continue;
        const from = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
        const to = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
        if (Math.hypot(to.x - from.x, to.y - from.y) < 24) continue;
        const role = "session" in route.from ? sessions.find((x) => x.id === (route.from as { session: SessionId }).session)?.role : null;
        add.push({ id: seq++, d: arcPath(from, to), color: "session" in route.from ? (roleInfo(role)?.color ?? "var(--role-custom)") : "var(--mc-gold)" });
      }
      if (add.length) setComets((c) => [...c, ...add].slice(-MAX));
    });
  }, [enabled]);

  return (
    <svg ref={svg} className="mc-comets" aria-hidden="true">
      {enabled &&
        comets.map((c) => (
          <g
            key={c.id}
            className="mc-msg-comet"
            style={{ ["--cc" as string]: c.color }}
            onAnimationEnd={(e) => e.target === e.currentTarget.lastChild && setComets((list) => list.filter((x) => x.id !== c.id))}
          >
            <path d={c.d} pathLength={1} className="mc-msg-trail" />
            <path d={c.d} pathLength={1} className="mc-msg-glow" />
            <path d={c.d} pathLength={1} className="mc-msg-head" />
          </g>
        ))}
    </svg>
  );
});
