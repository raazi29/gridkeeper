// Pure state of the merge dialog: default strategy and message, the test gate, why "Merge" is
// disabled, the request sent to Rust, and the conflict hand-off line. (Rust re-checks every guard.)

import { ownsTask, type Task } from "../../lib/missionDoc";
import type { MergeConflict, MergePreview, MergeRequest, MergeStrategy, TestRunInfo } from "../../lib/types";

export const MESSAGE_MAX = 500;

export function defaultStrategy(p: MergePreview | null): MergeStrategy {
  return p?.canFastForward ? "fastForward" : "mergeCommit";
}

export interface StrategyOption {
  value: MergeStrategy;
  label: string;
  hint: string;
  disabled: boolean;
}

export function strategyOptions(p: MergePreview | null): StrategyOption[] {
  const base = p?.base ?? "base";
  const ff = !!p?.canFastForward;
  return [
    { value: "fastForward", label: "Fast-forward", hint: ff ? `move ${base} to the branch tip; no new commit` : `not possible: ${base} has commits the branch lacks`, disabled: !ff },
    { value: "mergeCommit", label: "Merge commit", hint: "one merge commit; the branch's commits stay as they are", disabled: false },
    { value: "squash", label: "Squash", hint: "one new commit with all the changes; the branch stays unmerged in history", disabled: false },
  ];
}

/** The member's task on the mission board: doing, else todo, else the last done one. */
export function taskForMember(tasks: readonly Task[], m: { name: string; role: string | null }): Task | null {
  const owned = tasks.filter((t) => ownsTask(t, m));
  return owned.find((t) => t.state === "doing") ?? owned.find((t) => t.state === "todo") ?? owned.filter((t) => t.state === "done").pop() ?? null;
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** "Merge <branch>: <mission task or last subject>" (one line, at most MESSAGE_MAX). */
export function defaultMessage(branch: string | null, task: string | null | undefined, lastSubject: string | null | undefined): string {
  const what = oneLine(task ?? "") || oneLine(lastSubject ?? "");
  const msg = what ? `Merge ${branch ?? "branch"}: ${what}` : `Merge ${branch ?? "branch"}`;
  return msg.length > MESSAGE_MAX ? `${msg.slice(0, MESSAGE_MAX - 1)}…` : msg;
}

export type TestGate =
  | { state: "off" }
  | { state: "noCommand" }
  | { state: "missing" }
  | { state: "running"; run: TestRunInfo }
  | { state: "failed"; run: TestRunInfo }
  | { state: "stale"; run: TestRunInfo; reason: string }
  | { state: "ok"; run: TestRunInfo };

const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 10) : "?");

/** Does the newest run in the worktree prove the branch tip is green? (Rust checks the same.) */
export function testGate(p: MergePreview | null, run: TestRunInfo | undefined | null, required: boolean, hasCommand: boolean): TestGate {
  if (!required) return { state: "off" };
  if (!run) return hasCommand ? { state: "missing" } : { state: "noCommand" };
  if (run.status === "queued" || run.status === "running") return { state: "running", run };
  if (run.status !== "passed") return { state: "failed", run };
  if (!run.headSha || run.headSha !== p?.branchSha)
    return { state: "stale", run, reason: run.headSha ? `ran on ${short(run.headSha)}, the branch is at ${short(p?.branchSha)}` : "the branch changed while the tests ran" };
  if (run.uncommitted !== 0)
    return { state: "stale", run, reason: `the worktree had ${run.uncommitted ?? "unknown"} uncommitted or untracked file${run.uncommitted === 1 ? "" : "s"}, so the tests did not run on exactly the commit` };
  return { state: "ok", run };
}

export function gateText(g: TestGate): string {
  switch (g.state) {
    case "off":
      return "not required";
    case "noCommand":
      return "no test command (set one, or untick)";
    case "missing":
      return "not run yet on this commit";
    case "running":
      return "running…";
    case "failed":
      return "the last run did not pass";
    case "stale":
      return g.reason;
    case "ok":
      return `passed on ${short(g.run.headSha)}`;
  }
}

export interface MergeFormState {
  preview: MergePreview | null;
  strategy: MergeStrategy;
  message: string;
  gate: TestGate;
  busy: boolean;
}

/** Why "Merge" is disabled (empty = enabled). */
export function mergeDisabledReasons(f: MergeFormState): string[] {
  const out: string[] = [];
  const p = f.preview;
  if (!p) return ["The preview is not loaded."];
  if (f.busy) out.push("A merge is running.");
  out.push(...p.blockers);
  if (!p.branch || !p.base || !p.branchSha || !p.baseSha || !p.mainPath) out.push("The preview is incomplete.");
  if (f.strategy === "fastForward" && !p.canFastForward) out.push("Fast-forward is not possible.");
  if (f.strategy !== "fastForward") {
    const m = f.message.trim();
    if (!m) out.push("The commit message is empty.");
    else if (m.length > MESSAGE_MAX) out.push(`The commit message is longer than ${MESSAGE_MAX} characters.`);
    // eslint-disable-next-line no-control-regex
    else if (/[\u0000-\u001f\u007f]/.test(m)) out.push("The commit message must be one line.");
  }
  if (f.gate.state !== "off" && f.gate.state !== "ok") out.push(`Tests: ${gateText(f.gate)}.`);
  return out;
}

/** The request for Rust (null while the preview is incomplete). */
export function buildRequest(p: MergePreview | null, strategy: MergeStrategy, message: string, requireTests: boolean): MergeRequest | null {
  if (!p?.branch || !p.base || !p.branchSha || !p.baseSha || !p.mainPath) return null;
  return {
    path: p.path,
    mainPath: p.mainPath,
    base: p.base,
    branch: p.branch,
    baseSha: p.baseSha,
    branchSha: p.branchSha,
    strategy,
    message: strategy === "fastForward" ? "" : message.trim(),
    requireTests,
  };
}

/** One line for the branch's agent listing the conflicting files (sent only after the user confirms). */
export function conflictMessage(branch: string, base: string, conflicts: readonly MergeConflict[]): string {
  const n = conflicts.length;
  const files = conflicts
    .slice(0, 12)
    .map((c) => (c.kind && c.kind !== "conflict" ? `${c.path} (${c.kind})` : c.path))
    .join(", ");
  const more = n > 12 ? ` and ${n - 12} more` : "";
  return `Merging ${branch} into ${base} would conflict in ${n} file${n === 1 ? "" : "s"}: ${files}${more}. Please merge ${base} into ${branch} in your worktree, resolve the conflicts, run the tests, commit, and tell me when it is done.`;
}

/** A live session still uses the worktree (its folder is inside it): clean-up must wait. */
export function liveUsersOf(root: string, sessions: readonly { name: string; path: string | null; live: boolean }[], key: (p: string) => string): string[] {
  const r = key(root);
  return sessions.filter((s) => s.live && s.path && (key(s.path) === r || key(s.path).startsWith(`${r}\\`))).map((s) => s.name);
}
