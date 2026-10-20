// Native browser panes (Windows): one WebView2 child webview per browser pane, created and placed by
// src-tauri/src/browser_view.rs. This module decides for every browser pane whether its view is shown
// at the pane's host box, hidden for a moment ("occluded") or "parked", and keeps the views in sync:
// - geometry: the host box from frameHosts (the registry the iframe layer uses too), sent in CSS px
//   plus devicePixelRatio; re-synced on resizes, layout and store changes (one rAF per burst);
// - overlays: a native view paints above the whole page, so it is hidden whenever anything else is on
//   top of its host box (menus, dialogs, the palette, Mission Control, toasts). Detected by hit-testing
//   a grid of points over the host box (document.elementFromPoint): no list of overlays to maintain;
// - placeholders: before a view is hidden for an overlay or a drag, a JPEG snapshot of it is put into
//   the host box, so the pane does not go blank under a menu;
// - drags: HTML drag and drop (pane reorder) hides every view, which would otherwise swallow the drop;
// - keys: the app's bindings are registered with the host, which keeps them from a focused page and
//   sends them back here (`browser-view-shortcut`).
// See docs/TECHNICAL_DECISIONS.md ADR-021.

import { applyViewState, navigate, openBrowserPane } from "../actions/browser";
import { notify, useToasts } from "../actions/notify";
import { revealPath } from "../components/util/pick";
import { t } from "../i18n";
import { boundCombos, runBoundCombo } from "../keybindings";
import { isBrowserMeta } from "../lib/browserPanes";
import { errorMessage, ipc, onBrowserViewEvents } from "../lib/ipc";
import type { BrowserViewDownload, BrowserViewRect, BrowserViewVisibility, SessionId } from "../lib/types";
import { actionToast, useUi } from "../store/uiStore";
import { useApp } from "../store/appStore";
import { currentEngine, markNativeFailed, nativeSupported, useEngineState } from "./engine";
import { frameBox, getHost } from "./frameHosts";
import { coveredAt, decideVisibility, planView, samplePoints, toViewRect, type Box, type PlanOp } from "./nativeSync";
import { getNav, ownOrigin, setNav, useBrowserNav, viewOf } from "./nav";

// ---- manager -----------------------------------------------------------------------------------

/** How long a snapshot counts as current enough to stand in for the page under an overlay. */
const SNAP_FRESH_MS = 1500;
/** How long hiding may wait for a snapshot. */
const SNAP_WAIT_MS = 180;
/** Placeholder stays this long after a view is shown again (covers the re-show). */
const SNAP_CLEAR_MS = 300;

interface Entry {
  phase: "creating" | "ready";
  busy: boolean;
  sent: { vis: BrowserViewVisibility; rect: BrowserViewRect | null } | null;
  nonce: number;
  snapUrl: string | null;
  snapAt: number;
  clearTimer: number;
}

const entries = new Map<SessionId, Entry>();
/** Panes whose view was refused with an "invalid" error: not retried until their URL changes. */
const refused = new Map<SessionId, string>();
let raf = 0;
let dragging = false;
let lastCombos = "";

/** Re-sync every native view on the next animation frame (coalesced). */
export function scheduleNativeSync() {
  if (!raf && typeof requestAnimationFrame === "function") raf = requestAnimationFrame(syncNow);
}

function hostBox(host: HTMLElement | undefined): Box | null {
  return frameBox(host, { left: 0, top: 0 });
}

function hit(x: number, y: number): Element | null {
  return document.elementFromPoint(x, y);
}

/** The pane whose view has keyboard focus (cleared when the app page gets focus back). */
let viewFocus: SessionId | null = null;

/** Notifications (toasts are a live region) must not blank the page the user is typing in. */
function isNotification(el: unknown): boolean {
  return el instanceof Element && !!el.closest("[aria-live], [role='status'], [role='alert']");
}

function syncNow() {
  raf = 0;
  if (currentEngine() !== "native") {
    if (entries.size) closeAll();
    return;
  }
  const ids = new Set(
    useApp
      .getState()
      .persisted.sessions.filter((m) => isBrowserMeta(m))
      .map((m) => m.id),
  );
  for (const id of [...entries.keys()]) if (!ids.has(id)) closeView(id);
  const dpr = window.devicePixelRatio || 1;
  const pageVisible = document.visibilityState !== "hidden";
  const own = ownOrigin();
  const now = Date.now();
  for (const id of ids) {
    const nav = getNav(id);
    const wantUrl = nav?.url && viewOf(nav, own, "native") === "frame" ? nav.url : null;
    if (wantUrl && refused.get(id) === wantUrl) continue;
    const host = getHost(id);
    const box = hostBox(host);
    const covered = !!wantUrl && !!box && !!host && coveredAt(samplePoints(box), hit, host, viewFocus === id ? isNotification : undefined);
    const vis = decideVisibility({ box, pageVisible, dragging, covered });
    const e = entries.get(id);
    const ops = planView({
      exists: !!e && e.phase === "ready",
      busy: !!e?.busy,
      sent: e?.sent ?? null,
      appliedNonce: e?.nonce ?? -1,
      wantUrl,
      nonce: nav?.nonce ?? 0,
      vis,
      rect: box ? toViewRect(box, dpr) : null,
      snapFresh: !!e && now - e.snapAt < SNAP_FRESH_MS,
    });
    for (const op of ops) run(id, op, nav?.nonce ?? 0);
  }
}

function run(id: SessionId, op: PlanOp, nonce: number) {
  switch (op.kind) {
    case "create":
      create(id, op.url, op.rect, nonce);
      return;
    case "navigate": {
      const e = entries.get(id);
      if (e) e.nonce = nonce;
      void ipc.browserViewNavigate(id, { kind: "url", url: op.url }).catch((err) => notify("error", errorMessage(err)));
      return;
    }
    case "show": {
      const e = entries.get(id);
      if (!e) return;
      e.sent = { vis: "shown", rect: op.rect };
      void ipc.browserViewSetBounds(id, op.rect, "shown").catch(() => {});
      window.clearTimeout(e.clearTimer);
      e.clearTimer = window.setTimeout(() => {
        if (entries.get(id)?.sent?.vis === "shown") showSnapshot(id, false);
      }, SNAP_CLEAR_MS);
      return;
    }
    case "snapshot":
      void snapshotThenResync(id);
      return;
    case "hide": {
      const e = entries.get(id);
      if (!e) return;
      window.clearTimeout(e.clearTimer);
      // Occluded: the picture stands in for the page. Parked: the pane is off screen or shows a card.
      showSnapshot(id, op.vis === "occluded");
      e.sent = { vis: op.vis, rect: op.rect };
      void ipc.browserViewSetBounds(id, op.rect, op.vis).catch(() => {});
      return;
    }
  }
}

function create(id: SessionId, url: string, rect: BrowserViewRect, nonce: number) {
  const e: Entry = { phase: "creating", busy: true, sent: null, nonce, snapUrl: null, snapAt: 0, clearTimer: 0 };
  entries.set(id, e);
  ipc
    .browserViewCreate(id, url, rect, "shown")
    .then(() => {
      if (entries.get(id) !== e) {
        // The pane closed (or the engine switched) while the view was being created.
        void ipc.browserViewClose(id).catch(() => {});
        return;
      }
      e.phase = "ready";
      e.busy = false;
      e.sent = { vis: "shown", rect };
      scheduleNativeSync();
    })
    .catch((err: unknown) => {
      if (entries.get(id) === e) entries.delete(id);
      const code = (err as { code?: string } | null)?.code;
      if (code === "conflict") return; // a create for this pane is already running
      if (code === "invalid") {
        refused.set(id, url);
        notify("error", errorMessage(err));
        return;
      }
      markNativeFailed(errorMessage(err));
    });
}

function closeView(id: SessionId) {
  const e = entries.get(id);
  entries.delete(id);
  refused.delete(id);
  if (viewFocus === id) viewFocus = null;
  if (e) {
    window.clearTimeout(e.clearTimer);
    showSnapshot(id, false);
    if (e.snapUrl) URL.revokeObjectURL(e.snapUrl);
  }
  void ipc.browserViewClose(id).catch(() => {});
  setNav(id, (n) => (n.live ? { ...n, live: null } : n));
}

function closeAll() {
  for (const id of [...entries.keys()]) {
    const e = entries.get(id);
    if (e) window.clearTimeout(e.clearTimer);
    showSnapshot(id, false);
    if (e?.snapUrl) URL.revokeObjectURL(e.snapUrl);
    setNav(id, (n) => (n.live ? { ...n, live: null } : n));
  }
  entries.clear();
  refused.clear();
  void ipc.browserViewRetain([]).catch(() => {});
}

/** Put the entry's snapshot into (or take it out of) the pane's host box. */
function showSnapshot(id: SessionId, on: boolean) {
  const host = getHost(id);
  if (!host) return;
  const url = on ? entries.get(id)?.snapUrl : null;
  if (url) {
    host.style.backgroundImage = `url("${url}")`;
    host.dataset.snapshot = "";
  } else if (host.dataset.snapshot !== undefined) {
    host.style.backgroundImage = "";
    delete host.dataset.snapshot;
  }
}

/** Take a snapshot of a shown view. Resolves false (keeping the previous picture) when none came back. */
async function takeSnapshot(id: SessionId, waitMs: number): Promise<boolean> {
  const e = entries.get(id);
  if (!e || e.phase !== "ready") return false;
  let buf: ArrayBuffer | null = null;
  try {
    buf = await Promise.race([ipc.browserViewSnapshot(id), new Promise<null>((r) => window.setTimeout(() => r(null), waitMs))]);
  } catch {
    buf = null;
  }
  if (!buf || buf.byteLength === 0 || entries.get(id) !== e) return false;
  const url = URL.createObjectURL(new Blob([buf], { type: "image/jpeg" }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
  } catch {
    URL.revokeObjectURL(url);
    return false;
  }
  if (entries.get(id) !== e) {
    URL.revokeObjectURL(url);
    return false;
  }
  const old = e.snapUrl;
  e.snapUrl = url;
  e.snapAt = Date.now();
  // The old picture may be on screen right now: swap first, revoke after.
  if (getHost(id)?.dataset.snapshot !== undefined) showSnapshot(id, true);
  if (old) URL.revokeObjectURL(old);
  return true;
}

/** Overlay opening over a shown view: picture first (briefly), then hide (the next sync does). */
async function snapshotThenResync(id: SessionId) {
  const e = entries.get(id);
  if (!e || e.busy) return;
  e.busy = true;
  const ok = await takeSnapshot(id, SNAP_WAIT_MS);
  e.busy = false;
  if (!ok) {
    // No picture in time: hide without one (an old picture could show a different page).
    if (e.snapUrl) URL.revokeObjectURL(e.snapUrl);
    e.snapUrl = null;
    e.snapAt = Date.now(); // counts as "fresh", so the plan hides instead of asking again
  }
  scheduleNativeSync();
}

/** The pointer came back into the page from a view (or from outside): refresh pictures of shown views. */
function refreshSnapshots() {
  const now = Date.now();
  for (const [id, e] of entries) {
    if (e.phase === "ready" && !e.busy && e.sent?.vis === "shown" && now - e.snapAt > 1000) void takeSnapshot(id, 1000);
  }
}

function registerShortcuts() {
  const combos = boundCombos().sort();
  const key = combos.join("\n");
  if (key === lastCombos) return;
  lastCombos = key;
  void ipc.browserViewSetShortcuts(combos).catch(() => {
    lastCombos = "";
  });
}

function onDownload(d: BrowserViewDownload) {
  const name = d.path ? d.path.split(/[\\/]/).pop() || d.path : d.url;
  if (d.state === "started") notify("info", t("browser.download.started", { name }));
  else if (d.state === "failed") notify("error", t("browser.download.failed", { name }));
  else {
    const path = d.path;
    actionToast({
      kind: "info",
      message: t("browser.download.done", { name }),
      detail: path ?? undefined,
      action: path
        ? {
            label: t("browser.download.showInFolder"),
            run: () => void revealPath(path),
          }
        : undefined,
    });
  }
}

let installed = false;

/**
 * Wire the native views up (once, from BrowserLayer). No-op where native panes are unsupported.
 * Returns the uninstall function.
 */
export function installNativeViews(): () => void {
  if (installed || !nativeSupported()) return () => {};
  installed = true;
  const offs: (() => void)[] = [];

  let unlisten: (() => void) | null = null;
  let disposed = false;
  void onBrowserViewEvents({
    state: (s) => applyViewState(s),
    focus: (paneId) => {
      viewFocus = paneId;
      if (useApp.getState().focusedSessionId !== paneId) useApp.getState().setFocused(paneId);
      scheduleNativeSync();
    },
    shortcut: (s) => {
      // Keyboard focus back to the page first, so a dialog / palette the command opens gets the keys.
      void ipc.browserViewBlur().catch(() => {});
      runBoundCombo(s.combo, s.repeat);
    },
    newWindow: (r) => {
      if (useApp.getState().persisted.settings.browserNewWindow === "same") navigate(r.paneId, r.url);
      else openBrowserPane({ url: r.url, afterId: r.paneId });
    },
    download: onDownload,
  }).then((off) => {
    if (disposed) off();
    else unlisten = off;
  });
  offs.push(() => {
    disposed = true;
    unlisten?.();
  });

  // Views left from before a page reload whose pane closed meanwhile (all of them with the frame engine).
  const retain = () => {
    const ids =
      currentEngine() === "native"
        ? useApp
            .getState()
            .persisted.sessions.filter((m) => isBrowserMeta(m))
            .map((m) => m.id)
        : [];
    void ipc.browserViewRetain(ids).catch(() => {});
  };
  if (useApp.getState().loaded) retain();
  else {
    const off = useApp.subscribe((s) => {
      if (s.loaded) {
        off();
        retain();
        scheduleNativeSync();
      }
    });
    offs.push(off);
  }

  registerShortcuts();
  offs.push(
    useApp.subscribe((s, p) => {
      if (s.persisted.settings.keybindings !== p.persisted.settings.keybindings) registerShortcuts();
      if (s.persisted !== p.persisted || s.focusedSessionId !== p.focusedSessionId) scheduleNativeSync();
    }),
  );
  offs.push(
    useUi.subscribe((s, p) => {
      // Everything but the 2 s diagnostics refresh may open, close or move something.
      if (s.diag !== p.diag || s.diagError !== p.diagError) {
        const { diag: _a, diagError: _b, ...rest } = s;
        const { diag: _c, diagError: _d, ...prev } = p;
        if ((Object.keys(rest) as (keyof typeof rest)[]).every((k) => rest[k] === prev[k])) return;
      }
      scheduleNativeSync();
    }),
  );
  offs.push(useToasts.subscribe(() => scheduleNativeSync()));
  offs.push(useEngineState.subscribe(() => scheduleNativeSync()));
  offs.push(useBrowserNav.subscribe(() => scheduleNativeSync()));

  // Overlays are portaled to <body> or mounted as direct children of the shell: watch both, shallowly.
  const mo = new MutationObserver(() => scheduleNativeSync());
  mo.observe(document.body, { childList: true });
  const shell = document.querySelector(".shell");
  if (shell) mo.observe(shell, { childList: true });
  offs.push(() => mo.disconnect());

  const later = () => scheduleNativeSync();
  const onDragStart = () => {
    dragging = true;
    scheduleNativeSync();
  };
  const onDragEnd = () => {
    if (!dragging) return;
    dragging = false;
    scheduleNativeSync();
  };
  const onOver = (e: MouseEvent) => {
    if (e.relatedTarget === null) refreshSnapshots();
  };
  const onPageFocus = () => {
    if (viewFocus === null) return;
    viewFocus = null;
    scheduleNativeSync();
  };
  const winEvents: [string, EventListener, boolean][] = [
    ["resize", later, false],
    ["pointerup", later, true],
    ["click", later, true],
    ["transitionend", later, true],
    ["animationend", later, true],
    ["dragstart", onDragStart, true],
    ["dragend", onDragEnd, true],
    ["drop", onDragEnd, true],
    ["mouseover", onOver as EventListener, true],
    ["focus", onPageFocus, false],
  ];
  for (const [type, fn, capture] of winEvents) window.addEventListener(type, fn, capture);
  offs.push(() => {
    for (const [type, fn, capture] of winEvents) window.removeEventListener(type, fn, capture);
  });
  document.addEventListener("visibilitychange", later);
  offs.push(() => document.removeEventListener("visibilitychange", later));
  // Moving to a monitor with another scale changes devicePixelRatio.
  let mq: MediaQueryList | null = null;
  const watchDpr = () => {
    mq?.removeEventListener("change", onDpr);
    mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    mq.addEventListener("change", onDpr);
  };
  const onDpr = () => {
    watchDpr();
    scheduleNativeSync();
  };
  watchDpr();
  offs.push(() => mq?.removeEventListener("change", onDpr));

  scheduleNativeSync();
  return () => {
    installed = false;
    for (const off of offs) off();
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  };
}
