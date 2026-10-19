// Mission Control canvas navigation: zoom (Ctrl/⌘ + wheel around the pointer, trackpad pinch, keys, buttons),
// pan (wheel, Space + drag, middle drag, plain drag on the empty canvas), fit, 100 %, reveal, the rubber band,
// and a view remembered per workspace (localStorage, best effort). The transform is written straight to the
// canvas element (no React render per wheel tick); a tiny store publishes the view once per frame for the zoom
// controls and the minimap. Nothing runs while nothing happens: listeners only, no timers or frame loops.

import { useCallback, useEffect, useMemo, useRef, type RefObject } from "react";
import { create } from "zustand";
import { clampPan, clampZoom, fitView, HOME, normRect, parseView, revealView, sameView, stepZoom, toCanvas, wheelZoomFactor, zoomAt, type Rect, type Size, type View } from "./viewport";
import { layoutRect } from "./layout";

interface CanvasStore {
  view: View;
  viewport: Size;
  content: Size;
  /** Right edge covered by the agent panel (px), so reveal / fit / controls avoid it. */
  inset: number;
}

export const useCanvasView = create<CanvasStore>()(() => ({ view: HOME, viewport: { w: 0, h: 0 }, content: { w: 0, h: 0 }, inset: 0 }));

const VIEW_KEY = (wsId: string) => `gridkeeper.mc.view:${wsId}`;
const GLIDE_MS = 280;
/** Elements a plain drag never pans from (they have their own drag or click). */
const NOT_EMPTY = "[data-node]:not([data-node='top']), [data-card], button, input, textarea, select, a, label, [draggable='true'], .mc-newlane, .mc-newlane-zone, .mc-zoom, .mc-minimap";

export interface BandEvent {
  /** Client-coordinate rect of the band. */
  rect: Rect;
  /** Ctrl/⌘ held: add to the current selection. */
  additive: boolean;
}

export interface CanvasApi {
  viewport: RefObject<HTMLDivElement | null>;
  canvas: RefObject<HTMLDivElement | null>;
  set: (v: View, opts?: { animate?: boolean }) => void;
  zoomStep: (dir: 1 | -1) => void;
  zoomTo: (k: number) => void;
  fit: () => void;
  home: () => void;
  /** Smallest animated pan that shows `el` (a canvas descendant) beside the panel. */
  reveal: (el: HTMLElement | null, opts?: { animate?: boolean; pad?: number }) => void;
  get: () => View;
}

export interface CanvasOptions {
  wsId: string | null;
  still: boolean;
  /** The graph view is shown (listeners attach to its elements). */
  active: boolean;
  tool: "pan" | "select";
  onBand?: (e: BandEvent) => void;
  onBandEnd?: (e: BandEvent | null) => void;
  /** A click (no drag) on the empty canvas. */
  onEmptyClick?: () => void;
}

function readView(wsId: string | null): View | null {
  if (!wsId) return null;
  try {
    const raw = localStorage.getItem(VIEW_KEY(wsId));
    return raw ? parseView(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

function writeView(wsId: string, v: View) {
  try {
    if (sameView(v, HOME)) localStorage.removeItem(VIEW_KEY(wsId));
    else localStorage.setItem(VIEW_KEY(wsId), JSON.stringify({ x: Math.round(v.x), y: Math.round(v.y), k: Math.round(v.k * 1000) / 1000 }));
  } catch {
    /* storage unavailable: the view lasts until Mission Control closes */
  }
}

const isTyping = (el: Element | null) => !!el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || (el as HTMLElement).isContentEditable);

/** Can `el` (or an ancestor up to `stop`) scroll further in the wheel's direction? Then the wheel is its own. */
function scrollsItself(el: Element | null, stop: Element, dx: number, dy: number): boolean {
  for (let e = el; e && e !== stop; e = e.parentElement) {
    const s = getComputedStyle(e);
    if (dy && /(auto|scroll)/.test(s.overflowY) && e.scrollHeight > e.clientHeight + 1) {
      if ((dy < 0 && e.scrollTop > 0) || (dy > 0 && e.scrollTop + e.clientHeight < e.scrollHeight - 1)) return true;
    }
    if (dx && /(auto|scroll)/.test(s.overflowX) && e.scrollWidth > e.clientWidth + 1) {
      if ((dx < 0 && e.scrollLeft > 0) || (dx > 0 && e.scrollLeft + e.clientWidth < e.scrollWidth - 1)) return true;
    }
  }
  return false;
}

export function useCanvas(opts: CanvasOptions): CanvasApi {
  const viewport = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const view = useRef<View>(readView(opts.wsId) ?? HOME);
  const o = useRef(opts);
  o.current = opts;
  const frame = useRef(0);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const glideTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const publish = useCallback(() => {
    frame.current = 0;
    const s = useCanvasView.getState();
    if (!sameView(s.view, view.current) || s.view.k !== view.current.k) useCanvasView.setState({ view: view.current });
  }, []);

  const apply = useCallback(() => {
    const c = canvas.current;
    const vp = viewport.current;
    const v = view.current;
    if (c) c.style.transform = `translate3d(${v.x}px, ${v.y}px, 0) scale(${v.k})`;
    if (vp) {
      vp.style.setProperty("--mc-pan-x", `${v.x}px`);
      vp.style.setProperty("--mc-pan-y", `${v.y}px`);
      vp.style.setProperty("--mc-k", String(v.k));
    }
    if (!frame.current) frame.current = requestAnimationFrame(publish);
  }, [publish]);

  const sizes = () => {
    const s = useCanvasView.getState();
    return { content: s.content, vp: { w: Math.max(0, s.viewport.w - s.inset), h: s.viewport.h }, full: s.viewport };
  };

  const set = useCallback(
    (next: View, how?: { animate?: boolean }) => {
      const { content, full } = sizes();
      const v = full.w > 0 && content.w > 0 ? clampPan({ ...next, k: clampZoom(next.k) }, content, full) : { ...next, k: clampZoom(next.k) };
      if (sameView(v, view.current)) return;
      const c = canvas.current;
      if (c && how?.animate && !o.current.still) {
        c.classList.add("is-gliding");
        clearTimeout(glideTimer.current);
        glideTimer.current = setTimeout(() => c.classList.remove("is-gliding"), GLIDE_MS + 40);
      } else if (c && c.classList.contains("is-gliding") && !how?.animate) {
        c.classList.remove("is-gliding");
      }
      view.current = v;
      apply();
      const ws = o.current.wsId;
      if (ws) {
        clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => writeView(ws, view.current), 400);
      }
    },
    [apply],
  );

  const center = () => {
    const { vp } = sizes();
    return { x: vp.w / 2, y: vp.h / 2 };
  };
  const zoomStep = useCallback((dir: 1 | -1) => {
    const c = center();
    set(zoomAt(view.current, stepZoom(view.current.k, dir), c.x, c.y), { animate: true });
  }, [set]);
  const zoomTo = useCallback((k: number) => {
    const c = center();
    set(zoomAt(view.current, k, c.x, c.y), { animate: true });
  }, [set]);
  const fit = useCallback(() => {
    const { content, vp } = sizes();
    set(fitView(content, vp, 28, 1), { animate: true });
  }, [set]);
  const home = useCallback(() => set(HOME, { animate: true }), [set]);
  const reveal = useCallback(
    (el: HTMLElement | null, how?: { animate?: boolean; pad?: number }) => {
      const c = canvas.current;
      if (!el || !c || !c.contains(el)) return;
      const r = layoutRect(el, c);
      if (!r) return;
      const { vp } = sizes();
      if (vp.w <= 0) return;
      set(revealView(view.current, r, vp, how?.pad ?? 28), { animate: how?.animate ?? true });
    },
    [set],
  );
  const get = useCallback(() => view.current, []);

  // A workspace switch while open: that workspace's view.
  const firstWs = useRef(true);
  useEffect(() => {
    if (firstWs.current) {
      firstWs.current = false;
      apply();
      return;
    }
    view.current = readView(opts.wsId) ?? HOME;
    apply();
  }, [opts.wsId, apply]);

  // Sizes (no polling): the viewport and the canvas's layout size; a change re-clamps the view.
  useEffect(() => {
    const vp = viewport.current;
    const c = canvas.current;
    if (!opts.active || !vp || !c) return;
    apply();
    const measure = () => {
      useCanvasView.setState({ viewport: { w: vp.clientWidth, h: vp.clientHeight }, content: { w: c.offsetWidth, h: c.offsetHeight } });
      const { content, full } = sizes();
      if (full.w > 0 && content.w > 0) {
        const v = clampPan(view.current, content, full);
        if (!sameView(v, view.current)) {
          view.current = v;
          apply();
        }
      }
    };
    const ro = new ResizeObserver(measure);
    ro.observe(vp);
    ro.observe(c);
    measure();
    return () => ro.disconnect();
  }, [opts.active, apply]);

  // Wheel (non-passive: Ctrl + wheel must not zoom the whole WebView) and pointer gestures.
  useEffect(() => {
    const vp = viewport.current;
    if (!opts.active || !vp) return;
    let space = false;
    let downAt = 0;

    const onWheel = (e: WheelEvent) => {
      const zoom = e.ctrlKey || e.metaKey;
      if (!zoom && scrollsItself(e.target as Element, vp, e.deltaX, e.deltaY)) return;
      e.preventDefault();
      const r = vp.getBoundingClientRect();
      if (zoom) {
        const k = view.current.k * wheelZoomFactor(e.deltaY, e.deltaMode);
        // A mouse notch (big delta) glides a little; a trackpad pinch (many small deltas) follows directly.
        set(zoomAt(view.current, k, e.clientX - r.left, e.clientY - r.top), { animate: Math.abs(e.deltaY) >= 50 || e.deltaMode !== 0 });
        return;
      }
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? r.height : 1;
      let dx = e.deltaX * unit;
      let dy = e.deltaY * unit;
      if (e.shiftKey && !dx) [dx, dy] = [dy, 0];
      set({ ...view.current, x: view.current.x - dx, y: view.current.y - dy });
    };

    type Drag = { kind: "pan" | "band"; id: number; x0: number; y0: number; v0: View; moved: boolean; additive: boolean; el?: HTMLDivElement };
    let drag: Drag | null = null;

    const bandRect = (d: Drag, x: number, y: number) => normRect(d.x0, d.y0, x, y);
    const onDown = (e: PointerEvent) => {
      downAt = performance.now();
      if (e.pointerType === "touch") return;
      const t = e.target as HTMLElement;
      if (t.closest(".mc-zoom, .mc-minimap")) return;
      const empty = !t.closest(NOT_EMPTY);
      let kind: Drag["kind"] | null = null;
      if (e.button === 1) kind = "pan";
      else if (e.button === 0 && space) kind = "pan";
      else if (e.button === 0 && empty && !isTyping(t)) kind = e.shiftKey || o.current.tool === "select" ? "band" : "pan";
      if (!kind) return;
      e.preventDefault();
      (document.activeElement as HTMLElement | null)?.blur?.();
      vp.closest<HTMLElement>(".mc")?.focus({ preventScroll: true });
      vp.setPointerCapture(e.pointerId);
      drag = { kind, id: e.pointerId, x0: e.clientX, y0: e.clientY, v0: view.current, moved: false, additive: e.ctrlKey || e.metaKey };
      if (kind === "pan") vp.classList.add("is-panning");
    };
    const onMove = (e: PointerEvent) => {
      const d = drag;
      if (!d || e.pointerId !== d.id) return;
      const dx = e.clientX - d.x0;
      const dy = e.clientY - d.y0;
      if (!d.moved && Math.hypot(dx, dy) < 3) return;
      d.moved = true;
      if (d.kind === "pan") {
        set({ ...d.v0, x: d.v0.x + dx, y: d.v0.y + dy });
        return;
      }
      const r = vp.getBoundingClientRect();
      const band = bandRect(d, e.clientX, e.clientY);
      if (!d.el) {
        d.el = document.createElement("div");
        d.el.className = "mc-band";
        vp.appendChild(d.el);
      }
      Object.assign(d.el.style, { left: `${band.x - r.left}px`, top: `${band.y - r.top}px`, width: `${band.w}px`, height: `${band.h}px` });
      o.current.onBand?.({ rect: band, additive: d.additive });
    };
    const end = (e: PointerEvent, cancelled: boolean) => {
      const d = drag;
      if (!d || e.pointerId !== d.id) return;
      drag = null;
      vp.classList.remove("is-panning");
      if (vp.hasPointerCapture(e.pointerId)) vp.releasePointerCapture(e.pointerId);
      if (d.kind === "band") {
        d.el?.remove();
        o.current.onBandEnd?.(d.moved && !cancelled ? { rect: bandRect(d, e.clientX, e.clientY), additive: d.additive } : null);
      }
      if (!d.moved && !cancelled && e.button === 0 && !space) o.current.onEmptyClick?.();
    };
    const onUp = (e: PointerEvent) => end(e, false);
    const onCancel = (e: PointerEvent) => end(e, true);
    const onAux = (e: MouseEvent) => e.button === 1 && e.preventDefault(); // no autoscroll / paste on middle click
    const onDragStart = (e: DragEvent) => space && e.preventDefault();

    // Space held = hand tool (keys from text fields, buttons and task rows keep their Space).
    const spaceOk = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      if (!el || isTyping(el) || el.tagName === "BUTTON" || el.closest?.("[data-line], [role='dialog'] .modal, .menu-root")) return false;
      return !!vp.closest(".mc")?.contains(el) || el === document.body;
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== " " || e.ctrlKey || e.metaKey || e.altKey || !spaceOk(e.target)) return;
      e.preventDefault();
      if (!space) {
        space = true;
        vp.classList.add("is-space");
      }
    };
    const offSpace = () => {
      space = false;
      vp.classList.remove("is-space");
    };
    const onKeyUp = (e: KeyboardEvent) => e.key === " " && offSpace();

    // Keyboard focus that lands outside the visible part (Tab, arrows, find): bring it into view.
    const onFocusIn = (e: FocusEvent) => {
      if (performance.now() - downAt < 400) return;
      const el = e.target as HTMLElement;
      const c = canvas.current;
      if (!c?.contains(el) || el === c) return;
      const r = el.getBoundingClientRect();
      const box = vp.getBoundingClientRect();
      const right = box.right - useCanvasView.getState().inset;
      const visible = Math.max(0, Math.min(r.bottom, box.bottom) - Math.max(r.top, box.top)) * Math.max(0, Math.min(r.right, right) - Math.max(r.left, box.left));
      if (visible < r.width * r.height * 0.6) reveal(el.closest<HTMLElement>("[data-card], [data-line], [data-node]") ?? el);
    };

    vp.addEventListener("wheel", onWheel, { passive: false });
    vp.addEventListener("pointerdown", onDown);
    vp.addEventListener("pointermove", onMove);
    vp.addEventListener("pointerup", onUp);
    vp.addEventListener("pointercancel", onCancel);
    vp.addEventListener("auxclick", onAux);
    vp.addEventListener("mousedown", onAux);
    vp.addEventListener("dragstart", onDragStart, true);
    vp.addEventListener("focusin", onFocusIn);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", offSpace);
    return () => {
      vp.removeEventListener("wheel", onWheel);
      vp.removeEventListener("pointerdown", onDown);
      vp.removeEventListener("pointermove", onMove);
      vp.removeEventListener("pointerup", onUp);
      vp.removeEventListener("pointercancel", onCancel);
      vp.removeEventListener("auxclick", onAux);
      vp.removeEventListener("mousedown", onAux);
      vp.removeEventListener("dragstart", onDragStart, true);
      vp.removeEventListener("focusin", onFocusIn);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", offSpace);
      offSpace();
    };
  }, [opts.active, set, reveal]);

  useEffect(
    () => () => {
      cancelAnimationFrame(frame.current);
      clearTimeout(glideTimer.current);
      const ws = o.current.wsId;
      if (saveTimer.current !== undefined && ws) {
        clearTimeout(saveTimer.current);
        writeView(ws, view.current);
      }
    },
    [],
  );

  return useMemo(() => ({ viewport, canvas, set, zoomStep, zoomTo, fit, home, reveal, get }), [set, zoomStep, zoomTo, fit, home, reveal, get]);
}

/** Viewport point (client coordinates) -> canvas point, for drops and tests. */
export function clientToCanvas(vp: HTMLElement, v: View, clientX: number, clientY: number): { x: number; y: number } {
  const r = vp.getBoundingClientRect();
  return toCanvas(v, clientX - r.left, clientY - r.top);
}
