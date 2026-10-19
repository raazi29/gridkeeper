# Launch video: 45-second master

The master cut for X, the release post and the website. It is built to play muted: the cards carry the story,
and the voice-over is optional. Everything on screen is recorded from the real app (shots in
[shot-list.md](shot-list.md), automated by `scripts/showcase/launch.mjs`). Other lengths are in [cuts.md](cuts.md),
and the reasoning behind the format is in [research.md](research.md).

**Format:** 1920×1080, 30 fps, H.264 with a silent AAC track, Deep Space theme
(`docs/assets/showcase/launch-45s.mp4`).

**Cards:**
- Space Grotesk, white on a translucent panel with a left accent bar in the theme blue, lower left.
- Sub-lines in Geist Mono, accent colour.
- 0.28 s fade with a 16 px rise in, 0.22 s fade out.
- A small grey tag in the bottom-right corner reads "Recorded in the real app · demo panes print scripted output"
  from 0:00 to 0:40.

**Cuts:** hard cuts throughout. Pacing comes from the action inside each shot, not from transitions. The only
fade is into the end card.

## Beat table

| # | Timecode | Dur | Shot: panel and action on screen | On-screen text | Transition | VO (optional) |
|---|---|---|---|---|---|---|
| 1a | 0:00.0–0:01.4 | 1.4 s | **Grid**, workspace *OAuth demo*, 2×2: `lead`, `builder-1`, `builder-2`, `reviewer`, all four printing work (reads, edits, `+` lines). | **Your coding agents, one board.** (holds through 1b) | Cold open | "This is Gridkeeper: coding agents side by side, on one shared board." |
| 1b | 0:01.4–0:03.0 | 1.6 s | **Mission Control**, board cropped about 1.3×, played about 1.4×. *Wire the login button to /auth/start* flips `[~]` → `[x]`, the progress bar steps up, and the reviewer claims *Integration test for the full login flow* (`[ ]` → `[~]`). | (card from 1a) | Hard cut | |
| 2 | 0:03.0–0:05.5 | 2.5 s | **Grid** again, darkened 62 % and blurred: four terminals scrolling on their own. | **Separate terminals. No shared plan.** (centred) | Hard cut | "Usually each agent runs alone, with its own idea of the plan." |
| 3 | 0:05.5–0:13.0 | 7.5 s | **Mission Control**, board cropped. The lead's blocked task *Get the GitHub client secret into .env* goes `[!]` → `[x]`. A new task line *Add a logout route @builder-1* appears and the counts update. Agent cards below the board show each terminal's last line. | **Agents update one Markdown board.** / `.gridkeeper/mission.md · [ ] [~] [x] [!]` | Hard cut | "Here they share one Markdown file. They claim tasks and tick them off, and the board updates live." |
| 4a | 0:13.0–0:18.5 | 5.5 s | **Mission Control**, lead box and session log, played about 1.4×. *Lead control* is on **advisor**. The cursor clicks **autopilot**, the confirmation *Turn on autopilot for this project?* appears, and the cursor clicks **Turn on autopilot**. The lead's pane writes an instruction file. The session log gains a line: `lead → builder-2: [from lead] Take "Add rate limiting to /auth/start" next… auto-sent`. | **The lead hands out work.** / `Advisor: you approve each one · Autopilot: idle agents only` | Hard cut | "A lead agent hands out the work. In Advisor mode you approve every instruction. On Autopilot it goes only to agents that are idle." |
| 4b | 0:18.5–0:21.0 | 2.5 s | **Grid**, `builder-2` maximized. The delivered line appears at its idle prompt, then it claims *Add rate limiting* and starts editing `src/auth/rate-limit.ts`. | **Delivered while builder-2 was idle.** | Hard cut (follows the click on its card) | |
| 5a | 0:21.0–0:25.0 | 4.0 s | **Mission Control**, sign-off dock cropped. `builder-1` finishes: its card appears with the evidence from git, `⎇ gk/builder-1 · +1 commit · 2 files +27 −0 · clean · "Add /auth/callback and session token storage" · just now` (the numbers are whatever git reports). The cursor moves to **review diff**. | **Sign-off shows what changed.** / `commits · files · lines · review diff` (holds through 5b) | Hard cut | "When an agent finishes, sign-off shows its branch, commits and lines changed. One click opens the diff." |
| 5b | 0:25.0–0:29.0 | 4.0 s | **Changes drawer** on builder-1's worktree (read-only): `src/auth/callback.ts` as a green unified diff. | (card from 5a) | Hard cut | |
| 6 | 0:29.0–0:34.0 | 5.0 s | **Mission Control**, lanes cropped. The cursor grabs the `reviewer` card in lane *Build* and drags it, with the card following, into the empty lane *Verify*. Both lanes' counts update. | **Drag agents between lanes.** / `tasks onto agents · lanes into phases` | Hard cut | "Reorganise the team by dragging agents between lanes." |
| 7 | 0:34.0–0:40.0 | 6.0 s | **Command palette** opens and `replay` is typed. Enter opens the **Mission replay** dialog with this mission's recording selected. The preview canvas plays the timelapse (title card, then team and tasks filling in), and the cursor picks **15 s**. | **Every mission becomes a replay.** / `15–60 s video or GIF, rendered in the app` | Hard cut | "And every mission can be exported as a short replay video." |
| 8 | 0:40.0–0:45.0 | 5.0 s | **End card** (drawn in the app's fonts and colours): Gridkeeper mark, **Gridkeeper**, "Every agent in one grid.", `github.com/raazi29/gridkeeper`, "Windows · macOS and Linux in preview · MIT", "Installers on the Releases page", `Mission protocol for any agent:  npx skills add raazi29/gridkeeper`. Footnote: "Recorded in the real app. The demo panes print scripted output; no AI was called." | (the card itself) | 0.4 s fade in | "Gridkeeper. Open source, MIT licensed. Windows today, macOS and Linux in preview." |

Total: 45.0 s. With the voice-over, the lines fit at about 2.5 words a second. Beat 4a has the longest line, and it
fits 5.5 s if read briskly. Otherwise drop its last sentence.

## Each claim, and why it is true today

| On screen | Where the app does it |
|---|---|
| Agents update one Markdown board | `.gridkeeper/mission.md`, watched with filesystem events. Agents edit it themselves (README, *Mission*). In the demo the scripted panes make those edits. |
| `[ ] [~] [x] [!]` | Task states in `src/lib/missionDoc.ts`. |
| Advisor: you approve each one · Autopilot: idle agents only | `src/actions/leadControl.ts`, `src/store/leadControl.ts`. Autopilot delivers only while the target is idle or done and not asking anything, at most 1 per agent per 20 s. |
| Delivered while builder-2 was idle | Autopilot's safe-send rule (same file). The session log shows `auto-sent`. |
| Sign-off shows what changed | `Signoff.tsx` / `signoffModel.ts`: branch, commits ahead, files, lines, last commit, from read-only git. *review diff* opens the Changes drawer. |
| Drag agents between lanes; tasks onto agents; lanes into phases | `MissionControl.tsx`, `mcDrag.ts`. |
| Every mission becomes a replay, 15–60 s video or GIF, rendered in the app | `src/replay/*`, `ReplayDialog.tsx`: MP4/WebM via MediaRecorder or GIF, no ffmpeg. |
| Windows · macOS and Linux in preview · MIT | README *Platforms* and LICENSE. |
| `npx skills add raazi29/gridkeeper` | README: the agent-mission skill. |

There is no single-command installer for the app itself, so the end card says "Installers on the Releases page"
rather than inventing one. Before publishing, check that the release with the installers is live (the README says
the v0.2.0 installers are still on their way). If a winget or Homebrew package is published later, put its
one-liner on the end card in place of that line. The text is in `END_CARD` in `launch.mjs`.

## Words we don't use

There are no superlatives, no rhetorical questions, no exclamation marks and no emojis. "AI-powered" is out. So are
"revolutionize", "supercharge", "unleash", "game-changer", "seamless" and "next-level". Every card names something
the shot shows. The cards and VO never call the panes AI runs: they are scripted (`scripts/showcase/fake-agent.ps1`),
and the corner tag and end card say so.

## Sound

The cut is made to play muted, and the MP4 has a silent track so every platform accepts it. If music is added,
keep it low and steady, without drops, and cut it on the beat changes at 0:03, 0:05.5, 0:13, 0:21, 0:29, 0:34 and
0:40. Record any voice-over separately and lay it over the master. The timings above leave room for it.
