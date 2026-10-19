// Browser pane actions: create, navigate, probe, pop out, open externally, ports -> panes.
// With the native engine (src/browser/engine.ts) back / forward / reload go to the pane's view, and the
// view's own reports (applyViewState) keep the address, title and history buttons current.

import { openUrl } from "@tauri-apps/plugin-opener";
import { browserPaneForPort, isBrowserMeta } from "../lib/browserPanes";
import { t } from "../i18n";
import { errorMessage, ipc } from "../lib/ipc";
import type { BrowserViewAction, BrowserViewState, SessionId, SessionMeta } from "../lib/types";
import { displayUrl, isAppOrigin, isLocalDevUrl, urlForPort, validateUrl } from "../lib/url";
import { findGroupOf, selectActiveGroup, selectActiveWorkspace, uid, useApp } from "../store/appStore";
import { useUi } from "../store/uiStore";
import { currentEngine } from "../browser/engine";
import { dropNav, getNav, initNav, ownOrigin, pushNav, setNav, stepNav, viewOf } from "../browser/nav";
import { focusSession } from "./commands";
import { notify } from "./notify";

export interface OpenBrowserOptions {
  url?: string | null;
  /** Target group; default: the group of `afterId`, else the active group. */
  groupId?: string;
  /** Insert right after this pane. */
  afterId?: SessionId;
  name?: string;
}

function defaultName(url: string | null): string {
  return (url ? displayUrl(url) : "") || t("browser.defaultName");
}

/** Create a browser pane and focus it. Returns its id (null without a group). */
export function openBrowserPane(o: OpenBrowserOptions = {}): SessionId | null {
  const app = useApp.getState();
  const url = o.url ? validateUrl(o.url) : null;
  if (o.url && !url) {
    notify("error", t("browser.toast.invalidUrl"));
    return null;
  }
  const loc = o.afterId ? findGroupOf(o.afterId) : undefined;
  const groupId = o.groupId ?? loc?.group.id ?? selectActiveGroup(app)?.id;
  if (!groupId) return null;
  const ws = app.persisted.workspaces.find((w) => w.groups.some((g) => g.id === groupId)) ?? selectActiveWorkspace(app);
  const meta: SessionMeta = {
    id: uid(),
    name: o.name?.trim() || defaultName(url),
    agent: "generic",
    cwd: ws?.projectDir ?? "",
    kind: "browser",
    url,
    titleAsName: !o.name,
    profileId: null,
    command: null,
    args: [],
    env: [],
    autoStart: false,
    resumeOnRestore: { mode: "none" },
    preset: null,
    agentSessionId: null,
    worktree: null,
    createdAt: new Date().toISOString(),
    lastExitCode: null,
    role: null,
  };
  app.addSessionMeta(groupId, meta);
  if (o.afterId) {
    const g = useApp.getState().persisted.workspaces.flatMap((w) => w.groups).find((x) => x.id === groupId);
    const from = g ? g.sessionIds.indexOf(meta.id) : -1;
    const after = g ? g.sessionIds.indexOf(o.afterId) : -1;
    if (g && from >= 0 && after >= 0 && after + 1 < from) useApp.getState().moveSession(groupId, from, after + 1);
  }
  initNav(meta.id, url);
  if (url) void runProbe(meta.id, url);
  focusSession(meta.id);
  return meta.id;
}

/** Called by the pane on mount: restore its URL from the saved state. */
export function ensureNav(id: SessionId) {
  if (getNav(id)) return;
  const meta = useApp.getState().persisted.sessions.find((m) => m.id === id);
  const url = meta?.url ?? null;
  initNav(id, url);
  if (url) void runProbe(id, url);
}

function persistUrl(id: SessionId, url: string | null) {
  const app = useApp.getState();
  const meta = app.persisted.sessions.find((m) => m.id === id);
  if (!meta || meta.url === url) return;
  app.updateSessionMeta(id, { url, ...(meta.titleAsName && url ? { name: defaultName(url) } : {}) });
}

export function navigate(id: SessionId, raw: string): boolean {
  const url = validateUrl(raw);
  if (!url) {
    notify("error", t("browser.toast.invalidUrl"));
    return false;
  }
  initNav(id, null);
  setNav(id, (n) => pushNav(n, url));
  persistUrl(id, url);
  void runProbe(id, url);
  return true;
}

/** Native engine: send a navigation to the pane's view. Resolves false when there is no view yet. */
function viewNav(id: SessionId, action: BrowserViewAction): Promise<boolean> {
  return ipc.browserViewNavigate(id, action).then(
    () => true,
    () => false,
  );
}

export function goBack(id: SessionId) {
  if (currentEngine() === "native") {
    void viewNav(id, { kind: "back" });
    return;
  }
  setNav(id, (n) => stepNav(n, -1));
  afterStep(id);
}

export function goForward(id: SessionId) {
  if (currentEngine() === "native") {
    void viewNav(id, { kind: "forward" });
    return;
  }
  setNav(id, (n) => stepNav(n, 1));
  afterStep(id);
}

function afterStep(id: SessionId) {
  const url = getNav(id)?.url ?? null;
  persistUrl(id, url);
  if (url) void runProbe(id, url);
}

export function reload(id: SessionId) {
  const n = getNav(id);
  if (!n?.url) return;
  if (currentEngine() === "native") {
    // Reload keeps the page's own history; without a view (e.g. the unreachable card) it is a fresh load.
    void viewNav(id, { kind: "reload" }).then((ok) => {
      if (!ok) setNav(id, (x) => ({ ...x, nonce: x.nonce + 1, loading: true }));
    });
    void runProbe(id, n.url);
    return;
  }
  setNav(id, (x) => ({ ...x, nonce: x.nonce + 1, loading: true }));
  void runProbe(id, n.url);
}

/**
 * A native view reported its page (URL, title, history flags, loading). The URL is adopted only when a
 * browser pane may show it: blob:, data: and the app's own origins keep the last good address.
 */
export function applyViewState(st: BrowserViewState) {
  const id = st.paneId;
  if (!getNav(id)) return;
  const v = st.url && st.url !== "about:blank" ? validateUrl(st.url) : null;
  const url = v && !isAppOrigin(v, ownOrigin()) ? v : null;
  setNav(id, (n) => {
    const moved = !!url && url !== n.url;
    const live = { title: st.title, canGoBack: st.canGoBack, canGoForward: st.canGoForward };
    const same =
      !moved &&
      n.loading === st.loading &&
      n.live?.title === live.title &&
      n.live.canGoBack === live.canGoBack &&
      n.live.canGoForward === live.canGoForward;
    if (same) return n;
    return { ...n, url: moved ? url : n.url, loading: st.loading, live, ...(moved ? { probe: null, probeUrl: null } : {}) };
  });
  const app = useApp.getState();
  const meta = app.persisted.sessions.find((m) => m.id === id);
  if (!meta) return;
  const patch: Partial<SessionMeta> = {};
  if (url && meta.url !== url) patch.url = url;
  if (meta.titleAsName) {
    const name = st.title || (url ? defaultName(url) : meta.name);
    if (name !== meta.name) patch.name = name;
  }
  if (Object.keys(patch).length) app.updateSessionMeta(id, patch);
}

/** Show the start page (address cleared). */
export function goHome(id: SessionId) {
  setNav(id, (n) => ({ ...n, url: null, loading: false, probe: null, probeUrl: null }));
  persistUrl(id, null);
}

export function frameLoaded(id: SessionId) {
  setNav(id, (n) => (n.loading ? { ...n, loading: false } : n));
}

/** Show the iframe even though the probe said the site refuses framing / was unreachable. */
export function forceFrame(id: SessionId) {
  setNav(id, (n) => ({ ...n, forceFrame: true, nonce: n.nonce + 1, loading: true }));
}

// ---- probe ----------------------------------------------------------------------------------

const RETRY_MS = 3000;
const RETRY_MAX = 40; // ~2 minutes of waiting for a dev server to come up
const retries = new Map<SessionId, { timer: number; count: number }>();

function clearRetry(id: SessionId) {
  const r = retries.get(id);
  if (r) window.clearTimeout(r.timer);
  retries.delete(id);
}

/**
 * Probe the URL (embeddable? reachable? title?). Results for a URL the pane left are dropped.
 * Native engine: only local dev servers are probed (to wait for one that is not up yet); the view
 * renders every other site itself and reports the title.
 */
export async function runProbe(id: SessionId, url: string, isRetry = false): Promise<void> {
  if (!isRetry) clearRetry(id);
  // Only the iframe's onLoad clears `loading`; a pane that shows no frame (file: card, refused, unreachable) never gets one.
  const settle = () => setNav(id, (n) => (n.loading && viewOf(n, ownOrigin()) !== "frame" ? { ...n, loading: false } : n));
  if (!/^https?:/i.test(url)) return settle();
  if (currentEngine() === "native" && !isLocalDevUrl(url)) return;
  setNav(id, (n) => ({ ...n, probing: true }));
  let probe;
  try {
    probe = await ipc.browserProbe(url);
  } catch (e) {
    // "Probe failed" stays English: viewOf (browser/nav.ts) matches it to tell a failed probe from an unreachable site.
    probe = { reachable: false, status: null, frameable: null, reason: null, title: null, error: `Probe failed: ${errorMessage(e)}` };
  }
  const n = getNav(id);
  if (!n || n.url !== url) return;
  const wasUnreachable = n.probeUrl === url && n.probe && !n.probe.reachable;
  setNav(id, (x) => ({ ...x, probing: false, probe, probeUrl: url, nonce: wasUnreachable && probe.reachable ? x.nonce + 1 : x.nonce }));
  settle();
  const meta = useApp.getState().persisted.sessions.find((m) => m.id === id);
  const engine = currentEngine();
  if (engine === "frame" && probe.title && meta?.titleAsName && meta.name !== probe.title) useApp.getState().updateSessionMeta(id, { name: probe.title });
  // Waiting for a local dev server: try again for a while.
  if (!probe.reachable && isLocalDevUrl(url) && viewOf(getNav(id), ownOrigin(), engine) === "unreachable") {
    const count = (retries.get(id)?.count ?? 0) + 1;
    if (count <= RETRY_MAX) {
      const timer = window.setTimeout(() => {
        if (useApp.getState().persisted.sessions.some((m) => m.id === id)) void runProbe(id, url, true);
      }, RETRY_MS);
      retries.set(id, { timer, count });
    } else retries.delete(id);
  } else clearRetry(id);
}

// ---- outside the pane -------------------------------------------------------------------------

export function openExternal(url: string | null | undefined) {
  const v = url ? validateUrl(url) : null;
  if (!v || !/^https?:/i.test(v)) {
    notify("info", t("browser.toast.externalHttpOnly"));
    return;
  }
  openUrl(v).catch((e) => notify("error", t("browser.toast.openExternalFailed", { error: errorMessage(e) })));
}

/** Pop-out Gridkeeper browser window (real WebView2 window: any site, file: URLs, DevTools in debug builds). */
export async function popOut(id: SessionId, url?: string | null) {
  const target = url ?? getNav(id)?.url ?? useApp.getState().persisted.sessions.find((m) => m.id === id)?.url;
  if (!target) return;
  try {
    const label = await ipc.browserOpenWindow(target, getNav(id)?.popout ?? null);
    setNav(id, (n) => ({ ...n, popout: label }));
  } catch (e) {
    notify("error", errorMessage(e));
  }
}

export async function openDevtools(id: SessionId) {
  if (currentEngine() === "native") {
    try {
      await ipc.browserViewDevtools(id);
    } catch (e) {
      notify("info", errorMessage(e));
    }
    return;
  }
  const label = getNav(id)?.popout;
  if (!label) {
    notify("info", t("browser.toast.devtoolsNeedsPopout"));
    return;
  }
  try {
    await ipc.browserDevtools(label);
  } catch (e) {
    notify("info", errorMessage(e));
  }
}

/** Called when a browser pane is closed. */
export function disposeBrowserPane(id: SessionId) {
  clearRetry(id);
  const label = getNav(id)?.popout;
  if (label) void ipc.browserCloseWindow(label).catch(() => {});
  dropNav(id);
}

/** Port chip / Ports list: focus the browser pane already on this port next to the session, else open one. */
export function openPort(sessionId: SessionId | null, port: number) {
  const app = useApp.getState();
  const metas = new Map(app.persisted.sessions.map((m) => [m.id, m]));
  const loc = sessionId ? findGroupOf(sessionId) : undefined;
  const group = loc?.group ?? selectActiveGroup(app);
  if (group) {
    const existing = browserPaneForPort(port, group.sessionIds, metas);
    if (existing) {
      focusSession(existing);
      return;
    }
  }
  const startPage = (() => {
    const f = app.focusedSessionId;
    const m = f ? metas.get(f) : undefined;
    return m && isBrowserMeta(m) && !m.url && group?.sessionIds.includes(f!) ? f : null;
  })();
  if (startPage) {
    navigate(startPage, urlForPort(port));
    return;
  }
  openBrowserPane({ url: urlForPort(port), afterId: sessionId ?? undefined, groupId: group?.id });
}

/** "Open URL…" prompt. */
export function promptOpenUrl(groupId?: string) {
  useUi.getState().openDialog({ kind: "openUrl", groupId });
}
