// Test runs (evidence, not the agent's word). Runs live in Rust (src-tauri/src/testrun.rs: contained
// background processes, queue, 2 MiB ring, timeout); this store mirrors their infos from `test-run`
// events plus one snapshot when first used, keyed by run id and by folder (pathKey of the cwd).
//
// Starting a run: the command is the lane's override, else the workspace's, else the one detected in
// the folder (`test_detect`); with none, the test-command dialog opens instead. Finished runs go to the
// activity log; failures also raise a toast with a "Log" action. Nothing is ever typed into an agent
// from here — "ask the agent to fix" opens a dialog the user confirms.

import { create } from "zustand";
import { notify } from "../actions/notify";
import { evidencePath, handoffBlocker, pathKey } from "../actions/handoff";
import { isTerminalMeta } from "../lib/browserPanes";
import { errorMessage, ipc, onTestRun } from "../lib/ipc";
import type { SessionId, TestRunInfo } from "../lib/types";
import { badgeText, failureMessage, isActiveStatus, resolveTestCommand, resultText } from "../components/testrun/format";
import { recordActivity, sessionLabelOf } from "./activity";
import { useApp } from "./appStore";
import { actionToast } from "./uiStore";

/** Runs kept in the store (the newest per folder always stays). */
export const MAX_RUNS = 100;

export interface CommandDialogState {
  workspaceId: string;
  /** Lane whose override is edited too (null = workspace only). */
  groupId: string | null;
  /** Folder to detect in (else the project folder / the first session's folder). */
  detectDir: string | null;
  /** Why the dialog opened (e.g. "No test command found in …"). */
  reason: string | null;
  /** Run after saving (the run that was waiting for a command). */
  then: (() => void) | null;
}

export interface AskAgentRequest {
  sessionId: SessionId;
  title: string;
  text: string;
  /** Activity kind / wording of what was sent. */
  kind: "tests" | "merge";
}

export interface TestRunState {
  runs: Record<string, TestRunInfo>;
  /** pathKey(cwd) → id of the newest run in that folder. */
  latestByPath: Record<string, string>;
  /** Run whose log viewer is open. */
  viewer: string | null;
  commandDialog: CommandDialogState | null;
  ask: AskAgentRequest | null;
}

export const useTestRuns = create<TestRunState>()(() => ({ runs: {}, latestByPath: {}, viewer: null, commandDialog: null, ask: null }));

// ---- pure reducer ----------------------------------------------------------------------------------

/** Merge one run into the maps (newest run per folder by queue time; at most MAX_RUNS kept). */
export function applyRun(s: Pick<TestRunState, "runs" | "latestByPath">, info: TestRunInfo): Pick<TestRunState, "runs" | "latestByPath"> {
  const runs = { ...s.runs, [info.id]: info };
  const key = pathKey(info.cwd);
  const cur = s.latestByPath[key] ? runs[s.latestByPath[key]] : undefined;
  const latestByPath = !cur || cur.id === info.id || cur.queuedMs <= info.queuedMs ? { ...s.latestByPath, [key]: info.id } : s.latestByPath;
  const ids = Object.keys(runs);
  if (ids.length > MAX_RUNS) {
    const keep = new Set(Object.values(latestByPath));
    const old = ids
      .filter((id) => !keep.has(id) && !isActiveStatus(runs[id].status))
      .sort((a, b) => runs[a].queuedMs - runs[b].queuedMs)
      .slice(0, ids.length - MAX_RUNS);
    for (const id of old) delete runs[id];
  }
  return { runs, latestByPath };
}

/** The newest run in a folder (or undefined). */
export function latestRunFor(s: Pick<TestRunState, "runs" | "latestByPath">, path: string | null | undefined): TestRunInfo | undefined {
  if (!path) return undefined;
  const id = s.latestByPath[pathKey(path)];
  return id ? s.runs[id] : undefined;
}

// ---- events ------------------------------------------------------------------------------------------

let installed: Promise<void> | null = null;
const reported = new Set<string>();

function onFinished(info: TestRunInfo) {
  if (reported.has(info.id)) return;
  reported.add(info.id);
  const who = info.sessionId ? sessionLabelOf(info.sessionId) : { name: info.label, role: null, agent: null };
  const ok = info.status === "passed";
  recordActivity({
    sessionId: info.sessionId,
    sessionName: who.name || info.label,
    role: who.role,
    agent: who.agent,
    kind: "tests",
    level: ok ? "ok" : info.status === "cancelled" ? "info" : "error",
    message: `${badgeText(info, Date.now())} — ${info.command}`,
    result: resultText(info),
  });
  if (!ok && info.status !== "cancelled") {
    actionToast({ kind: "warn", message: `${info.label}: ${badgeText(info, Date.now())}`, detail: info.error ?? info.failures[0] ?? undefined, action: { label: "Log", run: () => openTestLog(info.id) } });
  }
}

function receive(info: TestRunInfo) {
  useTestRuns.setState((s) => applyRun(s, info));
  if (!isActiveStatus(info.status)) onFinished(info);
}

/** Subscribe to `test-run` events and load the current runs (once per app run; safe to call often). */
export function ensureTestRuns(): Promise<void> {
  installed ??= (async () => {
    try {
      await onTestRun(receive);
      const list = await ipc.testRunList();
      // Runs that finished before this view existed are not reported again.
      for (const r of list) if (!isActiveStatus(r.status)) reported.add(r.id);
      useTestRuns.setState((s) => list.reduce((acc, r) => ({ ...acc, ...applyRun(acc, r) }), s));
    } catch (e) {
      installed = null;
      ipc.log("warn", `test runs unavailable: ${errorMessage(e)}`);
    }
  })();
  return installed;
}

/** Test helper. */
export function resetTestRuns(): void {
  installed = null;
  reported.clear();
  useTestRuns.setState({ runs: {}, latestByPath: {}, viewer: null, commandDialog: null, ask: null });
}

// ---- starting runs -----------------------------------------------------------------------------------

type AppState = ReturnType<typeof useApp.getState>;

/** Workspace / lane that hold a session (or a group id). */
function locate(s: AppState, sessionId: SessionId | null, groupId: string | null) {
  for (const w of s.persisted.workspaces)
    for (const g of w.groups) if ((groupId && g.id === groupId) || (sessionId && g.sessionIds.includes(sessionId))) return { workspace: w, group: g };
  return undefined;
}

export interface RunTarget {
  path: string;
  label: string;
  sessionId: SessionId | null;
  workspaceId: string | null;
  groupId: string | null;
}

/** Resolve the command for a target (lane > workspace > detected). Null = none anywhere. */
export async function commandFor(t: RunTarget): Promise<{ command: string; source: string } | null> {
  const s = useApp.getState();
  const ws = s.persisted.workspaces.find((w) => w.id === t.workspaceId);
  const g = ws?.groups.find((x) => x.id === t.groupId);
  const configured = resolveTestCommand(g?.testCommand, ws?.testCommand, null);
  if (configured) return configured;
  try {
    const det = await ipc.testDetect(t.path);
    return resolveTestCommand(null, null, det.command);
  } catch {
    return null;
  }
}

/** Start (or join) a run for a folder. Opens the command dialog when no command applies. */
export async function runTestsAt(t: RunTarget): Promise<TestRunInfo | null> {
  await ensureTestRuns();
  const cmd = await commandFor(t);
  if (!cmd) {
    if (t.workspaceId)
      openTestCommandDialog({ workspaceId: t.workspaceId, groupId: t.groupId, detectDir: t.path, reason: `No test command found in ${t.path}. Set one for the workspace (or this lane).`, then: () => void runTestsAt(t) });
    else notify("warn", `No test command found in ${t.path}`);
    return null;
  }
  try {
    const info = await ipc.testRunStart({ cwd: t.path, command: cmd.command, label: t.label, sessionId: t.sessionId, timeoutSec: null });
    receive(info);
    return info;
  } catch (e) {
    notify("error", `Could not start the tests: ${errorMessage(e)}`);
    return null;
  }
}

/** The run target of a session: its worktree (else its working folder). Null for browser panes. */
export function sessionTarget(id: SessionId, s: AppState = useApp.getState()): RunTarget | null {
  const meta = s.persisted.sessions.find((m) => m.id === id);
  if (!meta || !isTerminalMeta(meta)) return null;
  const path = evidencePath(meta);
  if (!path) return null;
  const loc = locate(s, id, null);
  return { path, label: meta.name, sessionId: id, workspaceId: loc?.workspace.id ?? null, groupId: loc?.group.id ?? null };
}

export function runTestsForSession(id: SessionId): Promise<TestRunInfo | null> {
  const t = sessionTarget(id);
  if (!t) {
    notify("warn", "This pane has no folder to test");
    return Promise.resolve(null);
  }
  return runTestsAt(t);
}

/** One target per distinct folder of the lane's terminal sessions (first session names it). */
export function laneTargets(groupId: string, s: AppState = useApp.getState()): RunTarget[] {
  const loc = locate(s, null, groupId);
  if (!loc) return [];
  const seen = new Set<string>();
  const out: RunTarget[] = [];
  for (const id of loc.group.sessionIds) {
    const t = sessionTarget(id, s);
    if (!t || seen.has(pathKey(t.path))) continue;
    seen.add(pathKey(t.path));
    out.push(t);
  }
  return out;
}

/** "Test lane": each member's worktree (distinct folders); the Rust queue applies the concurrency cap. */
export async function runTestsForLane(groupId: string): Promise<void> {
  const targets = laneTargets(groupId);
  const name = locate(useApp.getState(), null, groupId)?.group.name ?? "lane";
  if (!targets.length) {
    notify("warn", `“${name}” has no session folders to test`);
    return;
  }
  notify("info", `Testing ${targets.length} folder${targets.length === 1 ? "" : "s"} of “${name}”`);
  for (const t of targets) {
    const started = await runTestsAt(t);
    if (!started) break; // no command: the dialog is open (it re-runs this target after saving)
  }
}

export async function cancelTestRun(id: string): Promise<void> {
  try {
    await ipc.testRunCancel(id);
  } catch (e) {
    notify("error", `Could not cancel: ${errorMessage(e)}`);
  }
}

// ---- dialogs -------------------------------------------------------------------------------------------

export function openTestLog(id: string): void {
  useTestRuns.setState({ viewer: id });
}

export function closeTestLog(): void {
  useTestRuns.setState({ viewer: null });
}

export function openTestCommandDialog(d: Partial<CommandDialogState> & { workspaceId: string }): void {
  useTestRuns.setState({ commandDialog: { groupId: null, detectDir: null, reason: null, then: null, ...d } });
}

/** Command dialog for the workspace (and lane) that holds a group. */
export function openLaneCommandDialog(groupId: string): void {
  const loc = findGroupOfGroup(groupId);
  if (loc) openTestCommandDialog({ workspaceId: loc.workspaceId, groupId });
}

function findGroupOfGroup(groupId: string): { workspaceId: string } | null {
  const w = useApp.getState().persisted.workspaces.find((x) => x.groups.some((g) => g.id === groupId));
  return w ? { workspaceId: w.id } : null;
}

export function closeTestCommandDialog(): void {
  useTestRuns.setState({ commandDialog: null });
}

/** Save the workspace command and (optionally) a lane override. Empty = auto-detect / no override. */
export function saveTestCommands(workspaceId: string, workspaceCommand: string, groupId: string | null, laneCommand: string): void {
  const ws = workspaceCommand.trim() || null;
  const lane = laneCommand.trim() || null;
  useApp.setState((s) => ({
    persisted: {
      ...s.persisted,
      workspaces: s.persisted.workspaces.map((w) =>
        w.id !== workspaceId ? w : { ...w, testCommand: ws, groups: groupId ? w.groups.map((g) => (g.id === groupId ? { ...g, testCommand: lane } : g)) : w.groups },
      ),
    },
  }));
}

/** "Ask the agent to fix…" for a failed run: a dialog with an editable line (sent only on confirm). */
export function askAgentToFix(runId: string): void {
  const r = useTestRuns.getState().runs[runId];
  if (!r?.sessionId) return;
  useTestRuns.setState({ ask: { sessionId: r.sessionId, title: `Ask ${r.label} to fix the tests`, text: failureMessage(r), kind: "tests" } });
}

export function openAskAgent(req: AskAgentRequest): void {
  useTestRuns.setState({ ask: req });
}

export function closeAskAgent(): void {
  useTestRuns.setState({ ask: null });
}

const ENTER_DELAY_MS = 80;

/** Type the confirmed line into the session and press Enter (same checks as a hand-off). Only called
 *  from the dialog's Send button. */
export async function sendToAgent(req: AskAgentRequest, text: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const line = text.replace(/[\r\n]+/g, " ").trim();
  if (!line) return { ok: false, reason: "The message is empty." };
  const blocker = await handoffBlocker(req.sessionId);
  if (blocker) return { ok: false, reason: blocker };
  const who = sessionLabelOf(req.sessionId);
  try {
    await ipc.sessionWrite(req.sessionId, line);
    await new Promise((r) => setTimeout(r, ENTER_DELAY_MS));
    await ipc.sessionWrite(req.sessionId, "\r");
  } catch (e) {
    const reason = errorMessage(e);
    recordActivity({ sessionId: req.sessionId, sessionName: who.name, role: who.role, agent: who.agent, kind: req.kind, level: "error", message: `message not sent: ${reason}`, result: "failed" });
    return { ok: false, reason };
  }
  const preview = line.length > 80 ? `${line.slice(0, 79)}…` : line;
  recordActivity({ sessionId: req.sessionId, sessionName: who.name, role: who.role, agent: who.agent, kind: req.kind, level: "info", message: `${req.kind === "merge" ? "asked to resolve merge conflicts" : "asked to fix the tests"}: ${preview}`, result: "sent" });
  return { ok: true };
}
