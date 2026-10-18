import { describe, expect, it } from "vitest";
import { parseMission } from "../lib/missionDoc";
import { diffMission, EMPTY_SNAP, snapMission } from "./diff";

const snap = (md: string) => snapMission(parseMission(md));

describe("snapMission", () => {
  it("scrubs goal and task text", () => {
    const s = snap("# Mission: Fix D:\\repo\\a for x@y.io\n- [ ] read C:\\Users\\me\\notes.txt @lead\n- [x] done\n");
    expect(s.goal).toBe("Fix ‹path› for ‹email›");
    expect(s.tasks.map((t) => t.text)).toEqual(["read ‹path›", "done"]);
    expect(s.tasks[0]).toMatchObject({ s: "todo", o: ["lead"], line: 1 });
    expect(snapMission(null)).toBe(EMPTY_SNAP);
  });
});

describe("diffMission", () => {
  const base = snap("# Mission: A\n## Tasks\n- [ ] one @b1\n- [ ] two @b2\n- [ ] three\n");

  it("reports nothing when nothing changed", () => {
    expect(diffMission(base, snap("# Mission: A\n## Tasks\n- [ ] one @b1\n- [ ] two @b2\n- [ ] three\n"), 5)).toEqual([]);
  });

  it("from empty: goal + every task", () => {
    const ev = diffMission(EMPTY_SNAP, base, 7);
    expect(ev[0]).toEqual({ t: 7, k: "goal", goal: "A" });
    expect(ev.slice(1).map((e) => (e.k === "task" ? `${e.text}:${e.s}` : e.k))).toEqual(["one:todo", "two:todo", "three:todo"]);
  });

  it("state and owner changes", () => {
    const next = snap("# Mission: A\n## Tasks\n- [~] one @b1\n- [ ] two @b1 @b2\n- [x] three\n");
    expect(diffMission(base, next, 9)).toEqual([
      { t: 9, k: "task", text: "one", s: "doing", o: ["b1"] },
      { t: 9, k: "task", text: "two", s: "todo", o: ["b1", "b2"] },
      { t: 9, k: "task", text: "three", s: "done", o: [] },
    ]);
  });

  it("goal change, new and removed tasks", () => {
    const next = snap("# Mission: B\n## Tasks\n- [ ] one @b1\n- [ ] four\n- [ ] three\n- [ ] five\n");
    const ev = diffMission(base, next, 1);
    expect(ev[0]).toEqual({ t: 1, k: "goal", goal: "B" });
    // "two" (line 3) → "four" (line 3) is a rename; "five" is new.
    expect(ev.slice(1)).toEqual([
      { t: 1, k: "task", text: "four", s: "todo", o: [], was: "two" },
      { t: 1, k: "task", text: "five", s: "todo", o: [] },
    ]);
    const removed = diffMission(base, snap("# Mission: A\n- [ ] one @b1\n"), 2);
    expect(removed).toEqual([
      { t: 2, k: "task", text: "two", s: "gone", o: [] },
      { t: 2, k: "task", text: "three", s: "gone", o: [] },
    ]);
  });

  it("tells repeated task texts apart by occurrence", () => {
    const a = snap("- [ ] test\n- [ ] test\n");
    const b = snap("- [ ] test\n- [x] test\n");
    expect(diffMission(a, b, 3)).toEqual([{ t: 3, k: "task", text: "test", s: "done", o: [] }]);
  });

  it("ignores whitespace / case differences in matching", () => {
    const a = snap("- [ ] Write  docs\n");
    const b = snap("- [x] write docs\n");
    expect(diffMission(a, b, 4)).toEqual([{ t: 4, k: "task", text: "write docs", s: "done", o: [] }]);
  });
});
