import { describe, expect, it } from "vitest";
import type { TestRunInfo } from "../../lib/types";
import { badgeText, badgeTitle, badgeTone, commandProblem, countsText, failureMessage, formatDuration, resolveTestCommand, resultText } from "./format";

function run(p: Partial<TestRunInfo> = {}): TestRunInfo {
  return {
    id: "t1",
    cwd: "D:\\repo\\.claude\\worktrees\\agent-1",
    command: "npm test",
    label: "builder 1",
    sessionId: "s1",
    status: "passed",
    queuedMs: 1000,
    startedMs: 1000,
    endedMs: 39_000,
    durationMs: 38_000,
    exitCode: 0,
    counts: { runner: "vitest", unit: "tests", passed: 412, failed: 0, skipped: 0 },
    failures: [],
    lastLines: ["Tests  412 passed (412)"],
    error: null,
    outputBytes: 1234,
    timeoutSec: 900,
    repoRoot: "D:\\repo\\.claude\\worktrees\\agent-1",
    headSha: "a".repeat(40),
    uncommitted: 0,
    ...p,
  };
}

describe("formatDuration", () => {
  it("scales from ms to hours", () => {
    expect(formatDuration(850)).toBe("850ms");
    expect(formatDuration(38_000)).toBe("38s");
    expect(formatDuration(72_000)).toBe("1m 12s");
    expect(formatDuration(3_720_000)).toBe("1h 02m");
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(-5)).toBe("—");
  });
});

describe("badgeText", () => {
  it("matches the card badge formats", () => {
    expect(badgeText(run(), 0)).toBe("tests ✓ 412 · 38s");
    expect(badgeText(run({ status: "failed", exitCode: 1, counts: { runner: "vitest", unit: "tests", passed: 409, failed: 3, skipped: 0 } }), 0)).toBe("tests ✗ 3 failed");
    expect(badgeText(run({ status: "failed", exitCode: 2, counts: null }), 0)).toBe("tests ✗ exit 2");
    expect(badgeText(run({ counts: null }), 0)).toBe("tests ✓ · 38s");
    expect(badgeText(run({ counts: { runner: "go", unit: "packages", passed: 7, failed: 0, skipped: 0 } }), 0)).toBe("tests ✓ 7 pkg · 38s");
    expect(badgeText(run({ status: "running", startedMs: 10_000, durationMs: null }), 22_000)).toBe("tests … 12s");
    expect(badgeText(run({ status: "queued" }), 0)).toBe("tests · queued");
    expect(badgeText(run({ status: "error" }), 0)).toBe("tests ! error");
    expect(badgeText(run({ status: "cancelled" }), 0)).toBe("tests ⊘ cancelled");
    expect(badgeText(run({ status: "timedOut" }), 0)).toBe("tests ⏱ timed out");
  });

  it("tones and result column", () => {
    expect(badgeTone("passed")).toBe("ok");
    expect(badgeTone("failed")).toBe("bad");
    expect(badgeTone("timedOut")).toBe("bad");
    expect(badgeTone("running")).toBe("busy");
    expect(badgeTone("cancelled")).toBe("muted");
    expect(resultText(run({ status: "failed", counts: { runner: "jest", unit: "tests", passed: 1, failed: 2, skipped: 0 } }))).toBe("2 failed");
    expect(resultText(run({ status: "failed", counts: null, exitCode: 1 }))).toBe("exit 1");
    expect(resultText(run())).toBe("passed");
  });

  it("tooltip names the command, folder, commit and first failures", () => {
    const t = badgeTitle(run({ status: "failed", exitCode: 1, failures: ["a", "b", "c", "d"], uncommitted: 2, lastLines: ["boom"] }));
    expect(t).toContain("npm test");
    expect(t).toContain("agent-1");
    expect(t).toContain("exit 1");
    expect(t).toContain("aaaaaaaaaa + 2 uncommitted files");
    expect(t).toContain("✗ a");
    expect(t).toContain("… and 1 more");
    expect(t).toContain("last: boom");
  });
});

describe("countsText", () => {
  it("drops zero parts", () => {
    expect(countsText({ runner: "cargo", unit: "tests", passed: 250, failed: 2, skipped: 3 })).toBe("250 passed · 2 failed · 3 skipped");
    expect(countsText({ runner: "cargo", unit: "tests", passed: 0, failed: 0, skipped: 0 })).toBe("0 passed");
    expect(countsText({ runner: "go", unit: "packages", passed: 0, failed: 1, skipped: 0 })).toBe("1 pkg failed");
    expect(countsText(null)).toBe("");
  });
});

describe("failureMessage", () => {
  it("is one line with the command, outcome and failing names", () => {
    const m = failureMessage(run({ status: "failed", exitCode: 1, counts: { runner: "vitest", unit: "tests", passed: 9, failed: 2, skipped: 0 }, failures: ["src/a.test.ts > adds", "src/b.test.ts > subtracts"] }));
    expect(m).not.toMatch(/\n/);
    expect(m).toContain("`npm test`");
    expect(m).toContain("(2 failed, exit 1)");
    expect(m).toContain("Failing: src/a.test.ts > adds; src/b.test.ts > subtracts.");
    expect(m).toContain("Please fix the failing tests");
  });

  it("falls back to the last lines, and says when it timed out", () => {
    const m = failureMessage(run({ status: "timedOut", exitCode: null, counts: null, lastLines: ["x", "y", "z", "last"] }));
    expect(m).toContain("timed out");
    expect(m).toContain("Last output: y | z | last.");
  });
});

describe("resolveTestCommand", () => {
  it("lane override > workspace > detected", () => {
    expect(resolveTestCommand("cargo test -p core", "npm test", "pnpm test")).toEqual({ command: "cargo test -p core", source: "lane" });
    expect(resolveTestCommand("  ", "npm test", "pnpm test")).toEqual({ command: "npm test", source: "workspace" });
    expect(resolveTestCommand(null, undefined, "pnpm test")).toEqual({ command: "pnpm test", source: "detected" });
    expect(resolveTestCommand(null, null, null)).toBeNull();
  });

  it("commandProblem mirrors the Rust validation", () => {
    expect(commandProblem("")).toBeNull();
    expect(commandProblem("npm test")).toBeNull();
    expect(commandProblem("npm test\nrm -rf /")).toBe("One line only");
    expect(commandProblem("x".repeat(2001))).toBe("At most 2000 characters");
  });
});
