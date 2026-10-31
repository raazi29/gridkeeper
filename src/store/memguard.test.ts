import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryLevel, MemoryStatus } from "../lib/types";

vi.mock("../lib/ipc", () => ({
  errorMessage: (e: unknown) => String(e),
  onMemoryStatus: vi.fn(async () => () => {}),
  ipc: { memoryStatus: vi.fn(async () => status("ok")), log: vi.fn() },
}));

const { useApp } = await import("./appStore");
const {
  BANNER_IDLE,
  applyMemorySettings,
  applyMemoryStatus,
  dismissMemoryBanner,
  launchGate,
  nextBanner,
  releaseHeld,
  resetMemGuardForTests,
  showMemoryBanner,
  useMemGuard,
} = await import("./memguard");

const GB = 1024 ** 3;
let seq = 0;

/** A status as Rust would send it next (increasing seq unless given). */
function status(level: MemoryLevel, opts: { supported?: boolean; seq?: number; free?: number } = {}): MemoryStatus {
  const free = opts.free ?? (level === "ok" ? 8 * GB : level === "low" ? 1.5 * GB : 0.5 * GB);
  return {
    supported: opts.supported ?? true,
    level,
    limitBytes: 40 * GB,
    freeBytes: free,
    lowBytes: 2 * GB,
    criticalBytes: GB,
    top: [],
    agentsBytes: null,
    appBytes: null,
    reserveHeld: level !== "critical",
    seq: opts.seq ?? ++seq,
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
    expect(useMemGuard.getState().banner).toEqual({ announced: "low", visible: "low" });
  });

  it("keeps the newest status: an older one (a slow initial read) is ignored", () => {
    const initial = status("low", { free: 1.9 * GB }); // the read started first...
    applyMemoryStatus(status("critical", { free: 0.4 * GB })); // ...an event arrived meanwhile
    applyMemoryStatus(initial);
    expect(useMemGuard.getState().status?.level).toBe("critical");
    expect(useMemGuard.getState().status?.freeBytes).toBe(0.4 * GB);
    // Same seq again: also ignored; a newer one replaces it.
    const same = useMemGuard.getState().status!.seq;
    applyMemoryStatus(status("ok", { seq: same }));
    expect(useMemGuard.getState().status?.level).toBe("critical");
    applyMemoryStatus(status("low", { free: 1.2 * GB }));
    expect(useMemGuard.getState().status?.freeBytes).toBe(1.2 * GB);
  });

  it("keeps the banner idle while warnings are off, and starts fresh when they come back", () => {
    useApp.getState().updateSettings({ lowMemoryWarnings: false });
    applyMemoryStatus(status("critical"));
    expect(useMemGuard.getState().banner).toEqual(BANNER_IDLE);
    // On again while memory is only low: the next reading announces low (nothing stale, nothing suppressed).
    useApp.getState().updateSettings({ lowMemoryWarnings: true });
    applyMemoryStatus(status("low"));
    expect(useMemGuard.getState().banner).toEqual({ announced: "low", visible: "low" });
  });

  it("turning warnings off clears an announced banner and releases held launches", async () => {
    applyMemoryStatus(status("critical"));
    let started = false;
    void launchGate("s1", "A").then(() => (started = true));
    useApp.getState().updateSettings({ lowMemoryWarnings: false });
    applyMemorySettings(useApp.getState().persisted.settings);
    await flush();
    expect(useMemGuard.getState().banner).toEqual(BANNER_IDLE);
    expect(started).toBe(true);
  });

  it("treats an unsupported platform as ok", async () => {
    applyMemoryStatus(status("critical", { supported: false }));
    expect(useMemGuard.getState().banner.visible).toBeNull();
    let started = false;
    void launchGate("s1", "Claude Code 1").then(() => (started = true));
    await flush();
    expect(started).toBe(true);
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
