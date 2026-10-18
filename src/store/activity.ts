// Activity log: an in-memory ring buffer (last ACTIVITY_LIMIT) of REAL events across all sessions —
// lifecycle (started / exited / failed / stopped), attention transitions (working / waiting / done /
// error), broadcasts, formation launches, worktrees created and mission briefs. Separate zustand store so log churn
// never re-renders app-store subscribers. Pure mapping helpers are unit-tested; `installActivity()`
// wires the subscriptions and is called once at app level (MissionLayer), never at import time.

import { create } from "zustand";
import type { AgentKind, SessionId, SessionInfo } from "../lib/types";
import { useApp } from "./appStore";
import { useAttention, type AttnState, type SessionAttn } from "./attention";

export const ACTIVITY_LIMIT = 500;

export type ActivityKind = "lifecycle" | "attention" | "broadcast" | "formation" | "worktree" | "mission";
export type ActivityLevel = "info" | "ok" | "needs" | "error";

export interface ActivityEvent {
  seq: number;
  /** ms epoch */
  at: number;
  sessionId: SessionId | null;
  /** Captured at event time (the session may be gone later). */
  sessionName: string;
  role: string | null;
  agent: AgentKind | null;
  kind: ActivityKind;
  level: ActivityLevel;
  message: string;
  /** Short right-aligned outcome, e.g. "exit 0", "sent", "3 sessions". */
  result?: string;
  /**
   * Account id whose name was not known yet when the event was recorded (accounts load asynchronously at
   * startup while restored sessions already start). The message holds PENDING_ACCOUNT until resolved.
   */
  pendingAccountId?: string;
}

export type ActivityInput = Omit<ActivityEvent, "seq" | "at"> & { at?: number };

/** Append to a ring buffer, keeping the newest `limit` items (newest last). Pure. */
export function pushRing<T>(list: readonly T[], item: T, limit: number): T[] {
  if (limit <= 0) return [];
  const keep = list.length >= limit ? list.slice(list.length - limit + 1) : list.slice();
  keep.push(item);
  return keep;
}

export type ActivityFilter = "all" | "needs" | "errors" | "lifecycle";

export function matchesActivityFilter(e: ActivityEvent, f: ActivityFilter): boolean {
  switch (f) {
    case "all":
      return true;
    case "needs":
      return e.level === "needs";
    case "errors":
      return e.level === "error";
    case "lifecycle":
      return e.kind === "lifecycle" || e.kind === "worktree" || e.kind === "formation";
  }
}

// ---- event mapping (pure) -------------------------------------------------------------

export interface SessionLabel {
  name: string;
  role: string | null;
  agent: AgentKind | null;
}

/**
 * Attention transition -> log entry. Only transitions INTO working / waiting / done / error are logged;
 * quiet transitions (working -> idle) and repeats of the same state are dropped to keep the ring useful
 * with many agents toggling active/idle.
 */
export function mapAttentionTransition(prev: SessionAttn | undefined, next: SessionAttn): { level: ActivityLevel; message: string; result?: string } | null {
  const from: AttnState = prev?.state ?? "idle";
  const to = next.state;
  if (from === to) return null;
  switch (to) {
    case "working":
      return { level: "info", message: "working", result: "active" };
    case "waiting":
      return { level: "needs", message: next.lastMessage ?? "Waiting for you", result: "needs you" };
    case "done":
      return { level: "ok", message: next.lastMessage ?? "Done", result: "done" };
    case "error":
      return { level: "error", message: next.lastMessage ?? "Error", result: "error" };
    default:
      return null;
  }
}

/**
 * Attention states produced by process exit / failure (see reduceAttention's "exit" / "failed" inputs).
 * The lifecycle mapping already logs those, so the attention echo is skipped.
 */
export function isLifecycleEcho(a: SessionAttn): boolean {
  return !!a.lastMessage && /^(Exited|Failed to start|Stopped)\b/.test(a.lastMessage);
}

export interface LifecycleTrack {
  state: string;
  startedAt: string | null;
}

// ---- account names ------------------------------------------------------------------------

/** Placeholder in a "started" message while the account list is still loading. */
export const PENDING_ACCOUNT = "account …";

export interface NamedAccount {
  id: string;
  name: string;
}

/** Agents whose sessions always run on some account (no profile id = the agent's default login). */
const ACCOUNT_AGENTS: ReadonlySet<AgentKind> = new Set<AgentKind>(["claude", "codex"]);

/**
 * Account shown for a session: looked up by id in BOTH the multi-agent `accounts` list and the
 * historical Claude `profiles` list. "Default" only when the session has no account id (and the agent
 * uses accounts); `pendingId` when the id is not known (yet); null = no account bit at all.
 */
export function resolveAccountName(
  agent: AgentKind | null | undefined,
  profileId: string | null | undefined,
  accounts: readonly NamedAccount[],
  profiles: readonly NamedAccount[],
): { name: string; pendingId?: undefined } | { name: null; pendingId: string } | null {
  if (!profileId) return agent && ACCOUNT_AGENTS.has(agent) ? { name: "Default" } : null;
  const name = accounts.find((a) => a.id === profileId)?.name ?? profiles.find((p) => p.id === profileId)?.name;
  return name ? { name } : { name: null, pendingId: profileId };
}

/** Fill in account names that were pending when their events were recorded. Returns null when nothing changed. */
export function resolvePendingAccounts(events: readonly ActivityEvent[], nameOf: (id: string) => string | null | undefined): ActivityEvent[] | null {
  let changed = false;
  const next = events.map((e) => {
    if (!e.pendingAccountId) return e;
    const name = nameOf(e.pendingAccountId);
    if (!name) return e;
    changed = true;
    const { pendingAccountId: _, ...rest } = e;
    return { ...rest, message: e.message.replace(PENDING_ACCOUNT, `account ${name}`) };
  });
  return changed ? next : null;
}

/**
 * Process state change -> log entry. "started" is logged once per run (keyed by `startedAt`, so the
 * optimistic `starting` snapshot with startedAt = null is ignored). A stop after `stopping` is a user
 * stop, not a crash.
 */
export function mapLifecycle(
  prev: LifecycleTrack | undefined,
  info: SessionInfo,
  meta: { profileName?: string | null; accountPending?: boolean; worktreeBranch?: string | null },
): { level: ActivityLevel; message: string; result?: string } | null {
  const cur = info.state.state;
  if ((cur === "running" || cur === "starting") && info.startedAt && info.startedAt !== prev?.startedAt) {
    const bits = [`started ${info.agent}`];
    if (meta.profileName) bits.push(`account ${meta.profileName}`);
    else if (meta.accountPending) bits.push(PENDING_ACCOUNT);
    if (meta.worktreeBranch) bits.push(`worktree ${meta.worktreeBranch}`);
    return { level: "info", message: bits.join(" · "), result: info.pid ? `pid ${info.pid}` : "started" };
  }
  if (prev?.state === cur) return null;
  if (info.state.state === "exited") {
    const code = info.state.code;
    if (prev?.state === "stopping") return { level: "info", message: "stopped by user", result: code === null ? "stopped" : `exit ${code}` };
    if (code !== null && code !== 0) return { level: "error", message: `exited with code ${code}`, result: `exit ${code}` };
    return { level: "ok", message: "exited", result: code === null ? "exit" : `exit ${code}` };
  }
  if (info.state.state === "failed") return { level: "error", message: `failed to start: ${info.state.message}`, result: "failed" };
  return null;
}

// ---- store ----------------------------------------------------------------------------

interface ActivityStore {
  events: ActivityEvent[];
  clear: () => void;
}

let seq = 1;

export const useActivity = create<ActivityStore>()((set) => ({
  events: [],
  clear: () => set({ events: [] }),
}));

export function recordActivity(input: ActivityInput) {
  const ev: ActivityEvent = { ...input, at: input.at ?? Date.now(), seq: seq++ };
  useActivity.setState((s) => ({ events: pushRing(s.events, ev, ACTIVITY_LIMIT) }));
}

export function sessionLabelOf(id: SessionId): SessionLabel {
  const m = useApp.getState().persisted.sessions.find((x) => x.id === id);
  return { name: m?.name ?? "session", role: m?.role ?? null, agent: m?.agent ?? null };
}

/** Record one event per broadcast target (called from actions/broadcast.ts after sending). */
export function recordBroadcast(text: string, targets: { id: SessionId; name: string }[], failedNames: string[]) {
  const preview = text.length > 80 ? `${text.slice(0, 79)}…` : text;
  for (const t of targets) {
    const failed = failedNames.some((f) => f.startsWith(`${t.name} (`));
    const l = sessionLabelOf(t.id);
    recordActivity({
      sessionId: t.id,
      sessionName: l.name,
      role: l.role,
      agent: l.agent,
      kind: "broadcast",
      level: failed ? "error" : "info",
      message: `broadcast: ${preview}`,
      result: failed ? "failed" : "sent",
    });
  }
}

/** Subscribe to the app + attention stores. Returns a full cleanup. Call once. */
export function installActivity(): () => void {
  const track = new Map<SessionId, LifecycleTrack>();
  const seed = useApp.getState().runtime;
  for (const id in seed) track.set(id, { state: seed[id].state.state, startedAt: seed[id].startedAt });

  let prevRuntime = useApp.getState().runtime;
  const unsubApp = useApp.subscribe((s) => {
    if (s.runtime === prevRuntime) return;
    const before = prevRuntime;
    prevRuntime = s.runtime;
    for (const id in s.runtime) {
      const info = s.runtime[id];
      if (before[id] === info) continue;
      const prev = track.get(id);
      const meta = s.persisted.sessions.find((m) => m.id === id);
      const account = resolveAccountName(meta?.agent ?? info.agent, meta ? meta.profileId : info.profileId, s.accounts, s.profiles);
      const mapped = mapLifecycle(prev, info, {
        profileName: account?.name ?? null,
        accountPending: !!account?.pendingId,
        worktreeBranch: meta?.worktree ? (meta.worktree.branch ?? meta.worktree.path) : null,
      });
      track.set(id, { state: info.state.state, startedAt: info.startedAt ?? prev?.startedAt ?? null });
      if (mapped)
        recordActivity({
          sessionId: id,
          sessionName: meta?.name ?? info.name,
          role: meta?.role ?? null,
          agent: meta?.agent ?? info.agent,
          kind: "lifecycle",
          ...mapped,
          ...(account?.pendingId && mapped.message.includes(PENDING_ACCOUNT) ? { pendingAccountId: account.pendingId } : {}),
        });
    }
    for (const id of track.keys()) if (!s.runtime[id]) track.delete(id);
  });

  // Account names that were unknown at event time (accounts still loading) are filled in once known.
  let prevAccounts = useApp.getState().accounts;
  let prevProfiles = useApp.getState().profiles;
  const unsubAccounts = useApp.subscribe((s) => {
    if (s.accounts === prevAccounts && s.profiles === prevProfiles) return;
    prevAccounts = s.accounts;
    prevProfiles = s.profiles;
    const events = useActivity.getState().events;
    if (!events.some((e) => e.pendingAccountId)) return;
    const next = resolvePendingAccounts(events, (aid) => resolveAccountName("claude", aid, s.accounts, s.profiles)?.name);
    if (next) useActivity.setState({ events: next });
  });

  let prevAttn = useAttention.getState().sessions;
  const unsubAttn = useAttention.subscribe((s) => {
    if (s.sessions === prevAttn) return;
    const before = prevAttn;
    prevAttn = s.sessions;
    for (const id in s.sessions) {
      const next = s.sessions[id];
      const prev = before[id];
      if (prev === next || isLifecycleEcho(next)) continue;
      const mapped = mapAttentionTransition(prev, next);
      if (!mapped) continue;
      const l = sessionLabelOf(id);
      recordActivity({ sessionId: id, sessionName: l.name, role: l.role, agent: l.agent, kind: "attention", at: next.at, ...mapped });
    }
  });

  return () => {
    unsubApp();
    unsubAccounts();
    unsubAttn();
  };
}
