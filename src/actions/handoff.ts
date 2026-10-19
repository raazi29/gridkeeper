// Sign-off evidence and hand-off (Mission Control).
//
// Branch summaries: read-only `git_branch_summary` per worktree, cached per path with in-flight dedupe.
// Fetched when a sign-off card appears and again (debounced) when its session turns done / waiting —
// never on a timer.
//
// Hand-off: pick another live session; a dialog shows an editable one-line message. Nothing is typed
// into any agent until the user presses Send, and Send refuses when the target is asking something
// (attention "waiting" or a prompt-shaped tail), because the Enter would answer its prompt.

import { create } from "zustand";
import type { MenuAction } from "../components/ui/Menu";
import { buildHandoffText, orderHandoffTargets, type HandoffCandidate } from "../components/mission/signoffModel";
import { errorMessage, ipc } from "../lib/ipc";
import { isTerminalMeta } from "../lib/browserPanes";
import type { BranchSummary, SessionId, SessionMeta } from "../lib/types";
import { isLive, selectActiveWorkspace, useApp } from "../store/appStore";
import { recordActivity, sessionLabelOf } from "../store/activity";
import { hookWaitReason, useAttention } from "../store/attention";
import { looksLikeQuestion } from "./starterPrompt";

const ENTER_DELAY_MS = 80;
/** Coalesces attention flicker (waiting <-> done) into one git call per path. */
export const SUMMARY_DEBOUNCE_MS = 900;

// ---- branch summaries -----------------------------------------------------------------------

export interface SummaryEntry {
  summary: BranchSummary | null;
  error: string | null;
  /** ms epoch of the fetch. */
  at: number;
}

interface SummaryStore {
  byPath: Record<string, SummaryEntry>;
}

export const useBranchSummaries = create<SummaryStore>()(() => ({ byPath: {} }));

/** Cache key of a folder (Windows paths: case-insensitive, either slash, no trailing slash). */
export function pathKey(p: string): string {
  return p.trim().replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}

/** The folder whose git state is a session's evidence: its worktree, else its working folder. */
export function evidencePath(meta: Pick<SessionMeta, "cwd" | "worktree"> | undefined): string | null {
  const p = (meta?.worktree?.path ?? meta?.cwd ?? "").trim();
  return p || null;
}

const inflight = new Map<string, Promise<SummaryEntry>>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

/** Fetch (or join the in-flight fetch of) a folder's branch summary and cache it. */
export function refreshBranchSummary(path: string): Promise<SummaryEntry> {
  const key = pathKey(path);
  const running = inflight.get(key);
  if (running) return running;
  const p = ipc
    .gitBranchSummary(path, null)
    .then((summary): SummaryEntry => ({ summary, error: null, at: Date.now() }))
    .catch((e): SummaryEntry => ({ summary: null, error: errorMessage(e), at: Date.now() }))
    .then((entry) => {
      useBranchSummaries.setState((s) => ({ byPath: { ...s.byPath, [key]: entry } }));
      return entry;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** Debounced refresh (attention transitions). */
export function scheduleBranchSummary(path: string, delay = SUMMARY_DEBOUNCE_MS): void {
  const key = pathKey(path);
  clearTimeout(timers.get(key));
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key);
      void refreshBranchSummary(path);
    }, delay),
  );
}

export function cachedBranchSummary(path: string | null): BranchSummary | null {
  return path ? (useBranchSummaries.getState().byPath[pathKey(path)]?.summary ?? null) : null;
}

/** Test helper. */
export function resetBranchSummaries(): void {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  inflight.clear();
  useBranchSummaries.setState({ byPath: {} });
}

// ---- hand-off targets -------------------------------------------------------------------------

type AppState = ReturnType<typeof useApp.getState>;

/** Sessions of the workspace that holds `fromId` (else the active one), in layout order. */
function workspaceCandidates(fromId: SessionId, s: AppState): HandoffCandidate[] {
  const ws = s.persisted.workspaces.find((w) => w.groups.some((g) => g.sessionIds.includes(fromId))) ?? selectActiveWorkspace(s);
  if (!ws) return [];
  const metas = new Map(s.persisted.sessions.map((m) => [m.id, m]));
  const out: HandoffCandidate[] = [];
  for (const g of ws.groups)
    for (const id of g.sessionIds) {
      const m = metas.get(id);
      if (!m) continue;
      out.push({ id, name: m.name, role: m.role ?? null, live: isLive(s.runtime[id]), terminal: isTerminalMeta(m) });
    }
  return out;
}

/** Who can take over `fromId`'s work: reviewers / verifiers, then the lead, then others (live only). */
export function handoffTargets(fromId: SessionId, s: AppState = useApp.getState()): HandoffCandidate[] {
  return orderHandoffTargets(fromId, workspaceCandidates(fromId, s));
}

/** Number of possible hand-off targets (a primitive: safe as a zustand selector result). */
export function handoffTargetCount(fromId: SessionId, s: AppState): number {
  return handoffTargets(fromId, s).length;
}

/** Menu entries "hand off to …" (empty when nobody else is running). Picking one opens the dialog. */
export function handoffMenuItems(fromId: SessionId, before?: () => void): MenuAction[] {
  return handoffTargets(fromId).map((t) => ({
    label: t.name,
    hint: t.role ?? undefined,
    onSelect: () => {
      before?.();
      void openHandoff(fromId, t.id);
    },
  }));
}

/** "Hand off…" submenu for the session context menu (Mission Control surface). */
export function handoffSubmenu(fromId: SessionId): MenuAction {
  return { label: "Hand off…", children: handoffMenuItems(fromId) };
}

// ---- dialog request -----------------------------------------------------------------------------

export interface HandoffRequest {
  fromId: SessionId;
  targetId: SessionId;
  fromName: string;
  targetName: string;
  targetRole: string | null;
  text: string;
}

interface HandoffUi {
  request: HandoffRequest | null;
}

export const useHandoff = create<HandoffUi>()(() => ({ request: null }));

export function closeHandoff(): void {
  useHandoff.setState({ request: null });
}

/** Open the hand-off dialog (prefilled from the branch summary). Sends nothing. */
export async function openHandoff(fromId: SessionId, targetId: SessionId): Promise<void> {
  const metas = useApp.getState().persisted.sessions;
  const from = metas.find((m) => m.id === fromId);
  const target = metas.find((m) => m.id === targetId);
  if (!from || !target) return;
  const path = evidencePath(from);
  let summary = cachedBranchSummary(path);
  if (path && !summary) summary = (await refreshBranchSummary(path)).summary;
  useHandoff.setState({
    request: {
      fromId,
      targetId,
      fromName: from.name,
      targetName: target.name,
      targetRole: target.role ?? null,
      text: buildHandoffText({ fromName: from.name, path: path ?? from.cwd, summary }),
    },
  });
}

// ---- send -----------------------------------------------------------------------------------------

export type HandoffResult = { ok: true } | { ok: false; reason: string };

/** Why a line must not be typed into `targetId` right now (null = safe). Reads the output tail. */
export async function handoffBlocker(targetId: SessionId): Promise<string | null> {
  const s = useApp.getState();
  const name = s.persisted.sessions.find((m) => m.id === targetId)?.name ?? "The session";
  if (!isLive(s.runtime[targetId])) return `${name} is not running.`;
  // Exact, from Claude Code hooks: a permission / question prompt is up. Typing would answer it.
  const prompt = hookWaitReason(useAttention.getState().sessions[targetId]);
  if (prompt) return `${name} ${prompt}. Sending would type into that prompt; answer it in its pane first.`;
  if (useAttention.getState().sessions[targetId]?.state === "waiting")
    return `${name} is waiting for an answer. Sending would press Enter on its prompt; answer it in its pane first.`;
  let tail = "";
  try {
    tail = await ipc.sessionOutputTail(targetId, 4096);
  } catch {
    /* no buffer yet */
  }
  if (looksLikeQuestion(tail)) return `${name} looks like it is asking something (its last lines read like a prompt). Sending would press Enter on it; answer it in its pane first.`;
  return null;
}

/** Type the hand-off into the target and press Enter. Only called from the dialog's Send button. */
export async function sendHandoff(fromId: SessionId, targetId: SessionId, text: string): Promise<HandoffResult> {
  const line = text.replace(/[\r\n]+/g, " ").trim();
  if (!line) return { ok: false, reason: "The message is empty." };
  const blocker = await handoffBlocker(targetId);
  if (blocker) return { ok: false, reason: blocker };
  const to = sessionLabelOf(targetId);
  const from = sessionLabelOf(fromId);
  const preview = line.length > 80 ? `${line.slice(0, 79)}…` : line;
  try {
    await ipc.sessionWrite(targetId, line);
    await new Promise((r) => setTimeout(r, ENTER_DELAY_MS));
    await ipc.sessionWrite(targetId, "\r");
  } catch (e) {
    const reason = errorMessage(e);
    recordActivity({ sessionId: targetId, sessionName: to.name, role: to.role, agent: to.agent, kind: "broadcast", level: "error", message: `hand-off from ${from.name} failed: ${reason}`, result: "failed" });
    return { ok: false, reason };
  }
  recordActivity({ sessionId: fromId, sessionName: from.name, role: from.role, agent: from.agent, kind: "broadcast", level: "info", message: `handed off to ${to.name}`, result: "handoff" });
  recordActivity({ sessionId: targetId, sessionName: to.name, role: to.role, agent: to.agent, kind: "broadcast", level: "info", message: `hand-off from ${from.name}: ${preview}`, result: "sent" });
  return { ok: true };
}
