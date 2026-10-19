// Browser pane actions: create, navigate, probe, pop out, open externally, ports -> panes.

import { openUrl } from "@tauri-apps/plugin-opener";
import { browserPaneForPort, isBrowserMeta } from "../lib/browserPanes";
import { errorMessage, ipc } from "../lib/ipc";
import type { SessionId, SessionMeta } from "../lib/types";
import { displayUrl, isLocalDevUrl, urlForPort, validateUrl } from "../lib/url";
import { findGroupOf, selectActiveGroup, selectActiveWorkspace, uid, useApp } from "../store/appStore";
import { useUi } from "../store/uiStore";
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
  return url ? displayUrl(url) || "Browser" : "Browser";
}

/** Create a browser pane and focus it. Returns its id (null without a group). */
export function openBrowserPane(o: OpenBrowserOptions = {}): SessionId | null {
  const app = useApp.getState();
  const url = o.url ? validateUrl(o.url) : null;
  if (o.url && !url) {
    notify("error", "Only http, https and file addresses can be opened");
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
    notify("error", "Only http, https and file addresses can be opened");
    return false;
  }
  initNav(id, null);
  setNav(id, (n) => pushNav(n, url));
  persistUrl(id, url);
  void runProbe(id, url);
  return true;
}

export function goBack(id: SessionId) {
  setNav(id, (n) => stepNav(n, -1));
  afterStep(id);
}

export function goForward(id: SessionId) {
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
  setNav(id, (x) => ({ ...x, nonce: x.nonce + 1, loading: true }));
  void runProbe(id, n.url);
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

/** Probe the URL (embeddable? reachable? title?). Results for a URL the pane left are dropped. */
export async function runProbe(id: SessionId, url: string, isRetry = false): Promise<void> {
  if (!isRetry) clearRetry(id);
  // Only the iframe's onLoad clears `loading`; a pane that shows no frame (file: card, refused, unreachable) never gets one.
  const settle = () => setNav(id, (n) => (n.loading && viewOf(n, ownOrigin()) !== "frame" ? { ...n, loading: false } : n));
  if (!/^https?:/i.test(url)) return settle();
  setNav(id, (n) => ({ ...n, probing: true }));
  let probe;
  try {
    probe = await ipc.browserProbe(url);
  } catch (e) {
    probe = { reachable: false, status: null, frameable: null, reason: null, title: null, error: `Probe failed: ${errorMessage(e)}` };
  }
  const n = getNav(id);
  if (!n || n.url !== url) return;
  const wasUnreachable = n.probeUrl === url && n.probe && !n.probe.reachable;
  setNav(id, (x) => ({ ...x, probing: false, probe, probeUrl: url, nonce: wasUnreachable && probe.reachable ? x.nonce + 1 : x.nonce }));
  settle();
  const meta = useApp.getState().persisted.sessions.find((m) => m.id === id);
  if (probe.title && meta?.titleAsName && meta.name !== probe.title) useApp.getState().updateSessionMeta(id, { name: probe.title });
  // Waiting for a local dev server: try again for a while.
  if (!probe.reachable && isLocalDevUrl(url) && viewOf(getNav(id), ownOrigin()) === "unreachable") {
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
    notify("info", "Only http and https addresses open in the system browser");
    return;
  }
  openUrl(v).catch((e) => notify("error", `Could not open the browser: ${errorMessage(e)}`));
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
  const label = getNav(id)?.popout;
  if (!label) {
    notify("info", "DevTools work in pop-out windows: pop the page out first (debug builds only)");
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
