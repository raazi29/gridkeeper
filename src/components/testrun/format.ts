// Pure formatting for test runs: badge text / tone / tooltip, counts, the "ask the agent to fix" line,
// and which test command applies (lane override > workspace > detected).

import { t, type MessageKey } from "../../i18n";
import type { TestCounts, TestRunInfo, TestRunStatus } from "../../lib/types";

export type BadgeTone = "ok" | "bad" | "busy" | "muted";

/** "850ms", "38s", "1m 12s", "1h 02m". */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

export function isActiveStatus(s: TestRunStatus): boolean {
  return s === "queued" || s === "running";
}

/** "407 passed · 3 failed · 2 skipped" (zero parts left out, except "0 passed" when nothing else). */
export function countsText(c: TestCounts | null | undefined): string {
  if (!c) return "";
  const pkg = c.unit === "packages";
  const parts: string[] = [];
  if (c.passed || (!c.failed && !c.skipped)) parts.push(t(pkg ? "testrun.counts.passedPackages" : "testrun.counts.passed", { count: c.passed }));
  if (c.failed) parts.push(t(pkg ? "testrun.counts.failedPackages" : "testrun.counts.failed", { count: c.failed }));
  if (c.skipped) parts.push(t("testrun.counts.skipped", { count: c.skipped }));
  return parts.join(" · ");
}

/** The short badge: `tests ✓ 412 · 38s`, `tests ✗ 3 failed`, `tests … 0:12`. */
export function badgeText(r: TestRunInfo, now: number): string {
  switch (r.status) {
    case "queued":
      return t("testrun.badge.queued");
    case "running":
      return t("testrun.badge.running", { duration: formatDuration(r.startedMs != null ? Math.max(0, now - r.startedMs) : 0) });
    case "passed": {
      const duration = formatDuration(r.durationMs);
      if (r.counts) return t(r.counts.unit === "packages" ? "testrun.badge.passedPackages" : "testrun.badge.passedTests", { count: r.counts.passed, duration });
      return t("testrun.badge.passed", { duration });
    }
    case "failed":
      if (r.counts && r.counts.failed > 0) return t("testrun.badge.failedCount", { count: r.counts.failed });
      return r.exitCode != null ? t("testrun.badge.failedExit", { code: r.exitCode }) : t("testrun.badge.failed");
    case "error":
      return t("testrun.badge.error");
    case "cancelled":
      return t("testrun.badge.cancelled");
    case "timedOut":
      return t("testrun.badge.timedOut");
  }
}

/** The badge in English, for the activity log (activity entries stay English, like store/activity.ts). */
export function badgeTextEn(r: TestRunInfo, now: number): string {
  switch (r.status) {
    case "queued":
      return "tests · queued";
    case "running":
      return `tests … ${formatDuration(r.startedMs != null ? Math.max(0, now - r.startedMs) : 0)}`;
    case "passed": {
      const dur = formatDuration(r.durationMs);
      if (r.counts) return `tests ✓ ${r.counts.passed}${r.counts.unit === "packages" ? " pkg" : ""} · ${dur}`;
      return `tests ✓ · ${dur}`;
    }
    case "failed":
      if (r.counts && r.counts.failed > 0) return `tests ✗ ${r.counts.failed} failed`;
      return r.exitCode != null ? `tests ✗ exit ${r.exitCode}` : "tests ✗ failed";
    case "error":
      return "tests ! error";
    case "cancelled":
      return "tests ⊘ cancelled";
    case "timedOut":
      return "tests ⏱ timed out";
  }
}

export function badgeTone(s: TestRunStatus): BadgeTone {
  switch (s) {
    case "passed":
      return "ok";
    case "failed":
    case "error":
    case "timedOut":
      return "bad";
    case "queued":
    case "running":
      return "busy";
    case "cancelled":
      return "muted";
  }
}

const STATUS_KEY: Record<TestRunStatus, MessageKey> = {
  queued: "testrun.status.queued",
  running: "testrun.status.running",
  passed: "testrun.status.passed",
  failed: "testrun.status.failed",
  error: "testrun.status.error",
  cancelled: "testrun.status.cancelled",
  timedOut: "testrun.status.timedOut",
};

/** The status in the UI language ("passed", "could not run", "timed out"). */
export function statusText(s: TestRunStatus): string {
  return t(STATUS_KEY[s]);
}

// Activity log: stays English (activity entries are event data, like store/activity.ts).
const STATUS_EN: Record<TestRunStatus, string> = {
  queued: "queued",
  running: "running",
  passed: "passed",
  failed: "failed",
  error: "could not run",
  cancelled: "cancelled",
  timedOut: "timed out",
};

/** Multi-line tooltip: what ran where, the outcome, the first failures, the last line. */
export function badgeTitle(r: TestRunInfo): string {
  const lines = [t("testrun.title.ranIn", { command: r.command, cwd: r.cwd })];
  const outcome = [statusText(r.status)];
  if (r.exitCode != null && r.status !== "passed") outcome.push(t("testrun.exitCode", { code: r.exitCode }));
  if (r.durationMs != null) outcome.push(formatDuration(r.durationMs));
  const counts = countsText(r.counts);
  if (counts) outcome.push(counts);
  lines.push(outcome.join(" · "));
  if (r.headSha) {
    const sha = r.headSha.slice(0, 10);
    lines.push(r.uncommitted ? t("testrun.title.atUncommitted", { sha, count: r.uncommitted }) : t("testrun.title.at", { sha }));
  }
  if (r.error) lines.push(r.error);
  for (const f of r.failures.slice(0, 3)) lines.push(`✗ ${f}`);
  if (r.failures.length > 3) lines.push(t("testrun.title.more", { count: r.failures.length - 3 }));
  const last = r.lastLines[r.lastLines.length - 1];
  if (last && r.status !== "passed") lines.push(t("testrun.title.last", { line: last }));
  lines.push(t("testrun.title.clickForLog"));
  return lines.join("\n");
}

/** Activity-log result column: "passed", "3 failed", "exit 1", "timed out". English (activity log). */
export function resultText(r: TestRunInfo): string {
  if (r.status === "failed") return r.counts?.failed ? `${r.counts.failed} failed` : r.exitCode != null ? `exit ${r.exitCode}` : "failed";
  return STATUS_EN[r.status];
}

function clip(s: string, max: number): string {
  const line = s.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** One line for the agent whose tests failed (editable before sending; nothing is sent automatically). */
// Agent-facing: stays English (typed into agents / written to files).
export function failureMessage(r: TestRunInfo): string {
  const what = [r.counts?.failed ? `${r.counts.failed} failed` : null, r.exitCode != null ? `exit ${r.exitCode}` : null, r.status === "timedOut" ? "timed out" : null]
    .filter(Boolean)
    .join(", ");
  const parts = [`The test run \`${r.command}\` in ${r.cwd} ${r.status === "timedOut" ? "timed out" : "failed"}${what ? ` (${what})` : ""}.`];
  if (r.failures.length) parts.push(`Failing: ${clip(r.failures.slice(0, 5).join("; "), 300)}.`);
  else {
    const tail = r.lastLines.slice(-3).join(" | ");
    if (tail) parts.push(`Last output: ${clip(tail, 300)}.`);
  }
  parts.push("Please fix the failing tests, commit, and run them again.");
  return parts.join(" ");
}

export type CommandSource = "lane" | "workspace" | "detected";

/** Which command applies: the lane's override, else the workspace's, else the detected one. */
export function resolveTestCommand(
  laneCommand: string | null | undefined,
  workspaceCommand: string | null | undefined,
  detected: string | null | undefined,
): { command: string; source: CommandSource } | null {
  const pick = (v: string | null | undefined) => (v ?? "").trim();
  if (pick(laneCommand)) return { command: pick(laneCommand), source: "lane" };
  if (pick(workspaceCommand)) return { command: pick(workspaceCommand), source: "workspace" };
  if (pick(detected)) return { command: pick(detected), source: "detected" };
  return null;
}

/** A persisted command: one line, at most 2000 characters ("" = none). Mirrors testrun::validate_command. */
export function commandProblem(cmd: string): string | null {
  const c = cmd.trim();
  if (!c) return null;
  if (c.length > 2000) return t("testrun.command.tooLong", { max: 2000 });
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(c)) return t("testrun.command.oneLine");
  return null;
}
