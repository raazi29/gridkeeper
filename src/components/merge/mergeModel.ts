// Pure state of the merge dialog: default strategy and message, the test gate, why "Merge" is
// disabled, the request sent to Rust, and the conflict hand-off line. (Rust re-checks every guard.)

import { t } from "../../i18n";
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
  const base = p?.base ?? t("merge.baseFallback");
  const ff = !!p?.canFastForward;
  return [
    { value: "fastForward", label: t("merge.strategyOption.fastForward"), hint: ff ? t("merge.strategyOption.fastForwardHint", { base }) : t("merge.strategyOption.fastForwardImpossible", { base }), disabled: !ff },
    { value: "mergeCommit", label: t("merge.strategyOption.mergeCommit"), hint: t("merge.strategyOption.mergeCommitHint"), disabled: false },
    { value: "squash", label: t("merge.strategyOption.squash"), hint: t("merge.strategyOption.squashHint"), disabled: false },
  ];
}

/** The member's task on the mission board: doing, else todo, else the last done one. */
export function taskForMember(tasks: readonly Task[], m: { name: string; role: string | null }): Task | null {
  const owned = tasks.filter((k) => ownsTask(k, m));
  return owned.find((k) => k.state === "doing") ?? owned.find((k) => k.state === "todo") ?? owned.filter((k) => k.state === "done").pop() ?? null;
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** "Merge <branch>: <mission task or last subject>" (one line, at most MESSAGE_MAX). */
// Commit message: stays English (written to the repository's history, like other files).
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
    return { state: "stale", run, reason: run.headSha ? t("merge.gate.ranOn", { sha: short(run.headSha), branchSha: short(p?.branchSha) }) : t("merge.gate.branchChanged") };
  if (run.uncommitted !== 0)
    return { state: "stale", run, reason: run.uncommitted == null ? t("merge.gate.dirtyUnknown") : t("merge.gate.dirty", { count: run.uncommitted }) };
  return { state: "ok", run };
}

export function gateText(g: TestGate): string {
  switch (g.state) {
    case "off":
      return t("merge.gate.off");
    case "noCommand":
      return t("merge.gate.noCommand");
    case "missing":
      return t("merge.gate.missing");
    case "running":
      return t("merge.gate.running");
    case "failed":
      return t("merge.gate.failed");
    case "stale":
      return g.reason;
    case "ok":
      return t("merge.gate.ok", { sha: short(g.run.headSha) });
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
  if (!p) return [t("merge.reason.notLoaded")];
  if (f.busy) out.push(t("merge.reason.busy"));
  out.push(...p.blockers);
  if (!p.branch || !p.base || !p.branchSha || !p.baseSha || !p.mainPath) out.push(t("merge.reason.incomplete"));
  if (f.strategy === "fastForward" && !p.canFastForward) out.push(t("merge.reason.noFastForward"));
  if (f.strategy !== "fastForward") {
    const m = f.message.trim();
    if (!m) out.push(t("merge.reason.emptyMessage"));
    else if (m.length > MESSAGE_MAX) out.push(t("merge.reason.longMessage", { max: MESSAGE_MAX }));
    // eslint-disable-next-line no-control-regex
    else if (/[\u0000-\u001f\u007f]/.test(m)) out.push(t("merge.reason.multiline"));
  }
  if (f.gate.state !== "off" && f.gate.state !== "ok") out.push(t("merge.reason.tests", { gate: gateText(f.gate) }));
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
// Agent-facing: stays English (typed into agents / written to files).
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
