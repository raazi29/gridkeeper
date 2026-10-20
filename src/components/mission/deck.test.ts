import { describe, expect, it } from "vitest";
import { filtersActive, inSpotlight, matchesFilters, NO_FILTERS, pinnedFirst, stateChipOf, toggleIn, toggleSpotlight, viewForKey } from "./deck";
import { findHits, stepHit, type FindAgent, type FindTask } from "./find";
import { nextSort, sortRows, stateRank, type ListRow } from "./listModel";
import { clickSelect, EMPTY_SELECTION, extendSelect, idsInRect, pruneSelection, rangeIds } from "./selection";

describe("selection", () => {
  const order = ["a", "b", "c", "d", "e"];
  it("plain click selects one card and sets the anchor", () => {
    expect(clickSelect({ ids: ["a", "b"], anchor: "a" }, "c", { toggle: false, range: false }, order)).toEqual({ ids: ["c"], anchor: "c" });
  });
  it("Ctrl/⌘ toggles, keeping display order", () => {
    let s = clickSelect(EMPTY_SELECTION, "d", { toggle: true, range: false }, order);
    s = clickSelect(s, "b", { toggle: true, range: false }, order);
    expect(s.ids).toEqual(["b", "d"]);
    s = clickSelect(s, "d", { toggle: true, range: false }, order);
    expect(s).toEqual({ ids: ["b"], anchor: "d" });
  });
  it("Shift selects a range from the anchor (Ctrl+Shift adds it)", () => {
    const base = { ids: ["b"], anchor: "b" };
    expect(clickSelect(base, "d", { toggle: false, range: true }, order)).toEqual({ ids: ["b", "c", "d"], anchor: "b" });
    expect(clickSelect(base, "a", { toggle: false, range: true }, order).ids).toEqual(["a", "b"]);
    expect(clickSelect({ ids: ["e"], anchor: "a" }, "b", { toggle: true, range: true }, order).ids).toEqual(["a", "b", "e"]);
    expect(rangeIds(order, "zz", "c")).toEqual(["c"]);
  });
  it("Shift+arrow extends from the anchor", () => {
    const r1 = extendSelect({ ids: ["b"], anchor: "b" }, "b", 1, order);
    expect(r1).toEqual({ sel: { ids: ["b", "c"], anchor: "b" }, focus: "c" });
    const r2 = extendSelect(r1.sel, r1.focus, -1, order);
    const r3 = extendSelect(r2.sel, r2.focus, -1, order);
    expect(r3.sel.ids).toEqual(["a", "b"]);
    expect(extendSelect({ ids: [], anchor: null }, "e", 1, order).focus).toBe("e");
  });
  it("hit-tests the rubber band and prunes removed cards", () => {
    const items = [
      { id: "a", rect: { x: 0, y: 0, w: 10, h: 10 } },
      { id: "b", rect: { x: 50, y: 0, w: 10, h: 10 } },
    ];
    expect(idsInRect(items, { x: 5, y: 5, w: 10, h: 10 })).toEqual(["a"]);
    const s = { ids: ["a", "x"], anchor: "x" };
    expect(pruneSelection(s, ["a", "b"])).toEqual({ ids: ["a"], anchor: null });
    const same = { ids: ["a"], anchor: "a" };
    expect(pruneSelection(same, ["a"])).toBe(same);
  });
});

describe("deck filters and spotlight", () => {
  it("folds lamps into state chips", () => {
    expect(stateChipOf("waiting")).toBe("needs");
    expect(stateChipOf("exited")).toBe("idle");
    expect(stateChipOf("stopped")).toBe("idle");
  });
  it("matches role and state chips (any within a group, both groups)", () => {
    expect(matchesFilters(NO_FILTERS, "builder", "working")).toBe(true);
    expect(filtersActive(NO_FILTERS)).toBe(false);
    const f = { roles: ["builder", ""], states: ["working" as const] };
    expect(matchesFilters(f, "builder", "working")).toBe(true);
    expect(matchesFilters(f, null, "working")).toBe(true);
    expect(matchesFilters(f, "builder", "idle")).toBe(false);
    expect(matchesFilters(f, "reviewer", "working")).toBe(false);
    expect(toggleIn(["a"], "a")).toEqual([]);
    expect(toggleIn(["a"], "b")).toEqual(["a", "b"]);
  });
  it("lights a lane or one agent; the same spotlight again turns it off", () => {
    expect(inSpotlight(null, "x", "g1")).toBe(true);
    expect(inSpotlight({ kind: "lane", id: "g1" }, "x", "g1")).toBe(true);
    expect(inSpotlight({ kind: "lane", id: "g1" }, "x", "g2")).toBe(false);
    expect(inSpotlight({ kind: "agent", id: "x" }, "x", "g2")).toBe(true);
    expect(toggleSpotlight({ kind: "lane", id: "g1" }, { kind: "lane", id: "g1" })).toBeNull();
    expect(toggleSpotlight({ kind: "lane", id: "g1" }, { kind: "agent", id: "g1" })).toEqual({ kind: "agent", id: "g1" });
  });
  it("puts pinned cards first without reallocating when nothing moves", () => {
    const ids = ["a", "b", "c"];
    expect(pinnedFirst(ids, ["c"])).toEqual(["c", "a", "b"]);
    expect(pinnedFirst(ids, ["a"])).toBe(ids);
    expect(pinnedFirst(ids, [])).toBe(ids);
    expect(pinnedFirst(ids, ["z"])).toBe(ids);
  });
  it("maps 1–4 to the views", () => {
    expect(viewForKey("1")).toBe("graph");
    expect(viewForKey("4")).toBe("list");
    expect(viewForKey("5")).toBeNull();
  });
});

describe("find", () => {
  const agents: FindAgent[] = [
    { id: "1", name: "reviewer", role: "reviewer", lane: "Verify", branch: null },
    { id: "2", name: "builder-1", role: "builder", lane: "Build", branch: "gk/builder-1" },
    { id: "3", name: "docs", role: null, lane: "Docs", branch: null },
  ];
  const tasks: FindTask[] = [
    { line: 5, text: "Review the ledger branch", owners: ["reviewer"], state: "todo" },
    { line: 6, text: "Ledger posting", owners: ["builder-1"], state: "doing" },
  ];
  it("finds agents first, name prefixes leading, then tasks", () => {
    const hits = findHits("re", agents, tasks);
    expect(hits.map((h) => h.key)).toEqual(["a:1", "t:5"]);
    expect(findHits("ledger", agents, tasks).map((h) => h.key)).toEqual(["t:5", "t:6"]);
    expect(findHits("build", agents, tasks)[0]).toMatchObject({ kind: "agent", id: "2" });
  });
  it("needs every word and understands @owners", () => {
    expect(findHits("ledger @builder-1", agents, tasks).map((h) => h.key)).toEqual(["t:6"]);
    expect(findHits("@docs", agents, tasks).map((h) => h.key)).toEqual(["a:3"]);
    expect(findHits("   ", agents, tasks)).toEqual([]);
  });
  it("steps through hits with wrap-around", () => {
    expect(stepHit(-1, 3, 1)).toBe(0);
    expect(stepHit(-1, 3, -1)).toBe(2);
    expect(stepHit(2, 3, 1)).toBe(0);
    expect(stepHit(0, 0, 1)).toBe(-1);
  });
});

describe("list sorting", () => {
  const row = (p: Partial<ListRow> & Pick<ListRow, "id" | "order">): ListRow => ({
    name: p.id,
    role: null,
    lane: "Build",
    lamp: "idle",
    since: null,
    task: null,
    taskState: null,
    branch: null,
    evidence: "",
    cost: null,
    ctx: null,
    cpu: null,
    ram: null,
    out: null,
    ...p,
  });
  const rows = [
    row({ id: "b", order: 0, lamp: "working", cost: 1.5, since: 300 }),
    row({ id: "a", order: 1, lamp: "waiting", cost: null, since: 100 }),
    row({ id: "c", order: 2, lamp: "error", cost: 0.2, since: null }),
  ];
  it("sorts by name and by state (needs you first)", () => {
    expect(sortRows(rows, "name", "asc").map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(sortRows(rows, "state", "asc").map((r) => r.id)).toEqual(["a", "c", "b"]);
    expect(stateRank("waiting")).toBeLessThan(stateRank("idle"));
  });
  it("keeps empty values last in both directions", () => {
    expect(sortRows(rows, "cost", "desc").map((r) => r.id)).toEqual(["b", "c", "a"]);
    expect(sortRows(rows, "cost", "asc").map((r) => r.id)).toEqual(["c", "b", "a"]);
    expect(sortRows(rows, "since", "asc").map((r) => r.id)).toEqual(["a", "b", "c"]);
  });
  it("breaks ties by display order and flips on a second click", () => {
    const tie = [row({ id: "x", order: 1, name: "same" }), row({ id: "y", order: 0, name: "same" })];
    expect(sortRows(tie, "name", "desc").map((r) => r.id)).toEqual(["y", "x"]);
    expect(nextSort({ key: "name", dir: "asc" }, "name")).toEqual({ key: "name", dir: "desc" });
    expect(nextSort({ key: "name", dir: "asc" }, "cpu")).toEqual({ key: "cpu", dir: "desc" });
    expect(nextSort({ key: "cpu", dir: "desc" }, "lane")).toEqual({ key: "lane", dir: "asc" });
  });
});
