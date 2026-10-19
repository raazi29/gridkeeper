// mission-recap: git output -> replay events (fixture text only, no git needed), scrubbing, defaults.
import { describe, expect, it } from "vitest";
import { toEvent, type ReplayEvent } from "../../../src/replay/events";
import { buildTimeline } from "../../../src/replay/timeline";
import * as core from "../scripts/lib/core.mjs";

// ---- fixtures -------------------------------------------------------------------------------------

interface C {
  sha: string;
  parents?: string[];
  t: number; // seconds
  author?: string;
  subject: string;
  body?: string;
  files?: [number | "-", number | "-", string][];
}

const T = 1_760_000_000; // a fixed epoch second
const sha = (n: number) => n.toString(16).padStart(40, "a");
const rec = (c: C) =>
  `\x1e${c.sha}\x1f${(c.parents ?? []).join(" ")}\x1f${c.t}\x1f${c.author ?? "Ada Lovelace"}\x1f${c.subject}\x1f${c.body ?? ""}\x1d\n\n` +
  (c.files ?? []).map(([i, d, p]) => `${i}\t${d}\t${p}`).join("\n") +
  "\n";
/** git log prints newest first. */
const log = (...cs: C[]) => [...cs].sort((a, b) => b.t - a.t).map(rec).join("");

const lane = (branch: string, commits: C[], extra: Partial<{ base: boolean; folder: string | null; createdAt: number | null; merged: boolean }> = {}) => ({
  branch,
  base: false,
  folder: null,
  createdAt: null,
  merged: false,
  ...extra,
  commits: core.parseLog(log(...commits)),
});

const valid = (events: unknown[]) => events.map((e) => toEvent(e)).filter((e): e is ReplayEvent => !!e);

// ---- git parsing ------------------------------------------------------------------------------------

describe("parseLog", () => {
  it("reads hash, parents, time, author, subject, agent trailer and numstat", () => {
    const out = core.parseLog(
      log(
        { sha: sha(1), t: T, subject: "Add login button", body: "Longer text.\n\nCo-Authored-By: Claude <noreply@anthropic.com>", files: [[10, 2, "src/a.ts"], ["-", "-", "logo.png"]] },
        { sha: sha(2), parents: [sha(1)], t: T + 60, subject: "Fix it", files: [[1, 1, "src/a.ts"]] },
      ),
    );
    expect(out.map((c) => c.subject)).toEqual(["Fix it", "Add login button"]);
    expect(out[1]).toMatchObject({ sha: sha(1), parents: [], t: T * 1000, author: "Ada Lovelace", agent: "claude" });
    expect(out[1].files).toEqual([
      { path: "src/a.ts", ins: 10, del: 2 },
      { path: "logo.png", ins: 0, del: 0 },
    ]);
    expect(out[0].parents).toEqual([sha(1)]);
    expect(out[0].agent).toBe("");
  });

  it("skips garbage and empty input", () => {
    expect(core.parseLog("")).toEqual([]);
    expect(core.parseLog("\x1enot-a-hash\x1f\x1f1\x1fa\x1fb\x1f\x1d")).toEqual([]);
  });

  it("detects agent CLIs only in trailers", () => {
    expect(core.agentHint("Co-authored-by: Codex <codex@openai.com>")).toBe("codex");
    expect(core.agentHint("Generated with Gemini CLI")).toBe("gemini");
    expect(core.agentHint("We talked about claude in the body only")).toBe("");
  });
});

describe("worktrees, refs, reflog", () => {
  it("parses `git worktree list --porcelain`", () => {
    const text = "worktree /repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /repo-wt/b1\nHEAD def\nbranch refs/heads/gk/1017-1530/builder-1\n\nworktree /repo-wt/x\nHEAD 123\ndetached\n";
    expect(core.parseWorktrees(text)).toEqual([
      { path: "/repo", head: "abc", branch: "main", detached: false, bare: false },
      { path: "/repo-wt/b1", head: "def", branch: "gk/1017-1530/builder-1", detached: false, bare: false },
      { path: "/repo-wt/x", head: "123", branch: null, detached: true, bare: false },
    ]);
  });

  it("parses for-each-ref lines", () => {
    expect(core.parseRefs(`main\t${sha(1)}\t${T}\nbad line\n`)).toEqual([{ name: "main", sha: sha(1), t: T * 1000 }]);
  });

  it("finds the branch creation entry (oldest reflog line)", () => {
    const text = `${sha(3)}\trefs/heads/b@{${T + 100}}\tcommit: second\n${sha(2)}\trefs/heads/b@{${T}}\tbranch: Created from HEAD\n`;
    expect(core.parseCreation(text)).toEqual({ sha: sha(2), t: T * 1000 });
    expect(core.parseCreation(`${sha(2)}\trefs/heads/b@{${T}}\tclone: from https://example.com/x.git\n`)).toBeNull();
    expect(core.parseCreation("")).toBeNull();
  });
});

// ---- lanes ------------------------------------------------------------------------------------------

describe("lanes", () => {
  it("names lanes after the last branch segment, longer on collisions, with short ids", () => {
    expect(core.laneNames(["main", "gk/1017-1530/builder-1", "gk/1017-1530/builder-2"])).toEqual(["main", "builder-1", "builder-2"]);
    expect(core.laneNames(["a/x/builder", "b/y/builder"])).toEqual(["x/builder", "y/builder"]);
    expect(core.laneNames(["worktree-agent-a7a23264f9c48ecb1", "main"])).toEqual(["agent-a7a2326", "main"]);
  });

  it("infers roles from lane names", () => {
    expect(core.inferRole("builder-1")).toBe("builder");
    expect(core.inferRole("gk-reviewer")).toBe("reviewer");
    expect(core.inferRole("leads")).toBe("lead");
    expect(core.inferRole("oauth-login")).toBeNull();
  });

  it("gives each commit to one lane: branches first (smallest first), the base lane last", () => {
    const shared = { sha: sha(1), t: T, subject: "builder work" };
    const out = core.assignCommits([
      lane("feature", [shared, { sha: sha(2), t: T + 10, subject: "lead work" }], { base: true }),
      lane("builder-1", [shared]),
    ]);
    expect(out[0].commits.map((c: { sha: string }) => c.sha)).toEqual([sha(2)]);
    expect(out[1].commits.map((c: { sha: string }) => c.sha)).toEqual([sha(1)]);
  });
});

// ---- events -----------------------------------------------------------------------------------------

describe("buildEvents", () => {
  const main = lane(
    "main",
    [
      { sha: sha(1), t: T, subject: "Plan the OAuth flow", files: [[20, 0, "docs/plan.md"]] },
      { sha: sha(9), parents: [sha(8), sha(3)], t: T + 900, subject: "Merge branch 'gk/x/builder-1'" },
    ],
    { base: true, folder: "/home/ada/repo", merged: false },
  );
  const b1 = lane(
    "gk/x/builder-1",
    [
      { sha: sha(2), t: T + 300, subject: "Implement /auth/callback in src/auth/callback.ts", files: [[100, 4, "src/auth/callback.ts"], [5, 0, "src/auth/index.ts"]] },
      { sha: sha(3), t: T + 600, subject: "Store tokens in the keychain", body: "Co-Authored-By: Claude <noreply@anthropic.com>", files: [[30, 10, "src/auth/callback.ts"]] },
    ],
    { folder: "/home/ada/repo-wt/builder-1", createdAt: (T + 120) * 1000, merged: true },
  );
  const b2 = lane("gk/x/builder-2", [{ sha: sha(4), t: T + 400, subject: "Login button", author: "Grace Hopper", files: [[12, 1, "src/ui/Login.tsx"]] }], {
    folder: "/home/ada/repo-wt/builder-2",
  });

  it("emits a valid recording: start, joins, branch counters, attention, comms", () => {
    const res = core.buildEvents({ goal: "Add OAuth login", lanes: [main, b1, b2], board: null, t0: (T - 3600) * 1000 });
    const events = valid(res.events);
    expect(events.length).toBe(res.events.length);
    expect(events[0]).toMatchObject({ k: "start", goal: "Add OAuth login", t: T * 1000 });
    const start = events[0] as Extract<ReplayEvent, { k: "start" }>;
    expect(start.team.map((m) => m.slug)).toEqual(["main"]);
    // builder-1 joins when its branch was created, builder-2 at its first commit.
    expect(events.filter((e) => e.k === "join").map((e) => [e.k === "join" && e.slug, e.t])).toEqual([
      ["builder-1", (T + 120) * 1000],
      ["builder-2", (T + 400) * 1000],
    ]);
    expect(res.lanes.map((l: { name: string; commits: number }) => [l.name, l.commits])).toEqual([
      ["main", 2],
      ["builder-1", 2],
      ["builder-2", 1],
    ]);
    // Roles from names, agent from trailers; no author names by default.
    const join1 = events.find((e) => e.k === "join" && e.slug === "builder-1");
    expect(join1).toMatchObject({ role: "builder", agent: "claude" });
    expect(JSON.stringify(res.events)).not.toContain("Grace");

    const tl = buildTimeline(events);
    expect(tl.stats.commits).toBe(5);
    expect(tl.stats.ins).toBe(20 + 135 + 12);
    expect(tl.stats.del).toBe(14 + 1);
    // Files are unique per lane: callback.ts twice on builder-1 counts once.
    expect(tl.stats.files).toBe(1 + 2 + 1);
    expect(tl.stats.agents).toBe(3);
    expect(tl.final.agents.find((a) => a.slug === "builder-1")?.attn).toBe("done"); // merged
    expect(tl.final.agents.find((a) => a.slug === "builder-2")?.attn).toBe("working");
  });

  it("puts commit subjects (paths removed) and merges in the comms ticker", () => {
    const res = core.buildEvents({ goal: "x", lanes: [main, b1, b2], board: null, t0: null });
    const msgs = res.events.filter((e: ReplayEvent) => e.k === "msg") as Extract<ReplayEvent, { k: "msg" }>[];
    // Routes stay ("/auth/callback" is not a file), the file path goes.
    expect(msgs.map((m) => m.text)).toContain("Implement /auth/callback in ‹path›");
    const merge = msgs.find((m) => m.to.length === 1);
    expect(merge).toMatchObject({ from: "main", to: ["builder-1"], text: "merged builder-1 into main" });
    const quiet = core.buildEvents({ goal: "x", lanes: [main, b1, b2], board: null, t0: null, subjects: false });
    expect(quiet.events.filter((e: ReplayEvent) => e.k === "msg")).toHaveLength(1); // the merge only
  });

  it("never writes paths, e-mails or hashes", () => {
    const res = core.buildEvents({ goal: "Fix C:\\Users\\ada\\repo for ada@example.com", lanes: [main, b1, b2], board: null, t0: null, showAuthors: true });
    const s = JSON.stringify(res.events);
    expect(s).not.toMatch(/\/home\/ada|C:\\\\Users|example\.com|src\/auth|callback\.ts/);
    expect(s).not.toContain(sha(2));
    expect(s).toContain("Grace Hopper"); // --show-authors
  });

  it("ticks a final board off in commit order, on the owners' commits", () => {
    const doc = core.parseMission(
      ["# Mission: Add OAuth login", "", "## Tasks", "- [x] Plan the flow @main", "- [x] Callback route @builder-1", "- [x] Token storage @builder-1", "- [~] Login button @builder-2", "- [!] Blocked: needs the secret @builder-2", "- [ ] Review @reviewer"].join("\n"),
    );
    const res = core.buildEvents({ goal: doc.goal, lanes: [main, b1, b2], board: { kind: "final", doc }, t0: null });
    const events = valid(res.events);
    const start = events[0] as Extract<ReplayEvent, { k: "start" }>;
    expect(start.tasks.map((t) => t.s)).toEqual(["todo", "todo", "todo", "todo", "todo", "todo"]);
    const doneAt = (text: string) => events.find((e) => e.k === "task" && e.text === text && e.s === "done")?.t;
    expect(doneAt("Callback route")).toBe((T + 300) * 1000); // builder-1's first commit
    expect(doneAt("Token storage")).toBe((T + 600) * 1000); // builder-1's second commit
    expect(doneAt("Plan the flow")).toBe((T + 900) * 1000); // main's commits: plan, then the merge
    const tl = buildTimeline(events);
    expect(tl.stats.tasksDone).toBe(3);
    expect(tl.stats.tasksTotal).toBe(6);
    const final = Object.fromEntries(tl.final.tasks.map((t) => [t.text, t.s]));
    expect(final).toEqual({
      "Plan the flow": "done",
      "Callback route": "done",
      "Token storage": "done",
      "Login button": "doing",
      "Blocked: needs the secret": "blocked",
      Review: "todo",
    });
    // main owns only done tasks -> done.
    expect(tl.final.agents.find((a) => a.slug === "main")?.attn).toBe("done");
  });

  it("replays a tracked mission.md from its history", () => {
    const v1 = core.parseMission("# Mission: M\n- [ ] A @builder-1\n- [ ] B @builder-2\n");
    const v2 = core.parseMission("# Mission: M\n- [x] A @builder-1\n- [~] B @builder-2\n");
    const v3 = core.parseMission("# Mission: M\n- [x] A @builder-1\n- [x] B @builder-2\n- [ ] C\n");
    const res = core.buildEvents({
      goal: "M",
      lanes: [main, b1, b2],
      board: { kind: "history", snaps: [{ t: null, doc: v1 }, { t: (T + 500) * 1000, doc: v2 }, { t: (T + 1200) * 1000, doc: v3 }] },
      t0: null,
    });
    const events = valid(res.events);
    const tasks = events.filter((e) => e.k === "task").map((e) => e.k === "task" && [e.t, e.text, e.s]);
    expect(tasks).toEqual([
      [(T + 500) * 1000, "A", "done"],
      [(T + 500) * 1000, "B", "doing"],
      [(T + 1200) * 1000, "B", "done"],
      [(T + 1200) * 1000, "C", "todo"],
    ]);
    expect(buildTimeline(events).stats.tasksDone).toBe(2);
  });

  it("returns no events when nothing happened", () => {
    expect(core.buildEvents({ goal: "x", lanes: [lane("main", [], { base: true })], board: null, t0: null }).events).toEqual([]);
  });
});

// ---- recordings -------------------------------------------------------------------------------------

describe("Gridkeeper recordings", () => {
  const rec1 = [
    { t: 1000, k: "start", v: 1, goal: "Old mission", team: [], tasks: [] },
    { t: 2000, k: "task", text: "x", s: "done", o: [] },
  ];
  const rec2 = [
    { t: 10_000, k: "start", v: 1, goal: "Ship it", team: [{ slug: "b1", name: "Builder 1", role: "builder", agent: "claude", live: true }], tasks: [] },
    { t: 11_000, k: "msg", from: "lead", to: ["b1"], text: "see C:\\Users\\ada\\notes.txt" },
  ];
  const rec3 = [
    { t: 20_000, k: "start", v: 1, goal: "Ship it", team: [], tasks: [] },
    { t: 21_000, k: "attn", slug: "b1", s: "done" },
  ];

  it("picks the recordings of the latest goal that overlap the window", () => {
    const parse = (r: object[]) => core.parseReplay(r.map((e) => JSON.stringify(e)).join("\n")).events;
    const picked = core.pickRecordings(
      [
        { name: "a.jsonl", events: parse(rec1) },
        { name: "b.jsonl", events: parse(rec2) },
        { name: "c.jsonl", events: parse(rec3) },
      ],
      5000,
    );
    expect(picked?.names).toEqual(["b.jsonl", "c.jsonl"]);
    expect(picked?.goal).toBe("Ship it");
    expect(core.pickRecordings([{ name: "a.jsonl", events: parse(rec1) }], 5000)).toBeNull();
  });

  it("scrubs recordings again and applies --goal", () => {
    const events = core.parseReplay(rec2.map((e) => JSON.stringify(e)).join("\n")).events;
    const out = core.sanitizeRecording(events, "New title");
    expect(out[0]).toMatchObject({ k: "start", goal: "New title" });
    expect(out[1]).toMatchObject({ k: "msg", text: "see ‹path›" });
  });
});

// ---- scrubbing and defaults -------------------------------------------------------------------------

describe("scrubSubject", () => {
  it.each([
    ["Fix crash in src/replay/render.ts", "Fix crash in ‹path›"],
    ["Update README.md and package.json", "Update ‹file› and ‹file›"],
    ["Touch a.ts, b.ts, c.rs", "Touch ‹files›"],
    ["Bump deps, touch Cargo.lock", "Bump deps, touch ‹file›"],
    ["Run ./scripts/dev", "Run ‹path›"],
    ["Support Windows/Ubuntu/macOS and read/write", "Support Windows/Ubuntu/macOS and read/write"],
    ["Port to Node.js 22", "Port to Node.js 22"],
    ["Mail ada@example.com about /home/ada/x", "Mail ‹email› about ‹path›"],
    ["Version 1.2/1.3 notes", "Version 1.2/1.3 notes"],
  ])("%s", (input, want) => {
    expect(core.scrubSubject(input)).toBe(want);
  });
});

describe("defaults", () => {
  it("parses options and their defaults", () => {
    expect(core.parseArgs([])).toMatchObject({ repo: null, since: null, goal: null, out: null, aspect: "landscape", length: 30, watermark: true, showAuthors: false, subjects: true, replay: true, mp4: null, gif: null });
    expect(core.parseArgs(["--aspect", "9:16", "--length=45", "--no-watermark", "--show-authors", "--goal", "Ship it"])).toMatchObject({ aspect: "vertical", length: 45, watermark: false, showAuthors: true, goal: "Ship it" });
    expect(core.parseArgs(["--mp4"]).mp4).toBe("");
    expect(core.parseArgs(["--mp4", "out.mp4", "--gif"])).toMatchObject({ mp4: "out.mp4", gif: "" });
    expect(() => core.parseArgs(["--length", "20"])).toThrow(/15, 30, 45 or 60/);
    expect(() => core.parseArgs(["--aspect", "4:3"])).toThrow(/landscape/);
    expect(() => core.parseArgs(["--since"])).toThrow(/needs a value/);
    expect(() => core.parseArgs(["--frobnicate"])).toThrow(/unknown option/);
  });

  it("starts at the merge-base on a feature branch, else at the start of today", () => {
    expect(core.defaultWindow({ current: "feat/x", defaultBranch: "main" })).toBe("merge-base");
    expect(core.defaultWindow({ current: null, defaultBranch: "main" })).toBe("merge-base"); // detached
    expect(core.defaultWindow({ current: "main", defaultBranch: "main" })).toBe("today");
    expect(core.defaultWindow({ current: "main", defaultBranch: null })).toBe("today");
    const d = new Date(core.startOfDay(new Date(2026, 9, 19, 15, 42).getTime()));
    expect([d.getHours(), d.getMinutes(), d.getDate()]).toEqual([0, 0, 19]);
  });

  it("resolves the goal: flag, mission, recording, branch, last commit", () => {
    const base = { flag: null, mission: null, recording: null, branch: "main", defaultBranch: "main", lastSubject: "Fix src/a.ts" };
    expect(core.resolveGoal({ ...base, flag: "Given", mission: "Board" })).toBe("Given");
    expect(core.resolveGoal({ ...base, mission: "Board" })).toBe("Board");
    expect(core.resolveGoal({ ...base, recording: "Recorded" })).toBe("Recorded");
    expect(core.resolveGoal({ ...base, branch: "feat/oauth-login" })).toBe("Oauth login");
    expect(core.resolveGoal(base)).toBe("Fix ‹path›");
    expect(core.resolveGoal({ ...base, lastSubject: null })).toBeNull();
  });
});
