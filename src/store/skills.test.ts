import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InstallResult, InstalledSkill, RepoSkills, SkillInfo, SkillRepoPage } from "../lib/types";

// ---- mocks: IPC (the Rust side), toasts, confirm, broadcast ------------------------------------------

const calls: string[] = [];
let installConflicts = 0;
let confirmAnswer = true;
const confirms: string[] = [];
const toasts: string[] = [];
const broadcasts: string[][] = [];

const skill = (path: string, name = path.split("/").pop() || "root"): SkillInfo => ({
  path,
  name,
  installName: name,
  description: null,
  files: [{ path: "SKILL.md", size: 10, executable: false }],
  totalBytes: 10,
  hasScripts: false,
  skillMd: "---\nname: x\n---\n",
  treeSha: "t",
  blocked: null,
});

const repoSkills = (repo: string, skills: SkillInfo[]): RepoSkills => ({
  repo,
  gitRef: "main",
  commitSha: "a".repeat(40),
  defaultBranch: "main",
  description: null,
  stars: 1,
  license: "MIT",
  pushedAt: null,
  htmlUrl: `https://github.com/${repo}`,
  archived: false,
  skills,
  warnings: [],
  fetchedAtMs: 0,
});

const page = (rateLimited = false): SkillRepoPage => ({
  items: [],
  total: 0,
  page: 1,
  rateLimited,
  resetAt: null,
  message: null,
  query: "q",
  fetchedAtMs: 0,
  cached: false,
});

vi.mock("../lib/ipc", () => ({
  errorMessage: (e: unknown) => (e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : String(e)),
  ipc: {
    skillsSearch: vi.fn(async (query: string, sort: string, p: number) => {
      calls.push(`search ${sort} ${query} ${p}`);
      return page(query === "limited");
    }),
    skillsInspect: vi.fn(async (repo: string, ref: string | null) => {
      calls.push(`inspect ${repo} ${ref}`);
      if (repo === "o/missing") throw { code: "not_found", message: "Repository o/missing" };
      if (repo === "o/one") return repoSkills(repo, [skill("skills/only")]);
      return repoSkills(repo, [skill("skills/a"), skill("skills/b")]);
    }),
    skillsFile: vi.fn(async (_repo: string, _sha: string, path: string) => {
      calls.push(`file ${path}`);
      return { path, text: "echo", size: 4, binary: false, truncated: false };
    }),
    skillsInstall: vi.fn(async (_dir: string, _repo: string, _sha: string, skillPath: string, targets: string[], replace: boolean): Promise<InstallResult> => {
      calls.push(`install ${skillPath} ${targets.join(",")} replace=${replace}`);
      if (!replace && installConflicts-- > 0) throw { code: "conflict", message: "conflict: .claude/skills/a already exists" };
      return { name: "a", installed: targets.map((t) => `${t}/a`), replaced: [], files: 1, totalBytes: 10, commitSha: "a".repeat(40), warnings: [] };
    }),
    skillsInstalled: vi.fn(async (dir: string) => {
      calls.push(`installed ${dir}`);
      return [] as InstalledSkill[];
    }),
    skillsRemove: vi.fn(async (_dir: string, rel: string) => void calls.push(`remove ${rel}`)),
    skillsCheckUpdate: vi.fn(async (repo: string, path: string, sha: string) => {
      calls.push(`check ${repo} ${path}`);
      return { repo, path, status: "update", pinnedSha: sha, currentSha: "b".repeat(40) };
    }),
  },
}));
vi.mock("../actions/notify", () => ({ notify: (kind: string, msg: string) => void toasts.push(`${kind}: ${msg}`) }));
vi.mock("./uiStore", () => ({
  useUi: { getState: () => ({ closePalette: () => {} }) },
  confirmDialog: async (o: { title: string }) => {
    confirms.push(o.title);
    return confirmAnswer;
  },
  actionToast: (t: { message: string; action?: { label: string; run: () => void } }) => {
    toasts.push(`action: ${t.message}`);
    t.action?.run();
  },
}));
vi.mock("./attention", () => ({ useAttentionUi: { getState: () => ({ openBroadcast: (ids: string[]) => void broadcasts.push(ids) }) } }));

const s = await import("./skills");
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  calls.length = 0;
  confirms.length = 0;
  toasts.length = 0;
  broadcasts.length = 0;
  installConflicts = 0;
  confirmAnswer = true;
  s.resetSkillsForTests();
});

describe("skills store: discover", () => {
  it("fetches a page once; force asks again (e.g. after a rate limit)", async () => {
    await s.loadPage("trending", "", 1);
    await s.loadPage("trending", "", 1);
    expect(calls).toEqual(["search trending  1"]);
    await s.loadPage("best", "limited", 1);
    const key = Object.keys(s.useSkills.getState().pages).find((k) => k.includes("limited"))!;
    const entry = s.useSkills.getState().pages[key];
    expect(entry.status === "ok" && entry.data.rateLimited).toBe(true);
    await s.loadPage("best", "limited", 1, true);
    expect(calls.filter((c) => c.includes("limited"))).toHaveLength(2);
  });

  it("opens the only skill of a repository, keeps the list for several, reports errors", async () => {
    s.selectRepo("o/one");
    await flush();
    expect(s.useSkills.getState().skillPath).toBe("skills/only");

    s.selectRepo("o/many");
    await flush();
    expect(s.useSkills.getState().skillPath).toBeNull();

    s.selectRepo("o/many", null, "skills/b");
    await flush();
    expect(s.useSkills.getState().skillPath).toBe("skills/b");
    expect(calls.filter((c) => c.startsWith("inspect o/many"))).toHaveLength(1);

    s.selectRepo("o/many", null, "skills/nope");
    await flush();
    expect(s.useSkills.getState().skillPath).toBeNull();

    s.selectRepo("o/missing");
    await flush();
    const e = s.useSkills.getState().repos["o/missing#"];
    expect(e.status === "error" && e.error).toContain("o/missing");
  });

  it("reads a file once", async () => {
    await s.loadFile("o/r", "a".repeat(40), "scripts/run.ps1");
    await s.loadFile("o/r", "a".repeat(40), "scripts/run.ps1");
    expect(calls).toEqual(["file scripts/run.ps1"]);
  });
});

describe("skills store: install / remove", () => {
  const base = (over: Partial<Parameters<typeof s.installSkill>[0]> = {}) => ({
    projectDir: "D:\\proj",
    repo: "o/many",
    commitSha: "a".repeat(40),
    skill: skill("skills/a"),
    targets: [".claude/skills" as const],
    isUpdate: false,
    agents: [
      { id: "c1", agent: "claude" as const, live: true },
      { id: "c2", agent: "claude" as const, live: false },
      { id: "x1", agent: "codex" as const, live: true },
      { id: "p1", agent: "powershell" as const, live: true },
    ],
    ...over,
  });

  it("installs, toasts with the agent count and offers Broadcast for running readers only", async () => {
    const r = await s.installSkill(base());
    expect(r?.installed).toEqual([".claude/skills/a"]);
    expect(calls[0]).toBe("install skills/a .claude/skills replace=false");
    expect(toasts[0]).toBe("action: Added a for 2 agents — running agents pick up project skills on their next session/reload");
    expect(broadcasts, "only live Claude sessions read .claude/skills").toEqual([["c1"]]);
    await flush();
    expect(calls).toContain("installed D:\\proj");
    expect(s.useSkills.getState().lastInstall?.result.name).toBe("a");
    expect(s.useSkills.getState().busy).toBe(false);
  });

  it("asks before replacing; declining writes nothing more", async () => {
    installConflicts = 1;
    confirmAnswer = false;
    expect(await s.installSkill(base())).toBeNull();
    expect(confirms).toEqual(["Replace “a”?"]);
    expect(calls.filter((c) => c.startsWith("install "))).toEqual(["install skills/a .claude/skills replace=false"]);

    installConflicts = 1;
    confirmAnswer = true;
    const r = await s.installSkill(base());
    expect(r).not.toBeNull();
    expect(calls.filter((c) => c.startsWith("install ")).slice(-2)).toEqual([
      "install skills/a .claude/skills replace=false",
      "install skills/a .claude/skills replace=true",
    ]);
  });

  it("updates replace directly and toasts plainly without running readers", async () => {
    await s.installSkill(base({ isUpdate: true, agents: [] }));
    expect(calls[0]).toBe("install skills/a .claude/skills replace=true");
    expect(confirms).toEqual([]);
    expect(toasts[0]).toBe("info: Added a to .claude/skills/a — agents started in this project pick it up");
    expect(broadcasts).toEqual([]);
  });

  it("removes only after confirmation", async () => {
    const inst: InstalledSkill = {
      name: "a",
      folder: "a",
      description: null,
      target: ".claude/skills",
      dirRel: ".claude/skills/a",
      dirAbs: "D:\\proj\\.claude\\skills\\a",
      provenance: { repo: "o/r", commitSha: "a".repeat(40), path: "skills/a", treeSha: "t", name: "a", installedAt: "x" },
      hasScripts: false,
      fileCount: 1,
      isLink: false,
    };
    confirmAnswer = false;
    expect(await s.removeSkill("D:\\proj", inst)).toBe(false);
    expect(calls).toEqual([]);
    confirmAnswer = true;
    expect(await s.removeSkill("D:\\proj", inst)).toBe(true);
    expect(calls[0]).toBe("remove .claude/skills/a");

    await s.checkUpdate(inst);
    const c = s.useSkills.getState().updateChecks[".claude/skills/a"];
    expect(c.status === "ok" && c.data.status).toBe("update");
    s.startUpdate(inst);
    await flush();
    const st = s.useSkills.getState();
    expect(st.updating?.dirRel).toBe(".claude/skills/a");
    expect(st.selection).toEqual({ repo: "o/r", ref: null, pathHint: "skills/a" });
    expect(st.tab).toBe("installed");
  });
});
