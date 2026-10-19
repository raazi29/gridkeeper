import { describe, expect, it } from "vitest";
import {
  blockedReason,
  brainBriefText,
  brainPaths,
  brainPathsOfMission,
  draftFromText,
  editNote,
  guessKind,
  isDuplicate,
  isValidSlug,
  newNoteText,
  normalizeKind,
  noteFields,
  parseNote,
  parseTags,
  scrubBody,
  similarity,
  slugForTitle,
  suggestFromBoard,
  suggestFromOutbox,
  taskNotes,
  titleFrom,
  today,
} from "./brain";
import { parseMission } from "./missionDoc";

const BOM = String.fromCharCode(0xfeff);

describe("note format", () => {
  it("parses front matter leniently (BOM, CRLF, quotes, block lists, junk lines)", () => {
    const p = parseNote(`${BOM}---\r\nTitle: "Quoted: title"\r\nkind: Gotcha\r\ntags:\r\n  - CI\r\n  - 'build cache'\r\nweird line\r\n---\r\n\r\nBody 1\r\nline 2\r\n`);
    expect(p.hasFrontMatter).toBe(true);
    expect(p.fields).toEqual([
      ["title", "Quoted: title"],
      ["kind", "Gotcha"],
      ["tags", "CI, build cache"],
    ]);
    expect(p.body).toBe("Body 1\nline 2");
    expect(parseNote("# Heading\nno front matter")).toEqual({ fields: [], body: "# Heading\nno front matter", hasFrontMatter: false });
    expect(parseNote("---\ntitle: x\nnever closed").hasFrontMatter).toBe(false);
    expect(parseNote("---\nkind: fact\n...\nb").fields).toEqual([["kind", "fact"]]);
  });

  it("normalizes kinds and tags like the Rust side", () => {
    expect(normalizeKind("Decision")).toBe("decision");
    expect(normalizeKind("how-to")).toBe("howto");
    expect(normalizeKind("person-free-context")).toBe("context");
    expect(normalizeKind("pitfall")).toBe("gotcha");
    expect(normalizeKind("???")).toBe("fact");
    expect(parseTags('[Auth, #CI, auth, "Build Cache", , x_y]')).toEqual(["auth", "ci", "build-cache", "x-y"]);
    expect(parseTags(Array.from({ length: 20 }, (_, i) => `t${i}`).join(","))).toHaveLength(12);
  });

  it("reads typed fields with defaults by folder", () => {
    const f = noteFields("---\ntitle: T\nkind: convention\ntags: [a]\nsupersedes: old.md\n---\nBody");
    expect(f).toMatchObject({ title: "T", kind: "convention", tags: ["a"], confidence: "confirmed", supersedes: "old", body: "Body" });
    expect(noteFields("Body only", true).confidence).toBe("suggested");
  });

  it("edits fields in place, keeping unknown keys, order and line endings", () => {
    const t = "---\r\ntitle: X\r\nconfidence: suggested\r\ntags:\r\n  - a\r\nextra: keep\r\n---\r\nbody\r\n";
    expect(editNote(t, { confidence: "confirmed", updated: "2026-10-19", tags: "[b]" })).toBe(
      "---\r\ntitle: X\r\nconfidence: confirmed\r\ntags: [b]\r\nextra: keep\r\nupdated: 2026-10-19\r\n---\r\nbody\r\n",
    );
    // null removes; a new body replaces the old one.
    expect(editNote("---\ntitle: X\nsupersedes: a\n---\nold\n", { supersedes: null }, "new\nlines")).toBe("---\ntitle: X\n---\nnew\nlines\n");
    // No front matter: one is created only when something is set.
    expect(editNote("just a body\n", { kind: "fact" })).toBe("---\nkind: fact\n---\njust a body\n");
    expect(editNote("just a body\n", { supersedes: null })).toBe("just a body\n");
    // Key spelling and the BOM survive.
    expect(editNote(`${BOM}---\nKind: x\n---\nb`, { kind: "gotcha" })).toBe(`${BOM}---\nKind: gotcha\n---\nb`);
    // Values stay on one line.
    expect(editNote("---\n---\n", { title: "a\nb" })).toBe("---\ntitle: a b\n---\n");
  });

  it("writes new notes in the documented format", () => {
    const t = newNoteText({ title: " Use  pnpm ", kind: "convention", tags: ["build"], source: "user", confidence: "suggested", body: "Never npm install.\r\n", date: "2026-10-19" });
    expect(t).toBe("---\ntitle: Use pnpm\nkind: convention\ntags: [build]\nsource: user\ncreated: 2026-10-19\nupdated: 2026-10-19\nconfidence: suggested\n---\nNever npm install.\n");
    const s = newNoteText({ title: "", kind: "fact", confidence: "confirmed", supersedes: "old", body: "", date: "2026-01-01" });
    expect(s).toContain("title: Untitled\n");
    expect(s).toContain("supersedes: old\n");
    expect(noteFields(t, true)).toMatchObject({ title: "Use pnpm", kind: "convention", tags: ["build"], created: "2026-10-19", confidence: "suggested" });
    expect(today(new Date(2026, 0, 5))).toBe("2026-01-05");
  });

  it("makes free, valid slugs", () => {
    expect(slugForTitle("Refresh tokens live in the OS keychain!", [])).toBe("refresh-tokens-live-in-the-os-keychain");
    expect(slugForTitle("CI cache", ["ci-cache", "CI-CACHE-2"])).toBe("ci-cache-3");
    expect(slugForTitle("—", [])).toBe("note");
    expect(slugForTitle("con", [])).toBe("note-con");
    expect(slugForTitle("x".repeat(200), []).length).toBe(48);
    for (const ok of ["a", "token-storage", "v2.1-notes"]) expect(isValidSlug(ok)).toBe(true);
    for (const bad of ["", "-a", ".a", "a..b", "a.", "a b", "a/b", "nul", "COM1", "x".repeat(81)]) expect(isValidSlug(bad)).toBe(false);
  });
});

describe("scrubbing, kinds, duplicates", () => {
  it("scrubs paths, e-mails and secrets line by line", () => {
    const body = scrubBody("See C:\\Users\\me\\repo\\x.ts and /home/me/x\n- mail bob@example.com\n\ntoken ghp_abcdefghijklmnopqrstuvwxyz0123");
    expect(body).toBe("See ‹path› and ‹path›\n- mail ‹email›\ntoken ‹redacted›");
    expect(scrubBody("a".repeat(2000), 100).length).toBeLessThanOrEqual(100);
    expect(scrubBody(Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n"), 1000, 3).split("\n")).toHaveLength(3);
  });

  it("guesses kinds and titles", () => {
    expect(guessKind("We decided to keep the tokens in the keychain")).toBe("decision");
    expect(guessKind("Always run the formatter before committing")).toBe("convention");
    expect(guessKind("The e2e suite is flaky on Windows")).toBe("gotcha");
    expect(guessKind("Run cargo test with two jobs")).toBe("howto");
    expect(guessKind("The API lives on port 8080")).toBe("fact");
    expect(titleFrom("note: the cache key must include the lock file. Otherwise CI reuses stale deps.")).toBe("The cache key must include the lock file");
    expect(titleFrom("x".repeat(100), 20)).toHaveLength(20);
    expect(titleFrom("")).toBe("");
  });

  it("detects near-duplicates", () => {
    const existing = [{ title: "Refresh tokens live in the OS keychain", excerpt: "We store refresh tokens in the OS keychain, never on disk." }];
    expect(isDuplicate({ title: "refresh tokens live in the os keychain", body: "x" }, existing)).toBe(true);
    expect(isDuplicate({ title: "Tokens in the keychain", body: "We store refresh tokens in the OS keychain and never on disk." }, existing)).toBe(true);
    expect(isDuplicate({ title: "CI cache key", body: "The cache key must include the lock file hash." }, existing)).toBe(false);
    expect(similarity("", "abc")).toBe(0);
  });

  it("drafts a memory from a selection", () => {
    const d = draftFromText("We decided: builds run with 2 jobs on this machine.\nOtherwise it runs out of memory.");
    expect(d.kind).toBe("decision");
    expect(d.title).toBe("We decided: builds run with 2 jobs on this machine");
    expect(d.body).toContain("Otherwise it runs out of memory.");
  });
});

describe("paths and briefs", () => {
  it("derives brain paths in the project's separator style", () => {
    expect(brainPaths("D:\\repo\\")).toEqual({ dir: "D:\\repo\\.gridkeeper\\brain", index: "D:\\repo\\.gridkeeper\\brain\\INDEX.md", notes: "D:\\repo\\.gridkeeper\\brain\\notes\\", inbox: "D:\\repo\\.gridkeeper\\brain\\inbox\\" });
    expect(brainPaths("/home/u/repo").inbox).toBe("/home/u/repo/.gridkeeper/brain/inbox/");
    expect(brainPathsOfMission("D:\\repo\\.gridkeeper\\mission.md").index).toBe("D:\\repo\\.gridkeeper\\brain\\INDEX.md");
  });

  it("brief line: one line with INDEX.md, the inbox and the format", () => {
    const t = brainBriefText("D:\\repo\\.gridkeeper\\mission.md");
    expect(t).not.toMatch(/[\r\n]/);
    expect(t).toContain("read D:\\repo\\.gridkeeper\\brain\\INDEX.md first");
    expect(t).toContain("D:\\repo\\.gridkeeper\\brain\\inbox\\<short-slug>.md");
    expect(t).toContain("'kind: decision|convention|gotcha|howto|fact|context'");
    expect(t).toContain("'confidence: suggested'");
    expect(t).toContain("Never edit confirmed notes");
  });
});

describe("capture", () => {
  const snap = (text: string) => ({ text, doc: parseMission(text) });
  const board = (tasks: string) => `# Mission: Add OAuth login\n\n## Tasks\n${tasks}`;

  it("reads task notes and blocked reasons", () => {
    const text = board("- [x] Design storage @lead\n  - note: tokens go to the OS keychain\n  - other sub item\n  * note:   second   \n- [ ] Next");
    const line = parseMission(text).tasks[0].line;
    expect(taskNotes(text, line)).toEqual(["tokens go to the OS keychain", "second"]);
    expect(taskNotes(text, 0)).toEqual([]);
    expect(blockedReason("blocked: needs the client secret — Implement callback")).toEqual({ reason: "needs the client secret", task: "Implement callback" });
    expect(blockedReason("Blocked: needs the client secret")).toEqual({ reason: "needs the client secret", task: "needs the client secret" });
  });

  it("suggests a memory when a task is completed with a note", () => {
    const prev = snap(board("- [~] Design the token storage @lead\n"));
    const next = snap(board("- [x] Design the token storage @lead\n  - note: we decided to store refresh tokens in the OS keychain, see C:\\secret\\notes.txt\n"));
    const s = suggestFromBoard(prev, next, "2026-10-19");
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ kind: "decision", source: "task “Design the token storage”" });
    expect(s[0].title).toBe("We decided to store refresh tokens in the OS keychain, see ‹path›");
    expect(s[0].body).not.toContain("C:\\");
    expect(s[0].body).toContain("(from the task “Design the token storage”)");
    // Done without notes, or already done before: nothing.
    expect(suggestFromBoard(prev, snap(board("- [x] Design the token storage @lead\n")))).toEqual([]);
    expect(suggestFromBoard(next, next)).toEqual([]);
    // Too short to be a memory.
    expect(suggestFromBoard(prev, snap(board("- [x] Design the token storage @lead\n  - note: ok\n")))).toEqual([]);
  });

  it("turns an LGTM review into a decision", () => {
    const prev = snap(board("- [ ] Review both branches @reviewer\n"));
    const next = snap(board("- [x] Review both branches @reviewer\n  - note: LGTM — tests pass on Windows and Linux\n"));
    const s = suggestFromBoard(prev, next, "2026-10-19");
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ kind: "decision", tags: ["review"], title: "Approved: Review both branches" });
    expect(s[0].body).toBe("Review “Review both branches” ended with LGTM on 2026-10-19. tests pass on Windows and Linux");
    // Owned by a reviewer counts too; an LGTM on a builder's own task does not.
    const byOwner = suggestFromBoard(snap(board("- [~] OAuth branch @codex-reviewer\n")), snap(board("- [x] OAuth branch @codex-reviewer\n  - note: LGTM\n")), "2026-10-19");
    expect(byOwner.map((x) => x.title)).toEqual(["Approved: OAuth branch"]);
    expect(suggestFromBoard(snap(board("- [~] Callback @builder-1\n")), snap(board("- [x] Callback @builder-1\n  - note: LGTM\n")))).toEqual([]);
  });

  it("records a resolved blocker as a gotcha (board-written prefix and agent-written lines)", () => {
    const viaBoard = suggestFromBoard(
      snap(board("- [!] blocked: needs the client secret — Implement /auth/callback @builder-1\n")),
      snap(board("- [~] Implement /auth/callback @builder-1\n")),
      "2026-10-19",
    );
    expect(viaBoard).toHaveLength(1);
    expect(viaBoard[0]).toMatchObject({ kind: "gotcha", title: "Blocker: needs the client secret", source: "blocker “Implement /auth/callback”" });
    expect(viaBoard[0].body).toBe("“Implement /auth/callback” was blocked: needs the client secret. Unblocked on 2026-10-19.");
    const byAgent = suggestFromBoard(snap(board("- [!] Blocked: waiting for the staging database @builder-2\n")), snap(board("- [x] Blocked: waiting for the staging database @builder-2\n")));
    expect(byAgent.map((x) => x.title)).toEqual(["Blocker: waiting for the staging database"]);
    // Still blocked: nothing.
    expect(suggestFromBoard(snap(board("- [!] Blocked: x y z @a\n")), snap(board("- [!] Blocked: x y z @a\n  - note: more\n")))).toEqual([]);
  });

  it("summarizes a review's new fix list", () => {
    const prev = snap(board("- [x] Implement callback @builder-1\n- [ ] fix: old one @builder-1\n"));
    const next = snap(board("- [x] Implement callback @builder-1\n- [ ] fix: old one @builder-1\n- [ ] fix: validate the state parameter @builder-1\n- [ ] Fix - handle expired codes @builder-1\n"));
    const s = suggestFromBoard(prev, next);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ kind: "gotcha", title: "Review found: validate the state parameter (+1 more)" });
    expect(s[0].body).toBe("A review asked for these fixes:\n- validate the state parameter\n- handle expired codes");
  });

  it("extracts decisions from the lead's outbox messages", () => {
    const s = suggestFromOutbox("[from lead] Thanks. We decided to use the OS keychain for refresh tokens. Never commit the .env file! ok");
    expect(s.map((x) => [x.kind, x.title])).toEqual([
      ["decision", "We decided to use the OS keychain for refresh tokens"],
      ["convention", "Never commit the .env file"],
    ]);
    expect(suggestFromOutbox("Please add a unit test for the callback route.")).toEqual([]);
    expect(suggestFromOutbox("never mind")).toEqual([]);
  });
});
