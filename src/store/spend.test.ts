import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionMeter, SessionMeta, SpendGuard } from "../lib/types";

// ---- mocks: the Rust side, toasts, OS notifications --------------------------------------------------------

let stored: string | null = null;
vi.mock("../lib/ipc", () => ({
  errorMessage: (e: unknown) => String(e),
  onSessionMeter: vi.fn(async () => () => {}),
  ipc: {
    spendLedgerRead: vi.fn(async () => stored),
    spendLedgerWrite: vi.fn(async (text: string) => {
      stored = text;
    }),
    meterSnapshot: vi.fn(async () => []),
    log: vi.fn(),
  },
}));
const toasts: [string, string][] = [];
vi.mock("../actions/notify", () => ({ notify: (kind: string, message: string) => void toasts.push([kind, message]) }));
const osSent: { title: string; body: string }[] = [];
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: async () => true,
  requestPermission: async () => "granted",
  sendNotification: (n: { title: string; body: string }) => void osSent.push(n),
}));

const { ipc } = await import("../lib/ipc");
const { useApp } = await import("./appStore");
const { applyMeter, useMeter } = await import("./meter");
const { policyOf, setPolicy, resetLeadControlStoreForTests } = await import("./leadControl");
const spend = await import("./spend");
const lib = await import("../lib/spend");

const DIR = "D:\\proj";

function meter(costUsd: number, claudeSessionId = "c1", sessionId = "p1"): SessionMeter {
  return {
    sessionId,
    status: "metered",
    note: null,
    chained: false,
    claudeSessionId,
    costUsd,
    paneCostUsd: costUsd,
    contextPct: 10,
    contextSize: 200000,
    inputTokens: null,
    outputTokens: null,
    apiDurationMs: null,
    durationMs: null,
    model: null,
    fiveHourPct: null,
    sevenDayPct: null,
    updatedMs: Date.now(),
  };
}

function setup(guard: SpendGuard | null) {
  const meta = { id: "p1", name: "builder", agent: "claude", cwd: DIR } as SessionMeta;
  useApp.setState((s) => ({
    persisted: {
      ...s.persisted,
      sessions: [meta],
      workspaces: [
        {
          id: "w1",
          name: "Proj",
          projectDir: DIR,
          createdAt: null,
          activeGroupId: "g1",
          groups: [{ id: "g1", name: "Main", layout: { preset: "grid", maximized: null, sizes: {} }, sessionIds: ["p1"] }],
        },
      ],
      settings: { ...s.persisted.settings, costMeter: true, spendGuards: (guard ? { w1: guard } : {}) as Record<string, SpendGuard> },
    },
  }));
}

const settle = async () => {
  for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0);
};
const ledger = () => spend.useSpend.getState().ledger!;
const spent = () => lib.spentToday(ledger(), "w1", Date.now());

let uninstall: (() => void) | null = null;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 19, 12, 0));
  vi.clearAllMocks();
  stored = null;
  toasts.length = 0;
  osSent.length = 0;
  spend.resetSpendForTests();
  resetLeadControlStoreForTests();
  useMeter.setState({ bySession: {} });
  useApp.setState({ loaded: true });
  setup({ budgetUsd: 1, warnPct: 50, action: "pause" });
  setPolicy(DIR, { mode: "autopilot" });
});

afterEach(() => {
  uninstall?.();
  uninstall = null;
  vi.useRealTimers();
});

async function install() {
  uninstall = spend.installSpendGuard();
  await settle();
}

describe("spend guard", () => {
  it("books meter updates, warns once, pauses Autopilot once at 100 %, never stops agents", async () => {
    await install();
    expect(ledger()).toEqual(lib.emptyLedger());
    applyMeter(meter(0.4));
    expect(spent()).toBeCloseTo(0.4);
    expect(toasts).toEqual([]);
    applyMeter(meter(0.6));
    expect(toasts).toHaveLength(1);
    expect(toasts[0][1]).toMatch(/Proj: today ~\$0\.60 of the \$1 daily budget \(50% reached/);
    applyMeter(meter(0.7));
    expect(toasts).toHaveLength(1);
    expect(policyOf(DIR).paused).toBe(false);
    applyMeter(meter(1.05));
    expect(policyOf(DIR)).toMatchObject({ mode: "autopilot", paused: true });
    expect(toasts).toHaveLength(2);
    expect(toasts[1][1]).toMatch(/reached the \$1 daily budget\. Autopilot is paused; agents keep running/);
    expect(lib.bannerFor(ledger(), "w1", spent(), spend.guardOf("w1"), Date.now())).toMatchObject({ pausedDir: DIR });
    applyMeter(meter(1.3));
    expect(toasts).toHaveLength(2);
    expect(osSent).toEqual([]);
    // Saved once after the debounce, with the totals; nothing else went to Rust (no stop, no write to a pane).
    expect(ipc.spendLedgerWrite).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(spend.SAVE_DEBOUNCE_MS);
    expect(ipc.spendLedgerWrite).toHaveBeenCalledTimes(1);
    expect(lib.parseLedger(stored)!.days["2026-10-19"].w1).toBeCloseTo(1.3);
    // Resume: Autopilot runs again, the banner goes, no new stop today for this budget.
    spend.resumeGuard("w1");
    expect(policyOf(DIR).paused).toBe(false);
    expect(lib.bannerFor(ledger(), "w1", spent(), spend.guardOf("w1"), Date.now())).toBeNull();
    applyMeter(meter(1.8));
    expect(policyOf(DIR).paused).toBe(false);
    expect(toasts).toHaveLength(2);
  });

  it("raising the budget resumes the paused Autopilot and arms the guard again", async () => {
    await install();
    applyMeter(meter(1.2));
    expect(policyOf(DIR).paused).toBe(true);
    spend.raiseBudget("w1", 2);
    expect(spend.guardOf("w1")).toMatchObject({ budgetUsd: 2, action: "pause" });
    expect(policyOf(DIR).paused).toBe(false);
    expect(lib.bannerFor(ledger(), "w1", spent(), spend.guardOf("w1"), Date.now())).toBeNull();
    applyMeter(meter(2.1));
    expect(policyOf(DIR).paused).toBe(true);
  });

  it("warn only: toast and banner, Autopilot untouched; pause + notify also sends an OS notification", async () => {
    setup({ budgetUsd: 1, warnPct: 80, action: "warn" });
    await install();
    applyMeter(meter(1.5));
    expect(policyOf(DIR).paused).toBe(false);
    expect(toasts.map((t) => t[0])).toEqual(["warn"]);
    expect(lib.bannerFor(ledger(), "w1", spent(), spend.guardOf("w1"), Date.now())).toMatchObject({ pausedDir: null });
    expect(osSent).toEqual([]);

    spend.resetSpendForTests();
    uninstall?.();
    setup({ budgetUsd: 1, warnPct: 80, action: "pauseNotify" });
    stored = null;
    await install();
    applyMeter(meter(1.5, "c2"));
    await settle();
    expect(policyOf(DIR).paused).toBe(true);
    expect(osSent).toHaveLength(1);
    expect(osSent[0].title).toBe("Spend guard: Proj");
  });

  it("a lowered budget that is already reached acts at once; no guard = bookkeeping only", async () => {
    setup(null);
    await install();
    applyMeter(meter(3));
    expect(spent()).toBeCloseTo(3);
    expect(toasts).toEqual([]);
    spend.setGuard("w1", { budgetUsd: 2, warnPct: 80, action: "pause" });
    expect(policyOf(DIR).paused).toBe(true);
    expect(toasts).toHaveLength(1);
  });

  it("continues from the stored ledger: the same costs are not booked twice after a restart", async () => {
    await install();
    applyMeter(meter(0.3));
    await vi.advanceTimersByTimeAsync(spend.SAVE_DEBOUNCE_MS);
    uninstall?.();
    uninstall = null;
    spend.resetSpendForTests();
    await install();
    expect(spent()).toBeCloseTo(0.3);
    // The meter snapshot of the earlier run arrives again: nothing new is booked.
    applyMeter({ ...meter(0.3), updatedMs: Date.now() - 1 });
    expect(spent()).toBeCloseTo(0.3);
    applyMeter(meter(0.45));
    expect(spent()).toBeCloseTo(0.45);
  });

  it("a new day starts at $0 and the guard can act again", async () => {
    await install();
    applyMeter(meter(1.2));
    expect(policyOf(DIR).paused).toBe(true);
    spend.resumeGuard("w1");
    vi.setSystemTime(new Date(2026, 9, 20, 9, 0));
    expect(spent()).toBe(0);
    applyMeter(meter(1.6));
    expect(spent()).toBeCloseTo(0.4);
    expect(policyOf(DIR).paused).toBe(false);
    applyMeter(meter(2.3));
    expect(spent()).toBeCloseTo(1.1);
    expect(policyOf(DIR).paused).toBe(true);
  });
});
