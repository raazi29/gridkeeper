// Attention model: per-session "what is it doing / does it need me" state and the Comms feed.
// A separate small zustand store so attention churn never re-renders subscribers of the app store.
// Pure functions (reduceAttention, nextAttentionTarget, …) carry the logic and are unit-tested;
// event wiring lives in actions/attentionNotify.ts.

import { create } from "zustand";
import { t, type MessageKey } from "../i18n";
import type { SessionAttention, SessionId } from "../lib/types";

export type AttnState = "working" | "waiting" | "done" | "error" | "idle";

export interface SessionAttn {
  state: AttnState;
  /** Something happened the user has not looked at yet. */
  unread: boolean;
  lastMessage?: string;
  /**
   * `lastMessage` was produced by the process lifecycle (exit / failed to start / stopped), not by the program.
   * Lets the activity log skip the echo without matching (translated) text.
   */
  lifecycle?: boolean;
  /** ms epoch of the last change. */
  at: number;
}

export type AttnInput =
  | { type: "attention"; ev: SessionAttention }
  | { type: "start" }
  | { type: "exit"; code: number | null; userStopped: boolean }
  | { type: "failed"; message: string };

/** Notification-worthy outcome of an input. `category` maps to the settings toggles. */
export interface Alert {
  category: "bell" | "idle" | "error";
  /** Feed / lamp flavour. */
  kind: "waiting" | "done" | "error";
  message: string;
  /** Notification title from the program (OSC 777 / 99 / 7501), if any. */
  title?: string;
  /** What raised it: lets notification rules tell a BEL / OSC notify from a "waiting for you" status. */
  source?: "bell" | "notify" | "status" | "idle" | "active" | "exit" | "failed";
}

export interface Reduction {
  next: SessionAttn;
  alert?: Alert;
}

const WORKING = new Set(["working", "busy", "running", "thinking", "progress"]);
const WAITING = new Set(["blocked", "waiting", "input", "question", "permission", "attention", "prompt"]);
const DONE = new Set(["done", "complete", "completed", "finished", "success"]);
const ERROR = new Set(["error", "failed", "failure"]);
const QUIET = new Set(["idle", "clear", "ready"]);

// Generated messages are in the UI language (shown in Fleet, Comms, notifications); program-supplied titles /
// bodies are shown as the program sent them.
const REASON_TEXT: Record<string, MessageKey> = {
  permission: "attention.reason.permission",
  question: "attention.reason.question",
  auth: "attention.reason.auth",
};

function reasonText(reason: string | undefined): string | undefined {
  const key = reason ? REASON_TEXT[reason] : undefined;
  return key ? t(key) : undefined;
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function joinText(title?: string, body?: string): string | undefined {
  const parts = [title, body].filter((x): x is string => !!x && x.trim().length > 0);
  return parts.length ? parts.join(": ") : undefined;
}

/**
 * Pure reducer. `seen` = the user is looking at this session right now (focused, on screen, window
 * focused); alerts then never mark it unread.
 */
export function reduceAttention(prev: SessionAttn | undefined, input: AttnInput, seen: boolean, now: number): Reduction {
  const base: SessionAttn = prev ?? { state: "idle", unread: false, at: now };
  const flag = (unread: boolean) => (seen ? false : unread || base.unread);
  const alertState = (state: AttnState, kind: Alert["kind"], category: Alert["category"], message: string, title?: string, lifecycle?: boolean): Reduction => ({
    next: lifecycle ? { state, unread: flag(true), lastMessage: message, lifecycle: true, at: now } : { state, unread: flag(true), lastMessage: message, at: now },
    alert: { category, kind, message, title, source: input.type === "attention" ? input.ev.kind : input.type === "start" ? undefined : input.type },
  });
  const quiet = (state: AttnState, lastMessage = base.lastMessage): Reduction => ({
    next:
      state === base.state && lastMessage === base.lastMessage
        ? base
        : { ...base, state, lastMessage, lifecycle: lastMessage === base.lastMessage ? base.lifecycle : undefined, at: now },
  });

  switch (input.type) {
    case "start":
      return { next: { state: "idle", unread: false, at: now } };
    case "failed":
      return alertState("error", "error", "error", t("attention.msg.failedToStart", { error: input.message }), undefined, true);
    case "exit": {
      if (input.userStopped) return { next: { state: "idle", unread: base.unread, lastMessage: t("attention.msg.stopped"), lifecycle: true, at: now } };
      if (input.code !== null && input.code !== 0) return alertState("error", "error", "error", t("attention.msg.exitedCode", { code: input.code }), undefined, true);
      return alertState("done", "done", "idle", input.code === 0 ? t("attention.msg.exitedZero") : t("attention.msg.exited"), undefined, true);
    }
    case "attention": {
      const ev = input.ev;
      switch (ev.kind) {
        case "active":
          return quiet("working");
        case "idle":
          if (ev.status === "done") return alertState("done", "done", "idle", t("attention.msg.finishedAfter", { duration: formatDuration(ev.activeMs ?? 0) }));
          return base.state === "working" ? quiet("idle") : { next: base };
        case "bell":
          return alertState("waiting", "waiting", "bell", t("attention.msg.bell"));
        case "notify":
          return alertState("waiting", "waiting", "bell", joinText(ev.title, ev.body) ?? t("attention.msg.notification"), ev.title);
        case "status": {
          const st = (ev.status ?? "").toLowerCase();
          const text = joinText(ev.title, ev.body);
          if (WORKING.has(st)) return quiet("working", text ?? base.lastMessage);
          if (WAITING.has(st))
            return alertState("waiting", "waiting", "bell", text ?? reasonText(ev.reason) ?? t("attention.msg.waiting"), ev.title);
          if (DONE.has(st)) return alertState("done", "done", "idle", text ?? t("attention.msg.done"), ev.title);
          if (ERROR.has(st)) return alertState("error", "error", "error", text ?? t("attention.msg.reportedError"), ev.title);
          // done / error persist until the user has seen them.
          if (QUIET.has(st)) return quiet(base.unread ? base.state : "idle");
          return quiet(base.state, text ?? (st ? t("attention.msg.status", { status: st }) : base.lastMessage));
        }
      }
    }
  }
  return { next: base };
}

export const needsAttention = (a: SessionAttn | undefined): boolean => !!a && (a.unread || a.state === "waiting");

/**
 * Round-robin "next alert": the first session after `current` (in global workspace → group → pane
 * order, wrapping) that needs attention. Unread sessions win over merely-waiting ones that were
 * already seen. Returns null when nothing needs attention.
 */
export function nextAttentionTarget(order: SessionId[], sessions: Record<SessionId, SessionAttn>, current: SessionId | null): SessionId | null {
  if (order.length === 0) return null;
  const start = current ? order.indexOf(current) : -1;
  const rotated = [...order.slice(start + 1), ...order.slice(0, start + 1)];
  const unread = rotated.find((id) => sessions[id]?.unread && id !== current);
  if (unread) return unread;
  const waiting = rotated.find((id) => id !== current && needsAttention(sessions[id]));
  if (waiting) return waiting;
  return current && needsAttention(sessions[current]) ? current : null;
}

export function countUnread(sessions: Record<SessionId, SessionAttn>, ids?: Iterable<SessionId>): number {
  let n = 0;
  if (ids) {
    for (const id of ids) if (sessions[id]?.unread) n++;
  } else for (const id in sessions) if (sessions[id].unread) n++;
  return n;
}

// ---- store ---------------------------------------------------------------------

export interface FeedItem {
  seq: number;
  id: SessionId;
  kind: Alert["kind"];
  message: string;
  at: number;
  /** The user's notification rules silenced it; still listed so nothing is silently lost. */
  muted?: boolean;
  /** Why, e.g. "Session muted", "Quiet hours". */
  mutedReason?: string;
}

/** Lets the notifier annotate the feed entry of an alert (e.g. muted) as it is recorded. */
export type FeedDecorator = (alert: Alert) => Partial<Pick<FeedItem, "muted" | "mutedReason">> | undefined;

export const FEED_LIMIT = 100;

export interface AttentionStore {
  sessions: Record<SessionId, SessionAttn>;
  /** Newest last. In-memory only. */
  feed: FeedItem[];
  /** Apply an input; returns the alert (if any) for the notifier. */
  apply: (id: SessionId, input: AttnInput, seen: boolean, now?: number, decorate?: FeedDecorator) => Alert | undefined;
  markRead: (id: SessionId) => void;
  markAllRead: () => void;
  clearFeed: () => void;
  /** Drop state of sessions that no longer exist. */
  prune: (alive: Set<SessionId>) => void;
}

let feedSeq = 1;

export const useAttention = create<AttentionStore>()((set, get) => ({
  sessions: {},
  feed: [],
  apply: (id, input, seen, now = Date.now(), decorate) => {
    const prev = get().sessions[id];
    const { next, alert } = reduceAttention(prev, input, seen, now);
    if (next === prev && !alert) return undefined;
    const extra = alert && decorate ? decorate(alert) : undefined;
    set((s) => ({
      sessions: next === prev ? s.sessions : { ...s.sessions, [id]: next },
      feed: alert ? [...s.feed.slice(-(FEED_LIMIT - 1)), { seq: feedSeq++, id, kind: alert.kind, message: alert.message, at: now, ...extra }] : s.feed,
    }));
    return alert;
  },
  markRead: (id) =>
    set((s) => {
      const a = s.sessions[id];
      return a?.unread ? { sessions: { ...s.sessions, [id]: { ...a, unread: false } } } : s;
    }),
  markAllRead: () =>
    set((s) => {
      if (!Object.values(s.sessions).some((a) => a.unread)) return s;
      const sessions: Record<SessionId, SessionAttn> = {};
      for (const [id, a] of Object.entries(s.sessions)) sessions[id] = a.unread ? { ...a, unread: false } : a;
      return { sessions };
    }),
  clearFeed: () => set({ feed: [] }),
  prune: (alive) =>
    set((s) => {
      const dead = Object.keys(s.sessions).filter((id) => !alive.has(id));
      const feed = s.feed.filter((f) => alive.has(f.id));
      if (dead.length === 0 && feed.length === s.feed.length) return s;
      const sessions = { ...s.sessions };
      for (const id of dead) delete sessions[id];
      return { sessions, feed };
    }),
}));

// ---- overlay UI state (Fleet / Broadcast / Comms) ---------------------------------

export type AttentionOverlay = "fleet" | "broadcast" | null;

interface AttentionUi {
  overlay: AttentionOverlay;
  commsOpen: boolean;
  /** Sessions preselected in the Broadcast composer (null = default: live sessions of the active group). */
  broadcastPreselect: SessionId[] | null;
  open: (o: Exclude<AttentionOverlay, null>) => void;
  /** Open the Broadcast composer with these sessions preselected (Mission Control lanes, context menus). */
  openBroadcast: (ids?: SessionId[] | null) => void;
  close: () => void;
  toggleComms: (open?: boolean) => void;
}

export const useAttentionUi = create<AttentionUi>()((set) => ({
  overlay: null,
  commsOpen: false,
  broadcastPreselect: null,
  open: (overlay) => set({ overlay, commsOpen: false, broadcastPreselect: null }),
  openBroadcast: (ids) => set({ overlay: "broadcast", commsOpen: false, broadcastPreselect: ids ?? null }),
  close: () => set({ overlay: null, broadcastPreselect: null }),
  toggleComms: (open) => set((s) => ({ commsOpen: open ?? !s.commsOpen })),
}));
