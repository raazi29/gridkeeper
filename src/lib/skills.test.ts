import { describe, expect, it } from "vitest";
import { FEATURED_SKILL_REPOS, featuredEntry } from "./featuredSkills";
import {
  REPO_RE,
  agentsReading,
  defaultTargets,
  formatBytes,
  formatStars,
  githubUrl,
  installToast,
  installedCopies,
  isExecutablePath,
  isValidRef,
  minutesUntil,
  pageKey,
  parseRepoInput,
  relativeTime,
  repoKey,
  riskyFiles,
  shortSha,
  skillPathLabel,
  splitFrontmatter,
} from "./skills";
import type { InstalledSkill } from "./types";

describe("parseRepoInput", () => {
  it("accepts owner/repo with an optional ref", () => {
    expect(parseRepoInput("anthropics/skills")).toEqual({ repo: "anthropics/skills", ref: null, path: null });
    expect(parseRepoInput("  heygen-com/hyperframes#v1.2 ")).toEqual({ repo: "heygen-com/hyperframes", ref: "v1.2", path: null });
    expect(parseRepoInput("o/r#feature/x")).toEqual({ repo: "o/r", ref: "feature/x", path: null });
    expect(parseRepoInput("o/r#")).toEqual({ repo: "o/r", ref: null, path: null });
  });

  it("accepts GitHub URLs", () => {
    expect(parseRepoInput("https://github.com/mattpocock/skills")).toEqual({ repo: "mattpocock/skills", ref: null, path: null });
    expect(parseRepoInput("github.com/o/r.git")?.repo).toBe("o/r");
    expect(parseRepoInput("https://www.github.com/o/r/")?.repo).toBe("o/r");
    expect(parseRepoInput("git@github.com:o/r.git")?.repo).toBe("o/r");
    expect(parseRepoInput("https://github.com/o/r?tab=readme")?.repo).toBe("o/r");
    expect(parseRepoInput("https://github.com/o/r/tree/main/skills/pdf")).toEqual({ repo: "o/r", ref: "main", path: "skills/pdf" });
    expect(parseRepoInput("https://github.com/o/r/blob/abc123/skills/my%20skill/SKILL.md")).toEqual({
      repo: "o/r",
      ref: "abc123",
      path: "skills/my skill",
    });
    expect(parseRepoInput("https://github.com/o/r/tree/main")).toEqual({ repo: "o/r", ref: "main", path: null });
    expect(parseRepoInput("https://github.com/o/r/tree/main#dev")?.ref).toBe("dev");
    expect(parseRepoInput("https://github.com/o/r/issues")).toEqual({ repo: "o/r", ref: null, path: null });
  });

  it("rejects everything else", () => {
    for (const bad of ["", "   ", "anthropics", "https://gitlab.com/o/r", "ftp://github.com/o/r", "o r/x", "o/r;rm", "../x", "o/..", "o/r#../x", "o/r#-x"]) {
      expect(parseRepoInput(bad), bad).toBeNull();
    }
  });

  it("validates like the Rust side", () => {
    expect(REPO_RE.test("a-b/c.d_e")).toBe(true);
    expect(REPO_RE.test("a_b/c")).toBe(false);
    for (const ok of ["main", "v1.2.3", "feature/x", "0123456789abcdef0123456789abcdef01234567"]) expect(isValidRef(ok), ok).toBe(true);
    for (const bad of ["", "-x", "/x", "x/", "a..b", "a//b", "a b", ".x", "x.", "x/.y"]) expect(isValidRef(bad), bad).toBe(false);
  });
});

describe("formatting", () => {
  it("formats bytes, stars and SHAs", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1025)).toBe("2 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatStars(999)).toBe("999");
    expect(formatStars(1000)).toBe("1k");
    expect(formatStars(1250)).toBe("1.3k");
    expect(formatStars(181_829)).toBe("182k");
    expect(formatStars(2_400_000)).toBe("2.4M");
    expect(shortSha("0123456789abcdef")).toBe("0123456");
    expect(shortSha(null)).toBe("");
  });

  it("describes times relative to now", () => {
    const now = Date.parse("2026-10-18T12:00:00Z");
    expect(relativeTime("2026-10-18T08:00:00Z", now)).toBe("today");
    expect(relativeTime("2026-10-17T08:00:00Z", now)).toBe("yesterday");
    expect(relativeTime("2026-10-10T12:00:00Z", now)).toBe("8 days ago");
    expect(relativeTime("2026-08-01T12:00:00Z", now)).toBe("2 months ago");
    expect(relativeTime("2024-10-01T12:00:00Z", now)).toBe("2 years ago");
    expect(relativeTime("2027-01-01T00:00:00Z", now), "clock skew never shows the future").toBe("today");
    expect(relativeTime(null, now)).toBe("");
    expect(relativeTime("garbage", now)).toBe("");
    expect(minutesUntil(now / 1000 + 600, now)).toBe(10);
    expect(minutesUntil(now / 1000 + 5, now)).toBe(1);
    expect(minutesUntil(now / 1000 - 5, now)).toBeNull();
    expect(minutesUntil(null, now)).toBeNull();
  });

  it("splits SKILL.md frontmatter", () => {
    expect(splitFrontmatter("---\nname: x\ndescription: y\n---\n\n# Body\ntext")).toEqual({ frontmatter: "name: x\ndescription: y", body: "# Body\ntext" });
    expect(splitFrontmatter("\uFEFF---\r\nname: x\r\n---\r\nbody")).toEqual({ frontmatter: "name: x", body: "body" });
    expect(splitFrontmatter("# No frontmatter")).toEqual({ frontmatter: null, body: "# No frontmatter" });
    expect(splitFrontmatter("---\nunclosed")).toEqual({ frontmatter: null, body: "---\nunclosed" });
  });

  it("builds GitHub links and labels", () => {
    expect(githubUrl("o/r")).toBe("https://github.com/o/r");
    expect(githubUrl("o/r", "abc", "skills/my skill")).toBe("https://github.com/o/r/tree/abc/skills/my%20skill");
    expect(githubUrl("o/r", "abc", "")).toBe("https://github.com/o/r/tree/abc");
    expect(skillPathLabel("")).toBe("(repository root)");
    expect(skillPathLabel("skills/pdf")).toBe("skills/pdf");
    expect(repoKey("Anthropics/Skills", null)).toBe("anthropics/skills#");
    expect(repoKey("o/r", "main")).toBe("o/r#main");
    expect(pageKey("best", " pdf ", 2)).toBe(pageKey("best", "pdf", 2));
    expect(pageKey("best", "pdf", 1)).not.toBe(pageKey("stars", "pdf", 1));
  });
});

describe("scripts warning", () => {
  it("flags scripts and executable-looking files", () => {
    for (const p of ["run.ps1", "scripts/x.SH", "a/b/tool.exe", "x.cmd", "x.bat", "index.js", "fill.py"]) expect(isExecutablePath(p), p).toBe(true);
    for (const p of ["README.md", "assets/logo.png", ".py", "notes.txt", "reference/ps1"]) expect(isExecutablePath(p), p).toBe(false);
    const files = [
      { path: "SKILL.md", size: 1, executable: false },
      { path: "scripts/helper.txt", size: 1, executable: false },
      { path: "bin/tool", size: 1, executable: true },
      { path: "lib/x.py", size: 1, executable: false },
    ];
    expect(riskyFiles(files).map((f) => f.path)).toEqual(["scripts/helper.txt", "bin/tool", "lib/x.py"]);
  });
});

describe("targets and agents", () => {
  it("defaults targets to the workspace's agents", () => {
    expect(defaultTargets(["claude", "powershell"])).toEqual([".claude/skills"]);
    expect(defaultTargets(["codex"])).toEqual([".agents/skills"]);
    expect(defaultTargets(["generic"])).toEqual([".agents/skills"]);
    expect(defaultTargets(["claude", "codex"])).toEqual([".claude/skills", ".agents/skills"]);
    expect(defaultTargets(["powershell"])).toEqual([".claude/skills", ".agents/skills"]);
    expect(defaultTargets([])).toEqual([".claude/skills", ".agents/skills"]);
  });

  it("counts the agents that read the installed targets", () => {
    const agents = [
      { id: "a", agent: "claude" as const },
      { id: "b", agent: "codex" as const },
      { id: "c", agent: "powershell" as const },
      { id: "d", agent: "claude" as const },
    ];
    expect(agentsReading([".claude/skills"], agents).map((a) => a.id)).toEqual(["a", "d"]);
    expect(agentsReading([".claude/skills", ".agents/skills"], agents).map((a) => a.id)).toEqual(["a", "b", "d"]);
    expect(agentsReading([], agents)).toEqual([]);
  });

  it("writes honest toasts", () => {
    expect(installToast("pdf", [".claude/skills/pdf"], 3)).toBe(
      "Added pdf for 3 agents — running agents pick up project skills on their next session/reload",
    );
    expect(installToast("pdf", [".claude/skills/pdf"], 1)).toContain("for 1 agent —");
    expect(installToast("pdf", [".claude/skills/pdf", ".agents/skills/pdf"], 0)).toBe(
      "Added pdf to .claude/skills/pdf and .agents/skills/pdf — agents started in this project pick it up",
    );
    expect(installToast("pdf", [], 2)).not.toMatch(/live|now active/i);
  });

  it("finds installed copies by provenance", () => {
    const mk = (dirRel: string, repo: string | null, path = "skills/pdf"): InstalledSkill => ({
      name: "pdf",
      folder: "pdf",
      description: null,
      target: dirRel.startsWith(".claude") ? ".claude/skills" : ".agents/skills",
      dirRel,
      dirAbs: `C:\\p\\${dirRel}`,
      provenance: repo ? { repo, commitSha: "a".repeat(40), path, treeSha: null, name: "pdf", installedAt: "2026-10-18T00:00:00Z" } : null,
      hasScripts: false,
      fileCount: 1,
      isLink: false,
    });
    const list = [mk(".claude/skills/pdf", "O/R"), mk(".agents/skills/pdf", "o/r"), mk(".claude/skills/local", null), mk(".claude/skills/other", "o/r", "skills/other")];
    expect(installedCopies(list, "o/r", "skills/pdf").map((i) => i.dirRel)).toEqual([".claude/skills/pdf", ".agents/skills/pdf"]);
    expect(installedCopies(list, "x/y", "skills/pdf")).toEqual([]);
  });
});

describe("featured skills", () => {
  it("lists valid repositories, marked featured (not verified)", () => {
    expect(FEATURED_SKILL_REPOS.map((f) => f.fullName)).toEqual([
      "raazi29/gridkeeper",
      "anthropics/skills",
      "cathrynlavery/diagram-design",
      "mattpocock/skills",
      "heygen-com/hyperframes",
    ]);
    for (const f of FEATURED_SKILL_REPOS) {
      expect(REPO_RE.test(f.fullName), f.fullName).toBe(true);
      expect(f.description).not.toMatch(/verified|official|safe/i);
    }
    expect(featuredEntry("Anthropics/Skills")?.fullName).toBe("anthropics/skills");
    expect(featuredEntry("x/y")).toBeUndefined();
  });
});
