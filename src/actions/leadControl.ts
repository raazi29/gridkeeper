// Lead control engine: lets a lead (or any agent) instruct its teammates through files, under the autonomy the
// user chose per project folder (store/leadControl.ts; protocol: lib/outbox.ts).
//
// Runs whenever a workspace with control != off exists, whether or not Mission Control is open:
// - holds the ref-counted mission watch of every controlled folder (acquireMission: no polling) and lists
//   `.gridkeeper/outbox/` on every "outbox" change event (and once when a folder becomes controlled);
// - turns each instruction file into a proposal (advisor), or queues message / review items for automatic
//   delivery (autopilot, not paused). Delivery uses the same safe-send rules as "brief team" / "hand off":
//   never while the target is "waiting", a Claude hook reports a permission / question prompt (exact; checked
//   first, see hookWaitReason) or its output tail reads like a question; autopilot additionally waits
//   while the target is working, at most 1 delivery per target per 20 s and 8 per minute, retries on the
//   target's next attention transition and gives up after 10 minutes (it becomes a proposal). stop / restart
//   are never automatic: they go through the confirmStop / confirmRestart dialogs;
// - asks the lead to review a teammate's finished work (auto-review), once per session + HEAD commit;
// - regenerates `.gridkeeper/team.md` (coalesced, 1.5 s) on attention transitions, session start / stop,
//   mission file changes and branch-summary refreshes. Never on a timer: the only timers exist while
//   something is pending (a team write, or queued items waiting for a rate limit / give-up deadline).
// Nothing is typed into an agent except by the user's Send or by autopilot the user explicitly enabled.

import { tailLines } from "../components/util/fleet";
import { isTerminalMeta } from "../lib/browserPanes";
import { errorMessage, ipc, onMissionChanged } from "../lib/ipc";
import { currentTaskFor, ownsTask, progress, slugify, type MissionDoc, type Task } from "../lib/missionDoc";
import {
  autoReviewText,
  cleanInstruction,
  fromLabel,
  instructionPrefix,
  isLeadRole,
  memberState,
  parseOutbox,
  pruneDeliveries,
  rateLimitWait,
  renderTeamMd,
  resolveTargets,
  senderLeads,
  stripControl,
  type Delivery,
  type TeamMdMember,
  type TeamMdSnapshot,
} from "../lib/outbox";
import { normalizeRole } from "../lib/roles";
import type { OutboxItem, SessionId, SessionMeta } from "../lib/types";
import { recordActivity, sessionLabelOf } from "../store/activity";
import { isLive, useApp } from "../store/appStore";
import { hookWaitReason, useAttention } from "../store/attention";
import {
  DEFAULT_POLICY,
  effectiveMode,
  getProposal,
  patchProposal,
  policyOf,
  removeDirProposals,
  removeProposal,
  setPolicy,
  upsertProposal,
  useLeadControl,
  type ControlMode,
  type ControlPolicy,
  type Proposal,
} from "../store/leadControl";
import { acquireMission, dirKey, useMissionDocs } from "../store/missionDoc";
import { cachedBranchSummary, evidencePath, handoffBlocker, refreshBranchSummary, scheduleBranchSummary, useBranchSummaries } from "./handoff";

/** team.md is written at most this long after the first change of a burst. */
export const TEAM_DEBOUNCE_MS = 1500;
/** Autopilot gives up on a queued item after this long without a safe moment (it becomes a proposal). */
export const GIVE_UP_MS = 10 * 60 * 1000;
/** An empty message file younger than this is probably still being written: wait for its next change. */
export const EMPTY_GRACE_MS = 10_000;
const ENTER_DELAY_MS = 80;
const TAIL_BYTES = 8192;
const OUTPUT_LINES = 15;

export interface Member {
  id: SessionId;
  name: string;
  role: string | null;
  agent: string;
  slug: string;
  meta: SessionMeta;
}

interface Hold {
  dir: string;
  release: () => void;
}

const holds = new Map<string, Hold>();
let unlisten: Promise<(() => void) | null> | null = null;
const teamTimers = new Map<string, ReturnType<typeof setTimeout>>();
const lastTeamBody = new Map<string, string>();
const teamErrorLogged = new Set<string>();
let history: Delivery[] = [];
/** Auto-review requests already made: `${sessionId}|c|<HEAD fingerprint>` or `${sessionId}|t|<task>`. */
const reviewed = new Set<string>();
/** Done task keys per folder (baseline = first read after the folder became controlled). */
const doneTasks = new Map<string, Set<string>>();
/** A task the session owns that turned [x] since its last review request. */
const newlyDone = new Map<SessionId, string>();
/** Proposal keys of outbox files that were moved (or are being moved) out of the outbox. */
const archived = new Set<string>();
const scanning = new Set<string>();
const rescan = new Set<string>();
let pumping = false;
let pumpAgain = false;
let tickTimer: ReturnType<typeof setTimeout> | undefined;
let uninstall: (() => void) | null = null;

// ---- team ---------------------------------------------------------------------------------------------

function agentLabel(m: SessionMeta): string {
  return m.agent === "generic" ? (m.preset ?? "agent") : m.agent;
}

/** Process sessions of every workspace whose project folder is `dk`, in layout order. */
export function teamFor(dk: string, s = useApp.getState()): Member[] {
  const metas = new Map(s.persisted.sessions.map((m) => [m.id, m]));
  const out: Member[] = [];
  const seen = new Set<SessionId>();
  for (const ws of s.persisted.workspaces) {
    if (!ws.projectDir?.trim() || dirKey(ws.projectDir) !== dk) continue;
    for (const g of ws.groups)
      for (const id of g.sessionIds) {
        const m = metas.get(id);
        if (!m || !isTerminalMeta(m) || seen.has(id)) continue;
        seen.add(id);
        out.push({ id, name: m.name, role: normalizeRole(m.role), agent: agentLabel(m), slug: slugify(m.name), meta: m });
      }
  }
  return out;
}

/** Controlled folder (dirKey) of a session, or null. */
function dirOfSession(id: SessionId, s = useApp.getState()): string | null {
  for (const ws of s.persisted.workspaces) {
    if (!ws.projectDir?.trim() || !ws.groups.some((g) => g.sessionIds.includes(id))) continue;
    const k = dirKey(ws.projectDir);
    return holds.has(k) ? k : null;
  }
  return null;
}

function gridkeeperDir(dir: string): string {
  const sep = dir.includes("\\") || !dir.includes("/") ? "\\" : "/";
  return `${dir.replace(/[\\/]+$/, "")}${sep}.gridkeeper`;
}

const label = (id: SessionId) => sessionLabelOf(id).name;
const isLeadId = (id: SessionId) => isLeadRole(useApp.getState().persisted.sessions.find((m) => m.id === id)?.role);

// ---- controlled folders -------------------------------------------------------------------------------

function desiredDirs(): Map<string, string> {
  const pol = useLeadControl.getState().policies;
  const out = new Map<string, string>();
  for (const ws of useApp.getState().persisted.workspaces) {
    if (!ws.projectDir?.trim()) continue;
    const k = dirKey(ws.projectDir);
    if (!out.has(k) && (pol[k]?.mode ?? "off") !== "off") out.set(k, ws.projectDir);
  }
  return out;
}

function publishActive() {
  const active: Record<string, string> = {};
  for (const [k, h] of holds) active[k] = h.dir;
  const cur = useLeadControl.getState().active;
  const same = Object.keys(cur).length === holds.size && Object.entries(active).every(([k, d]) => cur[k] === d);
  if (!same) useLeadControl.setState({ active });
}

function syncActive() {
  const want = desiredDirs();
  for (const k of [...holds.keys()]) if (!want.has(k)) deactivate(k);
  for (const [k, dir] of want) if (!holds.has(k)) activate(k, dir);
  publishActive();
}

function activate(k: string, dir: string) {
  holds.set(k, { dir, release: acquireMission(dir) });
  ensureListener();
  const doc = useMissionDocs.getState().byDir[dir]?.doc;
  if (doc) doneTasks.set(k, doneKeys(doc));
  void scanOutbox(k);
  primeBranches(k);
  scheduleTeam(k);
}

function deactivate(k: string) {
  holds.get(k)?.release();
  holds.delete(k);
  clearTimeout(teamTimers.get(k));
  teamTimers.delete(k);
  lastTeamBody.delete(k);
  teamErrorLogged.delete(k);
  doneTasks.delete(k);
  removeDirProposals(k);
  // `archived` markers stay: a delivered file whose move failed must never be delivered again after an
  // off → on switch (a marker goes once a listing no longer shows its file).
  if (holds.size === 0) dropListener();
  reschedule();
}

function ensureListener() {
  if (unlisten) return;
  unlisten = onMissionChanged((ev) => {
    if (ev.file === "mission" || ev.file === "brain") return; // the mission store re-reads; doc changes arrive via its subscription
    const k = dirKey(ev.projectDir);
    if (holds.has(k)) void scanOutbox(k);
  }).catch(() => null);
}

function dropListener() {
  const p = unlisten;
  unlisten = null;
  void p?.then((off) => off?.());
}

/** Branch summaries for team.md: once per member when the folder becomes controlled (if not cached). */
function primeBranches(k: string) {
  for (const m of teamFor(k)) {
    const p = evidencePath(m.meta);
    if (p && !cachedBranchSummary(p)) void refreshBranchSummary(p);
  }
}

// ---- outbox → proposals -------------------------------------------------------------------------------

const outboxKey = (dk: string, name: string) => `${dk}|f|${name}`;

function isNotFound(e: unknown): boolean {
  return !!e && typeof e === "object" && (e as { code?: unknown }).code === "not_found";
}

/** One outbox file as a proposal (queued for autopilot when it can be delivered). Null = not ready yet. Pure. */
export function buildOutboxProposal(dk: string, dir: string, item: OutboxItem, team: readonly Member[], mode: ControlMode, now: number): Proposal | null {
  const parsed = parseOutbox(item.text);
  const warnings = [...parsed.warnings];
  if (item.truncated) warnings.push("the file is larger than 16 KiB — only its beginning was read");
  const typed = parsed.action === "message" || parsed.action === "review";
  if (typed && !parsed.text && item.modifiedMs > 0 && now - item.modifiedMs < EMPTY_GRACE_MS) return null;
  const { ids, unknown } = resolveTargets(parsed.to, team, parsed.from);
  for (const u of unknown) warnings.push(`nobody is named or has the role “${u}”`);
  let reason: string | null = null;
  if (ids.length === 0)
    reason = parsed.to.length === 0 ? "the file has no “to:” line" : unknown.length ? "no teammate matches its “to:” line" : "it is addressed only to its sender";
  else if (typed && !parsed.text) reason = "the instruction is empty";
  const auto = mode === "autopilot" && typed && reason === null;
  const leads = senderLeads(parsed.from, team);
  const names = ids.map((id) => team.find((m) => m.id === id)?.name ?? id);
  return {
    key: outboxKey(dk, item.name),
    dirKey: dk,
    dir,
    source: "outbox",
    file: item.name,
    modifiedMs: item.modifiedMs,
    from: fromLabel(parsed.from, team),
    lead: leads.length === 1 ? leads[0].name : null,
    to: parsed.to,
    targets: ids,
    targetLabel: names.join(", ") || parsed.to.join(", ") || "nobody",
    action: parsed.action,
    text: typed && parsed.text ? `${instructionPrefix(parsed.action, parsed.from)}${parsed.text}` : parsed.text,
    edited: false,
    warnings,
    status: auto ? "queued" : "proposal",
    reason,
    createdAt: now,
    queuedAt: auto ? now : null,
    delivered: [],
    busy: false,
  };
}

/** List the outbox of a controlled folder and reconcile the proposals. Bursts coalesce into one extra listing. */
export async function scanOutbox(k: string): Promise<void> {
  if (scanning.has(k)) {
    rescan.add(k);
    return;
  }
  scanning.add(k);
  try {
    do {
      rescan.delete(k);
      const h = holds.get(k);
      if (!h) return;
      let items: OutboxItem[];
      try {
        items = await ipc.missionOutboxList(h.dir);
      } catch (e) {
        ipc.log("warn", `lead control: could not list the outbox: ${errorMessage(e)}`);
        return;
      }
      if (holds.get(k) !== h) return;
      applyListing(k, h.dir, items);
    } while (rescan.has(k));
  } finally {
    scanning.delete(k);
  }
  void pump();
}

function applyListing(k: string, dir: string, items: readonly OutboxItem[]) {
  const names = new Set(items.map((i) => i.name));
  const prefix = `${k}|f|`;
  for (const a of [...archived]) if (a.startsWith(prefix) && !names.has(a.slice(prefix.length))) archived.delete(a);
  const existing = new Map<string, Proposal>();
  for (const p of useLeadControl.getState().proposals) if (p.dirKey === k && p.source === "outbox" && p.file) existing.set(p.file, p);
  // Deleted by its author: the proposal goes too (unless it is being sent right now).
  for (const [name, p] of existing) if (!names.has(name) && !p.busy) removeProposal(p.key);
  const mode = effectiveMode(policyOf(dir));
  const team = teamFor(k);
  const now = Date.now();
  for (const item of items) {
    const key = outboxKey(k, item.name);
    if (archived.has(key)) continue;
    const prev = existing.get(item.name);
    // A rewrite of the file replaces a proposal nobody touched yet.
    if (prev && (prev.modifiedMs === item.modifiedMs || prev.edited || prev.busy || prev.delivered.length > 0)) continue;
    const p = buildOutboxProposal(k, dir, item, team, mode, now);
    if (!p) continue;
    upsertProposal(prev ? { ...p, createdAt: prev.createdAt } : p);
  }
}

// ---- delivery -----------------------------------------------------------------------------------------

async function typeLine(id: SessionId, text: string) {
  await ipc.sessionWrite(id, text);
  await new Promise((r) => setTimeout(r, ENTER_DELAY_MS));
  await ipc.sessionWrite(id, "\r");
}

function senderToken(p: Proposal): string {
  return p.source === "review" ? "auto-review" : p.from.replace(/ \(self-declared\)$/, "");
}

function log(id: SessionId, level: "info" | "needs" | "error", message: string, result: string) {
  const l = sessionLabelOf(id);
  recordActivity({ sessionId: id, sessionName: l.name, role: l.role, agent: l.agent, kind: "mission", level, message, result });
}

function logSent(p: Proposal, id: SessionId, text: string, auto: boolean) {
  const preview = text.length > 80 ? `${text.slice(0, 79)}…` : text;
  log(id, "info", `${senderToken(p)} → ${slugify(label(id)) || label(id)}: ${preview}`, auto ? "auto-sent" : "sent");
}

/** Sessions still to receive `p`. Reviews go to the first running lead (else the first lead). */
function pendingTargets(p: Proposal): SessionId[] {
  if (p.source === "review") {
    if (p.delivered.length > 0) return [];
    const rt = useApp.getState().runtime;
    const live = p.targets.find((id) => isLive(rt[id]));
    const first = live ?? p.targets[0];
    return first ? [first] : [];
  }
  return p.targets.filter((id) => !p.delivered.includes(id));
}

function isComplete(p: Proposal): boolean {
  return p.source === "review" ? p.delivered.length > 0 : p.targets.length > 0 && p.targets.every((id) => p.delivered.includes(id));
}

function stillAutopilot(key: string): boolean {
  const p = getProposal(key);
  return !!p && p.status === "queued" && holds.has(p.dirKey) && effectiveMode(policyOf(p.dir)) === "autopilot";
}

/** Type `p.text` into each pending target that is safe right now. Returns why some were not sent (or null). */
async function sendTargets(key: string, auto: boolean): Promise<string | null> {
  const p0 = getProposal(key);
  if (!p0) return null;
  const text = cleanInstruction(p0.text).text;
  if (!text) return "The message is empty.";
  const reasons: string[] = [];
  for (const id of pendingTargets(p0)) {
    const name = label(id);
    if (auto) {
      // Never deliver into a prompt Claude reports through its hooks (permission, question, plan approval).
      const prompt = hookWaitReason(useAttention.getState().sessions[id]);
      if (prompt) {
        reasons.push(`${name} ${prompt}; sent after it is answered`);
        continue;
      }
      const wait = rateLimitWait(history, id, Date.now());
      if (wait > 0) {
        reasons.push(`rate limit: next automatic delivery to ${name} in ${Math.ceil(wait / 1000)} s`);
        continue;
      }
      if (useAttention.getState().sessions[id]?.state === "working") {
        reasons.push(`${name} is working; sent when it goes quiet`);
        continue;
      }
    }
    const blocker = await handoffBlocker(id);
    if (blocker) {
      reasons.push(blocker);
      continue;
    }
    // The user may have paused, switched mode or dismissed it while the tail was read.
    if (!getProposal(key) || (auto && !stillAutopilot(key))) return null;
    try {
      await typeLine(id, text);
    } catch (e) {
      reasons.push(`could not type into ${name}: ${errorMessage(e)}`);
      log(id, "error", `${senderToken(p0)} → ${slugify(name) || name}: failed: ${errorMessage(e)}`, "failed");
      continue;
    }
    if (auto) history.push({ target: id, at: Date.now() });
    const cur = getProposal(key);
    if (cur) patchProposal(key, { delivered: [...cur.delivered, id] });
    logSent(p0, id, text, auto);
  }
  return reasons.length ? reasons.join(" · ") : null;
}

/**
 * Remove a handled proposal; an outbox file is moved to outbox/sent/ or outbox/dismissed/. A failed move of a
 * DELIVERED file still removes the proposal (it must never be delivered twice; the file stays hidden this
 * run). A failed dismiss keeps the proposal. Returns an error message or null.
 */
async function finalize(key: string, disposition: "sent" | "dismissed"): Promise<string | null> {
  const p = getProposal(key);
  if (!p) return null;
  if (p.source === "outbox" && p.file) {
    archived.add(key);
    try {
      await ipc.missionOutboxArchive(p.dir, p.file, disposition);
    } catch (e) {
      if (!isNotFound(e)) {
        const msg = `could not move ${p.file} to outbox/${disposition}/: ${errorMessage(e)}`;
        if (disposition === "dismissed") {
          archived.delete(key);
          return msg;
        }
        ipc.log("warn", `lead control: ${msg}`);
        removeProposal(key);
        return msg;
      }
    }
  }
  removeProposal(key);
  return null;
}

async function pumpOnce() {
  history = pruneDeliveries(history, Date.now());
  const queued = useLeadControl
    .getState()
    .proposals.filter((p) => p.status === "queued" && !p.busy)
    .sort((a, b) => a.createdAt - b.createdAt);
  for (const q of queued) {
    const p = getProposal(q.key);
    if (!p || p.status !== "queued" || p.busy) continue;
    if (!holds.has(p.dirKey) || effectiveMode(policyOf(p.dir)) !== "autopilot") {
      patchProposal(p.key, { status: "proposal", queuedAt: null });
      continue;
    }
    if (p.queuedAt !== null && Date.now() - p.queuedAt >= GIVE_UP_MS) {
      patchProposal(p.key, { status: "proposal", queuedAt: null, reason: "autopilot found no safe moment within 10 minutes; send it yourself or dismiss it" });
      const who = pendingTargets(p)[0];
      if (who) log(who, "needs", `${senderToken(p)} → ${slugify(label(who))}: not delivered within 10 minutes (now waiting for you)`, "gave up");
      continue;
    }
    if (p.source === "review" && !p.targets.some((id) => isLive(useApp.getState().runtime[id]))) {
      if (p.reason !== "waiting for a lead to run") patchProposal(p.key, { reason: "waiting for a lead to run" });
      continue;
    }
    patchProposal(p.key, { busy: true });
    let reason: string | null = null;
    try {
      reason = await sendTargets(p.key, true);
    } finally {
      if (getProposal(p.key)) patchProposal(p.key, { busy: false });
    }
    const after = getProposal(p.key);
    if (!after) continue;
    if (isComplete(after)) await finalize(after.key, "sent");
    else if (after.reason !== reason) patchProposal(after.key, { reason });
  }
}

/** Try every queued item now (autopilot). Safe to call often: a no-op while nothing is queued. */
export async function pump(): Promise<void> {
  if (pumping) {
    pumpAgain = true;
    return;
  }
  if (!useLeadControl.getState().proposals.some((p) => p.status === "queued")) {
    reschedule();
    return;
  }
  pumping = true;
  try {
    do {
      pumpAgain = false;
      await pumpOnce();
    } while (pumpAgain);
  } finally {
    pumping = false;
    reschedule();
  }
}

/** One timer while queued items wait for a rate limit or a give-up deadline; none otherwise. */
function reschedule() {
  clearTimeout(tickTimer);
  tickTimer = undefined;
  const queued = useLeadControl.getState().proposals.filter((p) => p.status === "queued");
  if (queued.length === 0) return;
  const now = Date.now();
  let at = Infinity;
  for (const p of queued) {
    if (p.queuedAt !== null) at = Math.min(at, p.queuedAt + GIVE_UP_MS);
    for (const id of pendingTargets(p)) {
      const w = rateLimitWait(history, id, now);
      if (w > 0) at = Math.min(at, now + w);
    }
  }
  if (at === Infinity) return;
  tickTimer = setTimeout(
    () => {
      tickTimer = undefined;
      void pump();
    },
    Math.max(50, at - now),
  );
}

function onModeChange(dk: string, mode: ControlMode) {
  const now = Date.now();
  for (const p of useLeadControl.getState().proposals) {
    if (p.dirKey !== dk || p.busy) continue;
    if (mode === "autopilot") {
      const deliverable = (p.action === "message" || p.action === "review") && !p.edited && p.targets.length > 0 && !!cleanInstruction(p.text).text;
      if (p.status === "proposal" && deliverable) patchProposal(p.key, { status: "queued", queuedAt: now, reason: null });
    } else if (p.status === "queued") patchProposal(p.key, { status: "proposal", queuedAt: null, reason: null });
  }
  void pump();
}

// ---- user actions -------------------------------------------------------------------------------------

export type SendResult = { ok: true } | { ok: false; reason: string };

/**
 * The user's Send on a proposal. message / review: typed into every pending target that is not asking
 * anything (no rate limits: the user decided); the others keep the proposal with the reason. stop /
 * restart: the usual confirmation dialogs, one per target.
 */
export async function sendProposal(key: string): Promise<SendResult> {
  const p = getProposal(key);
  if (!p) return { ok: false, reason: "This instruction is gone." };
  if (p.busy) return { ok: false, reason: "It is being sent right now." };
  if (pendingTargets(p).length === 0) return { ok: false, reason: p.reason ?? "Nobody to send it to." };
  if (p.action === "stop" || p.action === "restart") return runLifecycle(key);
  patchProposal(key, { busy: true });
  let reason: string | null = null;
  try {
    reason = await sendTargets(key, false);
  } finally {
    if (getProposal(key)) patchProposal(key, { busy: false });
  }
  const after = getProposal(key);
  if (!after) return { ok: true };
  if (isComplete(after)) {
    const err = await finalize(key, "sent");
    return err ? { ok: false, reason: err } : { ok: true };
  }
  const r = reason ?? "Not sent.";
  patchProposal(key, { reason: r });
  return { ok: false, reason: r };
}

async function runLifecycle(key: string): Promise<SendResult> {
  const p = getProposal(key);
  if (!p) return { ok: false, reason: "This instruction is gone." };
  const { confirmRestart, confirmStop } = await import("../components/menus/sessionMenu");
  patchProposal(key, { busy: true });
  try {
    for (const id of pendingTargets(p)) {
      if (!getProposal(key)) break;
      const name = label(id);
      const before = useApp.getState().runtime[id];
      let done = false;
      if (p.action === "stop") {
        if (isLive(before)) await confirmStop(id, name);
        const after = useApp.getState().runtime[id];
        done = !isLive(after) || after?.state.state === "stopping";
      } else if (useApp.getState().persisted.sessions.some((m) => m.id === id)) {
        await confirmRestart(id, name, { mode: "continue" }, isLive(before));
        const after = useApp.getState().runtime[id];
        done = !!after && (after.startedAt !== before?.startedAt || after.state.state === "starting");
      }
      if (!done) continue;
      const cur = getProposal(key);
      if (cur) patchProposal(key, { delivered: [...cur.delivered, id] });
      log(id, "info", `${senderToken(p)} → ${slugify(name) || name}: ${p.action}${p.text ? ` (${p.text.slice(0, 60)})` : ""}`, "confirmed");
    }
  } finally {
    if (getProposal(key)) patchProposal(key, { busy: false });
  }
  const after = getProposal(key);
  if (!after) return { ok: true };
  if (isComplete(after)) {
    const err = await finalize(key, "sent");
    return err ? { ok: false, reason: err } : { ok: true };
  }
  return { ok: false, reason: `Nothing was ${p.action === "stop" ? "stopped" : "restarted"} (cancelled).` };
}

/** Dismiss: an outbox file moves to outbox/dismissed/; a review request is forgotten. */
export async function dismissProposal(key: string): Promise<SendResult> {
  const p = getProposal(key);
  if (!p) return { ok: true };
  if (p.busy) return { ok: false, reason: "It is being sent right now." };
  patchProposal(key, { busy: true });
  const err = await finalize(key, "dismissed");
  if (err) {
    patchProposal(key, { busy: false, reason: err });
    return { ok: false, reason: err };
  }
  return { ok: true };
}

export function setControlMode(dir: string, mode: ControlMode): void {
  setPolicy(dir, { mode, paused: false });
}

export function setControlOptions(dir: string, patch: Partial<Pick<ControlPolicy, "autoReview" | "shareOutput" | "paused">>): void {
  setPolicy(dir, patch);
}

/** Pause (or resume) autopilot in every controlled folder. */
export function setAutopilotPaused(paused: boolean): void {
  const s = useLeadControl.getState();
  for (const [k, dir] of Object.entries(s.active)) if (s.policies[k]?.mode === "autopilot" && s.policies[k].paused !== paused) setPolicy(dir, { paused });
}

/**
 * Type a one-line explanation of the channel into the running leads (the user pressed Send in a confirmation).
 * Same safety rules as everywhere: a lead that is asking something is skipped.
 */
export async function briefLeads(leadIds: readonly SessionId[], text: string): Promise<{ sent: string[]; skipped: string[] }> {
  const out = { sent: [] as string[], skipped: [] as string[] };
  const line = cleanInstruction(text).text;
  if (!line) return out;
  for (const id of leadIds) {
    const name = label(id);
    const blocker = await handoffBlocker(id);
    if (blocker) {
      out.skipped.push(name);
      continue;
    }
    try {
      await typeLine(id, line);
      out.sent.push(name);
      const l = sessionLabelOf(id);
      recordActivity({ sessionId: id, sessionName: l.name, role: l.role, agent: l.agent, kind: "mission", level: "info", message: `lead control brief: ${line.slice(0, 79)}…`, result: "sent" });
    } catch {
      out.skipped.push(name);
    }
  }
  return out;
}

// ---- auto-review --------------------------------------------------------------------------------------

const taskKey = (t: Pick<Task, "text" | "owners">) => `${t.text}|${t.owners.join(",")}`;

function doneKeys(doc: MissionDoc): Set<string> {
  return new Set(doc.tasks.filter((t) => t.state === "done").map(taskKey));
}

function onMissionDoc(k: string, doc: MissionDoc) {
  const now = doneKeys(doc);
  const prev = doneTasks.get(k);
  doneTasks.set(k, now);
  if (!prev) return; // baseline: tasks already done when control started don't count
  const team = teamFor(k);
  for (const t of doc.tasks) {
    if (t.state !== "done" || prev.has(taskKey(t))) continue;
    for (const m of team) {
      if (isLeadRole(m.role) || !ownsTask(t, m)) continue;
      newlyDone.set(m.id, t.text);
      if (useAttention.getState().sessions[m.id]?.state === "done") void requestReview(m.id);
    }
  }
}

function reviewProposal(dk: string, dir: string, leads: readonly Member[], rk: string, text: string, mode: ControlMode, now: number): Proposal {
  const live = leads.find((l) => isLive(useApp.getState().runtime[l.id])) ?? leads[0];
  const queued = mode === "autopilot";
  return {
    key: `${dk}|r|${rk}`,
    dirKey: dk,
    dir,
    source: "review",
    file: null,
    modifiedMs: 0,
    from: "auto-review",
    lead: live.name,
    to: ["lead"],
    targets: leads.map((l) => l.id),
    targetLabel: leads.length === 1 ? leads[0].name : `first running lead (${leads.map((l) => l.name).join(", ")})`,
    action: "review",
    text,
    edited: false,
    warnings: [],
    status: queued ? "queued" : "proposal",
    reason: null,
    createdAt: now,
    queuedAt: queued ? now : null,
    delivered: [],
    busy: false,
  };
}

/**
 * A non-lead session finished (attention "done"): when its branch has commits ahead or it owns a task that
 * just turned [x], ask the lead to review it. Once per session + HEAD commit (or + task).
 */
export async function requestReview(id: SessionId): Promise<void> {
  const dk = dirOfSession(id);
  const h = dk ? holds.get(dk) : undefined;
  if (!dk || !h) return;
  const pol = policyOf(h.dir);
  if (pol.mode === "off" || !pol.autoReview) return;
  const team = teamFor(dk);
  const me = team.find((m) => m.id === id);
  if (!me || isLeadRole(me.role)) return;
  const leads = team.filter((m) => isLeadRole(m.role));
  const path = evidencePath(me.meta);
  if (leads.length === 0 || !path) return;
  const sum = (await refreshBranchSummary(path)).summary;
  if (holds.get(dk) !== h) return;
  const committed = !!sum?.isRepo && sum.ahead > 0;
  const doneTask = newlyDone.get(id) ?? null;
  if (!committed && !doneTask) return;
  const rk = committed && sum ? `${id}|c|${sum.branch ?? ""}|${sum.ahead}|${sum.lastCommitMs ?? ""}|${sum.lastCommitSubject ?? ""}` : `${id}|t|${doneTask}`;
  if (reviewed.has(rk)) return;
  reviewed.add(rk);
  newlyDone.delete(id);
  const doc = useMissionDocs.getState().byDir[h.dir]?.doc;
  const lastDone = doc?.tasks.filter((t) => t.state === "done" && ownsTask(t, me)).pop();
  const task = doneTask ?? lastDone?.text ?? (doc ? (currentTaskFor(doc.tasks, me)?.text ?? null) : null);
  const text = autoReviewText({
    name: me.name,
    slug: me.slug,
    task,
    branch: sum?.branch ?? null,
    base: sum?.base ?? null,
    ahead: committed && sum ? sum.ahead : 0,
    files: committed && sum ? sum.filesChanged : 0,
    path,
  });
  const mode = effectiveMode(policyOf(h.dir));
  if (mode === "off" || !policyOf(h.dir).autoReview) return;
  upsertProposal(reviewProposal(dk, h.dir, leads, rk, text, mode, Date.now()));
  void pump();
}

// ---- team.md ------------------------------------------------------------------------------------------

function scheduleTeam(k: string) {
  if (!holds.has(k) || teamTimers.has(k)) return;
  teamTimers.set(
    k,
    setTimeout(() => {
      teamTimers.delete(k);
      void writeTeam(k);
    }, TEAM_DEBOUNCE_MS),
  );
}

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

async function outputOf(id: SessionId): Promise<string[] | null> {
  try {
    const lines = tailLines(await ipc.sessionOutputTail(id, TAIL_BYTES), OUTPUT_LINES, 300)
      .map((l) => stripControl(l).replace(/\s+$/, ""))
      .filter((l) => l.trim());
    return lines.length ? lines : null;
  } catch {
    return null;
  }
}

/** The team.md snapshot of a controlled folder (reads output tails when the user shares them). */
export async function teamSnapshot(k: string): Promise<TeamMdSnapshot | null> {
  const h = holds.get(k);
  if (!h) return null;
  const pol = policyOf(h.dir);
  const s = useApp.getState();
  const attn = useAttention.getState().sessions;
  const doc = useMissionDocs.getState().byDir[h.dir]?.doc ?? null;
  const tasks = doc?.tasks ?? [];
  const members: TeamMdMember[] = await Promise.all(
    teamFor(k, s).map(async (m) => {
      const sum = cachedBranchSummary(evidencePath(m.meta));
      return {
        slug: m.slug,
        name: m.name,
        role: m.role,
        agent: m.agent,
        state: memberState(isLive(s.runtime[m.id]), attn[m.id]?.state),
        task: currentTaskFor(tasks, m)?.text ?? null,
        branch: sum?.isRepo
          ? { name: sum.branch, ahead: sum.ahead, files: sum.filesChanged, insertions: sum.insertions, deletions: sum.deletions, uncommitted: sum.uncommitted }
          : null,
        output: pol.shareOutput && s.runtime[m.id] ? await outputOf(m.id) : null,
      };
    }),
  );
  return {
    gridkeeperDir: gridkeeperDir(h.dir),
    goal: doc?.goal ?? null,
    progress: doc ? progress(tasks) : null,
    mode: pol.mode === "autopilot" ? "autopilot" : "advisor",
    paused: pol.paused,
    members,
  };
}

/** Regenerate team.md now (skipped when nothing but the time stamp would change). */
export async function writeTeam(k: string): Promise<void> {
  const h = holds.get(k);
  if (!h || policyOf(h.dir).mode === "off") return;
  const snap = await teamSnapshot(k);
  if (!snap || holds.get(k) !== h || policyOf(h.dir).mode === "off") return;
  const body = renderTeamMd(snap);
  if (lastTeamBody.get(k) === body) return;
  try {
    await ipc.missionTeamWrite(h.dir, renderTeamMd({ ...snap, updatedAt: stamp(new Date()) }));
    lastTeamBody.set(k, body);
    teamErrorLogged.delete(k);
  } catch (e) {
    if (!teamErrorLogged.has(k)) {
      teamErrorLogged.add(k);
      ipc.log("warn", `lead control: could not write team.md: ${errorMessage(e)}`);
    }
  }
}

// ---- install ------------------------------------------------------------------------------------------

/** Wire the controller to the stores (call once at app level). Returns a full cleanup. */
export function installLeadControl(): () => void {
  if (uninstall) return () => {};
  let prevWs = useApp.getState().persisted.workspaces;
  let prevSessions = useApp.getState().persisted.sessions;
  let prevRuntime = useApp.getState().runtime;
  const unsubApp = useApp.subscribe((s) => {
    const structure = s.persisted.workspaces !== prevWs || s.persisted.sessions !== prevSessions;
    const runtime = s.runtime !== prevRuntime;
    if (!structure && !runtime) return;
    const before = prevRuntime;
    prevWs = s.persisted.workspaces;
    prevSessions = s.persisted.sessions;
    prevRuntime = s.runtime;
    if (structure) {
      syncActive();
      for (const k of holds.keys()) scheduleTeam(k);
    }
    if (!runtime || holds.size === 0) return;
    let touched = false;
    const touch = (id: SessionId) => {
      const k = dirOfSession(id, s);
      if (!k) return;
      scheduleTeam(k);
      touched = true;
    };
    for (const id in s.runtime) if (s.runtime[id]?.state.state !== before[id]?.state.state) touch(id);
    for (const id in before) if (!s.runtime[id]) touch(id);
    if (touched) void pump();
  });

  let prevAttn = useAttention.getState().sessions;
  const unsubAttn = useAttention.subscribe((s) => {
    if (s.sessions === prevAttn) return;
    const before = prevAttn;
    prevAttn = s.sessions;
    if (holds.size === 0) return;
    let touched = false;
    for (const id in s.sessions) {
      const next = s.sessions[id];
      if (next === before[id] || next.state === before[id]?.state) continue;
      const k = dirOfSession(id);
      if (!k) continue;
      touched = true;
      scheduleTeam(k);
      if (next.state === "done" || next.state === "waiting") {
        const path = evidencePath(useApp.getState().persisted.sessions.find((m) => m.id === id));
        if (path) scheduleBranchSummary(path);
      }
      if (next.state === "done" && !isLeadId(id)) void requestReview(id);
    }
    if (touched) void pump(); // a transition is the retry signal for held items
  });

  let prevPolicies = useLeadControl.getState().policies;
  const unsubPolicies = useLeadControl.subscribe((s) => {
    if (s.policies === prevPolicies) return;
    const before = prevPolicies;
    prevPolicies = s.policies;
    syncActive();
    for (const k of holds.keys()) {
      const a = before[k] ?? DEFAULT_POLICY;
      const b = s.policies[k] ?? DEFAULT_POLICY;
      if (effectiveMode(a) !== effectiveMode(b)) onModeChange(k, effectiveMode(b));
      if (a.mode !== b.mode || a.paused !== b.paused || a.shareOutput !== b.shareOutput) scheduleTeam(k);
    }
  });

  let prevDocs = useMissionDocs.getState().byDir;
  const unsubDocs = useMissionDocs.subscribe((s) => {
    if (s.byDir === prevDocs) return;
    const before = prevDocs;
    prevDocs = s.byDir;
    for (const [k, h] of holds) {
      const e = s.byDir[h.dir];
      if (e === before[h.dir]) continue;
      if (e?.doc && e.doc !== before[h.dir]?.doc) onMissionDoc(k, e.doc);
      scheduleTeam(k);
    }
  });

  const unsubBranches = useBranchSummaries.subscribe(() => {
    for (const k of holds.keys()) scheduleTeam(k);
  });

  syncActive();

  const off = () => {
    unsubApp();
    unsubAttn();
    unsubPolicies();
    unsubDocs();
    unsubBranches();
    for (const k of [...holds.keys()]) deactivate(k);
    dropListener();
    clearTimeout(tickTimer);
    tickTimer = undefined;
    uninstall = null;
  };
  uninstall = off;
  return off;
}

/** Test hook: uninstall and forget everything. */
export function resetLeadControlForTests(): void {
  uninstall?.();
  for (const t of teamTimers.values()) clearTimeout(t);
  teamTimers.clear();
  lastTeamBody.clear();
  teamErrorLogged.clear();
  history = [];
  reviewed.clear();
  doneTasks.clear();
  newlyDone.clear();
  archived.clear();
  scanning.clear();
  rescan.clear();
  pumping = false;
  pumpAgain = false;
  clearTimeout(tickTimer);
  tickTimer = undefined;
  holds.clear();
  unlisten = null;
}
