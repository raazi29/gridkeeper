import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MissionChanged, MissionFile } from "../lib/types";

// ---- mocks: IPC (the Rust side) and toasts --------------------------------------------------------

const disk = new Map<string, MissionFile>();
let listener: ((ev: MissionChanged) => void) | null = null;
const calls: string[] = [];

vi.mock("../lib/ipc", () => ({
  errorMessage: (e: unknown) => (e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : String(e)),
  onMissionChanged: (cb: (ev: MissionChanged) => void) => {
    listener = cb;
    calls.push("listen");
    return Promise.resolve(() => {
      listener = null;
      calls.push("unlisten");
    });
  },
  ipc: {
    missionRead: vi.fn(async (dir: string) => {
      calls.push(`read ${dir}`);
      return disk.get(dir) ?? { path: `${dir}\\.gridkeeper\\mission.md`, exists: false, text: "", modifiedMs: null };
    }),
    missionWrite: vi.fn(async (dir: string, text: string, expected?: number | null) => {
      calls.push(`write ${dir}`);
      const cur = disk.get(dir);
      if (expected !== undefined && (cur?.modifiedMs ?? null) !== expected) throw { code: "conflict", message: "changed" };
      const f = { path: `${dir}\\.gridkeeper\\mission.md`, exists: true, text, modifiedMs: (cur?.modifiedMs ?? 0) + 1 };
      disk.set(dir, f);
      return f;
    }),
    missionWatch: vi.fn(async (dir: string) => void calls.push(`watch ${dir}`)),
    missionUnwatch: vi.fn(async (dir: string) => void calls.push(`unwatch ${dir}`)),
  },
}));

const toasts: string[] = [];
vi.mock("../actions/notify", () => ({ notify: (kind: string, msg: string) => void toasts.push(`${kind}: ${msg}`) }));
const undoToasts: { message: string; run: () => void }[] = [];
vi.mock("./uiStore", () => ({
  actionToast: (t: { message: string; action?: { run: () => void } }) => void undoToasts.push({ message: t.message, run: t.action!.run }),
}));

const { acquireMission, CONFLICT_MESSAGE, dirKey, editMission, reloadMission, resetMissionDocsForTests, UNDO_CONFLICT_MESSAGE, undoMission, updateTaskState, useMissionDocs, writeMission } =
  await import("./missionDoc");
const { addTask, deleteTask, moveTask } = await import("../lib/missionDoc");

const DIR = "D:\\proj";
const flush = () => new Promise((r) => setTimeout(r, 0));
const entry = () => useMissionDocs.getState().byDir[DIR];
const put = (text: string, modifiedMs: number) => disk.set(DIR, { path: `${DIR}\\.gridkeeper\\mission.md`, exists: true, text, modifiedMs });

beforeEach(() => {
  disk.clear();
  calls.length = 0;
  toasts.length = 0;
  undoToasts.length = 0;
  listener = null;
  resetMissionDocsForTests();
});

describe("mission store: watch lifecycle", () => {
  it("watches + reads on first acquire, re-reads on change events, unwatches on last release", async () => {
    put("# Mission: A\n- [ ] t @lead\n", 5);
    const r1 = acquireMission(DIR);
    const r2 = acquireMission(DIR);
    await flush();
    expect(calls.filter((c) => c.startsWith("watch"))).toEqual([`watch ${DIR}`]);
    expect(calls.filter((c) => c.startsWith("read"))).toHaveLength(1);
    expect(entry().doc?.goal).toBe("A");
    expect(entry().file?.modifiedMs).toBe(5);

    put("# Mission: B\n", 6);
    listener?.({ projectDir: "d:/PROJ/" }); // Rust may report another spelling of the same folder
    await flush();
    expect(entry().doc?.goal).toBe("B");

    listener?.({ projectDir: "D:\\other" });
    await flush();
    expect(calls.filter((c) => c.startsWith("read"))).toHaveLength(2);

    r1();
    r1(); // idempotent
    expect(calls).not.toContain(`unwatch ${DIR}`);
    r2();
    await flush();
    expect(calls).toContain(`unwatch ${DIR}`);
    expect(calls).toContain("unlisten");
  });

  it("a missing file gives an entry with no doc", async () => {
    const off = acquireMission(DIR);
    await flush();
    expect(entry().file?.exists).toBe(false);
    expect(entry().doc).toBeNull();
    expect(entry().loading).toBe(false);
    off();
  });

  it("coalesces bursts of reloads into at most one extra read", async () => {
    put("# Mission: A\n", 1);
    const p = reloadMission(DIR);
    void reloadMission(DIR);
    void reloadMission(DIR);
    await p;
    expect(calls.filter((c) => c.startsWith("read"))).toHaveLength(2);
  });

  it("dirKey normalizes case, slashes and trailing separators", () => {
    expect(dirKey("D:/Proj/")).toBe(dirKey("d:\\proj"));
  });
});

describe("mission store: writes", () => {
  it("creates a file only when none exists (expected null)", async () => {
    acquireMission(DIR);
    await flush();
    const r = await writeMission(DIR, "# Mission: New\n", null);
    expect(r.ok).toBe(true);
    expect(entry().doc?.goal).toBe("New");
    // A second create must fail: the file exists now.
    const again = await writeMission(DIR, "# Mission: Other\n", null);
    expect(again).toEqual({ ok: false, conflict: true });
    expect(toasts).toEqual([`warn: ${CONFLICT_MESSAGE}`]);
    expect(entry().doc?.goal).toBe("New");
  });

  it("updateTaskState rewrites one box with the last-read mtime", async () => {
    put("# Mission: A\r\n- [ ] one @lead\r\n- [ ] two\r\n", 3);
    acquireMission(DIR);
    await flush();
    expect(await updateTaskState(DIR, 2, "doing")).toBe(true);
    expect(disk.get(DIR)?.text).toBe("# Mission: A\r\n- [ ] one @lead\r\n- [~] two\r\n");
    expect(entry().doc?.tasks[1].state).toBe("doing");
  });

  it("on a conflict re-reads, toasts and leaves the agent's edit alone", async () => {
    put("# Mission: A\n- [ ] one\n", 3);
    acquireMission(DIR);
    await flush();
    put("# Mission: A\n- [x] one\n- [ ] added by an agent\n", 4); // changed behind our back (no event yet)
    expect(await updateTaskState(DIR, 1, "doing")).toBe(false);
    expect(disk.get(DIR)?.text).toBe("# Mission: A\n- [x] one\n- [ ] added by an agent\n");
    expect(toasts).toEqual([`warn: ${CONFLICT_MESSAGE}`]);
    expect(entry().doc?.tasks).toHaveLength(2);
    // Retrying after the reload works.
    expect(await updateTaskState(DIR, 2, "doing")).toBe(true);
  });

  it("a stale line number re-reads instead of writing", async () => {
    put("# Mission: A\n- [ ] one\n", 3);
    acquireMission(DIR);
    await flush();
    expect(await updateTaskState(DIR, 0, "done")).toBe(false);
    expect(calls.filter((c) => c.startsWith("write"))).toHaveLength(0);
    expect(toasts).toHaveLength(1);
  });

  it("other write errors toast an error", async () => {
    const { ipc } = await import("../lib/ipc");
    vi.mocked(ipc.missionWrite).mockRejectedValueOnce({ code: "io", message: "disk full" });
    const r = await writeMission(DIR, "x", null);
    expect(r).toEqual({ ok: false, conflict: false });
    expect(toasts[0]).toBe("error: Could not save the mission file: disk full");
  });
});

describe("mission store: board edits", () => {
  it("editMission writes a pure edit with the last-read mtime and offers Undo", async () => {
    put("# Mission: A\r\n## Tasks\r\n- [ ] one\r\n- [ ] two\r\n", 3);
    acquireMission(DIR);
    await flush();
    expect(await editMission(DIR, (t) => deleteTask(t, 2), { undo: "Task deleted" })).toBe(true);
    expect(disk.get(DIR)?.text).toBe("# Mission: A\r\n## Tasks\r\n- [ ] two\r\n");
    expect(undoToasts.map((t) => t.message)).toEqual(["Task deleted"]);
    undoToasts[0].run();
    await flush();
    await flush();
    expect(disk.get(DIR)?.text).toBe("# Mission: A\r\n## Tasks\r\n- [ ] one\r\n- [ ] two\r\n");
    expect(entry().doc?.tasks).toHaveLength(2);
  });

  it("undo refuses to overwrite a later change", async () => {
    put("# Mission: A\n- [ ] one\n", 3);
    acquireMission(DIR);
    await flush();
    await editMission(DIR, (t) => addTask(t, "two"));
    const after = disk.get(DIR)!.modifiedMs;
    put("# Mission: A\n- [x] one\n- [ ] two\n", 9); // an agent edited it after us
    expect(await undoMission(DIR, "# Mission: A\n- [ ] one\n", after)).toBe(false);
    expect(disk.get(DIR)?.text).toBe("# Mission: A\n- [x] one\n- [ ] two\n");
    expect(toasts).toEqual([`warn: ${UNDO_CONFLICT_MESSAGE}`]);
  });

  it("refuses an edit whose task moved (expect guard) and re-reads", async () => {
    put("# Mission: A\n- [ ] one\n- [ ] two\n", 3);
    acquireMission(DIR);
    await flush();
    const edit = vi.fn((t: string) => moveTask(t, 1, 3));
    expect(await editMission(DIR, edit, { expect: { line: 1, text: "two" } })).toBe(false);
    expect(edit).not.toHaveBeenCalled();
    expect(calls.filter((c) => c.startsWith("write"))).toHaveLength(0);
    expect(toasts).toEqual([`warn: ${CONFLICT_MESSAGE}`]);
    expect(await editMission(DIR, edit, { expect: { line: 1, text: "one" } })).toBe(true);
    expect(disk.get(DIR)?.text).toBe("# Mission: A\n- [ ] two\n- [ ] one\n");
  });

  it("runs edits one at a time, each on the previous result", async () => {
    put("# Mission: A\n## Tasks\n", 3);
    acquireMission(DIR);
    await flush();
    const results = await Promise.all([editMission(DIR, (t) => addTask(t, "a")), editMission(DIR, (t) => addTask(t, "b")), editMission(DIR, (t) => addTask(t, "c"))]);
    expect(results).toEqual([true, true, true]);
    expect(disk.get(DIR)?.text).toBe("# Mission: A\n## Tasks\n- [ ] a\n- [ ] b\n- [ ] c\n");
    expect(toasts).toEqual([]);
  });

  it("a no-op edit writes nothing", async () => {
    put("# Mission: A\n- [ ] one\n", 3);
    acquireMission(DIR);
    await flush();
    expect(await editMission(DIR, (t) => t, { undo: "x" })).toBe(true);
    expect(calls.filter((c) => c.startsWith("write"))).toHaveLength(0);
    expect(undoToasts).toHaveLength(0);
  });
});
