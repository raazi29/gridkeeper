// Notification rules ("as per user"): pure, store-free policy so every rule is unit-tested.
// attentionNotify.ts gathers the context (window focus, on-screen, clock, rate limit) and calls
// shouldNotify(); the feed always records the alert, marked muted when a user rule silenced it.

import { t, type MessageKey } from "../i18n";
import { DEFAULT_SETTINGS, type AgentKind, type NotificationSettings, type SessionId } from "../lib/types";
import type { Alert } from "../store/attention";

/** User-facing event kinds (Settings › Notifications toggles). */
export type NotifyEventKind = "needsInput" | "done" | "error" | "bell";

export interface NotifyEvent {
  kind: NotifyEventKind;
  sessionId: SessionId;
  /** Workspace that holds the session (null when unknown). */
  workspaceId: string | null;
  agent: AgentKind;
}

export interface NotifyContext {
  windowFocused: boolean;
  /** The session's pane is visible in the active group. */
  onScreen: boolean;
  /** Since this session's last notification. */
  sinceLastMs: number;
  /** Local time of day in minutes (0–1439). Passed in so the policy stays pure. */
  minutesOfDay: number;
}

export type SuppressReason = "disabled" | "event" | "agent" | "session" | "workspace" | "dnd" | "quiet" | "visible" | "focused" | "rate" | "feedOnly";

export interface NotifyDecision {
  /** Windows notification (+ taskbar flash). */
  toast: boolean;
  /** In-app toast with a Jump button. */
  inApp: boolean;
  sound: boolean;
  /** A user rule (filter / mute / DND / quiet hours) silenced it: mark the feed entry. */
  muted: boolean;
  reason?: SuppressReason;
}

export const PER_SESSION_GAP_MS = 5000;

const MUTED_REASON_KEY: Partial<Record<SuppressReason, MessageKey>> = {
  event: "notifications.mutedReason.event",
  agent: "notifications.mutedReason.agent",
  session: "notifications.mutedReason.session",
  workspace: "notifications.mutedReason.workspace",
  dnd: "notifications.mutedReason.dnd",
  quiet: "notifications.mutedReason.quiet",
};

/** Feed label for muted entries, in the current UI language (undefined for reasons that don't mute). */
export function mutedReasonText(reason: SuppressReason): string | undefined {
  const key = MUTED_REASON_KEY[reason];
  return key ? t(key) : undefined;
}

const MUTING: ReadonlySet<SuppressReason> = new Set(["event", "agent", "session", "workspace", "dnd", "quiet"]);

/** Deep-merge stored settings over the defaults (older state files lack the newer fields). */
export function normalizeNotifications(raw: Partial<NotificationSettings> | null | undefined): NotificationSettings {
  const d = DEFAULT_SETTINGS.notifications;
  const r = raw ?? {};
  const delivery = r.delivery === "inApp" || r.delivery === "off" || r.delivery === "toast" ? r.delivery : d.delivery;
  const soundSet = r.soundSet === "comm" || r.soundSet === "console" || r.soundSet === "droid" || r.soundSet === "none" ? r.soundSet : d.soundSet;
  const volume = typeof r.volume === "number" && Number.isFinite(r.volume) ? Math.min(100, Math.max(0, Math.round(r.volume))) : d.volume;
  return {
    ...d,
    ...r,
    delivery,
    soundSet,
    volume,
    quietHours: { ...d.quietHours, ...(r.quietHours ?? {}) },
    agents: { ...d.agents, ...(r.agents ?? {}) },
    mutedSessions: Array.isArray(r.mutedSessions) ? r.mutedSessions : [],
    mutedWorkspaces: Array.isArray(r.mutedWorkspaces) ? r.mutedWorkspaces : [],
  };
}

/** Map a reducer alert to the user-facing event kind. */
export function eventKindOf(alert: Pick<Alert, "category" | "source">): NotifyEventKind {
  if (alert.category === "error") return "error";
  if (alert.category === "idle") return "done";
  // category "bell": a raw BEL / OSC notification, or a structured "waiting for you" status.
  return alert.source === "bell" || alert.source === "notify" ? "bell" : "needsInput";
}

export function agentBucket(agent: AgentKind): keyof NotificationSettings["agents"] {
  return agent === "claude" || agent === "codex" || agent === "powershell" ? agent : "other";
}

/** "HH:MM" -> minutes since midnight, or null when malformed. */
export function parseHHMM(v: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** Whether `minutes` falls inside [start, end) — ranges may cross midnight; start == end means never. */
export function inQuietHours(minutes: number, q: NotificationSettings["quietHours"]): boolean {
  if (!q.enabled) return false;
  const start = parseHHMM(q.start);
  const end = parseHHMM(q.end);
  if (start === null || end === null || start === end) return false;
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

function eventEnabled(kind: NotifyEventKind, n: NotificationSettings): boolean {
  switch (kind) {
    case "needsInput":
      return n.onInput;
    case "done":
      return n.onIdle;
    case "error":
      return n.onError;
    case "bell":
      return n.onBell;
  }
}

const none = (reason: SuppressReason): NotifyDecision => ({ toast: false, inApp: false, sound: false, muted: MUTING.has(reason), reason });

/**
 * The whole notification policy. Order matters: user filters and mutes first (they mark the feed),
 * then situational suppression (already looking at it, rate limit), then the delivery mode.
 */
export function shouldNotify(event: NotifyEvent, ctx: NotifyContext, settings: Partial<NotificationSettings> | null | undefined): NotifyDecision {
  const n = normalizeNotifications(settings);
  if (!n.enabled) return none("disabled");
  if (!eventEnabled(event.kind, n)) return none("event");
  if (!n.agents[agentBucket(event.agent)]) return none("agent");
  if (n.mutedSessions.includes(event.sessionId)) return none("session");
  if (event.workspaceId && n.mutedWorkspaces.includes(event.workspaceId)) return none("workspace");
  if (n.dnd) return none("dnd");
  if (inQuietHours(ctx.minutesOfDay, n.quietHours)) return none("quiet");
  if (ctx.windowFocused && ctx.onScreen) return none("visible"); // the lamp is right there
  if (n.onlyWhenUnfocused && ctx.windowFocused) return none("focused");
  if (ctx.sinceLastMs < PER_SESSION_GAP_MS) return none("rate");
  if (n.delivery === "off") return none("feedOnly");
  const toast = n.delivery === "toast" && !ctx.windowFocused;
  const inApp = !toast;
  const sound = n.sound && n.soundSet !== "none" && n.volume > 0;
  return { toast, inApp, sound, muted: false };
}

/** Drop mutes for sessions / workspaces that no longer exist. Returns the same object when nothing changed. */
export function pruneMutes(n: NotificationSettings, sessionIds: ReadonlySet<string>, workspaceIds: ReadonlySet<string>): NotificationSettings {
  const ms = n.mutedSessions.filter((id) => sessionIds.has(id));
  const mw = n.mutedWorkspaces.filter((id) => workspaceIds.has(id));
  if (ms.length === n.mutedSessions.length && mw.length === n.mutedWorkspaces.length) return n;
  return { ...n, mutedSessions: ms, mutedWorkspaces: mw };
}

/** Toggle an id in a list (immutable). */
export function toggleIn(list: readonly string[], id: string, on?: boolean): string[] {
  const has = list.includes(id);
  const want = on ?? !has;
  if (want === has) return [...list];
  return want ? [...list, id] : list.filter((x) => x !== id);
}
