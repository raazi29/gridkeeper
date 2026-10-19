# Other cuts

All cuts reuse the six shots of [shot-list.md](shot-list.md). `scripts/showcase/launch.mjs` assembles the first three
(`CUTS` in that file). The Show HN version is an outline to edit by hand from the same footage, plus three extra
shots listed below.

The tables use the shot names from the shot list. "Mark" is a named moment the capture script records, such as
`go`, `click-autopilot`, `delivered`, `signoff`, `review`, `grab`, `drop`, `palette` and `dialog`. Segment in-points
are tied to marks, so a take that runs a little slower still cuts correctly. A span longer than its slot is sped up,
within the cap shown in the table.

## 1. README hero loop: 15 s, 16:9, looping

**Output:** `docs/assets/showcase/launch-hero.gif`.
- The GIF is 960 px wide at 15 fps, a two-pass palette, 6 MB or less. It steps down to 880/800/720 px and 12/10 fps
  if needed.
- The source MP4 stays in the work folder.

**Rules:**
- No voice-over, no end card, no logo. A README already has a title.
- One small pill label per beat, three or four words.
- The loop seam is a 0.6 s crossfade from the last frame back to the first. Both are the same board, so it doesn't
  jump.

| Time | Shot (in → out) | Speed | Framing | Label |
|---|---|---|---|---|
| 0.0–3.2 | board `go+0.4 → go+4.4` | about 1.05× | board | Agents update the board |
| 3.2–6.6 | autopilot `confirm−0.2 → delivered+0.8` | up to 3× | lead box + session log | Lead on autopilot |
| 6.6–10.0 | signoff `signoff−0.6 → review+1.6` | up to 1.8× | full window (card appears, click, drawer opens) | Sign-off with git evidence |
| 10.0–12.4 | drag `grab−0.2 → drop+0.6` | 1× | lanes | Drag between lanes |
| 12.4–15.0 | board `go+10.0`, crossfading into 0.0 over the last 0.6 s | 1× | board | Agents update the board (fades in at 12.6 and is still up at 0.0) |

Suggested README markup, which replaces nothing until the integrator decides:

```html
<p align="center">
  <img src="docs/assets/showcase/launch-hero.gif" width="100%"
       alt="Gridkeeper: agents update a shared mission board, the lead delivers an instruction on autopilot, sign-off shows git evidence, an agent is dragged to another lane" />
  <br/><sub>Recorded in the real app; the terminals print scripted demo output.
  45 s version: <a href="docs/assets/showcase/launch-45s.mp4">launch-45s.mp4</a></sub>
</p>
```

## 2. Vertical: 30 s, 9:16 (1080×1920)

**Output:** `docs/assets/showcase/launch-vertical.mp4`, for LinkedIn mobile, Shorts and Reels.

**Layout:** three bands, not a squeezed 16:9 frame.
- **Headline band** (y 120–500): Space Grotesk 78 px, centred, at most two lines.
- **Footage band** (y 520–1480): a near-square crop of the real UI, scaled to 1080 wide. It is never upscaled more
  than 1.35×.
- **Caption band** (around y 1590): mono, accent colour.

The disclosure tag sits at the bottom centre.

| Time | Shot (in → out) | Framing | Headline / caption |
|---|---|---|---|
| 0.0–2.5 | board `go+0.4 → go+2.6` | board | Your coding agents, one board. |
| 2.5–8.5 | board `go+3.0`, 6 s | board | Agents update one Markdown board. / `.gridkeeper/mission.md` |
| 8.5–13.5 | autopilot `click-autopilot−0.6 → delivered+0.8` | lead box + session log | The lead hands out work. / `Autopilot: idle agents only` |
| 13.5–15.5 | autopilot `maximized+0.4`, 2 s | left 62 % of builder-2's maximized pane | Delivered while builder-2 was idle. |
| 15.5–19.0 | signoff `signoff−1.2 → review−0.1` | sign-off dock | Sign-off shows what changed. / `commits · files · lines · review diff` |
| 19.0–22.5 | signoff `review+0.5`, 3.5 s | Changes drawer | (same) |
| 22.5–26.0 | replay `palette−0.3 → dialog+4.0` | replay dialog | Every mission becomes a replay. / `video or GIF, rendered in the app` |
| 26.0–30.0 | vertical end card | n/a | Mark, Gridkeeper, repo URL, platforms, install lines, footnote |

The drag beat is left out of the vertical cut. Lanes are wide, and a square crop of them reads poorly at phone
size.

## 3. Show HN: 60–90 s outline (target 75 s)

**Where it goes:** on the page the Show HN post links to (the README or the release), next to the download. It
doesn't replace trying the app.

**Pacing:** HN viewers are more patient than X viewers but more sceptical, so this version shows more of the
mechanism and less copy.

**Voice-over:** recommended here, read plainly, first person from the author. Captions are burned in with the same
card style.

| # | Time | Content | Footage | Card |
|---|---|---|---|---|
| 1 | 0:00–0:05 | Hook: the board ticking tasks off while four panes run | grid → board (as the master) | "Coding agents, one shared board." |
| 2 | 0:05–0:12 | The setup, in one sentence each: several agent CLIs and several accounts, one window, Windows-native | **extra shot D**: the New session dialog (`Ctrl+Shift+T`) with its agent list open, showing the CLIs detected on the recording machine. Don't open the account picker, because it can show e-mail addresses. | "Claude Code, Codex and other CLIs, side by side." (over the real agent list, not over the scripted panes) |
| 3 | 0:12–0:22 | The protocol: open `.gridkeeper/mission.md` in the reviewer pane (`Get-Content`) next to the board. The same line changes in both. | **extra shot A**: split of the file and the board | "A plain Markdown file. Agents edit it; the board follows." |
| 4 | 0:22–0:34 | Lead control: Advisor first. A proposal appears, you edit the text and press Send. Then Autopilot, as in the master. | **extra shot B**: advisor proposal + autopilot shot | "Advisor: you approve. Autopilot: idle agents only." |
| 5 | 0:34–0:44 | Sign-off + review diff, as in the master, held longer on the diff | signoff | "Sign-off is git evidence, not a status message." |
| 6 | 0:44–0:50 | Drag: an agent to a new lane, a task onto an agent | drag + a task-drag variant | "Drag agents and tasks." |
| 7 | 0:50–0:58 | Replay, ending on the replay's end card (tasks, commits, lines, agents, wall time) | replay, played to its end card | "Every mission becomes a replay." |
| 8 | 0:58–1:06 | Engineering facts for this audience: Job Objects (no orphans), WebGL terminals, near-zero idle CPU. Shown: Diagnostics panel with the CPU split, then quitting the workspace and the session count dropping to 0. | **extra shot C**: Diagnostics panel | "No orphan processes. GPU terminals. Idle ≈ 0.1–0.4 % CPU." (the figure measured in docs/PERFORMANCE.md; re-check it on the recording machine) |
| 9 | 1:06–1:10 | Themes: three quick switches (Deep Space → Saber Duel → Ice Planet) | from `record.mjs` | "12 themes." |
| 10 | 1:10–1:15 | End card: repo URL, MIT, platforms, install lines, footnote | end card | n/a |

**Extra shots for this cut:** these are not automated in `launch.mjs`. Record them with the same sandbox and demo
workspace (`--keep`) and the same capture settings.
- **A. File and board side by side:** in the reviewer pane, run `Get-Content .gridkeeper/mission.md -Wait`, then
  record the grid while the board shot's section plays.
- **B. Advisor proposal:**
  1. Set Lead control to *advisor*.
  2. Start the autopilot section of the transcripts (`fake-agent.ps1 -Section autopilot` in each pane).
  3. Signal `autopilot-on` by hand: create the file `<work>/signals/autopilot-on`.
  4. The proposal shows up under the lead box with Send / Dismiss. Click into the text, edit a word, press Send.
- **D. Agent list:** open the New session dialog and the agent dropdown, then close it with Escape. Nothing is
  launched.
- **C. Diagnostics:** ``Ctrl+Shift+` `` opens the panel. Show the per-process table (host, WebView2, sessions),
  then close the workspace and show the session rows disappearing. Don't put any CPU figure on screen that this
  recording doesn't show.

**Things the HN cut must not do:**
- Show the Accounts dialog, because it lists e-mail addresses.
- Show the cost meter. It reads Claude Code's status line, and the demo panes are not Claude Code.
- Claim performance numbers that aren't on screen or in docs/PERFORMANCE.md.
