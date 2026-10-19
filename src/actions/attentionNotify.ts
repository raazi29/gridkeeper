// Attention wiring: Rust `session-attention` + `session-state` events -> attention store, unread
// clearing on focus, window title badge (+ Dock badge on macOS), in-app / OS toasts, taskbar flash and
// optional sound.
// `installAttention()` is called once (AttentionLayer) and returns a full cleanup.
// Every "should this ping the user?" rule lives in the pure shouldNotify() (notifyRules.ts).

import { disposeAudio, playSound } from "../audio/sounds";
import { t } from "../i18n";
import { APP_NAME } from "../lib/brand";
import { errorMessage, ipc, onSessionAttention, onSessionState } from "../lib/ipc";
import { isMac } from "../lib/platform";
import { installPhoneAlerts, notifyPhone, type PhoneEvent } from "../lib/phoneAlerts";
import type { SessionId, SessionInfo } from "../lib/types";
import { findGroupOf, selectActiveGroup, useApp } from "../store/appStore";
import { countUnread, useAttention, type Alert } from "../store/attention";
import { useMission } from "../store/mission";
import { actionToast } from "../store/uiStore";
import { jumpToSession } from "./commands";
import {
  eventKindOf,
  mutedReasonText,
  normalizeNotifications,
  pruneMutes,
  shouldNotify,
  type NotifyDecision,
  type NotifyEvent,
} from "./notifyRules";

export { shouldNotify } from "./notifyRules";

// A sandbox instance (GRIDKEEPER_SANDBOX) keeps its marker so it is never mistaken for the live app.
// The window title is not translated: test scripts and the sandbox tooling match it.
let baseTitle = APP_NAME;

// ---- window focus (synchronous; DOM events, not the async window API) ----------------

// document.hasFocus() stays true while focus is inside a browser-pane iframe, where window "blur" would fire.
export function isWindowFocused(): boolean {
  return typeof document === "undefined" || (document.hasFocus() && document.visibilityState === "visible");
}

/** The session's pane is on screen: active workspace + group, view not hidden, not behind a maximized pane or Mission Control. */
export function isOnScreen(id: SessionId): boolean {
  if (useMission.getState().open) return false;
  const s = useApp.getState();
  const g = selectActiveGroup(s);
  if (!g || !g.sessionIds.includes(id) || s.hiddenViews[id]) return false;
  return !g.layout.maximized || g.layout.maximized === id;
}

/** The user is looking at this session right now. */
export function isSeen(id: SessionId): boolean {
  return isWindowFocused() && useApp.getState().focusedSessionId === id && isOnScreen(id);
}

export function sessionLabel(id: SessionId): string {
  return useApp.getState().persisted.sessions.find((m) => m.id === id)?.name ?? t("notifications.sessionFallback");
}

// ---- notifications -----------------------------------------------------------------

const lastToastAt = new Map<SessionId, number>();

/** Gather the context for an alert and run the policy. */
function decide(id: SessionId, alert: Alert, now = Date.now()): NotifyDecision {
  const meta = useApp.getState().persisted.sessions.find((m) => m.id === id);
  const event: NotifyEvent = {
    kind: eventKindOf(alert),
    sessionId: id,
    workspaceId: findGroupOf(id)?.workspace.id ?? null,
    agent: meta?.agent ?? "generic",
  };
  const d = new Date(now);
  return shouldNotify(
    event,
    {
      windowFocused: isWindowFocused(),
      onScreen: isOnScreen(id),
      sinceLastMs: now - (lastToastAt.get(id) ?? 0),
      minutesOfDay: d.getHours() * 60 + d.getMinutes(),
    },
    useApp.getState().persisted.settings.notifications,
  );
}

function toastText(id: SessionId, alert: Alert): { title: string; body: string } {
  const name = sessionLabel(id);
  if (alert.kind === "error") return { title: t("notifications.toast.error", { name }), body: alert.message };
  if (alert.kind === "done") return { title: t("notifications.toast.done", { name }), body: alert.message };
  return { title: alert.title ? t("notifications.toast.titled", { name, title: alert.title }) : t("notifications.toast.attention", { name }), body: alert.message };
}

function handleAlert(id: SessionId, alert: Alert, decision: NotifyDecision) {
  if (!decision.toast && !decision.inApp) return;
  lastToastAt.set(id, Date.now());
  if (decision.sound) {
    const n = normalizeNotifications(useApp.getState().persisted.settings.notifications);
    playSound(n.soundSet, eventKindOf(alert), n.volume);
  }
  const { title, body } = toastText(id, alert);
  if (decision.toast) {
    void osToast(title, body);
    void flashTaskbar();
  } else {
    actionToast({
      kind: alert.kind === "error" ? "error" : alert.kind === "waiting" ? "warn" : "info",
      message: title,
      detail: body,
      action: { label: t("notifications.jump"), run: () => jumpToSession(id) },
    });
  }
}

/** The phone gets the same alerts the feed records (its own filters, Do not disturb and mutes apply there). */
function phoneEvent(id: SessionId, alert: Alert): PhoneEvent {
  const kind = eventKindOf(alert);
  const g = findGroupOf(id);
  return {
    kind: kind === "error" || kind === "done" ? kind : "needsInput",
    key: `s:${id}`,
    sessionId: id,
    workspaceId: g?.workspace.id ?? null,
    paneName: sessionLabel(id),
    workspaceName: g?.workspace.name,
    onScreen: isOnScreen(id),
  };
}

// OS toasts: rate-limited globally; bursts collapse into one summary toast.
let permission: Promise<boolean> | null = null;
let lastOsToast = 0;
let pending: { title: string; body: string }[] = [];
let flushTimer: number | undefined;
const OS_GAP_MS = 2000;

async function ensurePermission(): Promise<boolean> {
  permission ??= (async () => {
    try {
      const n = await import("@tauri-apps/plugin-notification");
      if (await n.isPermissionGranted()) return true;
      return (await n.requestPermission()) === "granted";
    } catch (e) {
      ipc.log("warn", `notification permission unavailable: ${errorMessage(e)}`);
      return false;
    }
  })();
  return permission;
}

async function sendOs(title: string, body: string) {
  if (!(await ensurePermission())) return;
  try {
    const n = await import("@tauri-apps/plugin-notification");
    n.sendNotification({ title, body });
  } catch (e) {
    ipc.log("warn", `notification failed: ${errorMessage(e)}`);
  }
}

async function osToast(title: string, body: string) {
  const now = Date.now();
  if (now - lastOsToast >= OS_GAP_MS && pending.length === 0) {
    lastOsToast = now;
    return sendOs(title, body);
  }
  pending.push({ title, body });
  if (flushTimer === undefined) {
    flushTimer = window.setTimeout(() => {
      flushTimer = undefined;
      const items = pending;
      pending = [];
      lastOsToast = Date.now();
      if (items.length === 1) void sendOs(items[0].title, items[0].body);
      else if (items.length > 1) void sendOs(t("notifications.osSummary", { count: items.length }), items.map((i) => i.title).join("\n"));
    }, Math.max(0, OS_GAP_MS - (now - lastOsToast)));
  }
}

/** Taskbar flash: works for dev builds too, where Windows toasts appear under PowerShell's identity. */
async function flashTaskbar() {
  try {
    const { getCurrentWindow, UserAttentionType } = await import("@tauri-apps/api/window");
    await getCurrentWindow().requestUserAttention(UserAttentionType.Informational);
  } catch {
    /* not available (tests / older capability) */
  }
}

// ---- window title --------------------------------------------------------------------

let lastTitle = "";
let lastBadge = 0;
function syncTitle(unread: number) {
  syncDockBadge(unread);
  const title = unread > 0 ? `(${unread}) ${baseTitle}` : baseTitle;
  if (title === lastTitle) return;
  lastTitle = title;
  document.title = title;
  void import("@tauri-apps/api/window")
    .then(({ getCurrentWindow }) => getCurrentWindow().setTitle(title))
    .catch(() => {});
}

/** macOS: unread count on the Dock icon (capabilities/macos.json). Windows / Linux: nothing. */
function syncDockBadge(unread: number) {
  if (!isMac || unread === lastBadge) return;
  lastBadge = unread;
  void import("@tauri-apps/api/window")
    .then(({ getCurrentWindow }) => getCurrentWindow().setBadgeCount(unread > 0 ? unread : undefined))
    .catch(() => {});
}

// ---- install -------------------------------------------------------------------------

export function installAttention(): () => void {
  let disposed = false;
  const unlisteners: (() => void)[] = [];
  const track = (p: Promise<() => void>) =>
    p.then((un) => (disposed ? un() : unlisteners.push(un))).catch((e) => ipc.log("warn", `attention listener: ${errorMessage(e)}`));

  const apply = (id: SessionId, input: Parameters<ReturnType<typeof useAttention.getState>["apply"]>[1]) => {
    // Unknown ids (sessions of another window / already removed) are ignored.
    if (!useApp.getState().persisted.sessions.some((m) => m.id === id)) return;
    // The decision is made while the feed entry is recorded, so muted alerts are marked as such.
    let decision = null as NotifyDecision | null;
    const alert = useAttention.getState().apply(id, input, isSeen(id), undefined, (a) => {
      decision = decide(id, a);
      return decision.muted ? { muted: true, mutedReason: mutedReasonText(decision.reason ?? "dnd") } : undefined;
    });
    if (alert && decision) handleAlert(id, alert, decision);
    if (alert) void notifyPhone(phoneEvent(id, alert));
  };

  // Previous coarse state per session, to tell user stops from crashes.
  const prevState = new Map<SessionId, string>();
  const seed = useApp.getState().runtime;
  for (const id in seed) prevState.set(id, seed[id].state.state);

  track(
    onSessionAttention((ev) => {
      const rt = useApp.getState().runtime[ev.id];
      // Activity events can race the exit event: ignore them for sessions that are not live.
      if ((ev.kind === "active" || ev.kind === "idle") && rt && (rt.state.state === "exited" || rt.state.state === "failed")) return;
      apply(ev.id, { type: "attention", ev });
    }),
  );
  track(
    onSessionState((info: SessionInfo) => {
      const prev = prevState.get(info.id);
      const cur = info.state.state;
      prevState.set(info.id, cur);
      if (prev === cur) return;
      if (cur === "starting") apply(info.id, { type: "start" });
      else if (info.state.state === "exited") apply(info.id, { type: "exit", code: info.state.code, userStopped: prev === "stopping" });
      else if (info.state.state === "failed") apply(info.id, { type: "failed", message: info.state.message });
    }),
  );

  // Focusing a session (or returning to the window with it focused) marks it read.
  const markFocusedRead = () => {
    const f = useApp.getState().focusedSessionId;
    if (f && isSeen(f)) useAttention.getState().markRead(f);
  };
  window.addEventListener("focus", markFocusedRead);
  document.addEventListener("visibilitychange", markFocusedRead);

  let prevFocus = useApp.getState().focusedSessionId;
  let prevSessions = useApp.getState().persisted.sessions;
  let prevWorkspaces = useApp.getState().persisted.workspaces;
  // Mutes of removed sessions / workspaces are dropped so the settings file does not accumulate ids.
  const pruneMutedIds = () => {
    const s = useApp.getState();
    if (!s.loaded || s.loadError) return;
    const cur = s.persisted.settings.notifications;
    if (!cur?.mutedSessions?.length && !cur?.mutedWorkspaces?.length) return;
    const n = normalizeNotifications(cur);
    const next = pruneMutes(n, new Set(s.persisted.sessions.map((m) => m.id)), new Set(s.persisted.workspaces.map((w) => w.id)));
    if (next !== n) s.updateSettings({ notifications: next });
  };
  const unsubApp = useApp.subscribe((s) => {
    if (s.focusedSessionId !== prevFocus) {
      prevFocus = s.focusedSessionId;
      if (prevFocus && isWindowFocused()) useAttention.getState().markRead(prevFocus);
    }
    const sessionsChanged = s.persisted.sessions !== prevSessions;
    if (sessionsChanged) {
      prevSessions = s.persisted.sessions;
      useAttention.getState().prune(new Set(prevSessions.map((m) => m.id)));
    }
    if (sessionsChanged || s.persisted.workspaces !== prevWorkspaces) {
      prevWorkspaces = s.persisted.workspaces;
      pruneMutedIds();
    }
  });
  pruneMutedIds();

  // Lead proposals waiting for the user and finished mission boards also go to the phone (opt-in).
  const uninstallPhone = installPhoneAlerts();

  let prevUnread = -1;
  const unsubAttn = useAttention.subscribe((s) => {
    const n = countUnread(s.sessions);
    if (n !== prevUnread) {
      prevUnread = n;
      syncTitle(n);
    }
  });
  syncTitle(countUnread(useAttention.getState().sessions));
  void ipc
    .appInfo()
    .then((info) => {
      if (disposed || !info.sandbox) return;
      baseTitle = `${APP_NAME} [sandbox: ${info.sandbox}]`;
      lastTitle = "";
      syncTitle(countUnread(useAttention.getState().sessions));
    })
    .catch(() => {});

  return () => {
    disposed = true;
    for (const un of unlisteners) un();
    window.removeEventListener("focus", markFocusedRead);
    document.removeEventListener("visibilitychange", markFocusedRead);
    unsubApp();
    unsubAttn();
    uninstallPhone();
    window.clearTimeout(flushTimer);
    flushTimer = undefined;
    pending = [];
    disposeAudio();
  };
}
