// Attention wiring: Rust `session-attention` + `session-state` events -> attention store, unread
// clearing on focus, window title badge, in-app / Windows toasts, taskbar flash and optional sound.
// `installAttention()` is called once (AttentionLayer) and returns a full cleanup.

import { APP_NAME } from "../lib/brand";
import { errorMessage, ipc, onSessionAttention, onSessionState } from "../lib/ipc";
import { DEFAULT_SETTINGS, type NotificationSettings, type SessionId, type SessionInfo } from "../lib/types";
import { selectActiveGroup, useApp } from "../store/appStore";
import { countUnread, useAttention, type Alert } from "../store/attention";
import { actionToast } from "../store/uiStore";
import { jumpToSession } from "./commands";

const BASE_TITLE = APP_NAME;

// ---- window focus (synchronous; DOM events, not the async window API) ----------------

let windowFocused = typeof document === "undefined" ? true : document.hasFocus();

export function isWindowFocused(): boolean {
  return windowFocused && (typeof document === "undefined" || document.visibilityState === "visible");
}

/** The session's pane is on screen: active workspace + group, view not hidden, not behind a maximized pane. */
export function isOnScreen(id: SessionId): boolean {
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
  return useApp.getState().persisted.sessions.find((m) => m.id === id)?.name ?? "Session";
}

// ---- notifications -----------------------------------------------------------------

function notifSettings(): NotificationSettings {
  return { ...DEFAULT_SETTINGS.notifications, ...(useApp.getState().persisted.settings.notifications ?? {}) };
}

const lastToastAt = new Map<SessionId, number>();
const PER_SESSION_GAP_MS = 5000;

/** Pure policy (exported for tests): should this alert produce a toast, and which kind? */
export function toastDecision(
  alert: Alert,
  settings: NotificationSettings,
  ctx: { windowFocused: boolean; onScreen: boolean; sinceLastMs: number },
): "none" | "os" | "inApp" {
  if (!settings.enabled) return "none";
  if (alert.category === "bell" && !settings.onBell) return "none";
  if (alert.category === "idle" && !settings.onIdle) return "none";
  if (ctx.windowFocused && ctx.onScreen) return "none"; // the lamp is visible; no toast needed
  if (ctx.sinceLastMs < PER_SESSION_GAP_MS) return "none";
  return ctx.windowFocused ? "inApp" : "os";
}

function toastText(id: SessionId, alert: Alert): { title: string; body: string } {
  const name = sessionLabel(id);
  if (alert.kind === "error") return { title: `${name} stopped with an error`, body: alert.message };
  if (alert.kind === "done") return { title: `${name} finished`, body: alert.message };
  return { title: alert.title ? `${name}: ${alert.title}` : `${name} needs your attention`, body: alert.message };
}

function handleAlert(id: SessionId, alert: Alert) {
  const settings = notifSettings();
  const now = Date.now();
  const decision = toastDecision(alert, settings, {
    windowFocused: isWindowFocused(),
    onScreen: isOnScreen(id),
    sinceLastMs: now - (lastToastAt.get(id) ?? 0),
  });
  if (decision === "none") return;
  lastToastAt.set(id, now);
  if (settings.sound) playBlip(alert.kind);
  const { title, body } = toastText(id, alert);
  if (decision === "os") {
    void osToast(title, body);
    void flashTaskbar();
  } else {
    actionToast({
      kind: alert.kind === "error" ? "error" : alert.kind === "waiting" ? "warn" : "info",
      message: title,
      detail: body,
      action: { label: "Jump", run: () => jumpToSession(id) },
    });
  }
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
      else if (items.length > 1) void sendOs(`${items.length} sessions need your attention`, items.map((i) => i.title).join("\n"));
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

let audio: AudioContext | null = null;
function playBlip(kind: Alert["kind"]) {
  try {
    audio ??= new AudioContext();
    // Created outside a user gesture it may start suspended.
    if (audio.state === "suspended") void audio.resume();
    const t = audio.currentTime;
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(kind === "error" ? 330 : kind === "done" ? 660 : 880, t);
    if (kind === "waiting") osc.frequency.setValueAtTime(1175, t + 0.07);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.06, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    osc.connect(gain).connect(audio.destination);
    osc.start(t);
    osc.stop(t + 0.18);
  } catch {
    /* audio unavailable */
  }
}

// ---- window title --------------------------------------------------------------------

let lastTitle = "";
function syncTitle(unread: number) {
  const title = unread > 0 ? `(${unread}) ${BASE_TITLE}` : BASE_TITLE;
  if (title === lastTitle) return;
  lastTitle = title;
  document.title = title;
  void import("@tauri-apps/api/window")
    .then(({ getCurrentWindow }) => getCurrentWindow().setTitle(title))
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
    const alert = useAttention.getState().apply(id, input, isSeen(id));
    if (alert) handleAlert(id, alert);
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
  const onFocus = () => {
    windowFocused = true;
    markFocusedRead();
  };
  const onBlur = () => {
    windowFocused = false;
  };
  window.addEventListener("focus", onFocus);
  window.addEventListener("blur", onBlur);
  document.addEventListener("visibilitychange", markFocusedRead);

  let prevFocus = useApp.getState().focusedSessionId;
  let prevSessions = useApp.getState().persisted.sessions;
  const unsubApp = useApp.subscribe((s) => {
    if (s.focusedSessionId !== prevFocus) {
      prevFocus = s.focusedSessionId;
      if (prevFocus && isWindowFocused()) useAttention.getState().markRead(prevFocus);
    }
    if (s.persisted.sessions !== prevSessions) {
      prevSessions = s.persisted.sessions;
      useAttention.getState().prune(new Set(prevSessions.map((m) => m.id)));
    }
  });

  let prevUnread = -1;
  const unsubAttn = useAttention.subscribe((s) => {
    const n = countUnread(s.sessions);
    if (n !== prevUnread) {
      prevUnread = n;
      syncTitle(n);
    }
  });
  syncTitle(countUnread(useAttention.getState().sessions));

  return () => {
    disposed = true;
    for (const un of unlisteners) un();
    window.removeEventListener("focus", onFocus);
    window.removeEventListener("blur", onBlur);
    document.removeEventListener("visibilitychange", markFocusedRead);
    unsubApp();
    unsubAttn();
    window.clearTimeout(flushTimer);
    flushTimer = undefined;
    pending = [];
  };
}
