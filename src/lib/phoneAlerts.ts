// Phone alerts (opt-in, ntfy): decides whether an attention / lead / mission event goes to the user's phone and
// builds the GENERIC text. Never terminal output: a pane / workspace name only with `includeNames`, the mission
// goal only with `includeTaskNames`, otherwise a fixed sentence. Rust re-checks the switches, scrubs the text again
// (paths, URLs, e-mail addresses, secrets) and rate limits (src-tauri/src/phone.rs); the pure functions here carry
// the policy and are unit-tested.
//
// Event sources: the attention pipeline (attentionNotify.ts calls notifyPhone for every alert it records),
// lead-control proposals that start waiting for the user, and a mission board whose last task gets checked off.
// The last two are watched here (installPhoneAlerts); a mission board is only known while something holds it
// (Mission Control open, or lead control on for that folder).
//
// The alert title and message are translated into the UI language: they are shown to the user only, as a push
// notification on their own phone (never typed into an agent or written to a project file).

import { getNotif } from "../actions/notifyPrefs";
import { inQuietHours } from "../actions/notifyRules";
import { useApp } from "../store/appStore";
import { useLeadControl } from "../store/leadControl";
import { dirKey, useMissionDocs, type MissionEntry } from "../store/missionDoc";
import { actionToast } from "../store/uiStore";
import { t } from "../i18n";
import { errorMessage, ipc } from "./ipc";
import type { MissionDoc } from "./missionDoc";
import type { NotificationSettings, PhoneAlert, PhoneConfig, PhoneEventKind, SessionId } from "./types";

export interface PhoneEvent {
  kind: PhoneEventKind;
  /** Rate-limit key: "s:<session id>", "p:<folder>", "m:<folder>". */
  key: string;
  sessionId?: SessionId;
  workspaceId?: string | null;
  /** The pane (or the lead, for a proposal). */
  paneName?: string;
  workspaceName?: string;
  /** Mission goal (missionDone only). */
  goal?: string | null;
  /** Tasks done / total (missionDone only). */
  done?: number;
  total?: number;
  /** The pane is on screen in the active group (the user may be looking right at it). */
  onScreen?: boolean;
}

export interface PhoneContext {
  /** The Gridkeeper window is in front. */
  windowActive: boolean;
  minutesOfDay: number;
  notif: Pick<NotificationSettings, "dnd" | "mutedSessions" | "mutedWorkspaces">;
}

/** ntfy priorities: 3 default, 4 high, 5 max. */
export const PHONE_PRIORITY: Record<PhoneEventKind, number> = { needsInput: 4, error: 4, proposal: 4, missionDone: 3, done: 3 };

const TAG: Record<PhoneEventKind, string> = {
  needsInput: "speech_balloon",
  error: "rotating_light",
  done: "white_check_mark",
  proposal: "memo",
  missionDone: "tada",
};

/** Why this event stays off the phone, or null when it qualifies. Do not disturb and mutes of the app apply. */
export function phoneSkipReason(cfg: PhoneConfig, ev: PhoneEvent, ctx: PhoneContext): string | null {
  if (!cfg.enabled || !cfg.topic) return "off";
  if (!cfg.events[ev.kind]) return "event";
  if (ctx.notif.dnd) return "dnd";
  if (ev.sessionId && ctx.notif.mutedSessions.includes(ev.sessionId)) return "session";
  if (ev.workspaceId && ctx.notif.mutedWorkspaces.includes(ev.workspaceId)) return "workspace";
  if (inQuietHours(ctx.minutesOfDay, cfg.quietHours)) return "quiet";
  if (PHONE_PRIORITY[ev.kind] < cfg.minPriority) return "priority";
  if (ctx.windowActive && ev.onScreen) return "visible";
  if (cfg.onlyWhenAway && ctx.windowActive) return "present";
  return null;
}

/** Generic text only: the event carries names, never output, and the names are used only when allowed. */
export function buildPhoneAlert(cfg: PhoneConfig, ev: PhoneEvent): PhoneAlert {
  const who = cfg.includeNames && ev.paneName ? ev.paneName : null;
  const workspace = cfg.includeNames && ev.workspaceName ? ev.workspaceName : null;
  const where = workspace ? ` · ${workspace}` : "";
  let title: string;
  let message: string;
  switch (ev.kind) {
    case "needsInput":
      title = (who ? t("phone.alert.needsInputTitle", { who }) : t("phone.alert.needsInputTitleAnon")) + where;
      message = t("phone.alert.needsInputMessage");
      break;
    case "error":
      title = (who ? t("phone.alert.errorTitle", { who }) : t("phone.alert.errorTitleAnon")) + where;
      message = t("phone.alert.errorMessage");
      break;
    case "done":
      title = (who ? t("phone.alert.doneTitle", { who }) : t("phone.alert.doneTitleAnon")) + where;
      message = t("phone.alert.doneMessage");
      break;
    case "proposal":
      title = t("phone.alert.proposalTitle") + where;
      message = who ? t("phone.alert.proposalMessageFrom", { who }) : t("phone.alert.proposalMessage");
      break;
    case "missionDone": {
      const goal = cfg.includeTaskNames && ev.goal ? ev.goal : null;
      const done = ev.done ?? ev.total;
      if (ev.total) title = goal ? t("phone.alert.missionDoneGoalCount", { goal, done, total: ev.total }) : t("phone.alert.missionDoneCount", { done, total: ev.total });
      else title = goal ? t("phone.alert.missionDoneGoal", { goal }) : t("phone.alert.missionDone");
      message = workspace ? t("phone.alert.missionDoneMessageIn", { workspace }) : t("phone.alert.missionDoneMessage");
      break;
    }
  }
  return { key: ev.key, kind: ev.kind, title, message, priority: PHONE_PRIORITY[ev.kind], tags: [TAG[ev.kind]] };
}

// ---- settings helpers (shared with the Settings section) ---------------------------------------------

/** Mirrors phone.rs validate_server for inline hints; Rust has the final word. Null = fine. */
export function serverProblem(raw: string): string | null {
  const s = raw.trim().replace(/\/+$/, "");
  if (!s) return t("phone.serverEmpty");
  const m = /^(https?):\/\/([^/?#@\s]+)(\/[A-Za-z0-9\-._~/%]*)?$/.exec(s);
  if (!m) return t("phone.serverInvalid");
  if (m[1] === "http" && !isPrivateHost(m[2].replace(/:\d+$/, ""))) return t("phone.serverPlainHttp");
  return null;
}

export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || [".localhost", ".local", ".lan", ".home.arpa", ".internal"].some((s) => h.endsWith(s))) return true;
  if (h.startsWith("[")) return h === "[::1]" || /^\[(fc|fd|fe80:)/.test(h);
  const p = h.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  return p[0] === 127 || p[0] === 10 || (p[0] === 192 && p[1] === 168) || (p[0] === 169 && p[1] === 254) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 100 && p[1] >= 64 && p[1] <= 127);
}

/** A topic anyone could guess (short or a plain word) deserves a warning on a public server. */
export function weakTopic(topic: string): boolean {
  return topic.length < 16 || /^[a-z]+$/i.test(topic);
}

/**
 * Where the phone subscribes: the topic's web page (any phone; the ntfy web app offers to subscribe) and the
 * ntfy app's deep link (`ntfy://host/topic`, Android; `?secure=false` for an http server).
 */
export function subscribeLinks(server: string, topic: string): { web: string; app: string } {
  const s = server.trim().replace(/\/+$/, "");
  const http = s.startsWith("http://");
  const rest = s.replace(/^https?:\/\//, "");
  return { web: `${s}/${topic}`, app: `ntfy://${rest}/${topic}${http ? "?secure=false" : ""}` };
}

// ---- sending -------------------------------------------------------------------------------------------

// The saved settings, fetched once and refreshed by Settings (events are rare; off is the default).
let cached: Promise<PhoneConfig> | null = null;

export function setPhoneConfig(cfg: PhoneConfig): void {
  cached = Promise.resolve(cfg);
}

function loadConfig(): Promise<PhoneConfig> {
  cached ??= ipc.phoneAlertsGet().then(
    (v) => v.config,
    (e) => {
      cached = null;
      throw e;
    },
  );
  return cached;
}

function windowActive(): boolean {
  return typeof document !== "undefined" && document.hasFocus() && document.visibilityState === "visible";
}

/** Fire and forget: qualify the event, then hand the generic alert to Rust. A failure is told once. */
export async function notifyPhone(ev: PhoneEvent): Promise<void> {
  try {
    const cfg = await loadConfig();
    if (!cfg.enabled) return;
    const d = new Date();
    if (phoneSkipReason(cfg, ev, { windowActive: windowActive(), minutesOfDay: d.getHours() * 60 + d.getMinutes(), notif: getNotif() })) return;
    const r = await ipc.phoneAlertSend(buildPhoneAlert(cfg, ev));
    if (r.outcome === "failed" && r.firstFailure) {
      actionToast({ kind: "warn", message: t("phone.toast.notDelivered"), detail: t("phone.toast.notDeliveredDetail", { error: r.detail ?? t("phone.toast.unknownError") }) });
    }
  } catch (e) {
    ipc.log("warn", `phone alert failed: ${errorMessage(e)}`);
  }
}

// ---- lead proposals and mission boards -------------------------------------------------------------------

function workspaceForDir(key: string) {
  return useApp.getState().persisted.workspaces.find((w) => w.projectDir && dirKey(w.projectDir) === key) ?? null;
}

/** Tasks done / total; `finished` when there is at least one task and all are done. Pure. */
export function boardProgress(doc: Pick<MissionDoc, "tasks">): { done: number; total: number; finished: boolean } {
  const total = doc.tasks.length;
  const done = doc.tasks.filter((t) => t.state === "done").length;
  return { done, total, finished: total > 0 && done === total };
}

/** A board read that can be compared: undefined = no usable read yet, null = no mission file. */
function boardOf(entry: MissionEntry | undefined): MissionDoc | null | undefined {
  if (!entry || entry.loading || entry.error || !entry.file) return undefined;
  return entry.file.exists && entry.doc ? entry.doc : null;
}

/** Watches lead-control proposals and mission boards for phone alerts. Returns the cleanup. */
export function installPhoneAlerts(): () => void {
  // A proposal that starts waiting for the user (new, or an autopilot item that gave up) is told once.
  const told = new Set<string>();
  for (const p of useLeadControl.getState().proposals) if (p.status === "proposal") told.add(p.key);
  const unsubProposals = useLeadControl.subscribe((s, prev) => {
    if (s.proposals === prev.proposals) return;
    const waiting = s.proposals.filter((p) => p.status === "proposal");
    for (const p of waiting) {
      if (told.has(p.key)) continue;
      told.add(p.key);
      const ws = workspaceForDir(p.dirKey);
      void notifyPhone({ kind: "proposal", key: `p:${p.dirKey}`, workspaceId: ws?.id ?? null, workspaceName: ws?.name, paneName: p.lead ?? undefined });
    }
    for (const k of told) if (!waiting.some((p) => p.key === k)) told.delete(k);
  });

  // The last open task of a board gets checked off. The first read of a folder is the baseline.
  const finished = new Map<string, boolean>();
  const seed = useMissionDocs.getState().byDir;
  for (const dir in seed) {
    const b = boardOf(seed[dir]);
    if (b !== undefined) finished.set(dirKey(dir), !!b && boardProgress(b).finished);
  }
  const unsubDocs = useMissionDocs.subscribe((s, prev) => {
    if (s.byDir === prev.byDir) return;
    for (const [dir, entry] of Object.entries(s.byDir)) {
      if (entry === prev.byDir[dir]) continue;
      const b = boardOf(entry);
      if (b === undefined) continue;
      const key = dirKey(dir);
      const progress = b ? boardProgress(b) : null;
      const was = finished.get(key);
      finished.set(key, !!progress?.finished);
      if (was === false && progress?.finished && b) {
        const ws = workspaceForDir(key);
        void notifyPhone({ kind: "missionDone", key: `m:${key}`, workspaceId: ws?.id ?? null, workspaceName: ws?.name, goal: b.goal, done: progress.done, total: progress.total });
      }
    }
  });

  return () => {
    unsubProposals();
    unsubDocs();
  };
}
