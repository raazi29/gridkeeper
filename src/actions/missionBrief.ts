// "Brief team…": one line per session, built from its role, that points the agent at the shared mission
// file and tells it how to use it (lead: split the mission into tasks; builders: claim / finish / block
// their tasks; reviewers & verifiers: check finished work). The texts are pure (unit-tested) and reused by
// the formation dialog's starter prompts. Sending happens only from the confirmation dialog's Send button,
// only to live terminal sessions, and never to a session that is asking something (attention "waiting" or
// a prompt-shaped output tail): an Enter there would accept the agent's default answer.

import { errorMessage, ipc } from "../lib/ipc";
import { slugify } from "../lib/missionDoc";
import { normalizeRole } from "../lib/roles";
import type { SessionId, SessionInfo } from "../lib/types";
import { isLive, useApp } from "../store/appStore";
import { recordActivity, sessionLabelOf } from "../store/activity";
import { useAttention } from "../store/attention";
import { isTerminalSession } from "./groupActions";
import { looksLikeQuestion } from "./starterPrompt";

const ENTER_DELAY_MS = 80;
const TAIL_BYTES = 4096;

export interface BriefMember {
  name: string;
  role: string | null;
}

export interface BriefTarget {
  /** Session name; null for a role-wide text (formation starter prompts). */
  name: string | null;
  role: string | null;
  /** Role-wide texts: the pane names of that role ("builder-1", "builder-2"). */
  names?: string[];
}

export interface BriefContext {
  /** Absolute path of the mission file (the main project's, also for worktree sessions). */
  missionPath: string;
  /** Everyone on the team (the target included; it is left out of the lead's owner list). */
  team: BriefMember[];
}

const tag = (s: string) => `@${s}`;
const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ").replace(/\s{2,}/g, " ").trim();

/** "@builder-1 (builder), @codex-reviewer (reviewer)" + a role-tag hint when a role has several members. */
function ownerList(team: BriefMember[], self: BriefTarget): string {
  const selfSlugs = new Set([self.name, ...(self.names ?? [])].map((n) => slugify(n)).filter(Boolean));
  const others = team.filter((m) => slugify(m.name) && !selfSlugs.has(slugify(m.name)));
  if (others.length === 0) return "@lead (you; no teammates yet)";
  const list = others.map((m) => {
    const role = normalizeRole(m.role);
    return role && role !== slugify(m.name) ? `${tag(slugify(m.name))} (${role})` : tag(slugify(m.name));
  });
  const counts = new Map<string, number>();
  for (const m of others) {
    const r = normalizeRole(m.role);
    if (r) counts.set(r, (counts.get(r) ?? 0) + 1);
  }
  const shared = [...counts].filter(([, n]) => n > 1).map(([r]) => tag(r));
  return list.join(", ") + (shared.length ? `; ${shared.join(" / ")} tags every member of that role` : "");
}

/** The one-line brief for a session (or, with `name` null, for every session of a role). Pure. */
export function briefText(target: BriefTarget, ctx: BriefContext): string {
  const path = oneLine(ctx.missionPath);
  const role = normalizeRole(target.role);
  if (role === "lead")
    return oneLine(
      `You are the lead. Our mission is in ${path}. Break it into concrete tasks in that file under '## Tasks' using '- [ ] task @owner' with owners from: ${ownerList(ctx.team, target)}. Keep tasks small. Update the file as plans change.`,
    );

  const slug = slugify(target.name);
  const who =
    target.name && slug !== role
      ? `You are ${oneLine(target.name)}${role ? ` (${role})` : ""}.`
      : target.name
        ? `You are the ${role}.`
        : `You are ${role ? `a ${role}` : "a member of the team"}.`;
  const own = (target.names ?? []).map(slugify).filter(Boolean);
  const tags = [slug ? tag(slug) : null, role && role !== slug ? tag(role) : null].filter(Boolean).join(" or ");
  const tagged = target.name
    ? `tasks tagged ${tags || "with your name"}`
    : `tasks tagged ${role ? tag(role) : "with your pane name"}${own.length ? ` or your own pane name (${own.map(tag).join(", ")})` : ""}`;

  if (role === "reviewer" || role === "verifier") {
    const verb = role === "reviewer" ? "Review the diff behind" : "Run the tests, lint and checks for";
    return oneLine(
      `${who} Read ${path}. ${verb} every task marked '[x]' and work on ${tagged}: mark '[~]' when you start, '[x]' when done. Report problems as new '- [ ] fix: … @owner' lines (or '[!] reason' on your own task). Don't change code yourself and don't edit other people's tasks.`,
    );
  }
  if (role === "scout")
    return oneLine(
      `${who} Read ${path}. Work on ${tagged}: mark '[~]' when you start, '[x]' when done with a one-line finding after the task, '[!] reason' if blocked. Don't change code. Don't edit other people's tasks.`,
    );
  return oneLine(
    `${who} Read ${path}. Work on ${tagged}: mark '[~]' when you start, '[x]' when done, '[!] reason' if blocked. Commit your work on your branch. Don't edit other people's tasks.`,
  );
}

/**
 * Formation starter prompts: one brief per role key ("agent" = no role) for a planned team. A role with a
 * single session gets that session's own text; a shared role gets the role-wide text naming its panes. Pure.
 */
export function formationBriefPrompts(roleKeys: readonly string[], team: readonly BriefMember[], missionPath: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of roleKeys) {
    const role = key === "agent" ? null : key;
    const names = team.filter((m) => (normalizeRole(m.role) ?? "agent") === key).map((m) => m.name);
    out[key] = briefText({ name: names.length === 1 ? names[0] : null, role, names }, { missionPath, team: [...team] });
  }
  return out;
}

// ---- recipients -------------------------------------------------------------------------------

export interface BriefCandidate {
  id: SessionId;
  name: string;
  role: string | null;
  terminal: boolean;
  live: boolean;
  /** Attention state is "waiting". */
  waiting: boolean;
  /** The output tail looks like a question / permission prompt. */
  question: boolean;
}

export interface BriefRecipient {
  id: SessionId;
  name: string;
  role: string | null;
  text: string;
}

export interface BriefSkip {
  id: SessionId;
  name: string;
  reason: string;
}

/** Why a session can't be briefed now (null = it can). Browser panes are never candidates at all. Pure. */
export function skipReason(c: Pick<BriefCandidate, "live" | "waiting" | "question">): string | null {
  if (!c.live) return "not running";
  if (c.waiting) return "waiting for you (answer it first)";
  if (c.question) return "asking something (answer it first)";
  return null;
}

/** Split candidates into recipients (with their text) and skipped sessions. Pure. */
export function planBrief(cands: readonly BriefCandidate[], ctx: BriefContext): { recipients: BriefRecipient[]; skipped: BriefSkip[] } {
  const recipients: BriefRecipient[] = [];
  const skipped: BriefSkip[] = [];
  for (const c of cands) {
    if (!c.terminal) continue;
    const reason = skipReason(c);
    if (reason) skipped.push({ id: c.id, name: c.name, reason });
    else recipients.push({ id: c.id, name: c.name, role: c.role, text: briefText({ name: c.name, role: c.role }, ctx) });
  }
  return { recipients, skipped };
}

async function tailOf(id: SessionId): Promise<string> {
  try {
    return await ipc.sessionOutputTail(id, TAIL_BYTES);
  } catch {
    return "";
  }
}

function isWaiting(id: SessionId): boolean {
  return useAttention.getState().sessions[id]?.state === "waiting";
}

/** Gather the team (in `ids` order) and decide who gets which brief. Reads output tails of live sessions. */
export async function gatherBrief(ids: readonly SessionId[], missionPath: string): Promise<{ recipients: BriefRecipient[]; skipped: BriefSkip[] }> {
  const s = useApp.getState();
  const metas = new Map(s.persisted.sessions.map((m) => [m.id, m]));
  const runtime: Record<SessionId, SessionInfo | undefined> = s.runtime;
  const cands: BriefCandidate[] = await Promise.all(
    ids.map(async (id) => {
      const m = metas.get(id);
      const terminal = isTerminalSession(m);
      const live = terminal && isLive(runtime[id]);
      return {
        id,
        name: m?.name ?? "session",
        role: m?.role ?? null,
        terminal,
        live,
        waiting: live && isWaiting(id),
        question: live && looksLikeQuestion(await tailOf(id)),
      };
    }),
  );
  const team = cands.filter((c) => c.terminal).map((c) => ({ name: c.name, role: c.role }));
  return planBrief(cands, { missionPath, team });
}

// ---- sending ----------------------------------------------------------------------------------

async function sendLine(id: SessionId, text: string) {
  await ipc.sessionWrite(id, oneLine(text));
  await new Promise((r) => setTimeout(r, ENTER_DELAY_MS));
  await ipc.sessionWrite(id, "\r");
}

function log(id: SessionId, level: "info" | "needs" | "error", message: string, result: string) {
  const l = sessionLabelOf(id);
  recordActivity({ sessionId: id, sessionName: l.name, role: l.role, agent: l.agent, kind: "mission", level, message, result });
}

export interface BriefOutcome {
  sent: string[];
  skipped: string[];
  failed: string[];
}

/**
 * Send the (possibly edited) briefs. Each session is checked again right before sending: one that ended
 * or started asking something since the dialog opened is skipped and logged. Call only from a Send button.
 */
export async function sendBrief(recipients: readonly Pick<BriefRecipient, "id" | "name" | "text">[]): Promise<BriefOutcome> {
  const out: BriefOutcome = { sent: [], skipped: [], failed: [] };
  await Promise.all(
    recipients.map(async (r) => {
      const text = oneLine(r.text);
      if (!text) return;
      const live = isLive(useApp.getState().runtime[r.id]);
      const reason = skipReason({ live, waiting: live && isWaiting(r.id), question: live && looksLikeQuestion(await tailOf(r.id)) });
      if (reason) {
        out.skipped.push(r.name);
        log(r.id, "needs", `mission brief not sent: ${reason}`, "skipped");
        return;
      }
      try {
        await sendLine(r.id, text);
        out.sent.push(r.name);
        log(r.id, "info", `mission brief: ${text}`, "sent");
      } catch (e) {
        out.failed.push(r.name);
        log(r.id, "error", `mission brief failed: ${errorMessage(e)}`, "failed");
      }
    }),
  );
  return out;
}
