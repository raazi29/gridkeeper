import { describe, expect, it } from "vitest";
import {
  buildFormationPlan,
  builtinTemplate,
  DEFAULT_PARAMS,
  describePlan,
  formationBranch,
  formationStamp,
  parseAgentKey,
  PROFILE_RR,
  PROFILE_SAVED,
  sanitizeTemplate,
  templateFromWorkspace,
  type PlanInput,
} from "./formationPlan";

const profiles = [
  { id: "p1", name: "work" },
  { id: "p2", name: "personal" },
  { id: "p3", name: "team" },
];

function input(p: Partial<PlanInput> = {}): PlanInput {
  return {
    template: builtinTemplate("pbv", DEFAULT_PARAMS),
    projectDir: "D:\\code\\app",
    repoRoot: "D:\\code\\app",
    useWorktrees: true,
    branchPrefix: "gk/",
    stamp: "1017-1530",
    profiles,
    profileByRole: { lead: "p1", builder: PROFILE_RR, verifier: "p3" },
    prompts: {},
    existingWorktrees: [{ path: "D:\\code\\app", branch: "main" }],
    liveProfileUse: {},
    ...p,
  };
}

describe("builtin templates", () => {
  it("Plan · Build · Verify has a lead, N builders with own worktrees and a reviewer (+ verifier)", () => {
    const t = builtinTemplate("pbv", { ...DEFAULT_PARAMS, builders: 4, builderAgent: "codex", verifier: false });
    expect(t.groups.map((g) => g.name)).toEqual(["Plan", "Build", "Verify"]);
    expect(t.groups[0].slots).toEqual([{ role: "lead", agent: "claude" }]);
    expect(t.groups[1].slots.map((s) => [s.role, s.agent, s.worktreeKey])).toEqual([
      ["builder", "codex", "builder-1"],
      ["builder", "codex", "builder-2"],
      ["builder", "codex", "builder-3"],
      ["builder", "codex", "builder-4"],
    ]);
    expect(t.groups[2].slots).toEqual([{ role: "reviewer", agent: "codex" }]);
  });
  it("clamps counts", () => {
    expect(builtinTemplate("pbv", { ...DEFAULT_PARAMS, builders: 99 }).groups[1].slots).toHaveLength(8);
    expect(builtinTemplate("swarm", { ...DEFAULT_PARAMS, scouts: 0 }).groups[0].slots).toHaveLength(1);
    expect(builtinTemplate("swarm", { ...DEFAULT_PARAMS, scouts: 40 }).groups[0].slots).toHaveLength(16);
  });
  it("Pair shares one worktree between builder and reviewer", () => {
    const plan = buildFormationPlan(input({ template: builtinTemplate("pair", DEFAULT_PARAMS) }));
    expect(plan.worktrees).toHaveLength(1);
    expect(plan.groups[0].sessions.map((s) => s.cwd)).toEqual([plan.worktrees[0].path, plan.worktrees[0].path]);
    expect(plan.groups[0].layout).toBe("columns");
  });
});

describe("buildFormationPlan", () => {
  it("names branches <prefix><stamp>/<key> and paths <repo>-worktrees/<flattened>", () => {
    const plan = buildFormationPlan(input());
    expect(plan.errors).toEqual([]);
    expect(plan.worktrees.map((w) => w.branch)).toEqual(["gk/1017-1530/builder-1", "gk/1017-1530/builder-2", "gk/1017-1530/builder-3"]);
    expect(plan.worktrees[0].path).toBe("D:\\code\\app-worktrees\\gk-1017-1530-builder-1");
    expect(plan.worktrees[0].command).toBe('git worktree add -b gk/1017-1530/builder-1 "D:\\code\\app-worktrees\\gk-1017-1530-builder-1"');
    const build = plan.groups[1].sessions;
    expect(build.map((s) => s.name)).toEqual(["builder-1", "builder-2", "builder-3"]);
    expect(build.map((s) => s.cwd)).toEqual(plan.worktrees.map((w) => w.path));
    expect(plan.groups[0].sessions[0]).toMatchObject({ name: "lead", role: "lead", agent: "claude", cwd: "D:\\code\\app", worktreeKey: null });
    expect(plan.sessionCount).toBe(6);
  });
  it("spreads builders round-robin across Claude profiles, least-used first", () => {
    const plan = buildFormationPlan(input());
    // lead = p1 and verifier = p3 are explicit, so the first builder gets the unused p2.
    expect(plan.groups[1].sessions.map((s) => s.profileId)).toEqual(["p2", "p1", "p2"]);
    // Already-live sessions count as usage too.
    const live = buildFormationPlan(input({ profileByRole: { lead: "", builder: PROFILE_RR, verifier: "" }, liveProfileUse: { p1: 2, p2: 1 } }));
    expect(live.groups[1].sessions.map((s) => s.profileId)).toEqual(["p3", "p2", "p3"]);
    expect(plan.groups[0].sessions[0].profileId).toBe("p1");
    expect(plan.groups[2].sessions.map((s) => [s.role, s.profileId])).toEqual([
      ["reviewer", null],
      ["verifier", "p3"],
    ]);
  });
  it("round-robin wraps and falls back to the default profile without profiles", () => {
    const t = builtinTemplate("pbv", { ...DEFAULT_PARAMS, builders: 5 });
    const plan = buildFormationPlan(input({ template: t, profiles: profiles.slice(0, 2), profileByRole: { lead: "", builder: PROFILE_RR, verifier: "" } }));
    expect(plan.groups[1].sessions.map((s) => s.profileId)).toEqual(["p1", "p2", "p1", "p2", "p1"]);
    const none = buildFormationPlan(input({ profiles: [], profileByRole: {} }));
    expect(none.groups[1].sessions.every((s) => s.profileId === null && s.profileName === "default")).toBe(true);
  });
  it("warns when one profile would run in more than one concurrent session (incl. live ones)", () => {
    const one = buildFormationPlan(input({ profiles: [profiles[0]], profileByRole: { lead: "p1", builder: PROFILE_RR, verifier: "p1" } }));
    expect(one.warnings.some((w) => w.includes("“work”") && w.includes("#91708"))).toBe(true);
    const live = buildFormationPlan(input({ template: builtinTemplate("pair", DEFAULT_PARAMS), profileByRole: { builder: "p2" }, liveProfileUse: { p2: 1 } }));
    expect(live.warnings.some((w) => w.includes("“personal”") && w.includes("2 concurrent"))).toBe(true);
    const spread = buildFormationPlan(input({ profileByRole: { lead: "p1", builder: PROFILE_RR, verifier: "p3" }, template: builtinTemplate("pbv", { ...DEFAULT_PARAMS, builders: 1 }) }));
    expect(spread.warnings).toEqual([]);
  });
  it("works without worktrees (everyone in the project folder)", () => {
    const plan = buildFormationPlan(input({ useWorktrees: false }));
    expect(plan.worktrees).toEqual([]);
    expect(plan.groups.flatMap((g) => g.sessions).every((s) => s.cwd === "D:\\code\\app" && s.worktreeKey === null)).toBe(true);
  });
  it("validates: folder, repo for worktrees, branch prefix, collisions", () => {
    expect(buildFormationPlan(input({ projectDir: "  " })).errors).toContain("Choose a project folder.");
    expect(buildFormationPlan(input({ repoRoot: null })).errors[0]).toMatch(/Git repository/);
    expect(buildFormationPlan(input({ repoRoot: null, useWorktrees: false })).errors).toEqual([]);
    expect(buildFormationPlan(input({ branchPrefix: "bad prefix/" })).errors.some((e) => e.includes("Branch prefix"))).toBe(true);
    const taken = buildFormationPlan(input({ existingWorktrees: [{ path: "D:\\code\\app-worktrees\\gk-1017-1530-builder-2", branch: "gk/1017-1530/builder-2" }] }));
    expect(taken.errors.some((e) => e.includes("already checked out"))).toBe(true);
    expect(taken.errors.some((e) => e.includes("already exists"))).toBe(true);
  });
  it("attaches starter prompts per role", () => {
    const plan = buildFormationPlan(input({ prompts: { builder: "  read TODO.md  ", lead: "" } }));
    expect(plan.groups[1].sessions.every((s) => s.prompt === "read TODO.md")).toBe(true);
    expect(plan.groups[0].sessions[0].prompt).toBeNull();
    expect(describePlan(plan)).toContain("starter prompt once it is idle");
  });
  it("describes every git command and session", () => {
    const text = describePlan(buildFormationPlan(input()));
    expect(text).toContain('cd "D:\\code\\app"');
    expect(text.match(/git worktree add -b/g)).toHaveLength(3);
    expect(text).toContain("# group “Build” (grid)");
    expect(text).toContain("account personal");
  });
});

describe("helpers", () => {
  it("formats branch names and stamps", () => {
    expect(formationBranch("gk/", "1017-1530", "builder-1")).toBe("gk/1017-1530/builder-1");
    expect(formationBranch("", "", "pair")).toBe("pair");
    expect(formationStamp(new Date(2026, 9, 7, 9, 5))).toBe("1007-0905");
  });
  it("parses agent keys", () => {
    expect(parseAgentKey("claude")).toEqual({ agent: "claude", preset: null, command: null });
    expect(parseAgentKey("preset:hermes")).toEqual({ agent: "generic", preset: "hermes", command: null });
    expect(parseAgentKey("command:C:\\t\\x.exe")).toEqual({ agent: "generic", preset: null, command: "C:\\t\\x.exe" });
  });
});

describe("saved formations", () => {
  const snapshot = templateFromWorkspace(
    "My team",
    [
      {
        name: "Main",
        layout: "columns",
        sessions: [
          { name: "Boss", role: "lead", agent: "claude", preset: null, command: null, args: [], profileId: "p2", hasWorktree: false },
          { name: "Hands", role: null, agent: "codex", preset: null, command: null, args: ["--model", "x"], profileId: null, hasWorktree: true },
        ],
      },
      { name: "Empty", layout: "grid", sessions: [] },
    ],
    "id1",
  );
  it("snapshots groups, roles, agents and accounts (empty groups dropped)", () => {
    expect(snapshot.groups).toHaveLength(1);
    expect(snapshot.groups[0].slots).toEqual([
      { role: "lead", agent: "claude", name: "Boss", worktreeKey: undefined, profileId: "p2", args: [] },
      { role: "agent", agent: "codex", name: "Hands", worktreeKey: "wt-1", profileId: undefined, args: ["--model", "x"] },
    ]);
  });
  it("re-plans with saved profiles and explicit names", () => {
    const plan = buildFormationPlan(input({ template: snapshot, profileByRole: { lead: PROFILE_SAVED } }));
    expect(plan.groups[0].sessions.map((s) => [s.name, s.profileId])).toEqual([
      ["Boss", "p2"],
      ["Hands", null],
    ]);
    expect(plan.worktrees.map((w) => w.branch)).toEqual(["gk/1017-1530/wt-1"]);
  });
  it("sanitizes untrusted stored templates", () => {
    expect(sanitizeTemplate(null)).toBeNull();
    expect(sanitizeTemplate({ id: "x", name: "y", groups: [] })).toBeNull();
    const t = sanitizeTemplate(JSON.parse(JSON.stringify(snapshot)));
    expect(t?.groups[0].slots[1].worktreeKey).toBe("wt-1");
    const evil = sanitizeTemplate({ id: "e", name: "e", groups: [{ name: "g", layout: "weird", slots: [{ agent: "claude", role: "Lead!!", worktreeKey: "../../x" }] }] });
    expect(evil?.groups[0]).toMatchObject({ layout: "grid", slots: [{ role: "lead", worktreeKey: "x" }] });
  });
});
