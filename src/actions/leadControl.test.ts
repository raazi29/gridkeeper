import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BranchSummary, MissionChanged, MissionFile, OutboxItem, SessionInfo, SessionMeta } from "../lib/types";

// ---- mocks: the Rust side ------------------------------------------------------------------------------

const DIR = "D:\\proj";
const WT1 = "D:\\proj\\.claude\\worktrees\\b1";

const listeners: ((ev: MissionChanged) => void)[] = [];
const outbox = new Map<string, OutboxItem[]>();
const mission = new Map<string, string>();
const tails: Record<string, string> = {};
const writes: [string, string][] = [];
const archives: [string, string, string][] = [];
const teamWrites: [string, string][] = [];
const summaries: Record<string, BranchSummary> = {};

const NO_REPO: BranchSummary = {
  isRepo: false,
  branch: null,
  base: null,
  ahead: 0,
  behind: 0,
  filesChanged: 0,
  insertions: 0,
  deletions: 0,
  uncommitted: 0,
  lastCommitSubject: null,
  lastCommitMs: null,
};

vi.mock("../lib/ipc", () => ({
  errorMessage: (e: unknown) => (e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : String(e)),
  onMissionChanged: (cb: (ev: MissionChanged) => void) => {
    listeners.push(cb);
    return Promise.resolve(() => {
      const i = listeners.indexOf(cb);
      if (i >= 0) listeners.splice(i, 1);
    });
  },
  ipc: {
    missionRead: vi.fn(async (dir: string): Promise<MissionFile> => {
      const text = mission.get(dir);
      const path = `${dir}\\.gridkeeper\\mission.md`;
      return text === undefined ? { path, exists: false, text: "", modifiedMs: null } : { path, exists: true, text, modifiedMs: text.length };
    }),
    missionWatch: vi.fn(async () => {}),
    missionUnwatch: vi.fn(async () => {}),
    missionOutboxList: vi.fn(async (dir: string) => (outbox.get(dir) ?? []).map((i) => ({ ...i }))),
    missionOutboxArchive: vi.fn(async (dir: string, name: string, disposition: string) => {
      archives.push([dir, name, disposition]);
      const list = outbox.get(dir) ?? [];
      const i = list.findIndex((x) => x.name === name);
      if (i < 0) throw { code: "not_found", message: "gone" };
      list.splice(i, 1);
      return `${dir}\\.gridkeeper\\outbox\\${disposition}\\${name}`;
    }),
    missionTeamWrite: vi.fn(async (dir: string, text: string) => void teamWrites.push([dir, text])),
    sessionWrite: vi.fn(async (id: string, data: string) => void writes.push([id, data])),
    sessionOutputTail: vi.fn(async (id: string) => tails[id] ?? "ready\n> "),
    gitBranchSummary: vi.fn(async (path: string) => summaries[path] ?? NO_REPO),
    log: vi.fn(),
  },
}));

const confirmStop = vi.fn(async (_id: string, _name: string) => {});
const confirmRestart = vi.fn(async (_id: string, _name: string, _mode: unknown, _live: boolean) => {});
vi.mock("../components/menus/sessionMenu", () => ({
  confirmStop: (id: string, name: string) => confirmStop(id, name),
  confirmRestart: (id: string, name: string, mode: unknown, live: boolean) => confirmRestart(id, name, mode, live),
}));

const { ipc } = await import("../lib/ipc");
const { useApp } = await import("../store/appStore");
const { useAttention } = await import("../store/attention");
const { useActivity } = await import("../store/activity");
const { resetMissionDocsForTests } = await import("../store/missionDoc");
const { refreshBranchSummary, resetBranchSummaries } = await import("./handoff");
const store = await import("../store/leadControl");
const lc = await import("./leadControl");

// ---- team fixture -------------------------------------------------------------------------------------

const layout = { preset: "grid" as const, maximized: null, sizes: {} };

function meta(id: string, name: string, role: string | null, p: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id,
    name,
    agent: "claude",
    cwd: DIR,
    profileId: null,
    command: null,
    args: [],
    env: [],
    autoStart: false,
    resumeOnRestore: { mode: "none" },
    agentSessionId: null,
    worktree: null,
    createdAt: null,
    lastExitCode: null,
    role,
    ...p,
  };
}

function running(id: string, startedAt = "t1"): SessionInfo {
  return { id, name: id, agent: "claude", pid: 1, state: { state: "running" }, cwd: DIR, profileId: null, commandDisplay: "", startedAt, endedAt: null, bytesOut: 0 };
}

function setupTeam(extra: SessionMeta[] = []) {
  const metas = [meta("L", "lead", "lead"), meta("B1", "builder-1", "builder", { worktree: { path: WT1, branch: "b1" } }), meta("B2", "Builder 2", "builder"), ...extra];
  useApp.setState({ loaded: true, runtime: Object.fromEntries(metas.map((m) => [m.id, running(m.id)])), focusedSessionId: null });
  useApp.setState((s) => ({
    persisted: {
      ...s.persisted,
      activeWorkspaceId: "w1",
      sessions: metas,
      workspaces: [{ id: "w1", name: "W", projectDir: DIR, createdAt: null, activeGroupId: "g1", groups: [{ id: "g1", name: "Main", layout, sessionIds: metas.map((m) => m.id) }] }],
    },
  }));
  useAttention.setState({ sessions: Object.fromEntries(metas.map((m) => [m.id, { state: "idle" as const, unread: false, at: 0 }])), feed: [] });
}

function attn(id: string, state: "working" | "waiting" | "done" | "idle" | "error") {
  useAttention.setState((s) => ({ sessions: { ...s.sessions, [id]: { state, unread: false, at: Date.now() } } }));
}

const item = (name: string, text: string, ageMs = 60_000): OutboxItem => ({ name, text, modifiedMs: Date.now() - ageMs, truncated: false });
const putOutbox = (...items: OutboxItem[]) => outbox.set(DIR, items);
const emit = (file?: "mission" | "outbox", projectDir = DIR) => {
  for (const l of [...listeners]) l({ projectDir, file });
};
const settle = async () => {
  for (let i = 0; i < 25; i++) await vi.advanceTimersByTimeAsync(0);
};
const flush = async (ms: number) => {
  await vi.advanceTimersByTimeAsync(ms);
  await settle();
};
const proposals = () => store.useLeadControl.getState().proposals;
const typed = () => writes.filter(([, d]) => d !== "\r");
const missionEvents = () => useActivity.getState().events.filter((e) => e.kind === "mission");
const last = <T,>(a: readonly T[]): T | undefined => a[a.length - 1];

async function start(mode: "advisor" | "autopilot", opts: Partial<import("../store/leadControl").ControlPolicy> = {}) {
  store.setPolicy(DIR, { mode, ...opts });
  lc.installLeadControl();
  await settle();
}

/** Run an action that types (80 ms Enter delay) under fake timers. */
async function run<T>(p: Promise<T>): Promise<T> {
  await flush(500);
  return p;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  lc.resetLeadControlForTests();
  resetMissionDocsForTests();
  resetBranchSummaries();
  store.resetLeadControlStoreForTests();
  listeners.length = 0;
  outbox.clear();
  mission.clear();
  for (const k of Object.keys(tails)) delete tails[k];
  for (const k of Object.keys(summaries)) delete summaries[k];
  writes.length = 0;
  archives.length = 0;
  teamWrites.length = 0;
  useActivity.setState({ events: [] });
  setupTeam();
});

afterEach(() => {
  lc.resetLeadControlForTests();
  vi.useRealTimers();
});

// ---- tests --------------------------------------------------------------------------------------------

describe("off", () => {
  it("watches nothing, lists nothing, writes nothing, arms no timer", async () => {
    putOutbox(item("0001.md", "to: builder-1\n---\nhi"));
    lc.installLeadControl();
    await flush(5000);
    expect(ipc.missionWatch).not.toHaveBeenCalled();
    expect(ipc.missionOutboxList).not.toHaveBeenCalled();
    expect(teamWrites).toEqual([]);
    expect(proposals()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("advisor", () => {
  it("turns outbox files into proposals, types nothing, writes team.md once", async () => {
    putOutbox(item("0007-builder-1.md", "to: builder-1\nfrom: lead\naction: message\n---\nAlso add a unit test."));
    await start("advisor");
    expect(ipc.missionWatch).toHaveBeenCalledWith(DIR);
    expect(proposals()).toHaveLength(1);
    expect(proposals()[0]).toMatchObject({
      dirKey: "d:\\proj",
      source: "outbox",
      file: "0007-builder-1.md",
      status: "proposal",
      from: "lead",
      lead: "lead",
      targets: ["B1"],
      targetLabel: "builder-1",
      action: "message",
      text: "[from lead] Also add a unit test.",
      warnings: [],
      reason: null,
    });
    expect(writes).toEqual([]);
    expect(store.useLeadControl.getState().active).toEqual({ "d:\\proj": DIR });

    await flush(lc.TEAM_DEBOUNCE_MS);
    expect(teamWrites).toHaveLength(1);
    const md = teamWrites[0][1];
    expect(teamWrites[0][0]).toBe(DIR);
    expect(md).toContain("Updated: ");
    expect(md).toContain("Mission: none yet");
    expect(md).toContain("Delivery: advisor");
    expect(md).toContain("- @lead (lead, claude) — idle — no open task");
    expect(md).toContain("- @builder-2 (builder, claude) — idle");
    expect(md).toContain("D:\\proj\\.gridkeeper\\outbox\\");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("re-lists on outbox events (not on mission events); deleted files drop their proposal", async () => {
    putOutbox(item("0001.md", "to: builder-1\n---\none"));
    await start("advisor");
    expect(ipc.missionOutboxList).toHaveBeenCalledTimes(1);
    outbox.get(DIR)!.push(item("0002.md", "to: all\n---\ntwo"));
    emit("mission");
    await settle();
    expect(ipc.missionOutboxList).toHaveBeenCalledTimes(1);
    emit("outbox", "d:/PROJ/"); // another spelling of the same folder
    await settle();
    expect(proposals().map((p) => p.file)).toEqual(["0001.md", "0002.md"]);
    expect(proposals()[1].targets).toEqual(["B1", "B2"]); // all = everyone but the lead
    outbox.set(DIR, [outbox.get(DIR)![1]]);
    emit(); // older hosts send no "file": treated as both
    await settle();
    expect(proposals().map((p) => p.file)).toEqual(["0002.md"]);
  });

  it("an empty message file is left alone while young, a rewritten file replaces an untouched proposal", async () => {
    putOutbox(item("0001.md", "to: builder-1\n---\n", 1000));
    await start("advisor");
    expect(proposals()).toEqual([]);
    putOutbox({ ...item("0001.md", "to: builder-1\n---\nnow with text", 0), modifiedMs: Date.now() + 1 });
    emit("outbox");
    await settle();
    expect(proposals()[0].text).toBe("[from lead] now with text");
    store.editProposal(proposals()[0].key, "my version");
    putOutbox({ ...item("0001.md", "to: builder-1\n---\nagent rewrote it", 0), modifiedMs: Date.now() + 2 });
    emit("outbox");
    await settle();
    expect(proposals()[0].text).toBe("my version");
  });

  it("Send types the text + Enter, archives to sent/ and logs", async () => {
    putOutbox(item("0001.md", "to: builder-1\n---\nadd a test"));
    await start("advisor");
    const key = proposals()[0].key;
    store.editProposal(key, "[from lead] add a test, please");
    expect(await run(lc.sendProposal(key))).toEqual({ ok: true });
    expect(writes).toEqual([
      ["B1", "[from lead] add a test, please"],
      ["B1", "\r"],
    ]);
    expect(archives).toEqual([[DIR, "0001.md", "sent"]]);
    expect(proposals()).toEqual([]);
    expect(last(missionEvents())).toMatchObject({ sessionId: "B1", message: "lead → builder-1: [from lead] add a test, please", result: "sent", level: "info" });
    // The archived file is not proposed again.
    emit("outbox");
    await settle();
    expect(proposals()).toEqual([]);
  });

  it("Send refuses while the target is waiting or asking something; the proposal keeps the reason", async () => {
    putOutbox(item("0001.md", "to: builder-1\n---\nadd a test"));
    await start("advisor");
    const key = proposals()[0].key;
    attn("B1", "waiting");
    const r = await run(lc.sendProposal(key));
    expect(r.ok).toBe(false);
    expect(store.getProposal(key)?.reason).toMatch(/waiting for an answer/);
    attn("B1", "idle");
    tails.B1 = "Do you want to make this edit?\n❯ 1. Yes\n  2. No";
    expect((await run(lc.sendProposal(key))).ok).toBe(false);
    expect(store.getProposal(key)?.reason).toMatch(/asking something/);
    useApp.setState((s) => ({ runtime: { ...s.runtime, B1: { ...s.runtime.B1, state: { state: "exited", code: 0 } } } }));
    expect((await run(lc.sendProposal(key))).ok).toBe(false);
    expect(store.getProposal(key)?.reason).toMatch(/not running/);
    expect(writes).toEqual([]);
    expect(archives).toEqual([]);
  });

  it("a multi-target Send delivers to the safe targets and keeps the rest", async () => {
    putOutbox(item("0001.md", "to: builder\n---\nrebase on main"));
    await start("advisor");
    const key = proposals()[0].key;
    attn("B2", "waiting");
    expect((await run(lc.sendProposal(key))).ok).toBe(false);
    expect(typed()).toEqual([["B1", "[from lead] rebase on main"]]);
    expect(store.getProposal(key)?.delivered).toEqual(["B1"]);
    attn("B2", "idle");
    expect(await run(lc.sendProposal(key))).toEqual({ ok: true });
    expect(typed()).toEqual([
      ["B1", "[from lead] rebase on main"],
      ["B2", "[from lead] rebase on main"],
    ]);
    expect(archives).toEqual([[DIR, "0001.md", "sent"]]);
  });

  it("Dismiss moves the file to dismissed/; a file already gone is fine", async () => {
    putOutbox(item("0001.md", "to: builder-1\n---\nx"), item("0002.md", "to: builder-2\n---\ny"));
    await start("advisor");
    const [a, b] = proposals().map((p) => p.key);
    expect(await lc.dismissProposal(a)).toEqual({ ok: true });
    expect(archives).toEqual([[DIR, "0001.md", "dismissed"]]);
    outbox.set(DIR, []); // its author deleted the other one meanwhile
    expect(await lc.dismissProposal(b)).toEqual({ ok: true });
    expect(proposals()).toEqual([]);
    expect(writes).toEqual([]);
  });

  it("no 'to:', unknown targets and unknown actions are explained and cannot be sent", async () => {
    putOutbox(item("0001.md", "hello there"), item("0002.md", "to: qa\naction: deploy\n---\nship"), item("0003.md", "to: builder-9, builder-2\n---\nhi"));
    await start("autopilot");
    const [a, b, c] = proposals();
    expect(a).toMatchObject({ status: "proposal", targets: [], reason: "the file has no “to:” line" });
    expect(a.warnings).toContain("no “to:” line — nobody to deliver it to");
    expect(b).toMatchObject({ status: "proposal", action: "message", targets: [], reason: "no teammate matches its “to:” line" });
    expect(b.warnings).toEqual(["unknown action “deploy” — treated as a message", "nobody is named or has the role “qa”"]);
    expect((await lc.sendProposal(a.key)).ok).toBe(false);
    // Partly known: delivered to the known target, with a warning.
    expect(c.warnings).toEqual(["nobody is named or has the role “builder-9”"]);
    await flush(500);
    expect(typed()).toEqual([["B2", "[from lead] hi"]]);
  });

  it("a self-declared sender is labelled as such", async () => {
    putOutbox(item("0001.md", "to: lead\nfrom: builder-1\n---\nI am blocked on the API key"));
    await start("advisor");
    expect(proposals()[0]).toMatchObject({ from: "builder-1 (self-declared)", lead: null, targets: ["L"], text: "[from builder-1] I am blocked on the API key" });
  });

  it("switching off releases the watch and forgets the proposals (files stay)", async () => {
    putOutbox(item("0001.md", "to: builder-1\n---\nx"));
    await start("advisor");
    lc.setControlMode(DIR, "off");
    await settle();
    expect(ipc.missionUnwatch).toHaveBeenCalledWith(DIR);
    expect(proposals()).toEqual([]);
    expect(archives).toEqual([]);
    expect(store.useLeadControl.getState().active).toEqual({});
    await flush(5000);
    expect(teamWrites).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("autopilot", () => {
  it("delivers to idle targets; holds a working one until its next quiet transition", async () => {
    attn("B1", "working");
    putOutbox(item("0001.md", "to: builder-1\n---\none"), item("0002.md", "to: builder-2\n---\ntwo"));
    await start("autopilot");
    await flush(500);
    expect(typed()).toEqual([["B2", "[from lead] two"]]);
    expect(archives).toEqual([[DIR, "0002.md", "sent"]]);
    const held = proposals()[0];
    expect(held).toMatchObject({ file: "0001.md", status: "queued" });
    expect(held.reason).toMatch(/builder-1 is working/);
    attn("B1", "idle");
    await flush(500);
    expect(typed()).toEqual([
      ["B2", "[from lead] two"],
      ["B1", "[from lead] one"],
    ]);
    expect(proposals()).toEqual([]);
    expect(missionEvents().map((e) => [e.message, e.result])).toEqual([
      ["lead → builder-2: [from lead] two", "auto-sent"],
      ["lead → builder-1: [from lead] one", "auto-sent"],
    ]);
    await flush(lc.TEAM_DEBOUNCE_MS);
    expect(vi.getTimerCount()).toBe(0); // nothing queued, team.md written: no timers
  });

  it("never answers a question: a waiting target holds the item, then it gives up after 10 minutes", async () => {
    attn("B1", "waiting");
    putOutbox(item("0001.md", "to: builder-1\n---\none"));
    await start("autopilot");
    await flush(1000);
    expect(writes).toEqual([]);
    expect(proposals()[0].status).toBe("queued");
    expect(vi.getTimerCount()).toBeGreaterThan(0); // the give-up deadline
    await flush(lc.GIVE_UP_MS);
    expect(proposals()[0]).toMatchObject({ status: "proposal", queuedAt: null });
    expect(proposals()[0].reason).toMatch(/10 minutes/);
    expect(last(missionEvents())).toMatchObject({ level: "needs", result: "gave up" });
    expect(writes).toEqual([]);
  });

  it("never delivers into a permission prompt a Claude hook reports, even when the lamp says idle", async () => {
    useAttention.setState((s) => ({
      sessions: { ...s.sessions, B1: { state: "idle", unread: false, at: Date.now(), hook: { state: "permission", tool: "Bash", at: Date.now() } } },
    }));
    putOutbox(item("0001.md", "to: builder-1\n---\none"));
    await start("autopilot");
    await flush(1000);
    expect(writes).toEqual([]);
    expect(proposals()[0].status).toBe("queued");
    expect(proposals()[0].reason).toMatch(/waiting for permission to use Bash/);
    // Answered (the hook reports the tool running, then the turn ends): delivered on the next transition.
    useAttention.setState((s) => ({
      sessions: { ...s.sessions, B1: { state: "done", unread: false, at: Date.now(), hook: { state: "stopped", at: Date.now() } } },
    }));
    await flush(500);
    expect(typed()).toEqual([["B1", "[from lead] one"]]);
  });

  it("Send (manual) refuses too while a hook reports a question", async () => {
    useAttention.setState((s) => ({
      sessions: { ...s.sessions, B2: { state: "working", unread: false, at: Date.now(), hook: { state: "input", tool: "AskUserQuestion", at: Date.now() } } },
    }));
    const { handoffBlocker } = await import("./handoff");
    expect(await handoffBlocker("B2")).toMatch(/waiting for an answer to its question/);
  });

  it("one automatic delivery per target per 20 s", async () => {
    putOutbox(item("0001.md", "to: builder-1\n---\none"), item("0002.md", "to: builder-1\n---\ntwo"));
    await start("autopilot");
    await flush(500);
    expect(typed()).toEqual([["B1", "[from lead] one"]]);
    expect(proposals()[0].reason).toMatch(/rate limit/);
    await flush(18_000);
    expect(typed()).toHaveLength(1);
    await flush(3_000);
    expect(typed()).toEqual([
      ["B1", "[from lead] one"],
      ["B1", "[from lead] two"],
    ]);
    expect(proposals()).toEqual([]);
  });

  it("at most 8 automatic deliveries per minute overall", async () => {
    setupTeam(Array.from({ length: 7 }, (_, i) => meta(`B${i + 3}`, `builder-${i + 3}`, "builder")));
    putOutbox(item("0001.md", "to: all\n---\nsync up"));
    await start("autopilot");
    await flush(2000);
    expect(typed()).toHaveLength(8);
    expect(proposals()[0].reason).toMatch(/rate limit/);
    await flush(50_000);
    expect(typed()).toHaveLength(8);
    await flush(10_000);
    expect(typed()).toHaveLength(9);
    expect(new Set(typed().map(([id]) => id)).size).toBe(9);
    expect(archives).toEqual([[DIR, "0001.md", "sent"]]);
  });

  it("stop / restart are never automatic; Send goes through the confirmation", async () => {
    putOutbox(item("0001.md", "to: builder-2\naction: stop\n---\nthe build is broken"));
    await start("autopilot");
    await flush(1000);
    const p = proposals()[0];
    expect(p).toMatchObject({ status: "proposal", action: "stop", text: "the build is broken" });
    expect(writes).toEqual([]);
    expect(confirmStop).not.toHaveBeenCalled();
    // Cancelled confirmation: nothing happens, the proposal stays.
    expect((await lc.sendProposal(p.key)).ok).toBe(false);
    expect(confirmStop).toHaveBeenCalledWith("B2", "Builder 2");
    expect(proposals()).toHaveLength(1);
    // Confirmed: the session stops, the file is archived.
    confirmStop.mockImplementationOnce(async (id: string) => {
      useApp.setState((s) => ({ runtime: { ...s.runtime, [id]: { ...s.runtime[id], state: { state: "stopping" } } } }));
    });
    expect(await lc.sendProposal(p.key)).toEqual({ ok: true });
    expect(archives).toEqual([[DIR, "0001.md", "sent"]]);
    expect(last(missionEvents())).toMatchObject({ message: "lead → builder-2: stop (the build is broken)", result: "confirmed" });
  });

  it("restart proposals use the restart confirmation", async () => {
    putOutbox(item("0001.md", "to: builder-1\naction: restart\n---\n"));
    await start("autopilot");
    confirmRestart.mockImplementationOnce(async (id: string) => {
      useApp.setState((s) => ({ runtime: { ...s.runtime, [id]: running(id, "t2") } }));
    });
    expect(await lc.sendProposal(proposals()[0].key)).toEqual({ ok: true });
    expect(confirmRestart).toHaveBeenCalledWith("B1", "builder-1", { mode: "continue" }, true);
    expect(writes).toEqual([]);
  });

  it("pause turns queued items into proposals; resume queues and delivers them", async () => {
    attn("B1", "working");
    putOutbox(item("0001.md", "to: builder-1\n---\none"));
    await start("autopilot");
    expect(proposals()[0].status).toBe("queued");
    lc.setAutopilotPaused(true);
    await settle();
    expect(store.policyOf(DIR)).toMatchObject({ mode: "autopilot", paused: true });
    expect(proposals()[0]).toMatchObject({ status: "proposal", queuedAt: null });
    attn("B1", "idle");
    await flush(500);
    expect(writes).toEqual([]); // paused = advisor
    lc.setAutopilotPaused(false);
    await flush(500);
    expect(typed()).toEqual([["B1", "[from lead] one"]]);
  });

  it("turning autopilot on queues waiting proposals the user did not edit", async () => {
    putOutbox(item("0001.md", "to: builder-1\n---\none"), item("0002.md", "to: builder-2\n---\ntwo"));
    await start("advisor");
    store.editProposal(proposals()[1].key, "[from lead] two, edited");
    lc.setControlMode(DIR, "autopilot");
    await flush(500);
    expect(typed()).toEqual([["B1", "[from lead] one"]]);
    expect(proposals()).toHaveLength(1);
    expect(proposals()[0].status).toBe("proposal");
  });
});

describe("auto-review", () => {
  const sum = (p: Partial<BranchSummary>): BranchSummary => ({ ...NO_REPO, isRepo: true, branch: "b1", base: "main", ahead: 2, filesChanged: 3, lastCommitMs: 5, lastCommitSubject: "Add callback", ...p });

  it("advisor: a finished builder with new commits → one review request for the lead, once per HEAD", async () => {
    summaries[WT1] = sum({});
    await start("advisor");
    attn("B1", "working");
    attn("B1", "done");
    await settle();
    expect(proposals()).toHaveLength(1);
    expect(proposals()[0]).toMatchObject({
      source: "review",
      from: "auto-review",
      lead: "lead",
      targets: ["L"],
      targetLabel: "lead",
      action: "review",
      status: "proposal",
      text: `builder-1 finished their task on b1 (+2 commits, 3 files). Review with: git -C "${WT1}" diff main...b1 — then message them via .gridkeeper/outbox (to: builder-1) with fixes, or mark the review task done.`,
    });
    attn("B1", "working");
    attn("B1", "done");
    await settle();
    expect(proposals()).toHaveLength(1);
    // A new commit is new work.
    summaries[WT1] = sum({ ahead: 3, lastCommitMs: 6 });
    attn("B1", "working");
    attn("B1", "done");
    await settle();
    expect(proposals()).toHaveLength(2);
    // Sent by the user: typed into the lead, nothing archived (no file).
    expect(await run(lc.sendProposal(proposals()[0].key))).toEqual({ ok: true });
    expect(typed()[0][0]).toBe("L");
    expect(archives).toEqual([]);
    expect(last(missionEvents())?.message).toMatch(/^auto-review → lead: builder-1 finished/);
  });

  it("autopilot: delivered to the first running lead", async () => {
    setupTeam([meta("L2", "second lead", "lead")]);
    useApp.setState((s) => ({ runtime: { ...s.runtime, L: { ...s.runtime.L, state: { state: "exited", code: 0 } } } }));
    summaries[WT1] = sum({});
    await start("autopilot");
    attn("B1", "done");
    await flush(500);
    expect(typed().map(([id]) => id)).toEqual(["L2"]);
    expect(last(missionEvents())).toMatchObject({ sessionId: "L2", result: "auto-sent" });
    expect(proposals()).toEqual([]);
  });

  it("a task turning [x] counts as finished work even without commits", async () => {
    mission.set(DIR, "# Mission: M\n\n## Tasks\n- [~] Write docs @builder-2\n");
    await start("advisor");
    attn("B2", "done");
    await settle();
    expect(proposals()).toEqual([]); // no commits, no newly done task
    mission.set(DIR, "# Mission: M\n\n## Tasks\n- [x] Write docs @builder-2\n");
    emit("mission");
    await settle();
    expect(proposals()).toHaveLength(1);
    expect(proposals()[0].text).toBe(
      `Builder 2 finished 'Write docs' in ${DIR} (no new commits). Review with: git -C "${DIR}" diff HEAD — then message them via .gridkeeper/outbox (to: builder-2) with fixes, or mark the review task done.`,
    );
  });

  it("off when the user turns it off, and never for the lead itself", async () => {
    summaries[WT1] = sum({});
    summaries[DIR] = sum({ branch: "main" });
    await start("advisor", { autoReview: false });
    attn("B1", "done");
    attn("L", "done");
    await settle();
    expect(proposals()).toEqual([]);
    lc.setControlOptions(DIR, { autoReview: true });
    attn("L", "working");
    attn("L", "done");
    await settle();
    expect(proposals()).toEqual([]);
  });
});

describe("team.md", () => {
  it("shares recent output only when asked, skips identical rewrites, never polls", async () => {
    tails.B1 = "$ npm test\n\u001b[32m12 passed\u001b[0m\n> ";
    summaries[WT1] = { ...NO_REPO, isRepo: true, branch: "b1", base: "main", ahead: 1, filesChanged: 2, insertions: 10, deletions: 3, uncommitted: 1 };
    mission.set(DIR, "# Mission: Ship it\n\n## Tasks\n- [~] Build the API @builder-1\n- [x] Plan @lead\n");
    await start("advisor", { shareOutput: true });
    await flush(lc.TEAM_DEBOUNCE_MS);
    expect(teamWrites).toHaveLength(1);
    const md = teamWrites[0][1];
    expect(md).toContain("Mission: Ship it — 1/2 tasks done (1 doing)");
    expect(md).toContain("- @builder-1 (builder, claude) — idle — task: Build the API — ⎇ b1 +1 commit, 2 files +10 −3, uncommitted 1");
    expect(md).toContain("### @builder-1\n\n```text\n$ npm test\n12 passed\n>\n```");
    // A refresh that changes nothing visible: no rewrite.
    await refreshBranchSummary(WT1);
    await flush(lc.TEAM_DEBOUNCE_MS);
    expect(teamWrites).toHaveLength(1);
    // A real change: rewritten (coalesced into one write).
    attn("B1", "working");
    attn("B2", "waiting");
    await flush(lc.TEAM_DEBOUNCE_MS);
    expect(teamWrites).toHaveLength(2);
    expect(teamWrites[1][1]).toContain("- @builder-1 (builder, claude) — working");
    expect(teamWrites[1][1]).toContain("- @builder-2 (builder, claude) — needs-you");
    expect(vi.getTimerCount()).toBe(0);
    // Without sharing: no output section.
    lc.setControlOptions(DIR, { shareOutput: false });
    await flush(lc.TEAM_DEBOUNCE_MS);
    expect(last(teamWrites)?.[1]).not.toContain("## Recent output");
  });

  it("session start / stop regenerates it", async () => {
    await start("advisor");
    await flush(lc.TEAM_DEBOUNCE_MS);
    const n = teamWrites.length;
    useApp.setState((s) => ({ runtime: { ...s.runtime, B2: { ...s.runtime.B2, state: { state: "exited", code: 0 } } } }));
    await flush(lc.TEAM_DEBOUNCE_MS);
    expect(teamWrites).toHaveLength(n + 1);
    expect(last(teamWrites)?.[1]).toContain("- @builder-2 (builder, claude) — stopped");
  });
});

describe("briefLeads", () => {
  it("types the channel explanation into running leads that are not asking anything", async () => {
    setupTeam([meta("L2", "second lead", "lead")]);
    attn("L2", "waiting");
    const r = await run(lc.briefLeads(["L", "L2"], "Team status is in D:\\proj\\.gridkeeper\\team.md"));
    expect(r).toEqual({ sent: ["lead"], skipped: ["second lead"] });
    expect(writes).toEqual([
      ["L", "Team status is in D:\\proj\\.gridkeeper\\team.md"],
      ["L", "\r"],
    ]);
  });
});
