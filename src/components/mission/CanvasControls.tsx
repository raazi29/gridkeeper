// Graph view controls in the canvas's bottom-right corner: tool (hand / box select), zoom − / % / +, fit, and the
// minimap (lanes and boxes as blocks, cards coloured by state, a frame for what is on screen; click to jump,
// drag the frame to pan). Both read the published view (once per frame), never the canvas per wheel tick.

import { memo, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { useDeck } from "../../store/missionDeck";
import { layoutRect } from "./layout";
import { IcFit, IcHand, IcMinimap, IcSelect, IcZoomIn, IcZoomOut } from "./mcIcons";
import { T } from "./mcText";
import { useCanvasView, type CanvasApi } from "./useCanvas";
import { centerOn, minimapScale, visibleRect, type Rect } from "./viewport";

export const ZoomControls = memo(function ZoomControls({ api }: { api: CanvasApi }) {
  const k = useCanvasView((s) => s.view.k);
  const tool = useDeck((s) => s.tool);
  const minimap = useDeck((s) => s.minimap);
  const set = useDeck((s) => s.set);
  return (
    <div className="mc-zoom" role="toolbar" aria-label={T.zoom.controls} onPointerDown={(e) => e.stopPropagation()}>
      <div className="mc-zoom-seg">
        <button type="button" className={tool === "pan" ? "is-on" : ""} aria-pressed={tool === "pan"} title={T.zoom.pan} onClick={() => set({ tool: "pan" })}>
          <IcHand />
        </button>
        <button type="button" className={tool === "select" ? "is-on" : ""} aria-pressed={tool === "select"} title={T.zoom.select} onClick={() => set({ tool: "select" })}>
          <IcSelect />
        </button>
      </div>
      <div className="mc-zoom-seg">
        <button type="button" title={T.zoom.zoomOut} aria-label={T.zoom.zoomOut} disabled={k <= 0.2501} onClick={() => api.zoomStep(-1)}>
          <IcZoomOut />
        </button>
        <button type="button" className="mc-zoom-pct" title={T.zoom.reset} aria-label={T.zoom.reset} onClick={() => api.home()}>
          {T.zoom.pct(k)}
        </button>
        <button type="button" title={T.zoom.zoomIn} aria-label={T.zoom.zoomIn} disabled={k >= 1.9999} onClick={() => api.zoomStep(1)}>
          <IcZoomIn />
        </button>
      </div>
      <div className="mc-zoom-seg">
        <button type="button" title={T.zoom.fit} aria-label={T.zoom.fit} onClick={() => api.fit()}>
          <IcFit />
        </button>
        <button type="button" className={minimap ? "is-on" : ""} aria-pressed={minimap} title={T.zoom.minimap} aria-label={T.zoom.minimap} onClick={() => set({ minimap: !minimap })}>
          <IcMinimap />
        </button>
      </div>
    </div>
  );
});

const BOX = { w: 164, h: 100 };

interface Block {
  key: string;
  r: Rect;
  kind: "node" | "card";
  lamp?: string;
  needs?: boolean;
}

/** Minimap of the canvas. `version` changes when boxes / cards / their states change (re-measure). */
export const Minimap = memo(function Minimap({ api, version }: { api: CanvasApi; version: string }) {
  const view = useCanvasView((s) => s.view);
  const viewport = useCanvasView((s) => s.viewport);
  const inset = useCanvasView((s) => s.inset);
  const content = useCanvasView((s) => s.content);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const drag = useRef<{ id: number; x0: number; y0: number; v0: { x: number; y: number; k: number } } | null>(null);

  useLayoutEffect(() => {
    const c = api.canvas.current;
    if (!c) return;
    const out: Block[] = [];
    for (const el of c.querySelectorAll<HTMLElement>("[data-node]:not([data-node='top'])")) {
      const r = layoutRect(el, c);
      if (r && r.w > 0) out.push({ key: `n:${el.dataset.node}`, r, kind: "node", needs: el.classList.contains("is-needs") });
    }
    for (const el of c.querySelectorAll<HTMLElement>("[data-card]")) {
      const r = layoutRect(el, c);
      if (r && r.w > 0) out.push({ key: `c:${el.dataset.card}`, r, kind: "card", lamp: el.dataset.lamp });
    }
    setBlocks(out);
  }, [api, version, content.w, content.h]);

  const s = minimapScale(content, BOX);
  if (content.w <= 0 || !(s > 0)) return null;
  const w = content.w * s;
  const h = content.h * s;
  const vis = visibleRect(view, { w: Math.max(0, viewport.w - inset), h: viewport.h });

  const toCanvas = (e: { clientX: number; clientY: number }, el: Element) => {
    const r = el.getBoundingClientRect();
    return { x: (e.clientX - r.left) / s, y: (e.clientY - r.top) / s };
  };
  const onDown = (e: RPointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const p = toCanvas(e, e.currentTarget);
    const inFrame = p.x >= vis.x && p.x <= vis.x + vis.w && p.y >= vis.y && p.y <= vis.y + vis.h;
    if (!inFrame) api.set(centerOn(api.get(), p.x, p.y, { w: Math.max(0, viewport.w - inset), h: viewport.h }), { animate: true });
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { id: e.pointerId, x0: e.clientX, y0: e.clientY, v0: inFrame ? api.get() : centerOn(api.get(), p.x, p.y, { w: Math.max(0, viewport.w - inset), h: viewport.h }) };
  };
  const onMove = (e: RPointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = (e.clientX - d.x0) / s;
    const dy = (e.clientY - d.y0) / s;
    api.set({ x: d.v0.x - dx * d.v0.k, y: d.v0.y - dy * d.v0.k, k: d.v0.k });
  };
  const onUp = (e: RPointerEvent<SVGSVGElement>) => {
    if (drag.current?.id === e.pointerId) drag.current = null;
  };

  return (
    <div className="mc-minimap" title={T.minimap.label} onPointerDown={(e) => e.stopPropagation()}>
      <svg width={w} height={h} viewBox={`0 0 ${content.w} ${content.h}`} role="img" aria-label={T.minimap.label} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
        {blocks.map((b) =>
          b.kind === "node" ? (
            <rect key={b.key} x={b.r.x} y={b.r.y} width={b.r.w} height={b.r.h} rx={6} className={`mc-mm-node${b.needs ? " is-needs" : ""}`} />
          ) : (
            <rect key={b.key} x={b.r.x + 4} y={b.r.y + 4} width={Math.max(4, b.r.w - 8)} height={Math.max(4, b.r.h - 8)} rx={4} className={`mc-mm-card is-${b.lamp ?? "idle"}`} />
          ),
        )}
        <rect x={vis.x} y={vis.y} width={vis.w} height={vis.h} className="mc-mm-frame" vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  );
});

/** Publishes the agent panel's overlap of the graph viewport (px) so reveal / fit / controls avoid it. */
export function useCanvasInset(inset: number): void {
  useEffect(() => {
    useCanvasView.setState({ inset });
    return () => useCanvasView.setState({ inset: 0 });
  }, [inset]);
}
