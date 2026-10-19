// mission-recap: the page writer, browser lookup, and an end-to-end run on a temporary git repo (skipped
// when git is not installed).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { toEvent, type ReplayEvent } from "../../../src/replay/events";
import { buildTimeline } from "../../../src/replay/timeline";
import * as core from "../scripts/lib/core.mjs";
import { browserCandidates, headlessUnavailable } from "../scripts/lib/headless.mjs";
import { collect, main, pageHtml, readPlayer } from "../scripts/recap.mjs";

function dataOf(html: string) {
  const open = '<script type="application/json" id="recap-data">';
  const start = html.indexOf(open) + open.length;
  return JSON.parse(html.slice(start, html.indexOf("</script>", start)));
}

describe("pageHtml", () => {
  it("inlines data and player safely, with a no-network CSP", () => {
    const goal = 'Break </script><script>alert(1)</script> "out"';
    const html = pageHtml({ goal, events: [{ t: 1, k: "end" }] }, "console.log('</script>')");
    expect(html.match(/<\/script>/g)).toHaveLength(2);
    expect(html).toContain("connect-src 'none'");
    expect(html).toContain("<title>Break &lt;/script&gt;");
    expect(dataOf(html).goal).toBe(goal);
  });

  it("ships a built player", () => {
    const js = readPlayer();
    expect(js).toContain("GridkeeperRecap");
    expect(js).toContain("data:font/woff2");
    expect(js).not.toMatch(/<\/script/i);
  });
});

describe("headless browser lookup", () => {
  it("lists per-OS candidates, $CHROME_PATH first", () => {
    const win = browserCandidates("win32", { CHROME_PATH: "X:\\chrome.exe", ProgramFiles: "C:\\PF", LOCALAPPDATA: "C:\\LA" });
    expect(win[0]).toBe("X:\\chrome.exe");
    expect(win.some((p) => p.endsWith("chrome.exe") && p.startsWith("C:\\PF"))).toBe(true);
    expect(win.some((p) => p.endsWith("msedge.exe"))).toBe(true);
    const mac = browserCandidates("darwin", {});
    expect(mac).toContain("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
    const linux = browserCandidates("linux", { PATH: ["/usr/bin", "/snap/bin"].join(process.platform === "win32" ? ";" : ":") });
    expect(linux).toContain(join("/usr/bin", "google-chrome"));
    expect(linux).toContain(join("/usr/bin", "chromium"));
  });

  it("needs Node 22 with WebSocket", () => {
    expect(headlessUnavailable("20.11.0", true)).toMatch(/Node 22/);
    expect(headlessUnavailable("22.0.0", false)).toMatch(/Node 22/);
    expect(headlessUnavailable("22.4.1", true)).toBeNull();
  });
});

const hasGit = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasGit)("recap.mjs on a temporary repo", () => {
  let dir = "";
  let repo = "";
  let wt = "";
  const now = Math.floor(Date.now() / 1000);
  const at = (minutesAgo: number) => `${now - minutesAgo * 60} +0000`;
  const git = (cwd: string, args: string[], date = at(0)) =>
    execFileSync("git", ["-C", cwd, "-c", "commit.gpgsign=false", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Test Author",
        GIT_AUTHOR_EMAIL: "author@example.com",
        GIT_COMMITTER_NAME: "Test Author",
        GIT_COMMITTER_EMAIL: "author@example.com",
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_DATE: date,
      },
    }).toString();
  const commit = (cwd: string, file: string, body: string, msg: string, minutesAgo: number) => {
    writeFileSync(join(cwd, file), body);
    git(cwd, ["add", "--", file], at(minutesAgo));
    git(cwd, ["commit", "-q", "--no-verify", "-m", msg], at(minutesAgo));
  };
  const opts = (...argv: string[]) => core.parseArgs(["--repo", repo, "--since", "3 hours ago", ...argv]);

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "mission-recap-test-"));
    repo = join(dir, "repo");
    wt = join(dir, "repo-builder-1");
    mkdirSync(repo);
    git(repo, ["init", "-q"]);
    git(repo, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    commit(repo, "plan.md", "# plan\n", "Plan the work in docs/plan.md", 90);
    commit(repo, "app.js", "console.log(1)\n", "Add the app skeleton", 80);
    git(repo, ["worktree", "add", "-q", "-b", "gk/test/builder-1", wt], at(70));
    commit(wt, "feature.js", "export const f = 1;\nexport const g = 2;\n", "Builder: add the feature", 60);
    commit(wt, "feature.js", "export const f = 3;\n", "Builder: tighten it up\n\nCo-Authored-By: Claude <noreply@anthropic.com>", 40);
    mkdirSync(join(repo, ".gridkeeper"));
    writeFileSync(join(repo, ".gridkeeper", ".gitignore"), "*\n");
    writeFileSync(join(repo, ".gridkeeper", "mission.md"), "# Mission: Ship the test feature\n\n## Tasks\n- [x] Plan it @main\n- [x] Build the feature @builder-1\n- [ ] Review @reviewer\n");
  });

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("builds lanes, board and events from git", () => {
    const res = collect(opts("--no-replay"));
    expect(res.summary.kind).toBe("git");
    expect(res.goal).toBe("Ship the test feature");
    expect(res.summary.lanes.map((l: { name: string; commits: number }) => [l.name, l.commits])).toEqual([
      ["main", 2],
      ["builder-1", 2],
    ]);
    const events = res.events.map((e: unknown) => toEvent(e)).filter((e: ReplayEvent | null): e is ReplayEvent => !!e);
    expect(events.length).toBe(res.events.length);
    const join1 = events.find((e: ReplayEvent) => e.k === "join");
    expect(join1).toMatchObject({ slug: "builder-1", role: "builder", agent: "claude", t: (now - 70 * 60) * 1000 });
    const tl = buildTimeline(events);
    expect(tl.stats.commits).toBe(4);
    expect(tl.stats.tasksDone).toBe(2);
    expect(tl.stats.tasksTotal).toBe(3);
    expect(tl.stats.ins).toBe(1 + 1 + 2 + 1);
  });

  it("defaults to the merge-base on a feature branch", () => {
    const res = collect(core.parseArgs(["--repo", wt, "--no-replay"]));
    expect(res.window.mode).toBe("ref");
    expect(res.summary.lanes.map((l: { name: string; commits: number }) => [l.name, l.commits])).toEqual([["builder-1", 2]]);
  });

  it("prefers a Gridkeeper recording that covers the window", () => {
    const rd = join(repo, ".gridkeeper", "replay");
    mkdirSync(rd, { recursive: true });
    const t = (now - 30 * 60) * 1000;
    const lines = [
      { t, k: "start", v: 1, goal: "Recorded mission", team: [{ slug: "lead", name: "Lead", role: "lead", agent: "claude", live: true }], tasks: [{ text: "Do it", s: "todo", o: ["lead"] }] },
      { t: t + 1000, k: "task", text: "Do it", s: "done", o: ["lead"] },
    ];
    const file = join(rd, "2026-10-19-1000-recorded-mission.jsonl");
    writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    try {
      const res = collect(opts());
      expect(res.summary.kind).toBe("recording");
      expect(res.goal).toBe("Recorded mission");
      expect(res.events).toHaveLength(2);
      expect(collect(opts("--no-replay")).summary.kind).toBe("git");
    } finally {
      rmSync(file);
    }
  });

  it("writes a self-contained page without paths or e-mails", async () => {
    const out = join(dir, "recap.html");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(await main(["--repo", repo, "--since", "3 hours ago", "--no-replay", "--out", out, "--aspect", "square", "--length", "15", "--no-watermark"])).toBe(0);
    } finally {
      log.mockRestore();
    }
    expect(existsSync(out)).toBe(true);
    const html = readFileSync(out, "utf8");
    const data = dataOf(html);
    expect(data.options).toEqual({ aspect: "square", length: 15, watermark: false });
    expect(data.source).toBe("git");
    const json = JSON.stringify(data);
    for (const p of [dir, dir.replace(/\\/g, "/"), "example.com", "Test Author", "docs/plan.md", "feature.js"]) expect(json).not.toContain(p);
    expect(json).toContain("Plan the work in ‹path›");
  });

  it("explains an empty window", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await main(["--repo", repo, "--since", "1 minute ago", "--no-replay", "--out", join(dir, "x.html")])).toBe(1);
      expect(err.mock.calls.flat().join(" ")).toMatch(/nothing to recap/);
    } finally {
      err.mockRestore();
    }
  });
});
