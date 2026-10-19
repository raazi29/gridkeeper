#!/usr/bin/env node
// mission-recap: turn a repo's recent agent work into a 15-60 s timelapse video page. Node >= 18, no npm
// dependencies, any OS, no Gridkeeper needed.
//
//   node recap.mjs [--since <date|ref>] [--goal "..."] [--out recap.html] [--mp4] ...   (see --help)
//
// Reads (read-only): `git log` of the current branch and of local branches / worktrees (each one is an
// agent lane), .gridkeeper/mission.md (the task board) or a --tasks checklist, and Gridkeeper's own
// recordings in .gridkeeper/replay/*.jsonl when they cover the window (preferred). Writes ONE HTML file:
// the events (JSON) plus Gridkeeper's replay renderer (player.js), which previews the recap and exports
// MP4 / WebM / GIF in the browser. --mp4 / --gif do the export headless in a local Chrome / Edge.
//
// PRIVACY: the page holds branch names, commit times and counts, commit subjects with file names removed
// (--no-subjects drops them) and task text; never file paths, contents, diffs, e-mail addresses or
// hashes. Author names only with --show-authors. The page makes no network requests.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as core from "./lib/core.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MISSION = ".gridkeeper/mission.md";

// ---- git ------------------------------------------------------------------------------------------

export function makeGit(cwd) {
  return (args) =>
    execFileSync("git", ["-C", cwd, "-c", "color.ui=never", "-c", "log.showSignature=false", "-c", "core.quotepath=off", ...args], {
      encoding: "utf8",
      maxBuffer: 512 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat" },
    });
}

const attempt = (git, args) => {
  try {
    return git(args);
  } catch {
    return null;
  }
};
const line = (git, args) => attempt(git, args)?.trim() || null;

function detectDefault(git) {
  const remoteHead = line(git, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  const has = (b) => line(git, ["rev-parse", "--verify", "--quiet", `refs/heads/${b}`]) !== null;
  if (remoteHead) {
    const local = remoteHead.replace(/^origin\//, "");
    return has(local) ? local : remoteHead;
  }
  const configured = line(git, ["config", "--get", "init.defaultBranch"]);
  for (const b of [configured, "main", "master", "trunk", "develop"]) if (b && has(b)) return b;
  return null;
}

const creation = (git, branch) => core.parseCreation(attempt(git, ["reflog", "show", "--date=unix", "--format=%H%x09%gd%x09%gs", `refs/heads/${branch}`, "--"]));

function localDateTime(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * Everything the recap needs from the repo (read-only git commands and files). Returns
 * { events, goal, window: { mode, label, t0 }, summary, boardLabel }.
 */
export function collect(opts, now = Date.now()) {
  const repo = resolve(opts.repo ?? process.cwd());
  let top;
  try {
    top = makeGit(repo)(["rev-parse", "--show-toplevel"]).trim();
  } catch (e) {
    const missing = e && e.code === "ENOENT";
    throw new Error(missing ? "git was not found on PATH" : `not a git repository: ${repo}`);
  }
  const git = makeGit(top);
  const worktrees = core.parseWorktrees(attempt(git, ["worktree", "list", "--porcelain"]) ?? "");
  const mainCheckout = worktrees.find((w) => !w.bare)?.path ?? top;
  const current = line(git, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const defaultBranch = detectDefault(git);

  // ---- window ----
  let mode = null;
  let base = null;
  let sinceArg = null;
  let label = "";
  if (opts.since) {
    const sha = line(git, ["rev-parse", "--verify", "--quiet", `${opts.since}^{commit}`]);
    if (sha) {
      mode = "ref";
      base = sha;
      label = `since ${opts.since}`;
    } else {
      mode = "date";
      sinceArg = opts.since;
      label = `since ${opts.since}`;
    }
  } else if (core.defaultWindow({ current, defaultBranch }) === "merge-base") {
    const mb = line(git, ["merge-base", "HEAD", defaultBranch]);
    if (mb) {
      mode = "ref";
      base = mb;
      label = `since ${current ?? "HEAD"} left ${defaultBranch}`;
    }
  }
  if (!mode) {
    mode = "date";
    sinceArg = localDateTime(core.startOfDay(now));
    label = "since the start of today";
  }
  let t0;
  if (mode === "ref") t0 = Number(line(git, ["show", "-s", "--format=%ct", base])) * 1000 || null;
  else {
    const m = /--max-age=(\d+)/.exec(line(git, ["rev-parse", `--since=${sinceArg}`]) ?? "");
    if (!m) throw new Error(`--since "${opts.since}" is neither a commit nor a date git understands`);
    t0 = Number(m[1]) * 1000;
  }
  const range = mode === "ref" ? [`^${base}`] : [`--since=${sinceArg}`];
  const logArgs = ["log", "--no-color", "--numstat", `--format=${core.LOG_FORMAT}`];
  const log = (revs) => core.parseLog(attempt(git, [...logArgs, ...range, ...revs, "--"]) ?? "");

  // ---- lanes: the current branch, then every local branch with work in the window ----
  const folderOf = new Map(worktrees.filter((w) => w.branch).map((w) => [w.branch, w.path]));
  const lanes = [
    {
      branch: current ?? "HEAD",
      base: true,
      folder: top,
      createdAt: current ? (creation(git, current)?.t ?? null) : null,
      merged: false,
      commits: log(["HEAD"]),
    },
  ];
  const refs = core.parseRefs(attempt(git, ["for-each-ref", "--format=%(refname:short)%09%(objectname)%09%(committerdate:unix)", "refs/heads"]) ?? "");
  for (const r of refs) {
    if (r.name === current) continue;
    if (t0 !== null && r.t < t0) continue; // tip older than the window: nothing new on it
    // On a feature branch, the default branch's own progress is someone else's work.
    if (mode === "ref" && r.name === defaultBranch && current !== defaultBranch) continue;
    const created = creation(git, r.name);
    const fork = created?.sha ?? line(git, ["merge-base", r.name, "HEAD"]);
    const commits = log([...(fork ? [`^${fork}`] : []), r.name]);
    if (!commits.length) continue;
    const merged = attempt(git, ["merge-base", "--is-ancestor", r.sha, "HEAD"]) !== null;
    lanes.push({ branch: r.name, base: false, folder: folderOf.get(r.name) ?? null, createdAt: created?.t ?? null, merged, commits });
  }

  // ---- task board ----
  const boardDirs = [...new Set([mainCheckout, top])];
  let board = null;
  let missionGoal = null;
  let boardLabel = null;
  if (opts.tasks) {
    const p = resolve(opts.tasks);
    if (!existsSync(p)) throw new Error(`--tasks file not found: ${opts.tasks}`);
    const doc = core.parseMission(readFileSync(p, "utf8"));
    board = { kind: "final", doc };
    missionGoal = doc.goal;
    boardLabel = `${doc.tasks.length} tasks from ${basename(p)}`;
  } else {
    for (const dir of boardDirs) {
      const p = join(dir, MISSION);
      if (!existsSync(p)) continue;
      const text = readFileSync(p, "utf8");
      const doc = core.parseMission(text);
      missionGoal = doc.goal;
      const g = makeGit(dir);
      const tracked = attempt(g, ["ls-files", "--error-unmatch", "--", MISSION]) !== null;
      if (tracked) {
        board = { kind: "history", snaps: missionHistory(g, { mode, base, sinceArg, text, mtime: statSync(p).mtimeMs, now }) };
        boardLabel = `${doc.tasks.length} tasks, mission.md history (${board.snaps.length} versions)`;
      } else {
        board = { kind: "final", doc };
        boardLabel = `${doc.tasks.length} tasks from mission.md (final states, ticked off in commit order)`;
      }
      break;
    }
  }

  // ---- Gridkeeper recordings (preferred when they cover the window) ----
  let recording = null;
  if (opts.replayFile) {
    const direct = resolve(opts.replayFile);
    const p = existsSync(direct) ? direct : boardDirs.map((d) => join(d, ".gridkeeper", "replay", opts.replayFile)).find(existsSync);
    if (!p) throw new Error(`recording not found: ${opts.replayFile}`);
    const { events } = core.parseReplay(readFileSync(p, "utf8"));
    if (!events.length) throw new Error(`no replay events in ${basename(p)}`);
    recording = { names: [basename(p)], events, goal: core.recordingInfo(events).goal };
  } else if (opts.replay !== false) {
    for (const dir of boardDirs) {
      const rd = join(dir, ".gridkeeper", "replay");
      if (!existsSync(rd)) continue;
      const recs = [];
      for (const name of readdirSync(rd)) {
        if (!core.RECORDING_NAME_RE.test(name)) continue;
        try {
          recs.push({ name, events: core.parseReplay(readFileSync(join(rd, name), "utf8")).events });
        } catch {
          /* unreadable: skip */
        }
      }
      recording = core.pickRecordings(recs, t0);
      if (recording) break;
    }
  }

  const newest = lanes.flatMap((l) => l.commits).sort((a, b) => b.t - a.t)[0];
  const goal = core.resolveGoal({ flag: opts.goal, mission: missionGoal, recording: recording?.goal, branch: current, defaultBranch, lastSubject: newest?.subject });

  let events;
  let summary;
  if (recording) {
    events = core.sanitizeRecording(recording.events, opts.goal);
    summary = { kind: "recording", names: recording.names };
  } else {
    const built = core.buildEvents({ goal, lanes, board, t0, showAuthors: !!opts.showAuthors, subjects: opts.subjects !== false });
    events = built.events;
    summary = { kind: "git", lanes: built.lanes, commits: built.commits, tasks: built.tasks };
  }
  const shown = recording ? core.scrubText(opts.goal || recording.goal) || goal : goal;
  return { events, goal: shown, window: { mode, label, t0 }, summary, boardLabel };
}

/** Versions of a tracked mission.md: the one at the window start (t: null), each commit in it, the working copy. */
function missionHistory(git, { mode, base, sinceArg, text, mtime, now }) {
  const range = mode === "ref" ? [`^${base}`] : [`--since=${sinceArg}`];
  const revs = (attempt(git, ["log", "--format=%H%x09%ct", ...range, "HEAD", "--", MISSION]) ?? "")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => {
      const [sha, ct] = l.split("\t");
      return { sha, t: Number(ct) * 1000 };
    })
    .reverse();
  const snaps = [];
  const before = mode === "ref" ? base : line(git, ["log", "-1", "--format=%H", `--until=${sinceArg}`, "HEAD", "--", MISSION]);
  const initial = before ? attempt(git, ["show", `${before}:${MISSION}`]) : null;
  if (initial !== null) snaps.push({ t: null, doc: core.parseMission(initial) });
  for (const r of revs) {
    const body = attempt(git, ["show", `${r.sha}:${MISSION}`]);
    snaps.push({ t: r.t, doc: core.parseMission(body ?? "") });
  }
  const head = attempt(git, ["show", `HEAD:${MISSION}`]);
  if ((head ?? "").trim() !== text.trim()) {
    const last = snaps.length ? (snaps[snaps.length - 1].t ?? 0) : 0;
    snaps.push({ t: Math.max(last + 1, Math.min(now, mtime)), doc: core.parseMission(text) });
  }
  return snaps;
}

// ---- page -----------------------------------------------------------------------------------------

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** The self-contained player page: events JSON + the inlined renderer. No external requests (CSP). */
export function pageHtml(data, playerJs) {
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  const js = String(playerJs).replace(/<\/(script)/gi, "<\\/$1");
  const title = escapeHtml(data.goal ? `${data.goal} · mission recap` : "Mission recap");
  const csp = "default-src 'none'; script-src 'unsafe-inline' blob:; worker-src blob: data:; style-src 'unsafe-inline'; font-src data:; img-src data: blob:; media-src blob: data:; connect-src 'none'; base-uri 'none'; form-action 'none'";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="generator" content="Gridkeeper mission-recap">
<title>${title}</title>
<style>html,body{margin:0;background:#07090d;color:#e7ecf4;font-family:system-ui,sans-serif}</style>
</head>
<body>
<div id="recap-root"><noscript><p style="padding:24px">This page needs JavaScript to play the recap.</p></noscript></div>
<script type="application/json" id="recap-data">${json}</script>
<script>${js}</script>
</body>
</html>
`;
}

export function readPlayer() {
  const p = join(HERE, "player.js");
  if (!existsSync(p)) throw new Error(`player.js is missing next to recap.mjs (${p}); rebuild it: npx vite build --config skills/mission-recap/player/vite.config.ts`);
  return readFileSync(p, "utf8");
}

// ---- cli ------------------------------------------------------------------------------------------

function openInBrowser(file) {
  const [cmd, args] = process.platform === "win32" ? ["explorer.exe", [file]] : process.platform === "darwin" ? ["open", [file]] : ["xdg-open", [file]];
  try {
    spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
  } catch {
    /* the path is printed anyway */
  }
}

const kb = (n) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export async function main(argv = process.argv.slice(2)) {
  let opts;
  try {
    opts = core.parseArgs(argv);
  } catch (e) {
    console.error(`mission-recap: ${e.message}`);
    return 2;
  }
  if (opts.help) {
    process.stdout.write(core.USAGE);
    return 0;
  }
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 18) {
    console.error(`mission-recap: needs Node 18 or newer (this is ${process.versions.node})`);
    return 1;
  }
  let res;
  try {
    res = collect(opts);
  } catch (e) {
    console.error(`mission-recap: ${e.message}`);
    return 1;
  }
  if (!res.events.length) {
    console.error(`mission-recap: nothing to recap ${res.window.label}: no commits on the current branch or any local branch.`);
    console.error(`  Try an earlier start, e.g. --since "yesterday", --since "3 days ago" or --since <commit>.`);
    return 1;
  }
  const out = resolve(opts.out ?? "mission-recap.html");
  const data = {
    format: 1,
    generator: "mission-recap",
    source: res.summary.kind,
    goal: res.goal,
    baseName: core.goalSlug(res.goal),
    options: { aspect: opts.aspect, length: opts.length, watermark: opts.watermark },
    events: res.events,
  };
  try {
    writeFileSync(out, pageHtml(data, readPlayer()));
  } catch (e) {
    console.error(`mission-recap: could not write ${out}: ${e.message}`);
    return 1;
  }

  const first = res.events[0].t;
  const last = res.events[res.events.length - 1].t;
  const clock = (t) => new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  console.log(`mission-recap: ${res.goal ?? "(no goal)"}`);
  console.log(`  window   ${res.window.label} (${clock(first)} -> ${clock(last)})`);
  if (res.summary.kind === "recording") console.log(`  source   Gridkeeper recording: ${res.summary.names.join(", ")}`);
  else {
    const lanes = res.summary.lanes.map((l) => `${l.name} ${l.commits}`).join(", ");
    console.log(`  source   git: ${res.summary.commits} commits in ${res.summary.lanes.length} lane(s) (${lanes})`);
    console.log(`  board    ${res.boardLabel ?? "none (no .gridkeeper/mission.md; pass --tasks <checklist.md> to show one)"}`);
  }
  console.log(`  wrote    ${out} (${kb(statSync(out).size)})`);

  let code = 0;
  const jobs = [];
  if (opts.mp4 !== null) jobs.push(["video", opts.mp4 || out.replace(/\.html?$/i, "") + ".mp4"]);
  if (opts.gif !== null) jobs.push(["gif", opts.gif || out.replace(/\.html?$/i, "") + ".gif"]);
  if (jobs.length) {
    const { renderHeadless } = await import("./lib/headless.mjs");
    for (const [kind, file] of jobs) {
      const label = (kind === "gif" ? "gif" : "video").padEnd(9);
      const r = await renderHeadless({ html: out, kind, out: resolve(file), browser: opts.browser, length: opts.length });
      if (r.ok) console.log(`  ${label}${r.file} (${kb(r.size)})${r.note ? `  ${r.note}` : ""}`);
      else {
        console.log(`  ${label}not rendered: ${r.reason}`);
        console.log(`           open the page and click Export ${kind === "gif" ? "GIF" : "MP4"} instead.`);
        code = 3;
      }
    }
  } else console.log(`  next     open the page in a browser, press play, then Export MP4 or Export GIF`);
  if (opts.open) openInBrowser(out);
  return code;
}

const invokedDirectly = (() => {
  try {
    return !!process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      console.error(`mission-recap: ${e?.stack ?? e}`);
      process.exitCode = 1;
    },
  );
}
