// Per-browser-pane navigation state (ephemeral, not persisted; the persisted part is meta.url).
// Frame engine: a cross-origin iframe hides its own history and current URL from us, so back / forward
// walk the addresses opened through Gridkeeper (address bar, port chips, links), not in-page link clicks.
// Native engine (src/browser/nativeViews.ts): the view reports its real URL, title and history flags
// (`live`), and back / forward / reload go to the view itself.

import { create } from "zustand";
import type { FrameProbe, SessionId } from "../lib/types";
import { frameMode } from "../lib/url";
import type { BrowserEngine } from "./engine";

export type BrowserView = "start" | "frame" | "refused" | "unreachable" | "file" | "blocked" | "invalid";

/** What a native view reports about its page. */
export interface LiveState {
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
}

export interface NavState {
  /** What the pane shows now (null = start page). Native engine: follows the page's own navigations. */
  url: string | null;
  history: string[];
  index: number;
  /** Bumped by every load Gridkeeper asks for (address bar, reload, recovery): remounts the iframe /
   *  makes the native view load `url` again. In-page navigations of a native view never bump it. */
  nonce: number;
  loading: boolean;
  probing: boolean;
  probe: FrameProbe | null;
  /** The URL the probe result belongs to. */
  probeUrl: string | null;
  /** The user chose to show the frame despite a refusal verdict / unreachable result. */
  forceFrame: boolean;
  /** Label of this pane's pop-out window, if one was opened. */
  popout: string | null;
  /** Native engine: the view's own title and history flags (null while no view reports). */
  live: LiveState | null;
}

export const emptyNav = (url: string | null = null): NavState => ({
  url,
  history: url ? [url] : [],
  index: url ? 0 : -1,
  nonce: 0,
  loading: !!url,
  probing: false,
  probe: null,
  probeUrl: null,
  forceFrame: false,
  popout: null,
  live: null,
});

/** Open `url` as a new history entry (drops the forward entries). Always a new load (nonce bumped). */
export function pushNav(n: NavState, url: string): NavState {
  if (n.url === url) return { ...n, nonce: n.nonce + 1, loading: true, forceFrame: false };
  const history = [...n.history.slice(0, n.index + 1), url].slice(-50);
  return { ...n, url, history, index: history.length - 1, nonce: n.nonce + 1, loading: true, forceFrame: false, probe: null, probeUrl: null };
}

export function stepNav(n: NavState, delta: -1 | 1): NavState {
  const index = n.index + delta;
  if (index < 0 || index >= n.history.length) return n;
  return { ...n, index, url: n.history[index], loading: true, forceFrame: false, probe: null, probeUrl: null };
}

export const canGoBack = (n: NavState | undefined) => !!n && (n.live ? n.live.canGoBack : n.index > 0);
export const canGoForward = (n: NavState | undefined) => !!n && (n.live ? n.live.canGoForward : n.index >= 0 && n.index < n.history.length - 1);

/**
 * Which view the pane body shows. "frame" = the page itself (iframe or native view). A native view
 * renders any site and file: pages, so "refused" and "file" only happen with the frame engine.
 */
export function viewOf(n: NavState | undefined, ownOrigin: string, engine: BrowserEngine = "frame"): BrowserView {
  if (!n || !n.url) return "start";
  const mode = frameMode(n.url, ownOrigin);
  if (mode === "invalid") return "invalid";
  if (mode === "blocked") return "blocked";
  if (mode === "window" && engine === "frame") return "file";
  if (!n.forceFrame && n.probe && n.probeUrl === n.url) {
    if (n.probe.frameable === false && engine === "frame") return "refused";
    if (!n.probe.reachable && n.probe.error && !/curl|Probe failed/i.test(n.probe.error)) return "unreachable";
  }
  return "frame";
}

interface NavStore {
  panes: Record<SessionId, NavState>;
}

export const useBrowserNav = create<NavStore>()(() => ({ panes: {} }));

export function getNav(id: SessionId): NavState | undefined {
  return useBrowserNav.getState().panes[id];
}

export function setNav(id: SessionId, fn: (n: NavState) => NavState) {
  useBrowserNav.setState((s) => {
    const cur = s.panes[id];
    if (!cur) return s;
    const next = fn(cur);
    return next === cur ? s : { panes: { ...s.panes, [id]: next } };
  });
}

export function initNav(id: SessionId, url: string | null) {
  if (getNav(id)) return;
  useBrowserNav.setState((s) => ({ panes: { ...s.panes, [id]: emptyNav(url) } }));
}

export function dropNav(id: SessionId) {
  useBrowserNav.setState((s) => {
    if (!s.panes[id]) return s;
    const { [id]: _, ...rest } = s.panes;
    return { panes: rest };
  });
}

/** The app's own origin (never framed). */
export function ownOrigin(): string {
  return typeof window !== "undefined" ? window.location.origin : "";
}
