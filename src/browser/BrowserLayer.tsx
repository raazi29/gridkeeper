// One persistent layer (inside .grid-area) holding every browser pane's iframe, laid over the pane's
// host box. Positions are applied imperatively (no React render per resize). Overlays (menus, palette,
// dialogs, toasts) are DOM above this layer, so they work normally.
// With the native engine (engine.ts) the panes are child webviews instead (nativeViews.ts): the layer
// then renders no iframes, but its geometry triggers drive those views too.

import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { frameLoaded } from "../actions/browser";
import { useT } from "../i18n";
import { isBrowserMeta } from "../lib/browserPanes";
import type { SessionId } from "../lib/types";
import { FRAME_SANDBOX } from "../lib/url";
import { useApp } from "../store/appStore";
import { useUi } from "../store/uiStore";
import { useBrowserEngine } from "./engine";
import { frameBox, getHost, hostIds, subscribeHosts } from "./frameHosts";
import { installNativeViews, scheduleNativeSync } from "./nativeViews";
import { ownOrigin, useBrowserNav, viewOf } from "./nav";

const slots = new Map<SessionId, HTMLDivElement>();
let raf = 0;
let layerEl: HTMLDivElement | null = null;

function syncNow() {
  raf = 0;
  if (!layerEl) return;
  const lr = layerEl.getBoundingClientRect();
  for (const [id, slot] of slots) {
    const box = frameBox(getHost(id), lr);
    if (box) {
      slot.style.transform = `translate(${box.left}px, ${box.top}px)`;
      slot.style.width = `${box.width}px`;
      slot.style.height = `${box.height}px`;
      slot.style.visibility = "visible";
    } else {
      slot.style.visibility = "hidden";
    }
  }
}

/** Re-place every frame (and native view) on the next animation frame (coalesced). */
export function syncFrames() {
  if (!raf) raf = requestAnimationFrame(syncNow);
  scheduleNativeSync();
}

export function BrowserLayer() {
  const ref = useRef<HTMLDivElement>(null);
  const [passive, setPassive] = useState(false);

  useEffect(() => installNativeViews(), []);
  // Panes that have been on screen at least once keep their frame (hidden) while their host is
  // unmounted, so maximize / group switches do not reload pages. Closed panes drop out.
  const browserIds = useApp(useShallow((s) => s.persisted.sessions.filter((m) => isBrowserMeta(m)).map((m) => m.id)));
  const [seen, setSeen] = useState<SessionId[]>([]);

  useEffect(() => {
    const update = () =>
      setSeen((prev) => {
        const add = hostIds().filter((id) => !prev.includes(id));
        return add.length ? [...prev, ...add] : prev;
      });
    update();
    return subscribeHosts(() => {
      update();
      syncFrames();
    });
  }, []);

  const live = seen.filter((id) => browserIds.includes(id));

  useLayoutEffect(() => {
    layerEl = ref.current;
    return () => {
      layerEl = null;
    };
  }, []);

  // Size changes of hosts and of the grid area; store changes that move panes without resizing them.
  useEffect(() => {
    const ro = new ResizeObserver(() => syncFrames());
    const observed = new Set<Element>();
    const observeHosts = () => {
      if (ref.current && !observed.has(ref.current)) {
        ro.observe(ref.current);
        observed.add(ref.current);
      }
      for (const id of hostIds()) {
        const h = getHost(id);
        if (h && !observed.has(h)) {
          ro.observe(h);
          observed.add(h);
        }
      }
      for (const el of [...observed]) if (!el.isConnected) {
        ro.unobserve(el);
        observed.delete(el);
      }
    };
    observeHosts();
    const offHosts = subscribeHosts(observeHosts);
    const offApp = useApp.subscribe((s, p) => {
      if (s.persisted.workspaces !== p.persisted.workspaces || s.persisted.activeWorkspaceId !== p.persisted.activeWorkspaceId) syncFrames();
    });
    const offUi = useUi.subscribe((s, p) => {
      if (s.focusMode !== p.focusMode || s.changesOpen !== p.changesOpen || s.presentation !== p.presentation) syncFrames();
    });
    window.addEventListener("resize", syncFrames);
    return () => {
      ro.disconnect();
      offHosts();
      offApp();
      offUi();
      window.removeEventListener("resize", syncFrames);
    };
  }, []);

  // While a mouse button is held in the app document (separator drags, pane drag & drop, text
  // selection) frames must not swallow the pointer. Events inside a frame never reach this document.
  useEffect(() => {
    const down = () => setPassive(true);
    const up = () => setPassive(false);
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("dragend", up, true);
    window.addEventListener("drop", up, true);
    window.addEventListener("blur", up);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("dragend", up, true);
      window.removeEventListener("drop", up, true);
      window.removeEventListener("blur", up);
    };
  }, []);

  // Clicking into a frame moves focus out of the document: make that pane the focused one.
  useEffect(() => {
    const onBlur = () =>
      window.setTimeout(() => {
        const el = document.activeElement;
        const id = el instanceof HTMLIFrameElement ? el.dataset.paneId : undefined;
        if (id && useApp.getState().focusedSessionId !== id) useApp.getState().setFocused(id);
      }, 0);
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, []);

  return (
    <div ref={ref} className={`browser-layer${passive ? " is-passive" : ""}`} aria-hidden={live.length === 0 || undefined}>
      {live.map((id) => (
        <FrameSlot key={id} id={id} />
      ))}
    </div>
  );
}

const FrameSlot = memo(function FrameSlot({ id }: { id: SessionId }) {
  const ref = useRef<HTMLDivElement>(null);
  const t = useT();
  const nav = useBrowserNav((s) => s.panes[id]);
  const name = useApp((s) => s.persisted.sessions.find((m) => m.id === id)?.name) ?? t("browser.defaultName");
  const engine = useBrowserEngine();
  const view = viewOf(nav, ownOrigin(), engine);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.visibility = "hidden";
    slots.set(id, el);
    syncFrames();
    return () => {
      if (slots.get(id) === el) slots.delete(id);
    };
  }, [id]);

  const show = engine === "frame" && view === "frame" && !!nav?.url;
  useEffect(() => {
    if (show) syncFrames();
  }, [show]);
  return (
    <div ref={ref} className="browser-frame-slot" data-pane-id={id} style={show ? undefined : { display: "none" }}>
      {show && (
        <iframe
          key={`${nav.url}#${nav.nonce}`}
          className="browser-frame"
          title={name}
          src={nav.url!}
          data-pane-id={id}
          sandbox={FRAME_SANDBOX}
          referrerPolicy="no-referrer"
          allow="clipboard-write; fullscreen"
          onLoad={() => frameLoaded(id)}
        />
      )}
    </div>
  );
});
