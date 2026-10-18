import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionInfo } from "../lib/types";

const writes: [string, string, number][] = [];
const tails: Record<string, string> = {};
vi.mock("../lib/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/ipc")>();
  return {
    ...real,
    ipc: {
      ...real.ipc,
      sessionWrite: vi.fn(async (id: string, data: string) => {
        if (id === "boom") throw { message: "pipe closed" };
        writes.push([id, data, Date.now()]);
      }),
      sessionOutputTail: vi.fn(async (id: string) => tails[id] ?? "ready\n> "),
    },
  };
});

const { briefText, channelBriefText, formationBriefPrompts, gatherBrief, leadControlOn, planBrief, projectDirOfMission, sendBrief, skipReason } = await import(
  "./missionBrief"
);
const { setPolicy } = await import("../store/leadControl");
const { useApp } = await import("../store/appStore");
const { useAttention } = await import("../store/attention");
const { useActivity } = await import("../store/activity");

const PATH = "D:\\proj\\.gridkeeper\\mission.md";
const team = [
  { name: "lead", role: "lead" },
  { name: "builder-1", role: "builder" },
  { name: "Builder 2", role: "builder" },
  { name: "codex reviewer", role: "reviewer" },
];
const ctx = { missionPath: PATH, team };

const info = (id: string, state: SessionInfo["state"]): SessionInfo => ({
  id,
  name: id,
  agent: "claude",
  pid: 1,
  state,
  cwd: "C:\\",
  profileId: null,
  commandDisplay: "",
  startedAt: "t",
  endedAt: null,
  bytesOut: 0,
});

describe("briefText", () => {
  it("lead: split the mission into tasks with owners from the rest of the team", () => {
    expect(briefText({ name: "lead", role: "lead" }, ctx)).toBe(
      `You are the lead. Our mission is in ${PATH}. Break it into concrete tasks in that file under '## Tasks' using '- [ ] task @owner' with owners from: @builder-1 (builder), @builder-2 (builder), @codex-reviewer (reviewer); @builder tags every member of that role. Keep tasks small. Update the file as plans change.`,
    );
    expect(briefText({ name: "lead", role: "lead" }, { missionPath: PATH, team: [team[0]] })).toContain("owners from: @lead (you; no teammates yet)");
  });

  it("builder: claim / finish / block own tasks, commit on the branch", () => {
    expect(briefText({ name: "Builder 2", role: "builder" }, ctx)).toBe(
      `You are Builder 2 (builder). Read ${PATH}. Work on tasks tagged @builder-2 or @builder: mark '[~]' when you start, '[x]' when done, '[!] reason' if blocked. Commit your work on your branch. Don't edit other people's tasks.`,
    );
  });

  it("no role / custom role / name equal to the role", () => {
    expect(briefText({ name: "scratch", role: null }, ctx)).toContain("You are scratch. Read");
    expect(briefText({ name: "scratch", role: null }, ctx)).toContain("tasks tagged @scratch:");
    expect(briefText({ name: "docs writer", role: "docs" }, ctx)).toContain("tagged @docs-writer or @docs:");
    expect(briefText({ name: "builder", role: "builder" }, ctx)).toContain("tagged @builder:");
  });

  it("reviewer / verifier: review-oriented, no code changes", () => {
    const r = briefText({ name: "codex reviewer", role: "reviewer" }, ctx);
    expect(r).toMatch(/^You are codex reviewer \(reviewer\)\. Read .*Review the diff behind every task marked '\[x\]'/);
    expect(r).toContain("@codex-reviewer or @reviewer");
    expect(r).toContain("Don't change code yourself");
    expect(briefText({ name: "v", role: "verifier" }, ctx)).toContain("Run the tests, lint and checks for every task marked '[x]'");
  });

  it("scout: findings, no code changes", () => {
    expect(briefText({ name: "scout-1", role: "scout" }, ctx)).toContain("Don't change code.");
  });

  it("role-wide text (formation starter prompt) names the role and its panes", () => {
    const t = briefText({ name: null, role: "builder", names: ["builder-1", "builder-2"] }, { missionPath: PATH, team });
    expect(t).toBe(
      `You are a builder. Read ${PATH}. Work on tasks tagged @builder or your own pane name (@builder-1, @builder-2): mark '[~]' when you start, '[x]' when done, '[!] reason' if blocked. Commit your work on your branch. Don't edit other people's tasks.`,
    );
    // A lead brief never lists the lead itself.
    expect(briefText({ name: null, role: "lead", names: ["lead"] }, ctx)).not.toContain("@lead (");
  });

  it("a session named after its role is 'the <role>'", () => {
    expect(briefText({ name: "Reviewer", role: "reviewer" }, ctx)).toMatch(/^You are the reviewer\. Read /);
  });

  it("formationBriefPrompts: one text per role key, single-member roles get their own name", () => {
    const planned = [
      { name: "lead", role: "lead" },
      { name: "builder-1", role: "builder" },
      { name: "builder-2", role: "builder" },
      { name: "reviewer", role: "reviewer" },
      { name: "shell", role: null },
    ];
    const p = formationBriefPrompts(["lead", "builder", "reviewer", "agent"], planned, PATH);
    expect(Object.keys(p)).toEqual(["lead", "builder", "reviewer", "agent"]);
    expect(p.lead).toContain("owners from: @builder-1 (builder), @builder-2 (builder), @reviewer, @shell; @builder tags every member of that role");
    expect(p.builder).toContain("You are a builder. Read");
    expect(p.builder).toContain("(@builder-1, @builder-2)");
    expect(p.reviewer).toMatch(/^You are the reviewer\./);
    expect(p.agent).toContain("You are shell. Read");
  });

  it("is always one line", () => {
    expect(briefText({ name: "a\r\nb", role: "builder" }, { missionPath: "C:\\x\ny", team })).not.toMatch(/[\r\n]/);
  });
});

describe("planBrief", () => {
  it("skips sessions that are not running or are asking something; ignores browser panes", () => {
    const base = { role: "builder", terminal: true, live: true, waiting: false, question: false };
    const { recipients, skipped } = planBrief(
      [
        { ...base, id: "a", name: "builder-1" },
        { ...base, id: "b", name: "b", waiting: true },
        { ...base, id: "c", name: "c", question: true },
        { ...base, id: "d", name: "d", live: false },
        { ...base, id: "w", name: "web", terminal: false },
      ],
      ctx,
    );
    expect(recipients.map((r) => r.id)).toEqual(["a"]);
    expect(recipients[0].text).toContain("@builder-1 or @builder");
    expect(skipped.map((s) => [s.id, s.reason])).toEqual([
      ["b", "waiting for you (answer it first)"],
      ["c", "asking something (answer it first)"],
      ["d", "not running"],
    ]);
  });

  it("skipReason order: not running beats waiting", () => {
    expect(skipReason({ live: false, waiting: true, question: true })).toBe("not running");
    expect(skipReason({ live: true, waiting: false, question: false })).toBeNull();
  });
});

describe("gatherBrief / sendBrief", () => {
  beforeEach(() => {
    writes.length = 0;
    for (const k of Object.keys(tails)) delete tails[k];
    useActivity.setState({ events: [] });
    useAttention.setState({ sessions: {} });
    const s = useApp.getState();
    useApp.setState({
      persisted: {
        ...s.persisted,
        sessions: [
          { id: "L", name: "lead", role: "lead", agent: "claude" },
          { id: "B", name: "builder-1", role: "builder", agent: "claude" },
          { id: "Q", name: "builder-2", role: "builder", agent: "claude" },
          { id: "S", name: "stopped", role: null, agent: "claude" },
          { id: "W", name: "docs", kind: "browser", agent: "powershell" },
        ] as never,
      },
      runtime: { L: info("L", { state: "running" }), B: info("B", { state: "running" }), Q: info("Q", { state: "running" }), W: info("W", { state: "running" }) },
    });
  });

  it("gathers recipients with role texts and lists the skipped ones", async () => {
    tails.Q = "Do you want to allow this edit? (y/n)";
    const { recipients, skipped } = await gatherBrief(["L", "B", "Q", "S", "W"], PATH);
    expect(recipients.map((r) => r.id)).toEqual(["L", "B"]);
    expect(recipients[0].text).toContain("owners from: @builder-1 (builder), @builder-2 (builder), @stopped");
    expect(skipped.map((s) => s.id)).toEqual(["Q", "S"]);
  });

  it("types the line, waits ~80 ms, then sends Enter; logs each send", async () => {
    const r = await sendBrief([{ id: "B", name: "builder-1", text: "hello\nteam" }]);
    expect(r).toEqual({ sent: ["builder-1"], skipped: [], failed: [] });
    expect(writes.map(([id, d]) => [id, d])).toEqual([
      ["B", "hello team"],
      ["B", "\r"],
    ]);
    expect(writes[1][2] - writes[0][2]).toBeGreaterThanOrEqual(70);
    const ev = useActivity.getState().events;
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ sessionId: "B", kind: "mission", result: "sent" });
  });

  it("re-checks right before sending: a session that started asking is skipped, nothing typed", async () => {
    useAttention.setState({ sessions: { L: { state: "waiting", unread: true, at: 0 } } });
    tails.B = "Do you trust the files in this folder?";
    const r = await sendBrief([
      { id: "L", name: "lead", text: "x" },
      { id: "B", name: "builder-1", text: "y" },
      { id: "S", name: "stopped", text: "z" },
    ]);
    expect(r.sent).toEqual([]);
    expect(r.skipped.sort()).toEqual(["builder-1", "lead", "stopped"]);
    expect(writes).toEqual([]);
    expect(useActivity.getState().events.every((e) => e.result === "skipped")).toBe(true);
  });

  it("reports failures", async () => {
    useApp.setState({ runtime: { ...useApp.getState().runtime, boom: info("boom", { state: "running" }) } });
    const r = await sendBrief([{ id: "boom", name: "boom", text: "x" }]);
    expect(r.failed).toEqual(["boom"]);
    expect(useActivity.getState().events[0]).toMatchObject({ level: "error", result: "failed" });
  });

  it("explains the lead control channel only while lead control is on for the project", async () => {
    let { recipients } = await gatherBrief(["L", "B"], PATH);
    expect(recipients[0].text).not.toContain("outbox");
    setPolicy("d:/PROJ", { mode: "advisor" });
    try {
      ({ recipients } = await gatherBrief(["L", "B"], PATH));
      expect(recipients[0].text).toContain("D:\\proj\\.gridkeeper\\team.md");
      expect(recipients[1].text).toContain("with a line 'to: lead'");
    } finally {
      setPolicy("D:\\proj", { mode: "off" });
    }
  });
});

describe("lead control channel in briefs", () => {
  const OUTBOX = "D:\\proj\\.gridkeeper\\outbox\\";

  it("lead: team.md, how to write an instruction, reviews, the user decides delivery", () => {
    expect(channelBriefText("lead", PATH)).toBe(
      `Team status (who is working, waiting, done, on which branch) is in D:\\proj\\.gridkeeper\\team.md, generated by Gridkeeper (read it, never edit it). To instruct a teammate, create ONE new file per instruction in ${OUTBOX} (e.g. 0001-builder-1.md) with a line 'to: <name, role or all>', optionally 'action: review' (or stop / restart), then a line '---', then the instruction text; never edit or delete files already there. When you are asked to review finished work, check its diff and message the author with fixes, or mark the review task done. The user decides whether these instructions are delivered automatically or wait for their approval.`,
    );
  });

  it("everyone else: how to message the lead", () => {
    expect(channelBriefText("builder", PATH)).toBe(`To message the lead, create a new file in ${OUTBOX} with a line 'to: lead', then a line '---', then your message.`);
    expect(channelBriefText(null, "/home/u/p/.gridkeeper/mission.md")).toContain("in /home/u/p/.gridkeeper/outbox/ with");
  });

  it("briefText appends it with ctx.channel; the base text is unchanged", () => {
    const lead = briefText({ name: "lead", role: "lead" }, { ...ctx, channel: true });
    expect(lead.startsWith(briefText({ name: "lead", role: "lead" }, ctx))).toBe(true);
    expect(lead).toContain(`create ONE new file per instruction in ${OUTBOX}`);
    const b = briefText({ name: "Builder 2", role: "builder" }, { ...ctx, channel: true });
    expect(b).toMatch(/Don't edit other people's tasks\. To message the lead, create a new file in /);
    expect(b).not.toMatch(/[\r\n]/);
  });

  it("formation prompts follow the project's policy unless told otherwise", () => {
    const planned = [
      { name: "lead", role: "lead" },
      { name: "builder-1", role: "builder" },
    ];
    expect(formationBriefPrompts(["lead"], planned, PATH).lead).not.toContain("outbox");
    expect(formationBriefPrompts(["lead", "builder"], planned, PATH, true).builder).toContain("'to: lead'");
    setPolicy("D:\\proj", { mode: "autopilot" });
    try {
      expect(leadControlOn(PATH)).toBe(true);
      expect(formationBriefPrompts(["lead"], planned, PATH).lead).toContain("team.md");
    } finally {
      setPolicy("D:\\proj", { mode: "off" });
    }
    expect(leadControlOn(PATH)).toBe(false);
  });

  it("projectDirOfMission", () => {
    expect(projectDirOfMission(PATH)).toBe("D:\\proj");
    expect(projectDirOfMission("/home/u/p/.gridkeeper/mission.md")).toBe("/home/u/p");
  });
});
