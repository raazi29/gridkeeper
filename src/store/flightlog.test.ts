import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MissionFile } from "../lib/types";
import type { ReplayEvent } from "../replay/events";

// ---- mocks: the signals the flight log listens to, toasts, settings, storage ----------------------

let tap: ((key: string, ev: ReplayEvent) => void) | null = null;
vi.mock("../replay/recorder", () => ({
  tapRecorder: (fn: (key: string, ev: ReplayEvent) => void) => {
    tap = fn;
    return () => {
      tap = null;
    };
  },
}));

const toasts: string[] = [];
vi.mock("./uiStore", () => ({ actionToast: (t: { message: string }) => void toasts.push(t.message) }));
vi.mock("../theme/applyTheme", () => ({ currentSaberLevel: () => "full" }));

const settings = { saberSound: false, notifications: { volume: 40 } };
const app = {
  persisted: {
    settings,
    workspaces: [{ projectDir: "D:\\work\\shop", groups: [{ sessionIds: ["id-1", "id-2"] }] }],
    sessions: [
      { id: "id-1", name: "builder 1", role: "builder", kind: "terminal" },
      { id: "id-2", name: "reviewer", role: "reviewer", kind: "terminal" },
    ],
  },
};
vi.mock("./appStore", () => ({ useApp: { getState: () => app } }));

vi.mock("./missionDoc", async () => {
  const { create } = await import("zustand");
  return {
    dirKey: (d: string) => d.trim().replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase(),
    useMissionDocs: create(() => ({ byDir: {} as Record<string, unknown> })),
  };
});

const storage = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => void storage.set(k, v),
  removeItem: (k: string) => void storage.delete(k),
});

type Mod = typeof import("./flightlog");
let m: Mod;
let docs: typeof import("./missionDoc");
let lib: typeof import("../lib/missionDoc");
let off: () => void = () => {};
let loadedTasks = -1;

beforeAll(async () => {
  storage.set("gridkeeper.flightlog.v1", JSON.stringify({ v: 1, enabled: true, days: { "2020-01-01": 2 }, tasks: 2 }));
  m = await import("./flightlog");
  loadedTasks = m.useFlightLog.getState().data.tasks;
  docs = await import("./missionDoc");
  lib = await import("../lib/missionDoc");
});

afterAll(() => {
  vi.useRealTimers();
});

const DIR = "D:\\work\\shop";

function setBoard(lines: string[], opts: { modifiedMs?: number | null; error?: string } = {}) {
  const text = lines.join("\n");
  const file: MissionFile = { path: `${DIR}\\.gridkeeper\\mission.md`, exists: true, text, modifiedMs: opts.modifiedMs === undefined ? Date.now() : opts.modifiedMs };
  docs.useMissionDocs.setState((s) => ({
    byDir: { ...s.byDir, [DIR]: opts.error ? { file: null, doc: null, loading: false, error: opts.error } : { file, doc: lib.parseMission(text), loading: false, error: null } },
  }));
}

beforeEach(() => {
  vi.useFakeTimers({ now: new Date(2026, 9, 19, 12), toFake: ["Date"] });
  off();
  m.resetFlightLogForTests();
  docs.useMissionDocs.setState({ byDir: {} });
  toasts.length = 0;
  settings.saberSound = false;
  off = m.installFlightLog();
});

describe("flight log store", () => {
  it("loaded what was stored", () => {
    expect(loadedTasks).toBe(2);
  });

  it("treats the first read of a project as a baseline", () => {
    setBoard(["# Mission: shop", "- [x] done before @builder-1", "- [ ] next"]);
    expect(m.useFlightLog.getState().data.tasks).toBe(0);
  });

  it("counts a task that goes to [x] and credits its owner", () => {
    setBoard(["# Mission: shop", "- [ ] one @builder-1", "- [ ] two"]);
    setBoard(["# Mission: shop", "- [x] one @builder-1", "- [ ] two"]);
    const d = m.useFlightLog.getState().data;
    expect(d.tasks).toBe(1);
    expect(d.agents).toHaveLength(1);
    expect(Object.values(d.days)).toEqual([1]);
    expect(JSON.parse(storage.get("gridkeeper.flightlog.v1") ?? "{}").tasks).toBe(1);
    // The same board again (another read) changes nothing.
    setBoard(["# Mission: shop", "- [x] one @builder-1", "- [ ] two"]);
    expect(m.useFlightLog.getState().data.tasks).toBe(1);
  });

  it("keeps the baseline across a failed read", () => {
    setBoard(["# Mission: shop", "- [ ] one", "- [ ] two"]);
    setBoard([], { error: "locked" });
    setBoard(["# Mission: shop", "- [x] one", "- [ ] two"]);
    expect(m.useFlightLog.getState().data.tasks).toBe(1);
  });

  it("announces a promotion once, with a chime only when blade sounds are on", () => {
    const chime = vi.fn();
    m.setFlightLogChime(chime);
    settings.saberSound = true;
    const tasks = Array.from({ length: 5 }, (_, i) => `task ${i}`);
    setBoard(["# Mission: shop", ...tasks.map((t) => `- [ ] ${t}`)]);
    setBoard(["# Mission: shop", ...tasks.map((t) => `- [x] ${t}`)]);
    expect(toasts).toEqual(["Promoted to Pilot. Medal earned: First jump."]);
    expect(chime).toHaveBeenCalledWith(40);
    expect(m.useFlightLog.getState().data.missions).toBe(1);
  });

  it("counts commits from recorded branch summaries and awards Clean landing", () => {
    expect(tap).toBeTruthy();
    const key = "d:\\work\\shop";
    tap!(key, { t: 1, k: "start", v: 1, goal: "shop", team: [], tasks: [] });
    tap!(key, { t: 2, k: "branch", slug: "builder-1", w: "aaaa1111", ahead: 1, files: 1, ins: 1, del: 0 });
    tap!(key, { t: 3, k: "branch", slug: "builder-1", w: "aaaa1111", ahead: 4, files: 3, ins: 9, del: 0 });
    expect(m.useFlightLog.getState().data.commits).toBe(3);
    tap!(key, { t: 4, k: "msg", from: "builder-1", to: ["reviewer"], text: "ready for review" });
    setBoard(["# Mission: shop", "- [ ] one @builder-1"]);
    setBoard(["# Mission: shop", "- [x] one @builder-1"]);
    expect(m.useFlightLog.getState().data.medals["clean-landing"]).toBeGreaterThan(0);
  });

  it("no Clean landing when a committer never handed off", () => {
    const key = "d:\\work\\shop";
    tap!(key, { t: 1, k: "start", v: 1, goal: "shop", team: [], tasks: [] });
    tap!(key, { t: 2, k: "branch", slug: "builder-1", w: "aaaa1111", ahead: 0, files: 0, ins: 0, del: 0 });
    tap!(key, { t: 3, k: "branch", slug: "builder-1", w: "aaaa1111", ahead: 2, files: 1, ins: 1, del: 0 });
    setBoard(["# Mission: shop", "- [ ] one"]);
    setBoard(["# Mission: shop", "- [x] one"]);
    const d = m.useFlightLog.getState().data;
    expect(d.missions).toBe(1);
    expect(d.medals["clean-landing"]).toBeUndefined();
  });

  it("stops counting when turned off and wipes on reset", () => {
    setBoard(["# Mission: shop", "- [ ] one", "- [ ] two"]);
    setBoard(["# Mission: shop", "- [x] one", "- [ ] two"]);
    m.setFlightLogEnabled(false);
    setBoard(["# Mission: shop", "- [x] one", "- [x] two"]);
    expect(m.useFlightLog.getState().data.tasks).toBe(1);
    expect(JSON.parse(storage.get("gridkeeper.flightlog.v1") ?? "{}").enabled).toBe(false);
    m.resetFlightLog();
    const d = m.useFlightLog.getState().data;
    expect(d.tasks).toBe(0);
    expect(d.enabled).toBe(false);
  });

  it("uses the file's write time when it is plausible", () => {
    const now = Date.now();
    expect(m.writeTime(now - 60_000, now)).toBe(now - 60_000);
    expect(m.writeTime(now + 3600_000, now)).toBe(now);
    expect(m.writeTime(now - 30 * 86_400_000, now)).toBe(now);
    expect(m.writeTime(null, now)).toBe(now);
  });
});
