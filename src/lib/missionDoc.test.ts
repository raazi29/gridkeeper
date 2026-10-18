import { describe, expect, it } from "vitest";
import {
  countOwned,
  currentTaskFor,
  newMissionText,
  nextState,
  ownerMatches,
  ownersFor,
  ownsTask,
  parseMission,
  progress,
  setTaskState,
  slugify,
  stateOfBox,
  unknownOwners,
  type TeamMember,
} from "./missionDoc";

const SAMPLE = [
  "# Mission: Add OAuth login",
  "",
  "We use the existing session table.",
  "Keep the old password login working.",
  "",
  "## Tasks",
  "- [ ] Design the token storage @lead",
  "- [~] Implement /auth/callback @builder-1",
  "- [x] Add login button @builder-2",
  "- [!] Blocked: needs client secret @builder-2",
  "",
].join("\n");

const team: TeamMember[] = [
  { id: "L", name: "lead", role: "lead" },
  { id: "B1", name: "builder-1", role: "builder" },
  { id: "B2", name: "Builder 2", role: "builder" },
  { id: "R", name: "Codex_Reviewer", role: "reviewer" },
  { id: "X", name: "scratch", role: null },
];

describe("slugify", () => {
  it("lowercases, maps spaces / underscores to dashes and drops other characters", () => {
    expect(slugify("Builder 2")).toBe("builder-2");
    expect(slugify("Codex_Reviewer")).toBe("codex-reviewer");
    expect(slugify("  API · docs!  ")).toBe("api-docs");
    expect(slugify("a  --  b")).toBe("a-b");
    expect(slugify("")).toBe("");
    expect(slugify(null)).toBe("");
    expect(slugify("ビルダー")).toBe("");
  });
});

describe("parseMission", () => {
  it("parses goal, context and tasks with states and owners", () => {
    const d = parseMission(SAMPLE);
    expect(d.goal).toBe("Add OAuth login");
    expect(d.context).toBe("We use the existing session table.\nKeep the old password login working.");
    expect(d.tasks).toEqual([
      { line: 6, text: "Design the token storage", state: "todo", owners: ["lead"] },
      { line: 7, text: "Implement /auth/callback", state: "doing", owners: ["builder-1"] },
      { line: 8, text: "Add login button", state: "done", owners: ["builder-2"] },
      { line: 9, text: "Blocked: needs client secret", state: "blocked", owners: ["builder-2"] },
    ]);
  });

  it("accepts every box spelling", () => {
    expect(["[ ]", "[]", "[~]", "[-]", "[/]", "[x]", "[X]", "[!]"].map((b) => parseMission(`- ${b} t`).tasks[0]?.state)).toEqual([
      "todo",
      "todo",
      "doing",
      "doing",
      "doing",
      "done",
      "done",
      "blocked",
    ]);
    expect(stateOfBox("?")).toBe("todo");
  });

  it("finds tasks anywhere, with any bullet and indentation, and handles CRLF", () => {
    const d = parseMission("# Goal\r\n\r\n* [ ] one\r\n  + [x] two\r\n1. [~] three\r\n2) [!] four\r\nnot - [ ] a task\r\n-[ ] no space\r\n");
    expect(d.goal).toBe("Goal");
    expect(d.tasks.map((t) => [t.line, t.text, t.state])).toEqual([
      [2, "one", "todo"],
      [3, "two", "done"],
      [4, "three", "doing"],
      [5, "four", "blocked"],
    ]);
  });

  it("ignores tasks in fenced code and HTML comments", () => {
    const d = parseMission(["# M", "```", "- [ ] example @x", "```", "<!-- - [ ] hidden", "- [ ] hidden too -->", "<!-- one line -->", "- [ ] real"].join("\n"));
    expect(d.tasks.map((t) => t.text)).toEqual(["real"]);
    expect(d.context).toBe("");
  });

  it("collects several owners, dedupes, slugifies and ignores e-mail addresses", () => {
    const t = parseMission("- [ ] pair on it @Builder_1 @reviewer, @builder-1 (@lead) mail a@b.com").tasks[0];
    expect(t.owners).toEqual(["builder-1", "reviewer", "lead"]);
    expect(t.text).toBe("pair on it , mail a@b.com");
  });

  it("is lenient about the goal heading", () => {
    expect(parseMission("# Mission — Ship it").goal).toBe("Ship it");
    expect(parseMission("# mission:   Ship it  ").goal).toBe("Ship it");
    expect(parseMission("# Ship it #").goal).toBe("Ship it");
    expect(parseMission("# Mission").goal).toBeNull();
    expect(parseMission("## Tasks\n- [ ] a").goal).toBeNull();
    expect(parseMission("").tasks).toEqual([]);
    // Only the first H1 is the goal; context stops at the next heading.
    const d = parseMission("intro\n# First\nctx\n## Notes\nnot ctx\n# Second");
    expect(d.goal).toBe("First");
    expect(d.context).toBe("ctx");
  });

  it("stops the context at the first task", () => {
    expect(parseMission("# G\n\nctx one\n\n\n\nctx two\n- [ ] t\nafter").context).toBe("ctx one\n\nctx two");
  });
});

describe("setTaskState", () => {
  it("rewrites only that line's box and keeps LF", () => {
    const out = setTaskState(SAMPLE, 6, "doing")!;
    expect(out).toBe(SAMPLE.replace("- [ ] Design", "- [~] Design"));
    expect(parseMission(out).tasks[0].state).toBe("doing");
  });

  it("keeps CRLF and mixed endings byte for byte", () => {
    const crlf = SAMPLE.replace(/\n/g, "\r\n");
    expect(setTaskState(crlf, 7, "done")).toBe(crlf.replace("- [~] Implement", "- [x] Implement"));
    const mixed = "# M\r\n- [ ] a\n- [ ] b\r\n";
    expect(setTaskState(mixed, 2, "blocked")).toBe("# M\r\n- [ ] a\n- [!] b\r\n");
  });

  it("keeps indentation, bullet and the rest of the line", () => {
    expect(setTaskState("  12) [] do it   @x  ", 0, "done")).toBe("  12) [x] do it   @x  ");
  });

  it("returns null for a line that is not a task and the same text for a no-op", () => {
    expect(setTaskState(SAMPLE, 0, "done")).toBeNull();
    expect(setTaskState(SAMPLE, 99, "done")).toBeNull();
    expect(setTaskState(SAMPLE, -1, "done")).toBeNull();
    expect(setTaskState(SAMPLE, 8, "done")).toBe(SAMPLE);
  });
});

describe("nextState", () => {
  it("cycles todo -> doing -> done -> todo; blocked -> todo", () => {
    expect(["todo", "doing", "done", "blocked"].map((s) => nextState(s as never))).toEqual(["doing", "done", "todo", "todo"]);
  });
});

describe("newMissionText", () => {
  it("writes a parseable file with goal, context, a format note and tasks", () => {
    const text = newMissionText("  Add   OAuth ", "Context line\r\nsecond", ["- [ ] first @lead", "", "  * second", "3. third @builder", "[x] fourth"]);
    expect(text.endsWith("\n")).toBe(true);
    expect(text).not.toContain("\r");
    const d = parseMission(text);
    expect(d.goal).toBe("Add OAuth");
    expect(d.context).toBe("Context line\nsecond");
    expect(d.tasks.map((t) => [t.text, t.state, t.owners])).toEqual([
      ["first", "todo", ["lead"]],
      ["second", "todo", []],
      ["third", "todo", ["builder"]],
      ["fourth", "todo", []],
    ]);
    expect(text).toContain("## Tasks");
  });

  it("works without context or tasks", () => {
    const d = parseMission(newMissionText("Goal", "", []));
    expect(d).toEqual({ goal: "Goal", context: "", tasks: [] });
  });
});

describe("owners", () => {
  it("match a session by name slug or role (singular or plural) or everyone", () => {
    expect(ownerMatches("builder-2", team[2])).toBe(true);
    expect(ownerMatches("builder", team[2])).toBe(true);
    expect(ownerMatches("builders", team[1])).toBe(true);
    expect(ownerMatches("codex-reviewer", team[3])).toBe(true);
    expect(ownerMatches("reviewer", team[1])).toBe(false);
    expect(ownerMatches("all", team[4])).toBe(true);
    expect(ownerMatches("scratch", team[4])).toBe(true);
  });

  it("ownersFor resolves to session ids in team order", () => {
    expect(ownersFor({ owners: ["builder"] }, team)).toEqual(["B1", "B2"]);
    expect(ownersFor({ owners: ["codex-reviewer", "lead"] }, team)).toEqual(["L", "R"]);
    expect(ownersFor({ owners: ["nobody"] }, team)).toEqual([]);
    expect(ownersFor({ owners: [] }, team)).toEqual([]);
    expect(ownersFor({ owners: ["team"] }, team)).toHaveLength(5);
    expect(unknownOwners({ owners: ["nobody", "lead"] }, team)).toEqual(["nobody"]);
    expect(ownsTask({ owners: ["builder"] }, team[0])).toBe(false);
  });

  it("currentTaskFor prefers the first doing task, else the first todo", () => {
    const { tasks } = parseMission(SAMPLE);
    expect(currentTaskFor(tasks, team[1])?.text).toBe("Implement /auth/callback");
    expect(currentTaskFor(tasks, team[0])?.text).toBe("Design the token storage");
    expect(currentTaskFor(tasks, team[2])).toBeNull(); // only done / blocked tasks
    const more = parseMission("- [ ] a @builder\n- [~] b @builder-2\n- [~] c @builder").tasks;
    expect(currentTaskFor(more, team[2])?.text).toBe("b");
    expect(currentTaskFor(more, team[1])?.text).toBe("c");
  });

  it("countOwned counts tasks owned by any member once", () => {
    const { tasks } = parseMission(SAMPLE);
    expect(countOwned(tasks, [team[1], team[2]])).toBe(3);
    expect(countOwned(tasks, [team[3]])).toBe(0);
    expect(countOwned(tasks, [])).toBe(0);
  });
});

describe("progress", () => {
  it("counts states and the done fraction", () => {
    expect(progress(parseMission(SAMPLE).tasks)).toEqual({ total: 4, done: 1, doing: 1, todo: 1, blocked: 1, fraction: 0.25 });
    expect(progress([])).toEqual({ total: 0, done: 0, doing: 0, todo: 0, blocked: 0, fraction: 0 });
  });
});
