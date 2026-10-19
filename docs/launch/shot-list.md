# Shot list

Every shot is recorded from the real app in an isolated **sandbox** instance (its own data folder, WebView2
profile and CDP port), never from the Gridkeeper you work in. `scripts/showcase/launch.mjs` automates all of it:
setup, the six shots, the text cards, the ffmpeg assembly and the cleanup. This page explains what it does, so a
shot can be checked or redone by hand.

## Run it

```powershell
# 1. Sandbox with e2e handles (dev build), fresh data, CDP on 9333. Keep its window visible: don't minimize it or
#    cover it completely (Chromium stops painting hidden windows). A 1920x1080 or larger display is best.
npm run sandbox -- -Name launch -Fresh

# 2. In another PowerShell, once the sandbox window is up:
$env:CDP_PORT = 9333
node scripts/showcase/launch.mjs                 # all shots, all cuts, cleanup (about 4-6 minutes)

# Redo one shot, then re-cut everything from the stored footage:
node scripts/showcase/launch.mjs --only shot4    # or: --only signoff,drag
node scripts/showcase/launch.mjs --assemble-only # re-cut only (no app needed once the cards exist)

# 3. Stop the sandbox
npm run sandbox:stop -- -Name launch
```

| Option | Default | Effect |
|---|---|---|
| `--port` | `CDP_PORT` or 9333 | sandbox CDP port |
| `--theme` | `deep-space` | app theme during the shots (restored afterwards) |
| `--scale` | 1 | capture device scale. Use 1.5 for sharper crops; it gives fewer screenshots per second. |
| `--fps` | 15 | screenshot rate in the default capture mode |
| `--capture` | `screenshot` | `screencast` uses `Page.startScreencast`: smoother, frames only when something changes |
| `--font-size` | 14 | terminal font size during the shots (restored afterwards) |
| `--root` | `C:\gk-demo` | where the throwaway repo and worktrees go. It must be empty or created by an earlier run (marker file). |
| `--work` | `%TEMP%\gridkeeper-launch` | frames, per-shot `meta.json`, cards, segments |
| `--out` | `docs/assets/showcase` | where the finished files go |
| `--keep` | off | leave the demo workspace and repo for the next run (resumes faster) |
| `--cleanup-only` | | remove the demo workspace, repo and worktrees |
| `--cuts` | `45s,hero,vertical` | which cuts to assemble |

What the script prints:
- each shot's marks and its duration, frame count and fps;
- each segment's in-point, speed and crop;
- the size of every output file.

`launch.mjs` refuses to run against an instance that isn't a sandbox, the same check as `scripts/e2e/cdp.mjs`
(`E2E_ALLOW_LIVE=1` overrides).

## Setup: what the script builds

1. **Demo repository** (plain `git`, from Node):
   - `C:\gk-demo\oauth-app` on `main`. It is a tiny web app (`src/server.ts`, `src/session.ts`, `src/auth/*`,
     `src/ui/header.tsx`), and `.gridkeeper/` is git-ignored.
   - Worktree `C:\gk-demo\oauth-app-builder-1` on branch `gk/builder-1`.
   - Worktree `C:\gk-demo\oauth-app-builder-2` on branch `gk/builder-2`. This one already has one commit,
     *Add the GitHub login button*.
   - The short `C:\gk-demo` path keeps user names out of the pane headers.
2. **Mission file** `C:\gk-demo\oauth-app\.gridkeeper\mission.md`, goal *Add OAuth login with GitHub*, with eight
   tasks owned by `@lead`, `@builder-1`, `@builder-2` and `@reviewer` (one unassigned). The script writes the
   starting state for each shot (`MISSION` in `launch.mjs`).
3. **Workspace** *OAuth demo* on the repo:
   - Group **Build** holds four PowerShell panes in a 2×2 grid:

     | Pane | Role | Working folder |
     |---|---|---|
     | `lead` | lead | main checkout |
     | `builder-1` | builder | its worktree |
     | `builder-2` | builder | its worktree |
     | `reviewer` | reviewer | main checkout |

   - An empty group **Verify** exists for the drag shot.
   - The panes start `pwsh -NoProfile -ExecutionPolicy Bypass -NoExit` with a short `PS> ` prompt.
4. **App settings while recording:** the theme, terminal font size 14, and notification delivery set to *Comms
   feed only*, so no toasts or OS notifications appear over the shots. The welcome sheet is skipped. All of these
   are restored at the end.
5. **Viewport:** CDP device-metrics override at 1920×1080 (times `--scale`), plus focus emulation so focus-based
   styling doesn't change when another window is active.
6. **Start-up grace:** Gridkeeper doesn't report "done" for activity in a session's first 20 s, so the first shot
   starts at least 22 s after the panes launch.

## The terminals: scripted, generic, honest

Each pane runs `scripts/showcase/fake-agent.ps1` with one of `scripts/showcase/transcripts/{lead,builder-1,builder-2,reviewer}.txt`.

**What the panes print:**
- Plain, generic agent-style lines: `▸ read`, `▸ edit`, `+` diff lines, `▸ run npm test`, `✓ mission.md [~] → [x]`.
- Lines appear at human pace, every 0.3–1.2 s with jitter. Some are typed out word by word.
- No product's UI, logo or wording is imitated.
- No numbers are invented: no costs, tokens, timings or coverage. Commit lines are git's real output.

**What they actually do,** so that what Gridkeeper shows is real:
- Flip task boxes in `mission.md`. The board updates through the app's own file watch.
- Write a lead-control instruction into `.gridkeeper/outbox/` (lead, autopilot shot).
- Wait for a line on stdin, so the autopilot delivery visibly lands (builder-2, autopilot shot).
- Write two files and make a real commit in their worktree (builder-1, sign-off shot). That commit is what sign-off
  and the review diff show.

**How a shot drives them:**
- Every shot restarts all four panes on the transcript section with the shot's name (`-Section board`, and so on).
  Each section opens with a few quick context lines, then waits for the `go` signal file.
- `go` is written the moment recording starts, so all panes start their timed part together. Other signals
  (`autopilot-on`) let a pane react to an on-camera click.
- No AI is called and no prompt is sent anywhere. The cuts say "Recorded in the real app · demo panes print
  scripted output" in a corner tag, and the end card repeats it.

## Shots

Times are seconds after `go`. **Marks** are the named moments that the cuts use as in-points.

### shot1 · grid (about 11 s)

- **View:** grid of group *Build* (2×2), with the sidebar and status bar visible.
- **Action:** none. All four panes print their `grid` section:
  - lead: reads team status, plans;
  - builder-1: edits `src/auth/callback.ts`;
  - builder-2: edits `LoginButton.tsx`;
  - reviewer: real `git log` / `git branch`, drafts a test.
- **Marks:** `go`, `end`.
- **Used in:** master 1a (`go+0.5`, 1.4 s) and 2 (`go+2.5`, darkened and blurred).

### shot2 · board (about 13 s)

- **View:** Mission Control, scrolled to the top, done tasks expanded. The board, the lead box and the top of the
  lanes are visible. The sign-off dock and session log sit at the bottom.
- **Mission start:** 1/8 done; callback and button doing; secret blocked.
- **Action** (by the panes):

  | Time | Pane | Change |
  |---|---|---|
  | +0.6 | builder-2 | *Wire the login button* `[~]→[x]` |
  | +1.6 | reviewer | *Integration test* `[ ]→[~]` |
  | about +3.3 | lead | *Get the GitHub client secret into .env* `[!]→[x]` |
  | about +6 | lead | adds `- [ ] Add a logout route @builder-1` |

- **Rects recorded:** `board`, `lead`, `signoff`.
- **Marks:** `go`, `end`.
- **Used in:** master 1b (`go+0.4 → go+2.6`) and 3 (`go+3.0`, 7.5 s); hero 0–3.2 and 12.4–15; vertical 0–8.5.

### shot3 · autopilot (about 20 s)

- **Not recorded, before:** Lead control is set to **advisor** and *auto-review* is unchecked. That way no review
  request is typed into the lead's scripted pane. The demo doesn't claim auto-review.
- **View:** Mission Control, lead box centred: *Lead control: off / advisor / autopilot*. The session log is at the
  bottom.
- **Action:**

  | Time | What happens |
  |---|---|
  | +0.7 | cursor to **autopilot** and click; mark `click-autopilot` |
  | about +1.8 | the confirmation dialog appears |
  | about +3 | cursor to **Turn on autopilot** and click; mark `confirm`; signal `autopilot-on` |
  | about +3.5 | the lead pane narrates and writes `.gridkeeper/outbox/<time>-builder-2.md` (`to: builder-2`, `action: message`) |
  | about +4–7 | Gridkeeper delivers it, because builder-2 has been sitting at its idle input prompt. The session log shows `lead → builder-2: … auto-sent`; mark `delivered`. The script waits up to 60 s for a new `auto-sent` line. |
  | +2.3 s later | cursor to the `builder-2` card and click (Mission Control closes, the pane gets focus); mark `jump` |
  | then | the pane is maximized; mark `maximized` |
  | over 5.5 s | builder-2 shows the delivered `[from lead] …` line, claims *Add rate limiting* and edits `src/auth/rate-limit.ts` |

- **Not recorded, after:** un-maximize, and set Lead control back to **off**.
- **Rects recorded:** `lead`, `log`, `lanes`.
- **Used in:** master 4a/4b, hero 3.2–6.6, vertical 8.5–15.5.

### shot4 · signoff (about 18 s)

- **Not recorded, before:**
  - Lead control is set to off.
  - builder-1's branch is reset to `main`, so its commit happens on camera.
  - Comms is marked read.
  - The script waits until no old builder-1 card is left in the dock.
- **View:** Mission Control. The sign-off dock (bottom) reads "nothing waiting for review".
- **Action:**

  | Time | What happens |
  |---|---|
  | +0 to about +6 | builder-1 prints its edits, writes `src/auth/callback.ts` and `src/auth/token-store.ts`, runs `git add -A` and `git commit` (git's own output), and ticks *Implement /auth/callback* `[x]` |
  | | lead, builder-2 and reviewer keep printing, so they stay "working" and out of sign-off |
  | about +10 | 4 s after builder-1's last line, Gridkeeper marks it done. Its sign-off card appears with branch, `+1 commit`, files, lines, `clean` and the commit subject; mark `signoff`. The script waits up to 60 s for the word "commit" in the card. |
  | +2.3 s later | cursor to **review diff** and click; mark `review`. Mission Control closes and the read-only Changes drawer opens on builder-1's worktree. |
  | | if the diff isn't shown yet, the cursor clicks `callback.ts`; mark `diff`. The shot holds 4.8 s on the green diff. |

- **Rects recorded:** `signoff`, `board`, `drawer`.
- **Used in:** master 5a/5b, hero 6.6–10, vertical 15.5–22.5.

### shot5 · drag (about 7 s)

- **Not recorded, before:** the reviewer is moved back into *Build*, and *Verify* is re-created if it was removed.
- **View:** Mission Control, lanes centred. *Lane 1 · Build* holds `builder-1`, `builder-2` and `reviewer`. The
  empty *Verify* lane and the *+ new lane* tile are next to it.
- **Action:**

  | Time | What happens |
  |---|---|
  | +0.7 | mark `grab`. The cursor moves to the `reviewer` card. |
  | over 1.3 s | the card is dragged along an arc into *Verify*; mark `drop` |
  | 2.6 s | hold on the result |

- **How the drag works:**
  - The drag uses the same HTML5 drag events a mouse drag produces (`dragstart`, `dragenter`, `dragover`, `drop`,
    `dragend` with a `DataTransfer`). The app's own drop handlers move the card.
  - A copy of the card follows the drawn cursor. The real OS drag image can't be captured.
  - If the drop isn't accepted, the script logs a warning. Redo the shot (`--only drag`).
- **Rects recorded:** `lanes`, `lead`.
- **Used in:** master 6, hero 10–12.4.

### shot6 · replay (about 10 s)

- **Not recorded, before:** with Mission Control open, the remaining tasks are ticked off in seven steps, 0.9 s
  apart. The project's replay recording, auto-recorded while Mission Control shows a mission, then holds a whole
  mission: task changes, agent states, commits and the lead's message.
- **Action:**

  | Time | What happens |
  |---|---|
  | +0.6 | command palette (`view.palette`); mark `palette` |
  | | `replay` typed at 90 ms per key, then Enter. If that doesn't open the dialog, the script runs `mission.replay` itself and logs it. |
  | | the **Mission replay** dialog opens with this mission's recording selected and the preview playing; mark `dialog` |
  | +1.6 s | cursor to **15 s** and click (the preview restarts at 15 s); mark `length` |
  | 6.5 s | hold on the preview |

- **Not exported:** the export buttons open a native save dialog, which a recording can't show.
- **Rects recorded:** `replay`.
- **Used in:** master 7, vertical 22.5–26.

## Cards and assembly

**Cards:**
- Text cards are drawn on a `<canvas>` inside the app page, in its own fonts (Space Grotesk, Geist, Geist Mono) and
  the current theme's colours.
- The canvas is saved as a transparent PNG (`<work>/cards/<cut>/`). ffmpeg composites the cards with a fade and a
  small rise.
- The raw shots stay clean, so the 16:9, vertical and hero cuts each get their own text layout.
- The end cards are drawn the same way. They include the Gridkeeper mark from `docs/assets/logo/gridkeeper-mark.svg`.

**Assembly, per shot and per cut:**
1. JPEG frames plus measured timestamps become a constant 30 fps intermediate, using the concat demuxer with the
   real frame durations. A slow capture doesn't change timing.
2. Each segment is cut from a mark-relative in-point and sped up to fit its slot within its cap. It is cropped to
   a recorded rect (board, lead box, sign-off, …), padded and fitted to the cut's aspect, and never upscaled more
   than 1.3× (1.35× vertical).
3. Segments are concatenated, cards and the disclosure tag are overlaid, and a silent AAC track is added. Output
   is H.264, CRF 18, `+faststart`.
4. **Hero:** the last 0.6 s crossfades into the first frame. The GIF is made with `palettegen` (`stats_mode=diff`)
   and `paletteuse` (Bayer, `diff_mode=rectangle`), stepped down until it is 6 MB or less.

## If a shot goes wrong

| Symptom | Fix |
|---|---|
| "no frames" | The sandbox window is minimized or hidden. Bring it to the front and re-run with `--only <shot>`. |
| autopilot times out | Check the lead box in the sandbox. The proposal shows why it waits, for example "rate limit: next automatic delivery in N s". Wait 20 s and re-run `--only autopilot`. |
| sign-off times out | builder-1 needs about 4 s of silence after its last line. A pane that keeps printing (a long-running loop) can't go "done". Check its transcript section. |
| drag warning | Re-run `--only drag`. If it keeps failing, record the move with the keyboard instead: select the card, then `Alt+↓`. |
| a cut is wrong but the footage is fine | Edit `CUTS` in `launch.mjs` and run `--assemble-only`. |
| leftovers after a crash | Run `node scripts/showcase/launch.mjs --cleanup-only`. It only removes `--root` if it holds the script's marker file. |
