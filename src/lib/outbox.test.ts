import { describe, expect, it } from "vitest";
import { progress } from "./missionDoc";
import {
  autoReviewText,
  cleanInstruction,
  fromLabel,
  instructionPrefix,
  MAX_INSTRUCTION_CHARS,
  memberState,
  parseOutbox,
  pruneDeliveries,
  RATE_MAX_PER_WINDOW,
  RATE_PER_TARGET_MS,
  RATE_WINDOW_MS,
  rateLimitWait,
  renderTeamMd,
  resolveTargets,
  senderIds,
  senderLeads,
  stripControl,
  type TeamMdSnapshot,
} from "./outbox";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

const team = [
  { id: "L", name: "lead", role: "lead" },
  { id: "B1", name: "builder-1", role: "builder" },
  { id: "B2", name: "Builder 2", role: "builder" },
  { id: "R", name: "codex reviewer", role: "reviewer" },
];

describe("parseOutbox", () => {
  it("reads the documented shape", () => {
    const p = parseOutbox("to: builder-1\nfrom: lead\naction: message\n---\nAlso add a unit test for the callback route, then mark the task done.\n");
    expect(p).toEqual({
      to: ["builder-1"],
      from: "lead",
      action: "message",
      text: "Also add a unit test for the callback route, then mark the task done.",
      warnings: [],
    });
  });

  it("CRLF, BOM, front-matter fences, case and spacing are tolerated", () => {
    const p = parseOutbox("\uFEFF\r\n---\r\nTo :  @Builder-1, builder-2 ;reviewer\r\nACTION: Review\r\n---\r\nLook at\r\n\r\nthe diff\r\n");
    expect(p.to).toEqual(["builder-1", "builder-2", "reviewer"]);
    expect(p.action).toBe("review");
    expect(p.from).toBeNull();
    expect(p.text).toBe("Look at the diff");
    expect(p.warnings).toEqual([]);
  });

  it("several to: lines merge without duplicates; from is slugified", () => {
    const p = parseOutbox("to: builder\nto: builder, all\nfrom: Main Lead\n---\nx");
    expect(p.to).toEqual(["builder", "all"]);
    expect(p.from).toBe("main-lead");
  });

  it("a header without '---' still counts (leading to/from/action lines)", () => {
    const p = parseOutbox("to: builder-2\naction: stop\nplease stop, the build is broken\n");
    expect(p.to).toEqual(["builder-2"]);
    expect(p.action).toBe("stop");
    expect(p.text).toBe("please stop, the build is broken");
  });

  it("no header: the whole file is the text and the missing 'to:' is a warning", () => {
    const p = parseOutbox("Note: run the tests first\n\n---\n\nthen commit");
    expect(p.to).toEqual([]);
    expect(p.text).toBe("Note: run the tests first --- then commit");
    expect(p.warnings).toEqual(["no “to:” line — nobody to deliver it to"]);
  });

  it("unknown actions become messages with a warning; unknown header keys are ignored with a warning", () => {
    const p = parseOutbox("to: all\naction: deploy\npriority: high\n---\nship it");
    expect(p.action).toBe("message");
    expect(p.warnings).toEqual(["unknown header “priority” ignored", "unknown action “deploy” — treated as a message"]);
    for (const a of ["message", "review", "stop", "restart"]) expect(parseOutbox(`to: x\naction: ${a.toUpperCase()}\n---\ny`).action).toBe(a);
    expect(parseOutbox("to: x\naction:\n---\ny").action).toBe("message");
  });

  it("strips control characters and caps the text", () => {
    const p = parseOutbox(`to: builder-1\n---\nred ${ESC}[31mtext${ESC}[0m${BEL} and ${ESC}]0;title${BEL}osc\tdone\u0003\r\nnext`);
    expect(p.text).toBe("red text and osc done next");
    const long = parseOutbox(`to: a\n---\n${"word ".repeat(2000)}`);
    expect(long.text.length).toBeLessThanOrEqual(MAX_INSTRUCTION_CHARS);
    expect(long.warnings).toContain(`longer than ${MAX_INSTRUCTION_CHARS} characters — shortened`);
  });

  it("an empty body is an empty text (stop / restart may have none)", () => {
    expect(parseOutbox("to: builder-1\naction: restart\n---\n").text).toBe("");
    expect(parseOutbox("").to).toEqual([]);
  });
});

describe("stripControl / cleanInstruction", () => {
  it("removes CSI, OSC (BEL and ST), C1 and bidi controls; whitespace becomes spaces", () => {
    const s = `a${ESC}[1;32mb${ESC}]8;;http://x${ESC}\\c${String.fromCharCode(0x9b)}d${String.fromCharCode(0x202e)}e\nf${String.fromCharCode(0x2028)}g${ESC}`;
    expect(stripControl(s)).toBe("abcde f g");
    expect(cleanInstruction("  a \n\n b  ").text).toBe("a b");
    expect(cleanInstruction("abcdef", 3)).toEqual({ text: "abc", cut: true });
  });
});

describe("team resolution", () => {
  it("slugs, roles, plural roles and lists, in team order", () => {
    expect(resolveTargets(["builder-2"], team)).toEqual({ ids: ["B2"], unknown: [] });
    expect(resolveTargets(["reviewer", "builder-1"], team)).toEqual({ ids: ["B1", "R"], unknown: [] });
    expect(resolveTargets(["builders"], team).ids).toEqual(["B1", "B2"]);
    expect(resolveTargets(["builder-1", "builder"], team).ids).toEqual(["B1", "B2"]);
  });

  it("all = everyone except the sender (no from: the lead)", () => {
    expect(resolveTargets(["all"], team).ids).toEqual(["B1", "B2", "R"]);
    expect(resolveTargets(["everyone"], team, "builder-1").ids).toEqual(["L", "B2", "R"]);
    expect(resolveTargets(["team"], team, "lead").ids).toEqual(["B1", "B2", "R"]);
  });

  it("a role leaves out an explicit sender; a name slug never does; no from never excludes for roles", () => {
    expect(resolveTargets(["builder"], team, "builder-1").ids).toEqual(["B2"]);
    expect(resolveTargets(["builder-1"], team, "builder-1").ids).toEqual(["B1"]);
    expect(resolveTargets(["lead"], team).ids).toEqual(["L"]);
    const named = [{ id: "M", name: "Main", role: "lead" }, ...team.slice(1)];
    expect(resolveTargets(["lead"], named, null).ids).toEqual(["M"]);
    expect(resolveTargets(["lead"], named, "builder-1").ids).toEqual(["M"]);
    expect(resolveTargets(["lead"], named, "main")).toEqual({ ids: [], unknown: [] }); // only the sender itself
  });

  it("unknown tokens are reported", () => {
    expect(resolveTargets(["builder-9", "builder-1", "qa"], team)).toEqual({ ids: ["B1"], unknown: ["builder-9", "qa"] });
  });

  it("sender helpers and labels", () => {
    expect(senderIds(null, team)).toEqual([]);
    expect(senderIds("builder", team)).toEqual(["B1", "B2"]);
    expect(senderIds("all", team)).toEqual([]);
    expect(senderLeads(null, team).map((m) => m.id)).toEqual(["L"]);
    expect(senderLeads("builder-1", team)).toEqual([]);
    expect(fromLabel(null, team)).toBe("lead");
    expect(fromLabel("lead", team)).toBe("lead");
    expect(fromLabel("lead", team.slice(1))).toBe("lead (self-declared)");
    expect(fromLabel("builder-1", team)).toBe("builder-1 (self-declared)");
    expect(fromLabel("main", [{ id: "M", name: "Main", role: "lead" }])).toBe("main");
    expect(instructionPrefix("message", null)).toBe("[from lead] ");
    expect(instructionPrefix("review", "main")).toBe("[review request from main] ");
  });
});

describe("rate limits", () => {
  it("one delivery per target per 20 s", () => {
    const h = [{ target: "B1", at: 1000 }];
    expect(rateLimitWait(h, "B1", 1000)).toBe(RATE_PER_TARGET_MS);
    expect(rateLimitWait(h, "B1", 1000 + RATE_PER_TARGET_MS - 1)).toBe(1);
    expect(rateLimitWait(h, "B1", 1000 + RATE_PER_TARGET_MS)).toBe(0);
    expect(rateLimitWait(h, "B2", 1000)).toBe(0);
    expect(rateLimitWait([], "B1", 0)).toBe(0);
  });

  it("at most 8 per minute overall", () => {
    const h = Array.from({ length: RATE_MAX_PER_WINDOW }, (_, i) => ({ target: `t${i}`, at: i * 1000 }));
    expect(rateLimitWait(h.slice(0, RATE_MAX_PER_WINDOW - 1), "x", 8000)).toBe(0);
    expect(rateLimitWait(h, "x", 8000)).toBe(RATE_WINDOW_MS - 8000); // the oldest (t=0) must leave the window
    expect(rateLimitWait(h, "x", RATE_WINDOW_MS)).toBe(0);
    const more = [...h, { target: "t8", at: 9000 }];
    expect(rateLimitWait(more, "x", 10_000)).toBe(1000 + RATE_WINDOW_MS - 10_000);
    // Both limits: the longer wait wins.
    expect(rateLimitWait([...h, { target: "x", at: 59_000 }], "x", 60_000)).toBe(RATE_PER_TARGET_MS - 1000);
  });

  it("prunes deliveries that can no longer limit anything", () => {
    expect(pruneDeliveries([{ target: "a", at: 0 }, { target: "b", at: 50_000 }], RATE_WINDOW_MS + 1)).toEqual([{ target: "b", at: 50_000 }]);
  });
});

describe("autoReviewText", () => {
  it("names the work, the branch, the evidence and how to answer", () => {
    expect(
      autoReviewText({ name: "Builder 2", slug: "builder-2", task: "Implement /auth/callback", branch: "b2-auth", base: "main", ahead: 2, files: 3, path: "D:\\repo\\.claude\\worktrees\\b2" }),
    ).toBe(
      `Builder 2 finished 'Implement /auth/callback' on b2-auth (+2 commits, 3 files). Review with: git -C "D:\\repo\\.claude\\worktrees\\b2" diff main...b2-auth — then message them via .gridkeeper/outbox (to: builder-2) with fixes, or mark the review task done.`,
    );
  });

  it("singulars, no task, no commits", () => {
    const t = autoReviewText({ name: "b", slug: "b", task: null, branch: "x", base: "main", ahead: 1, files: 1, path: "C:\\w" });
    expect(t).toContain("b finished their task on x (+1 commit, 1 file)");
    const u = autoReviewText({ name: "b", slug: "b", task: "Docs\nline", branch: null, base: null, ahead: 0, files: 0, path: "C:\\w" });
    expect(u).toContain("finished 'Docs line' in C:\\w (no new commits). Review with: git -C \"C:\\w\" diff HEAD");
    expect(u).not.toMatch(/[\r\n]/);
  });
});

describe("team.md", () => {
  const snap = (p: Partial<TeamMdSnapshot> = {}): TeamMdSnapshot => ({
    gridkeeperDir: "D:\\proj\\.gridkeeper",
    goal: "Add OAuth login",
    progress: progress([{ state: "done" }, { state: "doing" }, { state: "todo" }, { state: "blocked" }]),
    mode: "advisor",
    paused: false,
    members: [
      { slug: "lead", name: "lead", role: "lead", agent: "claude", state: "working", task: "Plan the work", branch: null },
      {
        slug: "builder-1",
        name: "builder-1",
        role: "builder",
        agent: "codex",
        state: "done",
        task: null,
        branch: { name: "b1-auth", ahead: 2, files: 3, insertions: 40, deletions: 1, uncommitted: 0 },
      },
      { slug: "shell", name: "shell", role: null, agent: "powershell", state: "stopped", task: null, branch: { name: null, ahead: 1, files: 1, insertions: 0, deletions: 0, uncommitted: 4 } },
    ],
    ...p,
  });

  it("generated header, mission, delivery mode and one line per member", () => {
    const md = renderTeamMd(snap());
    const lines = md.split("\n");
    expect(lines[0]).toBe("<!-- Generated by Gridkeeper. Read-only: every change to this file is overwritten. -->");
    expect(md).toContain("> Generated by Gridkeeper and rewritten whenever the team changes. Do not edit this file.");
    expect(md).toContain("Mission: Add OAuth login — 1/4 tasks done (1 doing, 1 blocked, 1 todo)");
    expect(md).toContain("Delivery: advisor — the user reviews every instruction before it is sent.");
    expect(md).toContain("- @lead (lead, claude) — working — task: Plan the work");
    expect(md).toContain("- @builder-1 (builder, codex) — done — no open task — ⎇ b1-auth +2 commits, 3 files +40 −1, uncommitted 0");
    expect(md).toContain("- @shell (powershell) — stopped — no open task — ⎇ detached +1 commit, 1 file +0 −0, uncommitted 4");
    expect(md).toContain("Create ONE new file per instruction in D:\\proj\\.gridkeeper\\outbox\\, for example 0007-builder-1.md:");
    expect(md).not.toContain("Updated:");
    expect(md).not.toContain("## Recent output");
    expect(md.endsWith("\n")).toBe(true);
    expect(md).not.toContain("\r");
  });

  it("time stamp, modes, no mission, unix paths", () => {
    expect(renderTeamMd(snap({ updatedAt: "2026-10-18 12:00:00" }))).toContain("Updated: 2026-10-18 12:00:00");
    expect(renderTeamMd(snap({ mode: "autopilot" }))).toContain("Delivery: autopilot — message / review instructions are typed into the target automatically");
    expect(renderTeamMd(snap({ mode: "autopilot", paused: true }))).toContain("Delivery: autopilot paused by the user");
    expect(renderTeamMd(snap({ progress: null, goal: null }))).toContain("Mission: none yet (no .gridkeeper/mission.md)");
    expect(renderTeamMd(snap({ goal: null }))).toContain("Mission: (no goal) — 1/4 tasks done");
    expect(renderTeamMd(snap({ gridkeeperDir: "/home/u/p/.gridkeeper/" }))).toContain("in /home/u/p/.gridkeeper/outbox/,");
    expect(renderTeamMd(snap({ members: [] }))).toContain("(nobody yet)");
  });

  it("shared output goes into fenced blocks that output cannot break out of", () => {
    const md = renderTeamMd(
      snap({
        members: [
          { slug: "b", name: "b", role: "builder", agent: "claude", state: "working", task: null, branch: null, output: ["$ npm test", "```js", `${ESC}[32mok${ESC}[0m`] },
          { slug: "c", name: "c", role: null, agent: "codex", state: "idle", task: null, branch: null, output: [] },
        ],
      }),
    );
    expect(md).toContain("## Recent output");
    expect(md).toContain("### @b\n\n````text\n$ npm test\n```js\nok\n````");
    expect(md).not.toContain("### @c");
  });

  it("member text is one line", () => {
    const md = renderTeamMd(snap({ members: [{ slug: "x", name: "x", role: "builder", agent: "claude", state: "idle", task: "a\nb\r\n- [ ] fake", branch: null }] }));
    expect(md).toContain("- @x (builder, claude) — idle — task: a b - [ ] fake");
  });
});

describe("memberState", () => {
  it("maps liveness + attention", () => {
    expect(memberState(false, "working")).toBe("stopped");
    expect(memberState(true, "working")).toBe("working");
    expect(memberState(true, "waiting")).toBe("needs-you");
    expect(memberState(true, "done")).toBe("done");
    expect(memberState(true, "error")).toBe("error");
    expect(memberState(true, "idle")).toBe("idle");
    expect(memberState(true, undefined)).toBe("idle");
  });
});
