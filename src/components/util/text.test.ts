import { describe, expect, it } from "vitest";
import {
  basename,
  formatSince,
  shortPath,
  defaultWorktreePath,
  formatCpu,
  formatMb,
  fuzzyFilter,
  fuzzyScore,
  initials,
  isValidBranchName,
  joinPath,
  splitArgs,
  taskManagerCpu,
} from "./text";

describe("splitArgs", () => {
  it("splits on whitespace", () => {
    expect(splitArgs("  --model  opus -p ")).toEqual(["--model", "opus", "-p"]);
  });
  it("respects double and single quotes", () => {
    expect(splitArgs('--name "my session" --x \'a b\'')).toEqual(["--name", "my session", "--x", "a b"]);
    expect(splitArgs('--dir="C:\\Program Files\\x"')).toEqual(["--dir=C:\\Program Files\\x"]);
  });
  it("keeps empty quoted args and backslashes", () => {
    expect(splitArgs('a "" b')).toEqual(["a", "", "b"]);
    expect(splitArgs("C:\\tools\\bin")).toEqual(["C:\\tools\\bin"]);
    expect(splitArgs('"say \\"hi\\""')).toEqual(['say "hi"']);
  });
  it("returns [] for blank input", () => {
    expect(splitArgs("   ")).toEqual([]);
  });
});

describe("fuzzy", () => {
  it("matches subsequences and rejects non-matches", () => {
    expect(fuzzyScore("nses", "New session")).not.toBeNull();
    expect(fuzzyScore("xyz", "New session")).toBeNull();
    expect(fuzzyScore("", "anything")).toBe(0);
  });
  it("ranks word starts / contiguous matches higher", () => {
    const items = ["Toggle sidebar", "Close session", "New session", "Restart session"];
    expect(fuzzyFilter(items, "new s", (x) => x)[0]).toBe("New session");
    expect(fuzzyFilter(items, "ts", (x) => x)[0]).toBe("Toggle sidebar");
    expect(fuzzyFilter(items, "close", (x) => x)).toEqual(["Close session"]);
  });
});

describe("paths", () => {
  it("basename handles both separators and trailing slashes", () => {
    expect(basename("D:\\code\\altera\\")).toBe("altera");
    expect(basename("/home/me/proj")).toBe("proj");
    expect(basename(null)).toBe("");
  });
  it("joins with the base's separator", () => {
    expect(joinPath("D:\\a", "b")).toBe("D:\\a\\b");
    expect(joinPath("D:/a/", "b")).toBe("D:/a/b");
  });
  it("builds default worktree paths", () => {
    expect(defaultWorktreePath("D:/AlteraAI", "feature/ui")).toBe("D:/AlteraAI-worktrees/feature-ui");
    expect(defaultWorktreePath("D:\\AlteraAI\\", "fix")).toBe("D:\\AlteraAI-worktrees\\fix");
  });
  it("validates branch names", () => {
    expect(isValidBranchName("feature/ui-2")).toBe(true);
    expect(isValidBranchName("bad name")).toBe(false);
    expect(isValidBranchName("a..b")).toBe(false);
    expect(isValidBranchName("-x")).toBe(false);
    expect(isValidBranchName("x.lock")).toBe(false);
  });
});

describe("format", () => {
  it("computes task-manager CPU", () => {
    expect(taskManagerCpu(200, 8)).toBe(25);
    expect(taskManagerCpu(50, 0)).toBe(50);
    expect(taskManagerCpu(5000, 4)).toBe(100);
    expect(taskManagerCpu(NaN, 4)).toBe(0);
  });
  it("formats values", () => {
    expect(formatCpu(3.456)).toBe("3.5%");
    expect(formatCpu(42.4)).toBe("42%");
    expect(formatCpu(0.01)).toBe("<0.1%");
    expect(formatMb(512 * 1024 * 1024)).toBe("512 MB");
  });
  it("initials", () => {
    expect(initials("api server")).toBe("AS");
    expect(initials("frontend")).toBe("FR");
    expect(initials("")).toBe("?");
  });
});

describe("shortPath", () => {
  it("keeps short paths", () => {
    expect(shortPath(String.raw`C:\gk-demo\oauth-app`)).toBe(String.raw`C:\gk-demo\oauth-app`);
  });
  it("drops middle folders, never cutting a name", () => {
    expect(shortPath(String.raw`C:\Users\amraa\AppData\Local\Temp\gk-uiaudit\oauth-app`)).toBe(String.raw`C:\…\Temp\gk-uiaudit\oauth-app`);
    expect(shortPath(String.raw`C:\Users\amraa\AppData\Local\Temp\gk-uiaudit\oauth-app`, 26)).toBe(String.raw`C:\…\gk-uiaudit\oauth-app`);
    expect(shortPath("/home/dev/projects/clients/acme/web/oauth-app", 24)).toBe("/…/acme/web/oauth-app");
  });
  it("keeps at least the last folder", () => {
    expect(shortPath(String.raw`C:\a\b\a-very-long-final-folder-name-that-is-long`, 10)).toBe(String.raw`C:\…\a-very-long-final-folder-name-that-is-long`);
  });
});

describe("formatSince", () => {
  it("formats seconds, minutes, hours and days", () => {
    expect(formatSince(42_000)).toBe("42s");
    expect(formatSince(185_000)).toBe("3m 05s");
    expect(formatSince(2 * 3600_000 + 14 * 60_000)).toBe("2h 14m");
    expect(formatSince(76 * 3600_000)).toBe("3d 4h");
    expect(formatSince(-5)).toBe("0s");
  });
});
