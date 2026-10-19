---
name: mission-recap
description: Turn an agent session, branch or PR into a 15-60 second timelapse video (MP4, WebM or GIF) built from git history and the task board - the goal, one lane per agent/branch, tasks ticking done, commits and +/- lines climbing, and an end card with totals. Use when the user asks for a recap video, a timelapse, a summary video or GIF of the session, PR, branch or day, or wants to share or show what the agents did. Works in any agent CLI on Windows, macOS and Linux with Node 18+ and git; Gridkeeper itself is not needed.
---

# Mission recap: an agent session as a 30-second video

`scripts/recap.mjs` reads the repository's git history (and the mission board, if there is one) and writes
**one self-contained HTML page**: a player with Gridkeeper's replay renderer and the session's events inlined.
The page previews the timelapse and exports it as **MP4** (WebM in browsers without H.264) or **GIF**, offline,
with no ffmpeg. Formats: 1920×1080, 1080×1080 or 1080×1920. Nothing is uploaded anywhere.

The video shows: a title card with the goal; then each agent lane (one per branch / worktree) with its commits
and +/− lines ticking up, the task board ticking off, commit subjects in the comms ticker; then an end card with
tasks done, commits, files, lines, agents and wall time, and a small "Made with Gridkeeper" watermark
(the user can turn it off).

## Run it

`<skill>` below is the folder that contains this SKILL.md. Run from the project folder (any worktree of the repo):

```bash
node "<skill>/scripts/recap.mjs"
```

1. **Goal.** If the user described what the session was about, pass it: `--goal "Add OAuth login"` (one line,
   at most ~80 characters). Otherwise the script uses the `# Mission:` line of `.gridkeeper/mission.md`, else the
   branch name, else the last commit subject.
2. **Tasks.** If `.gridkeeper/mission.md` exists it is the task board. If it does not and you kept a plan or todo
   list in this session, write it as a Markdown checklist to a temporary file and pass `--tasks <file>`:
   `- [x] done`, `- [~] in progress`, `- [!] blocked`, `- [ ] not started`, optional owners as `@builder-1`
   (the last part of a lane's branch name) so each task ticks off on that lane's commits.
   Only list work that really happened, and mark `[x]` only what was finished.
3. **Window.** By default the recap starts where the current branch left the default branch (on a feature
   branch), or at the start of today (on the default branch). For anything else pass `--since`, e.g.
   `--since "yesterday"`, `--since "2026-10-18 09:00"`, `--since v1.4.0` or `--since <commit>`.
4. **Open the page** it printed (`mission-recap.html` by default): `--open` does it, or `start "" mission-recap.html`
   (Windows cmd), `Invoke-Item mission-recap.html` (PowerShell), `open` (macOS), `xdg-open` (Linux).
5. **Export.** In the page: pick 16:9 / 1:1 / 9:16, 15–60 s, theme and watermark, press play to check it,
   then **Export MP4** (records in real time: a 30 s video takes 30 s; keep the tab in front) or **Export GIF**.
   The file is downloaded by the browser.

Tell the user where the page is, what it covers (lanes, commits, tasks, time range, as printed) and how to
export. Do not paste the events JSON into the chat.

### Headless export (no clicking)

```bash
node "<skill>/scripts/recap.mjs" --mp4            # writes mission-recap.mp4 next to the page
node "<skill>/scripts/recap.mjs" --gif recap.gif
```

Needs Node 22+ and Chrome, Edge or Chromium (found automatically; or set `CHROME_PATH` / pass `--browser`).
It starts a separate headless browser with a throwaway profile, renders, saves, and closes it. If either is
missing the script says so and the click flow above still works. A browser without H.264 saves `.webm`.

## Options

| Option | Default | |
|---|---|---|
| `--repo <dir>` | current folder | repository to read |
| `--since <date\|ref>` | merge-base with the default branch on a feature branch, else start of today | where the recap starts |
| `--goal "<text>"` | mission.md `# Mission:` line, else branch name, else last commit subject | title |
| `--tasks <file.md>` | `.gridkeeper/mission.md` | task checklist when there is no mission board |
| `--out <file.html>` | `./mission-recap.html` | page to write |
| `--aspect landscape\|square\|vertical` | `landscape` | 1920×1080, 1080×1080, 1080×1920 |
| `--length 15\|30\|45\|60` | `30` | seconds |
| `--no-watermark` | watermark on | hide "Made with Gridkeeper · github.com/raazi29/gridkeeper" |
| `--show-authors` | hidden | show commit author names on the lanes |
| `--no-subjects` | subjects shown | keep commit subjects out of the comms ticker |
| `--no-replay` / `--replay <file>` | auto | ignore / pick a Gridkeeper recording |
| `--open` | off | open the page in the default browser |
| `--mp4 [file]`, `--gif [file]` | off | render headless (see above) |
| `--browser <path>` | auto-detect | browser for headless export |

## Where the data comes from

1. **Gridkeeper recordings** (`.gridkeeper/replay/*.jsonl` in the main checkout), when one covers the window:
   the app's own event log of the mission (task changes, agent states, branch counters, lead messages). Used as
   is, scrubbed again.
2. **git** (read-only commands only): the current branch plus every local branch with commits in the window,
   including branches checked out in other worktrees (`git worktree list`). Each one is an **agent lane** named
   after its branch (`gk/1017-1530/builder-1` → `builder-1`; a role in the name such as `builder` or `reviewer`
   colours it). Per commit: time, `+`/`−` lines (summed per commit), files (unique per lane). A commit reachable
   from several branches counts once, for the branch that made it. A lane appears when its branch was created
   (reflog) or at its first commit; merging it shows "merged X into Y" and marks it done. Commit trailers such as
   `Co-Authored-By: Claude` label the lane's agent.
3. **Task board**: `.gridkeeper/mission.md` (format: the `agent-mission` skill). If the file is tracked in git
   its history replays exactly; otherwise (the usual `.gridkeeper/` is git-ignored) tasks start open and tick off
   in commit order on the commits of the lanes that own them, ending in their real final states. `--tasks`
   works the same way.

Nothing is invented: without commits in the window (and no recording) there is no video, and the script says
how to widen the window.

## Privacy

The page contains only: the goal, task text, branch names, commit times and counts, line and file counts, and
commit subjects with file names and paths removed. It never contains file paths, file contents, diffs, e-mail
addresses, commit hashes or absolute paths; free text goes through the same scrubber as Gridkeeper's recorder
(absolute paths, e-mails and secret-looking tokens are replaced). Author names appear only with
`--show-authors`; `--no-subjects` drops commit subjects. The page works offline and its content security policy
blocks every network request. Suggest the user watches the preview before sharing the video.

## Troubleshooting

- **"nothing to recap"**: no commits in the window. Use `--since "yesterday"`, `--since "3 days ago"` or
  `--since <commit>`.
- **Too many lanes** (old local branches): only branches with commits in the window appear; narrow it with
  `--since`.
- **No Export MP4 button** (Firefox, older Safari): the page offers WebM, or use the GIF, or open the page in
  Chrome or Edge.
- **Headless export refused**: needs Node 22+ and a Chromium-based browser; the click flow always works.
