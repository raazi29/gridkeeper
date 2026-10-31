import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryLevel, MemoryStatus } from "../lib/types";

vi.mock("../lib/ipc", () => ({
  errorMessage: (e: unknown) => String(e),
  onMemoryStatus: vi.fn(async () => () => {}),
  ipc: { memoryStatus: vi.fn(async () => status("ok")), log: vi.fn() },
}));

const { useApp } = await import("./appStore");
const { BANNER_IDLE, applyMemoryStatus, dismissMemoryBanner, launchGate, nextBanner, releaseHeld, resetMemGuardForTests, showMemoryBanner, useMemGuard } =
  await import("./memguard");

const GB = 1024 ** 3;

function status(level: MemoryLevel, supported = true): MemoryStatus {
  const free = level === "ok" ? 8 * GB : level === "low" ? 1.5 * GB : 0.5 * GB;
  return {
    supported,
    level,
    limitBytes: 40 * GB,
    freeBytes: free,
    lowBytes: 2 * GB,
    criticalBytes: GB,
    top: [],
    agentsBytes: null,
    appBytes: null,
    reserveHeld: level !== "critical",
  };
}

/** Lets resolved gate promises run their continuations. */
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  resetMemGuardForTests();
  useApp.getState().updateSettings({ lowMemoryWarnings: true, lowMemoryHold: true });
});

describe("nextBanner", () => {
  it("opens once per entry into a level and resets on recovery", () => {
    let b = nextBanner(BANNER_IDLE, "low");
    expect(b).toEqual({ announced: "low", visible: "low" });
    // Same level again (a refresh): no new banner after a dismiss.
    b = nextBanner({ ...b, visible: null }, "low");
    expect(b.visible).toBeNull();
    // Worse: opens again.
    b = nextBanner(b, "critical");
    expect(b).toEqual({ announced: "critical", visible: "critical" });
    // Back to low: the open banner follows the level, nothing new is announced.
    b = nextBanner(b, "low");
    expect(b).toEqual({ announced: "critical", visible: "low" });
    // Dismissed, then critical again without recovering in between: stays closed.
    b = nextBanner({ ...b, visible: null }, "critical");
    expect(b.visible).toBeNull();
    // Recovered: the next entry opens it again.
    b = nextBanner(b, "ok");
    expect(b).toEqual(BANNER_IDLE);
    expect(nextBanner(b, "low").visible).toBe("low");
  });
});

describe("memory guard store", () => {
  it("does not reopen a dismissed banner on repeated readings", () => {
    applyMemoryStatus(status("low"));
    expect(useMemGuard.getState().banner.visible).toBe("low");
    dismissMemoryBanner();
    for (let i = 0; i < 5; i++) applyMemoryStatus(status("low"));
    expect(useMemGuard.getState().banner.visible).toBeNull();
    // The status-bar chip reopens it on request.
    showMemoryBanner();
    expect(useMemGuard.getState().banner.visible).toBe("low");
  });

  it("treats an unsupported platform as ok", () => {
    applyMemoryStatus(status("critical", false));
    expect(useMemGuard.getState().banner.visible).toBeNull();
    let started = false;
    void launchGate("s1", "Claude Code 1").then(() => (started = true));
    return flush().then(() => expect(started).toBe(true));
  });

  it("lets launches through while ok or low", async () => {
    const started: string[] = [];
    applyMemoryStatus(status("low"));
    void launchGate("s1", "A").then(() => started.push("s1"));
    await flush();
    expect(started).toEqual(["s1"]);
    expect(useMemGuard.getState().held).toEqual([]);
  });

  it("holds launches while critical and releases them on recovery", async () => {
    const started: string[] = [];
    applyMemoryStatus(status("critical"));
    void launchGate("s1", "A").then(() => started.push("s1"));
    void launchGate("s2", "B").then(() => started.push("s2"));
    void launchGate("s1", "A").then(() => started.push("s1 again")); // a second click on the same pane
    await flush();
    expect(started).toEqual([]);
    expect(useMemGuard.getState().held.map((h) => h.id)).toEqual(["s1", "s2"]);
    // Still critical: nothing moves.
    applyMemoryStatus(status("critical"));
    await flush();
    expect(started).toEqual([]);
    // Recovered to low: everything waiting starts.
    applyMemoryStatus(status("low"));
    await flush();
    expect(started.sort()).toEqual(["s1", "s1 again", "s2"]);
    expect(useMemGuard.getState().held).toEqual([]);
  });

  it("Launch anyway releases one pane or all", async () => {
    const started: string[] = [];
    applyMemoryStatus(status("critical"));
    for (const id of ["a", "b", "c"]) void launchGate(id, id).then(() => started.push(id));
    releaseHeld(["b"]);
    await flush();
    expect(started).toEqual(["b"]);
    expect(useMemGuard.getState().held.map((h) => h.id)).toEqual(["a", "c"]);
    releaseHeld();
    await flush();
    expect(started.sort()).toEqual(["a", "b", "c"]);
  });

  it("does not hold when the hold or the warnings are turned off", async () => {
    const started: string[] = [];
    applyMemoryStatus(status("critical"));
    useApp.getState().updateSettings({ lowMemoryHold: false });
    void launchGate("x", "X").then(() => started.push("x"));
    useApp.getState().updateSettings({ lowMemoryHold: true, lowMemoryWarnings: false });
    void launchGate("y", "Y").then(() => started.push("y"));
    await flush();
    expect(started).toEqual(["x", "y"]);
  });
});
