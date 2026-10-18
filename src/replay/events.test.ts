import { describe, expect, it } from "vitest";
import { encodeEvent, folderHash, goalSlug, metaFromName, NAME_RE, parseReplay, recordingFileName, scrubText, summarize, toEvent, type ReplayEvent } from "./events";

describe("scrubText (privacy)", () => {
  it("removes absolute Windows, UNC and POSIX paths but keeps relative ones", () => {
    expect(scrubText("see D:\\AlteraAI\\src\\x.ts now")).toBe("see ‹path› now");
    expect(scrubText('git -C "C:/Users/amra/repo" diff')).toBe('git -C "‹path›" diff');
    expect(scrubText("share \\\\server\\team\\file.txt here")).toBe("share ‹path› here");
    expect(scrubText("open /home/me/project/a.md")).toBe("open ‹path›");
    expect(scrubText("open ~/project/a.md")).toBe("open ‹path›");
    expect(scrubText("edit src/components/replay/ReplayDialog.tsx")).toBe("edit src/components/replay/ReplayDialog.tsx");
    expect(scrubText("fix /auth/callback route")).toBe("fix /auth/callback route");
  });

  it("removes e-mail addresses and secret-looking tokens", () => {
    expect(scrubText("ping mahashweta@jurixoneai.com about it")).toBe("ping ‹email› about it");
    expect(scrubText("key sk-ant-api03-abcdefghijklmnop")).toBe("key ‹redacted›");
    expect(scrubText("token ghp_1234567890abcdefghij")).toBe("token ‹redacted›");
    expect(scrubText("hash 3f786850e387550fdab836ed7e6dc881de23001b")).toBe("hash ‹redacted›");
    // Long hyphenated words without digits are text, not secrets.
    expect(scrubText("add-oauth-login-with-pkce-and-refresh-token-rotation")).toBe("add-oauth-login-with-pkce-and-refresh-token-rotation");
  });

  it("collapses whitespace / control characters and truncates", () => {
    expect(scrubText("a\n\tb\u0007  c")).toBe("a b c");
    expect(scrubText("x".repeat(200), 10)).toBe(`${"x".repeat(9)}…`);
    expect(scrubText(null)).toBe("");
  });
});

describe("folder hash", () => {
  it("is stable across spelling and never contains the path", () => {
    expect(folderHash("D:\\Repo\\WT\\")).toBe(folderHash("d:/repo/wt"));
    expect(folderHash("D:\\repo\\a")).not.toBe(folderHash("D:\\repo\\b"));
    expect(folderHash("D:\\repo")).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("file names", () => {
  it("builds <YYYY-MM-DD-HHmm>-<slug>.jsonl that the Rust side accepts, and parses it back", () => {
    const at = new Date(2026, 9, 18, 10, 42);
    const name = recordingFileName(at, "Add OAuth login (PKCE)!");
    expect(name).toBe("2026-10-18-1042-add-oauth-login-pkce.jsonl");
    expect(NAME_RE.test(name)).toBe(true);
    const meta = metaFromName(name);
    expect(meta.slug).toBe("add-oauth-login-pkce");
    expect(meta.startedAt).toBe(at.getTime());
    expect(recordingFileName(at, null, "-2")).toBe("2026-10-18-1042-mission-2.jsonl");
    expect(metaFromName("2026-10-18-1042-mission-2.jsonl").slug).toBe("mission");
    expect(metaFromName("odd.jsonl")).toEqual({ startedAt: null, slug: "odd" });
  });

  it("never puts a path or e-mail into the slug", () => {
    expect(goalSlug("Fix C:\\secret\\dir for bob@corp.com")).toBe("fix-path-for-email");
    expect(goalSlug("")).toBe("mission");
    expect(goalSlug("x".repeat(100)).length).toBeLessThanOrEqual(48);
  });
});

describe("parsing", () => {
  const lines = [
    { t: 3000, k: "attn", slug: "b1", s: "working" },
    { t: 1000, k: "start", v: 1, goal: "Ship it", team: [{ slug: "b1", name: "b1", role: "builder", agent: "claude", live: true }, { nope: 1 }], tasks: [{ text: "a", s: "todo", o: ["b1"] }, { text: "", s: "todo" }] },
    { t: 2000, k: "task", text: "a", s: "doing", o: ["b1"] },
    { t: 2500, k: "task", text: "a", s: "weird", o: [] },
    { t: 4000, k: "future-kind" },
    { t: 5000, k: "msg", from: "you", to: ["b1"], text: "hello" },
    { t: 6000, k: "end" },
  ];
  const text = `${lines.map((l) => JSON.stringify(l)).join("\n")}\n{"t":7000,"k":"att`;

  it("keeps valid events sorted by time and counts the rest", () => {
    const { events, skipped } = parseReplay(text);
    expect(events.map((e) => e.k)).toEqual(["start", "task", "attn", "msg", "end"]);
    expect(skipped).toBe(3); // bad state, unknown kind, torn tail
    const start = events[0] as Extract<ReplayEvent, { k: "start" }>;
    expect(start.team).toHaveLength(1);
    expect(start.tasks).toHaveLength(1);
  });

  it("round-trips encodeEvent", () => {
    const ev: ReplayEvent = { t: 1, k: "branch", slug: "b1", w: "deadbeef", ahead: 2, files: 3, ins: 40, del: 1 };
    expect(toEvent(JSON.parse(encodeEvent(ev)))).toEqual(ev);
    expect(toEvent({ t: -1, k: "end" })).toBeNull();
    expect(toEvent("x")).toBeNull();
  });

  it("summarizes for the recording list", () => {
    const { events } = parseReplay(text);
    const s = summarize(events);
    expect(s).toMatchObject({ goal: "Ship it", startedAt: 1000, endedAt: 6000, durationMs: 5000, events: 5, agents: 1, tasksDone: 0, tasksTotal: 1, ended: true });
    expect(summarize([])).toMatchObject({ goal: null, durationMs: 0, events: 0 });
  });
});
