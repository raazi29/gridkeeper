// Phone alerts (opt-in, ntfy): decides whether an attention / lead / mission event goes to the user's phone and
// builds the GENERIC text. Never terminal output: a pane / workspace name only with `includeNames`, the mission
// goal only with `includeTaskNames`, otherwise a fixed sentence. Rust re-checks the switches, scrubs the text again
// and rate limits (phone.rs); the pure functions here carry the policy and are unit-tested.

import { getNotif } from "../actions/notifyPrefs";
import { inQuietHours } from "../actions/notifyRules";
import { actionToast } from "../store/uiStore";
import { errorMessage, ipc } from "./ipc";
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
}

export interface PhoneContext {
  /** The Gridkeeper window is in front. */
  windowActive: boolean;
  minutesOfDay: number;
  notif: Pick<NotificationSettings, "dnd" | "mutedSessions" | "mutedWorkspaces">;
}

/** ntfy priorities: 3 default, 4 high, 5 max. */
const PRIORITY: Record<PhoneEventKind, number> = { needsInput: 4, error: 4, proposal: 3, missionDone: 3, done: 3 };

const TEXT: Record<PhoneEventKind, { title: (who: string | null) => string; message: string; tag: string }> = {
  needsInput: { title: (w) => (w ? `${w} needs you` : "An agent needs you"), message: "Open Gridkeeper to respond.", tag: "speech_balloon" },
  error: { title: (w) => (w ? `${w} stopped with an error` : "An agent stopped with an error"), message: "Open Gridkeeper to see what happened.", tag: "rotating_light" },
  done: { title: (w) => (w ? `${w} finished` : "An agent finished"), message: "It went quiet after working.", tag: "white_check_mark" },
  proposal: { title: (w) => (w ? `${w} has a proposal` : "A lead has a proposal"), message: "It waits for your approval in Gridkeeper.", tag: "memo" },
  missionDone: { title: () => "Mission complete", message: "Every task on the board is checked off.", tag: "tada" },
};

/** Why this event stays off the phone, or null when it qualifies. Do not disturb and mutes of the app apply. */
export function phoneSkipReason(cfg: PhoneConfig, ev: PhoneEvent, ctx: PhoneContext): string | null {
  if (!cfg.enabled || !cfg.topic) return "off";
  if (!cfg.events[ev.kind]) return "event";
  if (ctx.notif.dnd) return "dnd";
  if (ev.sessionId && ctx.notif.mutedSessions.includes(ev.sessionId)) return "session";
  if (ev.workspaceId && ctx.notif.mutedWorkspaces.includes(ev.workspaceId)) return "workspace";
  if (inQuietHours(ctx.minutesOfDay, cfg.quietHours)) return "quiet";
  if (PRIORITY[ev.kind] < cfg.minPriority) return "priority";
  if (cfg.onlyWhenAway && ctx.windowActive) return "present";
  return null;
}

/** Generic text only: the event carries names, never output, and the names are used only when allowed. */
export function buildPhoneAlert(cfg: PhoneConfig, ev: PhoneEvent): PhoneAlert {
  const t = TEXT[ev.kind];
  const goal = cfg.includeTaskNames && ev.kind === "missionDone" ? ev.goal : null;
  const message = [cfg.includeNames ? ev.workspaceName : null, goal, t.message].filter(Boolean).join(" · ");
  return { key: ev.key, kind: ev.kind, title: t.title(cfg.includeNames ? (ev.paneName ?? null) : null), message, priority: PRIORITY[ev.kind], tags: [t.tag] };
}

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

/** Fire and forget: qualify the event, then hand the generic alert to Rust. */
export async function notifyPhone(ev: PhoneEvent): Promise<void> {
  try {
    const cfg = await loadConfig();
    const d = new Date();
    const windowActive = typeof document !== "undefined" && document.hasFocus() && document.visibilityState === "visible";
    if (phoneSkipReason(cfg, ev, { windowActive, minutesOfDay: d.getHours() * 60 + d.getMinutes(), notif: getNotif() })) return;
    const r = await ipc.phoneAlertSend(buildPhoneAlert(cfg, ev));
    if (r.outcome === "failed" && r.firstFailure) actionToast({ kind: "warn", message: "Phone alert not delivered", detail: r.detail ?? undefined });
  } catch (e) {
    ipc.log("warn", `phone alert failed: ${errorMessage(e)}`);
  }
}
