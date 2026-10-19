import { describe, expect, it } from "vitest";
import {
  addTask,
  addTaskOwner,
  changeTaskState,
  countOwned,
  currentTaskFor,
  deleteTask,
  editTaskText,
  matchesFilter,
  moveTask,
  newMissionText,
  ownerCompletion,
  planAdd,
  planMove,
  setTaskOwners,
  taskBlockEnd,
  taskSource,
  teamSlugs,
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

// ---- structural edits ------------------------------------------------------------------------------

const BOARD = [
  "# Mission: M", // 0
  "", // 1
  "## Tasks", // 2
  "- [ ] one @lead", // 3
  "  - note: about one", // 4
  "  more about one", // 5
  "- [~] two @builder-1", // 6
  "- [ ] three", // 7
  "", // 8
  "## Notes", // 9
  "keep me", // 10
  "",
].join("\n");
const crlf = (s: string) => s.replace(/\n/g, "\r\n");
const lines = (s: string) => s.split("\n");

describe("taskBlockEnd / taskSource", () => {
  it("covers the task line plus deeper-indented notes", () => {
    expect(taskBlockEnd(BOARD, 3)).toBe(6);
    expect(taskBlockEnd(BOARD, 6)).toBe(7);
    expect(taskBlockEnd(BOARD, 7)).toBe(8);
    expect(taskBlockEnd(BOARD, 4)).toBeNull();
    expect(taskSource(BOARD, 6)).toBe("- [~] two @builder-1");
    expect(taskSource(BOARD, 10)).toBeNull();
  });

  it("includes blank lines only between deeper lines and keeps a deeper fence whole", () => {
    const t = ["- [ ] a", "", "  cont", "", "- [ ] b", "  ```", "- [ ] not a task", "  ```", "x"].join("\n");
    expect(taskBlockEnd(t, 0)).toBe(3);
    expect(taskBlockEnd(t, 4)).toBe(8);
  });
});

describe("moveTask", () => {
  it("moves a task down with its notes, keeping every other line", () => {
    const out = moveTask(BOARD, 3, 8)!;
    expect(lines(out).slice(2, 9)).toEqual(["## Tasks", "- [~] two @builder-1", "- [ ] three", "- [ ] one @lead", "  - note: about one", "  more about one", ""]);
    expect(lines(out).slice(9)).toEqual(lines(BOARD).slice(9));
    expect(planMove(BOARD, 3, 8)!.line).toBe(5);
  });

  it("moves a task up (priority = order)", () => {
    const r = planMove(BOARD, 7, 3)!;
    expect(r.line).toBe(3);
    expect(parseMission(r.text).tasks.map((t) => t.text)).toEqual(["three", "one", "two"]);
  });

  it("is a no-op inside its own block and null for a non-task line", () => {
    expect(moveTask(BOARD, 3, 3)).toBe(BOARD);
    expect(moveTask(BOARD, 3, 5)).toBe(BOARD);
    expect(moveTask(BOARD, 3, 6)).toBe(BOARD); // right after its own block
    expect(moveTask(BOARD, 4, 0)).toBeNull();
    expect(moveTask(BOARD, 99, 0)).toBeNull();
  });

  it("snaps a target inside another task's notes to the end of that block", () => {
    const out = moveTask(BOARD, 7, 4)!;
    expect(parseMission(out).tasks.map((t) => t.text)).toEqual(["one", "three", "two"]);
    expect(lines(out)[4]).toBe("  - note: about one");
    expect(lines(out)[6]).toBe("- [ ] three");
  });

  it("keeps CRLF and mixed endings per line", () => {
    const c = crlf(BOARD);
    expect(moveTask(c, 7, 6)).toBe(crlf(moveTask(BOARD, 7, 6)!));
    expect(moveTask("- [ ] a\r\n- [ ] b\n", 1, 0)).toBe("- [ ] b\n- [ ] a\r\n");
  });

  it("keeps a missing final newline missing", () => {
    expect(moveTask("- [ ] a\n- [ ] b", 1, 0)).toBe("- [ ] b\n- [ ] a");
    expect(moveTask("- [ ] a\r\n- [ ] b", 0, 2)).toBe("- [ ] b\r\n- [ ] a");
  });

  it("moves tasks outside ## Tasks and ignores fenced examples", () => {
    const t = ["# M", "- [ ] loose", "```", "- [ ] example", "```", "## Tasks", "- [ ] real", ""].join("\n");
    expect(moveTask(t, 3, 0)).toBeNull();
    const out = moveTask(t, 1, 7)!;
    expect(lines(out)).toEqual(["# M", "```", "- [ ] example", "```", "## Tasks", "- [ ] real", "- [ ] loose", ""]);
  });
});

describe("deleteTask", () => {
  it("removes the task with its notes", () => {
    const out = deleteTask(BOARD, 3)!;
    expect(lines(out).slice(2, 5)).toEqual(["## Tasks", "- [~] two @builder-1", "- [ ] three"]);
    expect(lines(out)).toHaveLength(lines(BOARD).length - 3);
    expect(deleteTask(BOARD, 2)).toBeNull();
  });

  it("keeps endings, including a missing final newline", () => {
    expect(deleteTask("a\r\n- [ ] b\r\nc\r\n", 1)).toBe("a\r\nc\r\n");
    expect(deleteTask("a\n- [ ] b", 1)).toBe("a");
    expect(deleteTask("- [ ] only\n", 0)).toBe("");
  });
});

describe("changeTaskState", () => {
  it("changes the box like setTaskState", () => {
    expect(changeTaskState(BOARD, 7, "doing")).toBe(setTaskState(BOARD, 7, "doing"));
    expect(changeTaskState(BOARD, 6, "doing")).toBe(BOARD);
    expect(changeTaskState(BOARD, 4, "done")).toBeNull();
  });

  it("writes a blocked reason right after the box and removes it when unblocked", () => {
    const b = changeTaskState(crlf(BOARD), 6, "blocked", " needs\nthe secret ")!;
    expect(b.split("\r\n")[6]).toBe("- [!] blocked: needs the secret — two @builder-1");
    expect(parseMission(b).tasks[1]).toMatchObject({ state: "blocked", owners: ["builder-1"], text: "blocked: needs the secret — two" });
    const again = changeTaskState(b, 6, "blocked", "other")!;
    expect(again.split("\r\n")[6]).toBe("- [!] blocked: other — two @builder-1");
    expect(changeTaskState(b, 6, "todo")).toBe(crlf(BOARD).replace("- [~] two", "- [ ] two"));
    // An agent-written reason is left alone.
    expect(changeTaskState("- [!] Blocked: no key @x", 0, "todo")).toBe("- [ ] Blocked: no key @x");
  });
});

describe("addTask", () => {
  it("appends under ## Tasks after the section's last line", () => {
    const r = planAdd(crlf(BOARD), "  - [x] four @builder-2 ")!;
    expect(r.line).toBe(8);
    expect(r.text).toBe(crlf(BOARD).replace("- [ ] three\r\n", "- [ ] three\r\n- [ ] four @builder-2\r\n"));
    expect(parseMission(r.text).tasks[3]).toMatchObject({ text: "four", owners: ["builder-2"], state: "todo" });
  });

  it("can add in another state and right after an empty heading", () => {
    expect(addTask("# M\n## Tasks\n\n## Later\n", "x", "blocked")).toBe("# M\n## Tasks\n- [!] x\n\n## Later\n");
  });

  it("creates the heading when missing, keeping the final-newline state", () => {
    expect(addTask("# M\r\n\r\nctx\r\n", "a")).toBe("# M\r\n\r\nctx\r\n\r\n## Tasks\r\n- [ ] a\r\n");
    expect(addTask("# M\n", "a")).toBe("# M\n\n## Tasks\n- [ ] a\n");
    expect(addTask("# M\n\n", "a")).toBe("# M\n\n## Tasks\n- [ ] a\n");
    expect(addTask("# M", "a")).toBe("# M\n\n## Tasks\n- [ ] a");
    expect(addTask("", "a")).toBe("## Tasks\n- [ ] a\n");
  });

  it("ignores a ## Tasks heading inside a fence and rejects empty text", () => {
    expect(addTask("# M\n```\n## Tasks\n```\n", "a")).toBe("# M\n```\n## Tasks\n```\n\n## Tasks\n- [ ] a\n");
    expect(addTask(BOARD, "  ")).toBeNull();
    expect(addTask(BOARD, "- [ ] ")).toBeNull();
  });
});

describe("editTaskText", () => {
  it("replaces the text, keeping box and owners", () => {
    expect(lines(editTaskText(BOARD, 6, "two, better")!)[6]).toBe("- [~] two, better @builder-1");
    expect(editTaskText(BOARD, 6, " two ")).toBe(BOARD);
    expect(editTaskText(BOARD, 6, "")).toBeNull();
    expect(editTaskText(BOARD, 1, "x")).toBeNull();
  });

  it("keeps literal () and [] in the text; only brackets emptied by a removed owner go", () => {
    const doc = ["# M", "- [ ] Fix parse() crash in arr[] handling @builder (@lead)", ""].join("\n");
    expect(parseMission(doc).tasks[0].text).toBe("Fix parse() crash in arr[] handling");
    const out = setTaskOwners(doc, 1, ["tester"])!;
    expect(out.split("\n")[1]).toBe("- [ ] Fix parse() crash in arr[] handling @tester");
    expect(editTaskText(doc, 1, "Fix parse() and arr[] again")!.split("\n")[1]).toBe("- [ ] Fix parse() and arr[] again @builder @lead");
  });

  it("typed @tokens replace the owners; CRLF stays", () => {
    const out = editTaskText(crlf(BOARD), 3, "one for @Builder_2")!;
    expect(out.split("\r\n")[3]).toBe("- [ ] one for @Builder_2");
    expect(parseMission(out).tasks[0].owners).toEqual(["builder-2"]);
    expect(out.split("\r\n")[4]).toBe("  - note: about one");
  });
});

describe("owners on a task", () => {
  it("setTaskOwners replaces / clears the tokens", () => {
    expect(lines(setTaskOwners(BOARD, 3, ["@Builder 1", "reviewer", "builder-1"])!)[3]).toBe("- [ ] one @builder-1 @reviewer");
    expect(lines(setTaskOwners(BOARD, 3, [])!)[3]).toBe("- [ ] one");
    expect(setTaskOwners(BOARD, 3, ["lead"])).toBe(BOARD);
    expect(setTaskOwners(BOARD, 2, ["lead"])).toBeNull();
    expect(setTaskOwners(crlf(BOARD), 7, ["x"])).toBe(crlf(BOARD).replace("- [ ] three", "- [ ] three @x"));
  });

  it("addTaskOwner appends one token and is idempotent", () => {
    expect(lines(addTaskOwner(BOARD, 6, "Builder 2")!)[6]).toBe("- [~] two @builder-1 @builder-2");
    expect(addTaskOwner(BOARD, 6, "@builder-1")).toBe(BOARD);
    expect(addTaskOwner(BOARD, 6, "!!")).toBeNull();
    expect(addTaskOwner("- [ ] t  \r\nx", 0, "a")).toBe("- [ ] t @a\r\nx");
  });

  it("teamSlugs + ownerCompletion suggest name slugs then roles", () => {
    const slugs = teamSlugs(team);
    expect(slugs).toEqual(["lead", "builder-1", "builder-2", "codex-reviewer", "scratch", "builder", "reviewer"]);
    expect(ownerCompletion("fix it @bu", 10, slugs)).toEqual({ start: 7, prefix: "bu", matches: ["builder-1", "builder-2", "builder"] });
    expect(ownerCompletion("@", 1, slugs)?.matches).toHaveLength(slugs.length);
    expect(ownerCompletion("mail a@b", 8, slugs)).toBeNull();
    expect(ownerCompletion("fix @lead", 9, slugs)?.matches).toEqual([]);
  });
});

describe("matchesFilter", () => {
  const tasks = parseMission(SAMPLE).tasks;
  const names = (f: Parameters<typeof matchesFilter>[1], q = "", m: TeamMember | null = null) =>
    tasks.filter((t) => matchesFilter(t, f, q, team, m)).map((t) => t.text);
  it("filters by owner, assignment, state and text", () => {
    expect(names("all")).toHaveLength(4);
    expect(names("mine", "", team[2])).toEqual(["Add login button", "Blocked: needs client secret"]);
    expect(names("mine")).toEqual([]);
    expect(names("blocked")).toEqual(["Blocked: needs client secret"]);
    expect(tasks.filter((t) => matchesFilter(t, "unassigned", "", team.slice(1), null)).map((t) => t.text)).toEqual(["Design the token storage"]);
    expect(names("all", "LOGIN")).toEqual(["Add login button"]);
    expect(names("all", "@builder-1")).toEqual(["Implement /auth/callback"]);
  });
});
