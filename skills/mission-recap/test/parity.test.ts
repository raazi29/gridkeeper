// The recap script ports a few app helpers (it must run with plain Node, no build). Keep them identical.
import { describe, expect, it } from "vitest";
import { diffMission, snapMission } from "../../../src/replay/diff";
import { folderHash, goalSlug, parseReplay, scrubText, toEvent } from "../../../src/replay/events";
import { ownerMatches, parseMission, slugify } from "../../../src/lib/missionDoc";
import { normalizeRole } from "../../../src/lib/roles";
import * as core from "../scripts/lib/core.mjs";

const TEXTS = [
  "",
  "plain text",
  "  spaced\tout\nlines  ",
  "mail ada@example.com now",
  "open C:\\Users\\ada\\repo\\src\\main.rs please",
  "posix /home/ada/project/file.txt and ~/notes/x.md",
  "unc \\\\server\\share\\dir file",
  "key sk-ant-api03-abcdefghijklmnop1234 and ghp_abcdefghijklmnopqrstu1234",
  "sk-learn-notes is text",
  "AKIAABCDEFGHIJKLMNOP token",
  "hash 0123456789abcdef0123456789abcdef01234567",
  "a".repeat(400),
  "ünïcødé → arrows · dots … ‹kept›",
  "Implement /auth/callback with PKCE (see /var/log/app.log)",
];

describe("parity with the app", () => {
  it("scrubText", () => {
    for (const t of TEXTS) for (const max of [160, 120, 40, 10]) expect(core.scrubText(t, max)).toBe(scrubText(t, max));
    expect(core.scrubText(null)).toBe(scrubText(null));
  });

  it("folderHash, slugify, normalizeRole, goalSlug", () => {
    for (const p of ["D:\\repo\\wt\\b1", "d:/repo/wt/b1/", "/home/ada/repo", ""]) expect(core.folderHash(p)).toBe(folderHash(p));
    for (const n of ["Builder 1", "  Lead_Two ", "Ünï--côde", "a\tb", "", "gk/1017/x"]) {
      expect(core.slugify(n)).toBe(slugify(n));
      expect(core.normalizeRole(n)).toBe(normalizeRole(n));
      expect(core.goalSlug(n)).toBe(goalSlug(n));
    }
  });

  const BOARDS = [
    "# Mission: Add OAuth login\n\nContext line.\n\n## Tasks\n- [ ] Design @lead\n- [~] Callback @builder-1 @builder-2\n- [x] Button (@builder-2)\n- [!] Blocked: secret @builder-2\n* [/] other bullet\n1. [X] numbered\n- [] empty box\n",
    "# Goal without prefix\r\n- [ ] crlf task @Builder_1\r\n```\n- [ ] fenced, ignored\n```\n<!--\n- [ ] commented\n-->\n- [-] dash doing ada@example.com\n",
    "no heading\n- [ ] only a task @all\n",
  ];

  it("parseMission and ownerMatches", () => {
    for (const b of BOARDS) expect(core.parseMission(b)).toEqual(parseMission(b));
    const m = { name: "Builder 1", role: "builder" };
    for (const tok of ["builder-1", "builder", "builders", "all", "team", "lead", "builder-2"]) expect(core.ownerMatches(tok, m)).toBe(ownerMatches(tok, m));
  });

  it("snapMission and diffMission", () => {
    const docs = BOARDS.map((b) => parseMission(b));
    for (const a of docs)
      for (const b of docs) {
        expect(core.snapMission(a)).toEqual(snapMission(a));
        expect(core.diffMission(core.snapMission(a), core.snapMission(b), 5)).toEqual(diffMission(snapMission(a), snapMission(b), 5));
      }
    // Rename on the same line.
    const x = parseMission("- [ ] old name\n- [ ] other\n");
    const y = parseMission("- [x] new name\n- [ ] other\n");
    expect(core.diffMission(core.snapMission(x), core.snapMission(y), 9)).toEqual(diffMission(snapMission(x), snapMission(y), 9));
  });

  it("toEvent and parseReplay", () => {
    const samples: unknown[] = [
      { t: 5, k: "start", v: 1, goal: "g", team: [{ slug: "a", name: "A", role: null, agent: "claude", live: false }, { bad: 1 }], tasks: [{ text: "t", s: "doing", o: ["a"] }, { text: "x", s: "nope" }] },
      { t: 6, k: "task", text: "t", s: "gone", o: [], was: "old" },
      { t: 7, k: "attn", slug: "a", s: "needs" },
      { t: 8, k: "branch", slug: "a", w: "deadbeef", ahead: 2.6, files: -1, ins: 3, del: "x" },
      { t: 9, k: "msg", from: "", to: ["a", 3], text: "hi" },
      { t: 10, k: "join", slug: "b", name: "", role: "builder", agent: "", was: "a" },
      { t: 11, k: "leave", slug: "b", why: "weird" },
      { t: 12, k: "end" },
      { t: 0, k: "end" },
      { t: 13, k: "future" },
      null,
      "x",
    ];
    for (const s of samples) expect(core.toEvent(s)).toEqual(toEvent(s));
    const text = samples.map((s) => JSON.stringify(s)).join("\n") + "\n{torn";
    expect(core.parseReplay(text)).toEqual(parseReplay(text));
  });
});
