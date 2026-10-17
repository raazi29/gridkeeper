<p align="center">
  <img src="docs/assets/hero-banner.png" alt="Gridkeeper — every agent in one grid" width="100%" />
</p>

<p align="center">
  <a href="https://github.com/raazi29/gridkeeper/releases/latest"><img alt="Release v0.1.2" src="https://img.shields.io/badge/release-v0.1.2-4cc2ff?style=flat-square&labelColor=0b1220" /></a>
  <img alt="Platform: Windows 10 | 11" src="https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-4cc2ff?style=flat-square&labelColor=0b1220" />
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-3ddc84?style=flat-square&labelColor=0b1220" /></a>
  <img alt="Built with Tauri 2" src="https://img.shields.io/badge/Tauri-2.12-24c8db?style=flat-square&labelColor=0b1220&logo=tauri&logoColor=white" />
  <img alt="Rust" src="https://img.shields.io/badge/Rust-stable-f46623?style=flat-square&labelColor=0b1220&logo=rust&logoColor=white" />
  <img alt="React 19" src="https://img.shields.io/badge/React-19-61dafb?style=flat-square&labelColor=0b1220&logo=react&logoColor=white" />
  <img alt="xterm.js 6" src="https://img.shields.io/badge/xterm.js-6-ffd84a?style=flat-square&labelColor=0b1220" />
</p>

<p align="center">
  <b>Every agent in one grid.</b> A GPU-accelerated, Windows-native workspace for running many AI coding agents
  (Claude Code with several accounts at once, Codex, Hermes, OpenCode, Aider and plain shells) side by side,
  with a keeper that tells you which one needs you.
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#features">Features</a> ·
  <a href="#keybindings">Keybindings</a> ·
  <a href="#documentation">Docs</a> ·
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

<p align="center">
  <img src="docs/assets/readme/crawl.svg" width="100%" alt="Opening crawl: A long time ago, in a terminal far, far away… Episode I, The Grid Awakens. AI agents are scattered across a dozen lonely windows, orphaned shells linger after every crash and the CPU burns hot from restless polling loops. Developers who command several accounts watch their identities collide. Now, from the depths of ConPTY, a keeper rises. Armed with a GPU and Job Objects, it gathers every agent into one grid, and keeps watch for the one that needs you." />
</p>

<p align="center">
  <img src="docs/assets/showcase/gridkeeper-demo.gif" alt="Gridkeeper demo: live agent grid, themes, Mission Control, Fleet, command palette" width="100%" />
  <br/><sub>Recorded from the real app (31 s). Full-quality video: <a href="docs/assets/showcase/gridkeeper-demo.mp4">gridkeeper-demo.mp4</a></sub>
</p>

| Live agent grid | Mission Control |
|---|---|
| ![Grid of live sessions with roles](docs/assets/showcase/01-grid.png) | ![Mission Control: lead, lanes, sign-off, session log](docs/assets/showcase/04-mission-control.png) |
| **Fleet: every session at a glance** | **Command palette (Ice Planet light theme)** |
| ![Fleet overview](docs/assets/showcase/05-fleet.png) | ![Command palette](docs/assets/showcase/03-ice-planet.png) |

<p align="center"><img src="docs/assets/readme/saber-blue.svg" width="100%" alt="" /></p>

## Features

<table>
<tr>
<td width="33%" valign="top">🧩 <b>Agent grid</b><br/>Workspaces → groups → panes in a grid, columns or rows. Resizable splits, drag to reorder, maximize any pane.</td>
<td width="33%" valign="top">👥 <b>Many accounts, truly separate</b><br/>Several Claude Code, Codex and Hermes logins side by side, one isolated home folder per account. Credentials are never read.</td>
<td width="33%" valign="top">🛰️ <b>Mission Control &amp; Formations</b><br/>A team view of the workspace (lead, lanes, sign-off, live activity) and one-click agent teams with their own git worktrees.</td>
</tr>
<tr>
<td valign="top">🔔 <b>Knows when an agent needs you</b><br/>Attention lamps, unread badges, Windows notifications, a Comms feed. <code>Ctrl+Shift+J</code> jumps to the next alert.</td>
<td valign="top">🚀 <b>Fleet &amp; Broadcast</b><br/>Every session in every workspace as live tiles; type once and send to several agents (always with confirmation).</td>
<td valign="top">🌐 <b>Browser panes &amp; ports</b><br/>Preview dev servers next to the terminals. Listening ports are detected per session; a <code>:5173</code> chip opens them.</td>
</tr>
<tr>
<td valign="top">🔀 <b>Changes drawer</b><br/>Branch, ahead/behind and coloured diffs for the workspace and every worktree. Read-only by design.</td>
<td valign="top">⚡ <b>Built not to burn CPU</b><br/>Idle at ≈0.1–0.4 % of the machine. WebGL rendering, raw binary IPC, no polling while idle.</td>
<td valign="top">🛡️ <b>No orphans, ever</b><br/>Each agent's whole process tree lives in a Windows Job Object. Quit, close or crash: nothing is left running.</td>
</tr>
<tr>
<td valign="top">🎨 <b>12 themes</b><br/>Deep Space, Twin Suns, Carbonite, Ice Planet, Hyperspace, Holo Comms, Saber Duel, Outer Rim and more. All are WCAG contrast-tested.</td>
<td valign="top">♻️ <b>Restore that resumes</b><br/>Layouts always come back; each Claude pane resumes its own pinned conversation; Codex and catalog agents continue where they can.</td>
<td valign="top">🔒 <b>Local-first</b><br/>No telemetry, no cloud backend, no local HTTP server. Secrets are redacted from logs and exports.</td>
</tr>
</table>

Works with **Claude Code, Codex, PowerShell** and, when installed, **Hermes, OpenCode, Gemini CLI, Copilot CLI, Aider,
Factory Droid, Kimi, Qwen Code, Cursor Agent, Goose, Crush, Amp and OpenClaw**, plus any other command-line program.

## Why Gridkeeper

Built because the tools available on Windows kept failing this workflow: high CPU, freezes and crashes, flaky
cloud agent sessions, no clean way to run several Claude Code accounts at once, and wasted memory.

- **Native Windows, no WSL or tmux.** Real ConPTY sessions; every agent's whole process tree is contained in a
  Job Object, so quitting never leaves orphans.
- **Many accounts, truly separate.** One `CLAUDE_CONFIG_DIR` / `CODEX_HOME` / `HERMES_HOME` per account, identity
  variables stripped per pane, login verified with each CLI's own status command without reading credentials.
- **Built not to burn CPU.** Idle workspaces measured at ≈0.1–0.4 % of the machine (see
  [PERFORMANCE.md](docs/PERFORMANCE.md)); no polling loops; hidden panes stop rendering but keep their state; output
  flow control never pauses an agent.
- **GPU where it helps.** WebGL glyph rendering and GPU compositing, with automatic recovery and a software fallback.
  Agent CPU is always shown separately, so the app's own cost is visible.
- **Knows when an agent needs you.** Detected from terminal signals and output activity, never by reading your
  content.
- **One window for every agent CLI**, from Claude Code and Codex to a dozen catalog agents.
- **Local-first.** No telemetry, no cloud backend, no local HTTP server, secrets redacted from logs and exports.

## How it compares

Based on public information gathered in October 2026 (sources in
[docs/research-notes/agents-notifications-market.md](docs/research-notes/agents-notifications-market.md));
features change quickly, so check the projects themselves. "?" = not verified in our research.

| | Gridkeeper | Terax | Warp | Wave Terminal | Windows Terminal | Claude Squad | Superset / Conductor |
|---|---|---|---|---|---|---|---|
| Native Windows | yes | yes | yes | yes | yes | WSL only (tmux) | macOS-first |
| Grid of many agent panes | yes | single agent | tabs/panes | blocks | panes | yes (TUI) | yes |
| Several Claude accounts at once | yes, per pane | no | no | no | manual | no | no |
| Process-tree containment (no orphans) | Job Objects | ? | ? | ? | ? | tmux | ? |
| Attention detection + notifications | yes | via Claude hooks | ? | ? | — | ? | ? |
| Fleet overview / broadcast input | yes | ? | ? | ? | — | ? | ? |
| Footprint | Tauri, ≈6 MB installer | Tauri, ~7–8 MB | ? | Electron (reported) | native | Go TUI | ? |
| License | MIT | Apache-2.0 | proprietary | Apache-2.0 | MIT | AGPL-3.0 | ELv2 / closed |

Known public complaints about alternatives that motivated this design include Warp issues on Windows for high
idle CPU/GPU and memory growth with Codex/Claude (#5825, #7561, #12472, #8822, #11744), and Claude Squad's tmux
dependency (WSL-only on Windows).

<p align="center"><img src="docs/assets/readme/saber-red.svg" width="100%" alt="" /></p>

## Install

Download **`Gridkeeper_0.1.2_x64-setup.exe`** (≈6 MB, per-user install, no admin needed) from the
[latest release](https://github.com/raazi29/gridkeeper/releases/latest), or build it yourself (see *Build from
source* below). Windows 10 1809+ / Windows 11. The WebView2 runtime is preinstalled on Windows 11; the installer
bootstraps it elsewhere.

> [!NOTE]
> The installer is not code-signed yet, so Windows SmartScreen may show "Windows protected your PC" on first run.
> Choose *More info → Run anyway*. Windows notifications show the proper app name and icon only from the installed
> app (in a dev build they appear under PowerShell).

## Quick start

1. **Launch Gridkeeper.** It finds your existing Claude Code / Codex / Hermes logins automatically
   (`~/.claude`, `~/.claude-*`, `~/.codex`, `~/.codex-*`, …). There's nothing to configure.
2. **Create a workspace** with `Ctrl+Shift+N` and point it at a project folder. Then start agents with **+ New**,
   the agent cards in the empty grid, or `Ctrl+Shift+T` (pick the agent, the account, and 1–8 copies). For a whole
   team at once, open Mission Control (`Ctrl+Shift+U`) and launch a **Formation**.
3. **Let the keeper watch.** Lamps and notifications tell you who is working, done or waiting. `Ctrl+Shift+J` jumps
   to the next agent that needs you, `Ctrl+Shift+O` shows the Fleet, `Ctrl+Shift+K` broadcasts one message to several
   agents, and `Ctrl+Shift+P` finds everything else.

## Keybindings

Defaults (`src/keybindings/combo.ts`). Change them in Settings → Keybindings; an empty value unbinds a command.

| Shortcut | Command | | Shortcut | Command |
|---|---|---|---|---|
| `Ctrl+Shift+P` | Command palette | | `Ctrl+Shift+J` | Jump to next alert |
| `Ctrl+Shift+T` | New session… | | `Ctrl+Shift+O` | Fleet overview |
| `Ctrl+Shift+N` | New workspace… | | `Ctrl+Shift+K` | Broadcast to sessions… |
| `Ctrl+Shift+G` | New group | | `Ctrl+Shift+U` | Mission Control |
| `Ctrl+Shift+W` | Close session | | `Ctrl+Shift+H` | Changes: git status and diffs (read-only) |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Next / previous session | | `Ctrl+Shift+L` | Browser: open URL in a pane… |
| `Alt+1` … `Alt+9` | Focus pane 1 … 9 | | `Ctrl+Shift+F` | Find in terminal |
| `Ctrl+Shift+PgDn` / `PgUp` | Next / previous workspace | | `Ctrl+Shift+=` / `-` / `0` | Pane zoom in / out / reset |
| `Ctrl+Shift+D` / `Ctrl+Shift+E` | Split: new session in columns / rows | | `Ctrl+Shift+I` | Toggle inspector |
| `Ctrl+Shift+M` | Toggle maximize pane | | ``Ctrl+Shift+` `` | Toggle diagnostics |
| `Ctrl+Shift+B` | Toggle sidebar | | `Ctrl+,` | Settings |

These commands have no default shortcut and run from the palette (they can be bound):

- Session: restart (resume), restart (fresh conversation), stop, force stop, copy output, clear terminal
- Layout: grid / columns / rows
- Switch workspace…, go to session…, accounts, launch formation…
- Browser: new pane (start page), reload, pop out, open in system browser; Ports: refresh
- Themes: choose theme…, next / previous theme, theme: *name*

**Inside a terminal** (fixed, not configurable):

| Input | Action |
|---|---|
| `Ctrl+C` | Copies (and clears) the selection if there is one; otherwise sends `^C` |
| `Ctrl+Shift+C` | Copy the selection |
| `Ctrl+V` / `Ctrl+Shift+V` | Paste (bracketed paste when the program enabled it) |
| Right-click | Copy the selection, or paste. Goes to the program when it uses the mouse (hold Shift to override) |
| `Ctrl+click` | Open an http(s) link in the system browser |
| `Ctrl+Shift+click` | Open an http(s) link in a Gridkeeper browser pane next to the terminal |

**Policy:** Gridkeeper never binds keys that terminals and agents need. Settings refuses function keys, combos without
Ctrl or Alt, Ctrl+Alt (AltGr), Win-key combos, Alt+letter, Ctrl+letter, Ctrl+arrows and Ctrl+editing keys, and
Ctrl+Shift+C/V.

<p align="center"><img src="docs/assets/readme/saber-green.svg" width="100%" alt="" /></p>

## Documentation

| Document | What's in it |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Process model, threading, output data flow, session lifecycle, state and restore, security model |
| [docs/TECHNICAL_DECISIONS.md](docs/TECHNICAL_DECISIONS.md) | ADR-001 … ADR-019: why Tauri, xterm.js, ConPTY, Job Objects, sandboxed browser panes… |
| [docs/PERFORMANCE.md](docs/PERFORMANCE.md) | Measured CPU / RAM / GPU on the target machine, and how to reproduce |
| [docs/RESEARCH.md](docs/RESEARCH.md) | Research questions, evidence and sources |
| [docs/HANDOFF.md](docs/HANDOFF.md) | Project map and working notes for the next contributor (human or agent) |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Prioritized idea backlog |
| [docs/assets/logo/README.md](docs/assets/logo/README.md) | Brand and icon guide |
| [CONTRIBUTING.md](CONTRIBUTING.md) · [SECURITY.md](SECURITY.md) | How to build, test and contribute · how to report a vulnerability |

Under the hood: each session is a real ConPTY process tree whose output is rendered by xterm.js with WebGL. Gridkeeper
is built with Tauri 2.12 (Rust backend, `portable-pty`/ConPTY, Windows Job Objects) and React 19 + TypeScript +
xterm.js 6 in the system WebView2.

## Guide

<details>
<summary><b>Full feature list</b></summary>

- **Workspaces → groups → sessions.** A workspace has a project folder and holds groups (tabs). A group lays out its sessions as panes in a grid, columns or rows. Splits are resizable, panes can be reordered by drag and drop, and any pane can be maximized.
- **Agents:**
  - PowerShell (pwsh 7, with Windows PowerShell 5.1 as fallback)
  - Claude Code
  - Codex
  - catalog agents detected on PATH: Hermes, OpenCode, Gemini CLI, Copilot CLI, Aider, Factory Droid, Kimi, Qwen Code, Cursor Agent, Goose, Crush, Amp and OpenClaw (broken installs are reported, not listed), with their own continue/resume flags where documented
  - any other command-line program
- **Accounts.** Each account is its own home folder (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `HERMES_HOME`), so several accounts of one agent can run at the same time. Existing logins are discovered automatically. Inherited credential variables are stripped so accounts don't collapse into one identity. Login state comes from each CLI's own status command (`claude auth status --json`, `codex login status`); credentials are never read.
- **Conversation resume:**
  - Each Claude pane pins its own conversation id (`--session-id`) and resumes exactly that conversation.
  - Codex resumes with `resume --last`. When several Codex panes share a folder, each gets Codex's picker instead.
- **Git worktrees.** A new session can use an existing worktree or create one (you confirm the exact git command first).
- **Process safety:**
  - Every session's process tree is in its own Job Object, so closing a pane or quitting Gridkeeper never leaves orphans.
  - Graceful stop sends Ctrl+C, then closes the console, then kills the job. Force stop kills the whole tree.
- **Performance:**
  - Output is coalesced into raw binary IPC frames with ack-based flow control. A slow view never pauses an agent.
  - Hidden terminals don't render.
  - Visible terminals get WebGL (up to 12 contexts), with DOM as the fallback.
- **Attention & notifications:** per-pane lamps (working / needs you / done / error), unread badges on panes, tabs
  and workspaces, `(N)` in the window title, Windows notifications plus taskbar flash when the app is in the
  background, and in-app toasts with *Jump*. Signals: BEL, OSC 9/777/99, Claude's OSC 7501 status (when available)
  and output activity (working → quiet = done).
- **Comms:** a feed of recent attention events across all workspaces (bell in the status bar).
- **Fleet (Ctrl+Shift+O):** every session in every workspace as live tiles: state, account, CPU/RAM, last lines of
  output. Filter to *Needs me*, *Working* or *Errors*; Enter jumps to it.
- **Broadcast (Ctrl+Shift+K):** type once, send to several selected sessions (confirmation for more than 3 targets or
  other workspaces; never sends on its own).
- **Next alert (Ctrl+Shift+J):** jump to the next session that needs you.
- **Mission Control (Ctrl+Shift+U):** lead node(s), one lane per group, a sign-off node, an activity river and the session log. Every figure is real; nothing is estimated. Sessions can carry roles (lead, scout, builder, reviewer, verifier).
- **Formations:** launch a planned agent team (groups, sessions, `git worktree add -b` per member) after one confirmation. Optional starter prompts are held while an agent shows a trust / permission / login question, so nothing is auto-approved.
- **Quick launch:** *+ New* in the header and one-click agent cards in empty groups start a session in the
  workspace folder; the full dialog handles worktrees, arguments and launching several at once.
- **Inspector** for the focused session: PID, state, exit code, times, bytes, CPU/RAM of its tree, the command line (redacted), and restore options.
- **Diagnostics:** CPU/RAM split between the app host, WebView2 and each session's tree, live GPU load and GPU memory from the Windows GPU counters (the adapter that draws the UI, per-engine bars), renderer status and a redacted export bundle. The status bar shows the WebView2 GPU load and warns when system memory is above 85 %.
- **Find in terminal (Ctrl+Shift+F):** find bar per pane with next/previous (Enter / Shift+Enter), match case, regex and match count.
- **Per-pane zoom:** Ctrl+Shift+= / Ctrl+Shift+- / Ctrl+Shift+0 change one pane's font size; the PTY is resized to match.
- **Paste guard:** pasting more than 20 lines or 64 KiB into a program that has not enabled bracketed paste asks first (Settings › Terminal; programs like Claude Code and Codex are never asked).
- **Command palette** over commands, sessions in all workspaces, and workspaces.
- **Browser panes:** preview dev servers, docs and PRs in the grid next to the terminals (*+ New › Browser* / *Open URL…*, `Ctrl+Shift+L`, or `Ctrl+Shift+click` a link in a terminal). Address bar with back / forward / reload, open in the system browser, pop-out window; the pane name can follow the page title. Pages run in a sandboxed frame with no access to Gridkeeper; sites that refuse embedding (e.g. GitHub) and local `file:` pages open in a pop-out Gridkeeper window. Pages keep their state across layout changes, maximize and group switches.
- **Ports:** dev servers your sessions start are detected from the Windows TCP table (listening sockets inside each session's process tree). A `:5173` chip on the pane header opens or focuses a browser pane on it; the Inspector, the browser start page and *Open URL…* list them too. Checked only while one of those views is open or when a session's activity changes, never on a constant timer.
- **Changes (`Ctrl+Shift+H`, read-only):** a drawer with branch, ahead/behind and changed files for the workspace folder and every session worktree, plus a coloured unified diff (staged / unstaged / new files, capped at 2 MB). It never stages, commits, checks out or resets.
- **Persistence:** a versioned, atomically written workspace file with a backup. A damaged file is preserved, never silently overwritten.
- **No telemetry.**

</details>

<details>
<summary><b>Usage: workspaces, accounts, restore, worktrees, inspector</b></summary>

#### Workspaces, groups, sessions

- **New workspace** (sidebar `+` or `Ctrl+Shift+N`): give it a name and an optional project folder. The header shows the folder (click to reveal it in Explorer) and the git branch, with a dot when there are uncommitted changes.
- **Groups** are the tabs above the panes. Use `+` or `Ctrl+Shift+G` to add one, and double-click a tab to rename it. Deleting a group stops its sessions first, after confirmation. A workspace always keeps at least one group.
- **New session** (`Ctrl+Shift+T`):
  1. Pick the agent, folder and optional name, arguments and git worktree.
  2. For agents with accounts (Claude, Codex, Hermes), pick an account.
  3. Set a count of 1–8 identical sessions and a target group.

  `Ctrl+Shift+D` / `Ctrl+Shift+E` open the same dialog and switch the layout to columns / rows.
- **Layouts:** grid, columns or rows (header buttons or the palette). Drag split handles to resize, and the sizes are remembered per layout and pane count. `Ctrl+Shift+M` maximizes the focused pane.
- **Pane header:**
  - Status, agent, account, worktree, port and cwd chips.
  - Start/Stop (Shift+click to force stop) and Restart.
  - Menu: Rename, Copy output, Clear, Hide view, Restart fresh, Mute notifications.
  - Double-click the name to rename the pane.
- **Hide view:** frees the terminal view while the process keeps running. Show view replays the session's buffered output (the last `Output buffer` KiB).
- **Closing a pane** stops its process (after confirmation if it is running) and removes the session.

#### Accounts

Open **Accounts** in the sidebar footer, or *Accounts* in the palette.

- Gridkeeper discovers existing accounts automatically: Claude's default `%USERPROFILE%\.claude` plus every `%USERPROFILE%\.claude-<name>` that looks like a Claude config folder, Codex's `~/.codex` and `~/.codex-*`, and Hermes profiles. These are filename checks only.
- **To add an account:** click *Add*, choose the agent, a name and a folder (a missing folder is created empty), then *Sign in*. Gridkeeper opens a pane running the agent's own sign-in (`claude` + `/login`, `codex login`, `hermes setup`; device-code sign-in where the agent supports it) and re-checks the status when it finishes. The account e-mail is shown in the UI only and never logged.
- Removing an account removes only Gridkeeper's entry. The folder is never touched.
- Gridkeeper warns when two live sessions share one Claude account: concurrent token refreshes can force a re-login (Claude Code #91708). Use separate accounts for concurrent work.

#### Codex

Codex is detected on PATH or at `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin\codex.exe`. "Continue" maps to `codex resume --last`. Codex can't pin a conversation id up front, so when several restored Codex panes share a folder, each opens Codex's resume picker instead of resuming the same conversation.

#### Restore behaviour

- The layout always comes back.
- Processes never survive an app exit. Each restored pane starts a **new** process if its *Auto-start process* option is on (Inspector).
- *Conversation: Continue / New* (Inspector) decides whether the agent resumes its conversation.
- Claude resumes the pane's pinned conversation. If no transcript exists yet, it starts a new conversation under the same id.

#### Worktrees

In the New Session dialog, *Git worktree* has three options: *Use folder as is*, *Existing worktree*, or *Create new
worktree* (enter a branch, new or existing, and a folder). You see and confirm the exact `git worktree add` command
before anything is created.

#### Inspector, diagnostics, palette

- **Inspector** (`Ctrl+Shift+I`): details and actions for the focused session, its listening ports, plus its restore options. For a browser pane: address, server status, embedding verdict and pop-out.
- **Diagnostics** (``Ctrl+Shift+` ``): a per-process resource table (host / WebView2 / sessions), the GPU renderer string, WebGL/DOM counts and context losses. **Export** writes a redacted JSON bundle.
- **Status bar:** the breadcrumb, running count, app vs agent CPU/RAM (polled every 2 s while the window is visible; can be turned off) and renderer status.
- **Command palette** (`Ctrl+Shift+P`): fuzzy search over all commands, all sessions and all workspaces.

</details>

<details>
<summary><b>Themes, effects and modes</b></summary>

- **Switching:** the palette button in the workspace header and the theme chip in the status bar open a quick
  switcher of live theme cards. Hovering (or arrowing to) a card previews it on the whole interface; leaving
  reverts, clicking keeps it. *Choose theme…*, *Next / Previous theme* and *Theme: &lt;name&gt;* are in the palette;
  effects and the full gallery are in Settings › Appearance.
- **Themes (12):** Deep Space (default), Twin Suns, Carbonite, Ice Planet (light), Imperial, Rebel Squadron,
  Hyperspace, Holo Comms, Saber Duel, Outer Rim, Phosphor, High Contrast. Every palette passes a WCAG contrast test
  (`src/theme/themes.test.ts`: ≥ 7:1 terminal and body text).
  - **Holo Comms:** hologram cyan on blue-black; a faint scan band sweeps the focused pane's header now and then.
  - **Saber Duel:** near-black; the focused pane is framed by a glowing blade. *Saber colour*: blue, green, red,
    purple, amber or white (every blade is contrast-tested).
  - **Outer Rim:** rust, olive and bone on charcoal; stencilled labels and hazard trim on the focused pane.
- **Effects** (per machine, Settings › Appearance, only where a theme offers them): glow, holo scan band, CRT
  scanlines. **Hyperspace jump:** a 0.2 s star-streak flash on workspace switch: *With Hyperspace theme* (default),
  *Always* or *Off*. Effects never run on unfocused panes, never block input, pause while the window is in the
  background and are off under *Reduce motion* (or the Windows animation setting).
- **Modes:** focus mode hides the chrome (Esc outside a terminal exits); presentation mode enlarges text and UI.
- **Welcome:** a one-time sheet on first launch (theme, density, sounds / notifications, three tips); reopen it with
  *Show welcome* in the palette.

</details>

<details>
<summary><b>Notifications</b></summary>

Settings › Notifications decides who may interrupt you; everything is still recorded in **Comms** (the bell in the
status bar), with silenced alerts marked *muted* and the reason.

- **Events:** needs input (permission prompts, questions, "waiting for you"), finished, error, bell / notify escapes.
- **Delivery:** *Windows + in-app* (Windows notification and taskbar flash in the background, a toast with *Jump* in
  front), *In-app only*, or *Comms feed only*; optionally only while the window is in the background. You are never
  pinged about the pane you are looking at, and each session is rate-limited.
- **Sounds:** synthesized in-app (no audio files): *Comm beep*, *Console*, *Droid chatter* or *None*, with volume.
  Off by default.
- **Quiet:** *Do not disturb* (also: hold or right-click the Comms bell, or *Toggle do not disturb* in the palette)
  and daily quiet hours (may cross midnight).
- **Agents:** allow Claude Code, Codex, PowerShell and other tools separately.
- **Mutes:** *Mute notifications* in a pane's ⋯ menu or a workspace's right-click menu; muted panes show a bell-off
  glyph. Mutes are removed with the session / workspace.

</details>

<details>
<summary><b>Settings and data locations</b></summary>

Settings (`Ctrl+,`) has six sections, and everything is saved in `workspaces.json` (theme effects are per machine).

| Section | Settings |
|---|---|
| Appearance | Theme gallery, saber colour, glow / holo band / scanlines, density, terminal font, reduce motion, hyperspace jump, focus and presentation modes. |
| Notifications | Events, delivery, sound set and volume, Do not disturb, quiet hours, agent kinds, mute list. |
| Terminal | Renderer: Auto (WebGL) / WebGL / DOM. Font family (default Cascadia Mono), size 8–32, line height 1–2. Scrollback lines per view (default 5,000; 100–200,000). Output buffer KiB per session in the backend (default 2,048; 256–65,536), used for replay and Copy output. Default layout. Cursor blink. |
| Agents | Executable paths for Claude Code, Codex and PowerShell, with detected path and version. |
| Keybindings | Rebind with a key recorder. Forbidden combos are rejected. |
| Interface | Resource usage in the status bar, sidebar as a rail, inspector panel. |

Everything lives under `%APPDATA%\app.gridkeeper.desktop\`:

| Path | Contents |
|---|---|
| `workspaces.json` | Settings, workspaces, groups, layouts, session definitions (no secrets). `.bak` is the previous good version and `.tmp` is the in-flight write. `workspaces.corrupt-<timestamp>.json` holds preserved damaged files. |
| `profiles.json` | Account entries (agent, name, folder, colour). |
| `logs\gridkeeper.YYYY-MM-DD.log` | JSON-lines logs, redacted, daily rotation, 7 files kept. The level is set with the `GRIDKEEPER_LOG` env var (e.g. `GRIDKEEPER_LOG=debug,gridkeeper_lib::pty=trace`). |
| `diagnostics\gridkeeper-diagnostics-<timestamp>.json` | Exported diagnostics bundles (redacted, home directory shown as `~`). |

Gridkeeper never writes inside agent config directories. The one exception is creating an empty folder when you add a new account.

</details>

<details>
<summary><b>Build from source, requirements, tests and benchmarks</b></summary>

#### Requirements

- Windows 10 1809+ (ConPTY). Developed and tested on **Windows 11 build 26300**.
- WebView2 runtime. It is preinstalled on Windows 11, and the installer embeds the bootstrapper for machines without it.
- To build: Rust stable ≥ 1.95 (tested with 1.99.1) with the MSVC toolchain, Visual Studio 2022 Build Tools (C++
  workload, Windows 11 SDK), Node.js 22+ and npm.
- Optional agents, auto-detected, or set explicit paths in Settings → Agents: Claude Code (native
  `%USERPROFILE%\.local\bin\claude.exe` preferred over the npm shim), Codex CLI, PowerShell 7.

Tested versions: Claude Code 2.1.302, codex-cli 0.162.0, pwsh 7.6.7, WebView2 155.0.4283.60.

#### Build and run

Run these from **PowerShell** (or a VS Developer prompt), not Git Bash. Git Bash's environment can shadow MSVC tools;
for example, Git's `/usr/bin/link.exe` can be picked up instead of the MSVC linker.

```powershell
npm install
npm run tauri dev      # dev build: Vite on localhost:1420 + Rust host
npm run tauri build    # release build + NSIS installer (per-user install)
```

The installer is written to `src-tauri\target\release\bundle\nsis\`. See [CONTRIBUTING.md](CONTRIBUTING.md) for
low-RAM build settings.

#### Testing

```powershell
cd src-tauri; cargo test                                              # Rust unit + ConPTY integration tests
cargo test --test live_profiles -- --ignored --nocapture              # live checks against real Claude profiles (prints no e-mails)
cd ..; npx vitest run                                                 # frontend unit tests (same as: npm test)
npm run typecheck
```

The ConPTY tests spawn real `pwsh`/`cmd` processes. Run them from PowerShell.

#### Bench mode

Bench mode opens an in-memory "Bench" workspace with N PowerShell sessions running `scripts/bench/flood.ps1`. Nothing
is persisted in bench mode.

```powershell
$env:GRIDKEEPER_BENCH = "sessions=6;mode=sustained;seconds=60;rate=2000;layout=grid"
npm run tauri dev
```

| Key | Values |
|---|---|
| `sessions` | 1–32 (default 6) |
| `mode` | `idle` (shells only), `lines` (print `count` lines once), `sustained` (`rate` lines/s for `seconds`), `unicode`, `garbage` (malformed escapes) |
| `count`, `rate`, `seconds` | Passed to `flood.ps1` |
| `layout` | `grid` / `columns` / `rows` |

`GRIDKEEPER_BENCH_SCRIPTS` overrides the scripts folder. `scripts/bench/sample.ps1` samples CPU/RAM/GPU of a running
instance by category (host, webview, console, agents), and `scripts/bench/run-all.ps1` runs the standard scenarios
against a release build:

```powershell
pwsh -File scripts/bench/sample.ps1 -Seconds 60 -Label idle-6-sessions -OutDir bench-results
pwsh -File scripts/bench/run-all.ps1 -Exe src-tauri/target/release/gridkeeper.exe
```

#### E2E scripts

The e2e scripts drive the running dev app over the Chrome DevTools Protocol:

```powershell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"
npm run tauri dev
# in another shell:
node scripts/e2e/cdp.mjs file scripts/e2e/full-verify.js  # full verification suite (PowerShell panes only)
node scripts/e2e/cdp.mjs file scripts/e2e/ps-basic.js     # pwsh prompt, echo, Unicode, 20,000 lines
node scripts/e2e/cdp.mjs file scripts/e2e/multi-agent.js  # 3 Claude profiles + 2 Codex + 1 pwsh (sends no prompts)
node scripts/e2e/cdp.mjs file scripts/e2e/codex-race.js   # 3 Codex started in the same tick
node scripts/e2e/cdp.mjs eval "window.__gridkeeperTerminals.list()"
node scripts/e2e/cdp.mjs shot out.png
```

The scripts use hard-coded `D:\AlteraAI` as the working folder; edit them for other locations. Debug hooks (dev builds)
are `window.__gridkeeper`, `window.__gridkeeperTerminals.list()/text(id)` and `window.__gridkeeperForceContextLoss(id?)`
(simulates a GPU context loss). The README demo is recorded with `node scripts/showcase/record.mjs`.

</details>

<details>
<summary><b>Known limitations</b></summary>

- **Processes don't survive app exit or reboot.** On restore, agents start again and resume their *conversation*. The running process is not reattached.
- **Codex conversation ids can't be pinned** up front. Panes sharing a folder use Codex's picker on restore.
- **Shift+Enter in Claude Code on Windows** is unreliable: Claude enables the kitty keyboard protocol only for allowlisted terminals (Claude Code #92771). See Claude Code's interactive-mode documentation for alternative ways to enter multiline input.
- **The GPU accelerates terminal rendering only.** Agent CPU work, output parsing and IPC run on the CPU.
- **Hybrid graphics:** Windows chooses which GPU WebView2 uses. To change it, go to Settings → System → Display → Graphics. Measured here: NVIDIA RTX 3050 via ANGLE/D3D11.
- **Same-agent launches are staggered** (Claude 350 ms, Codex 600 ms) because of a rare Codex startup hang seen with 6 simultaneous launches. A pane with no output after 12 s offers Restart.
- **More than 12 visible terminals:** the extra ones use the DOM renderer (WebGL context budget).
- **Hide view frees the scrollback:** Show replays only the backend buffer (default 2 MiB per session).
- **Diagnostics leave out the ConPTY host process** (`conhost.exe`). It belongs to neither the host, WebView2 nor a session tree in the in-app numbers. `sample.ps1` reports it separately.
- **npm `.cmd` shims** run through `cmd.exe /d /c`, so arguments with cmd metacharacters are rejected. Prefer native `.exe` installs.
- **Browser panes are iframes** (ADR-019): back / forward cover addresses opened through Gridkeeper, not link clicks inside the page; the pane name follows the page's static `<title>` only; `target=_blank` links do nothing inside a pane; app shortcuts don't fire while the keyboard focus is inside a page; DevTools exist only for pop-out windows in debug builds. Opening an http(s) address fetches it once with `curl.exe` to check whether it may be embedded; an HTTPS dev server with a self-signed certificate probes as "TLS error" (use *Show anyway*).
- **Port detection** sees TCP listeners only (not UDP), and only inside a session's process tree. A server started detached from the session (e.g. a Windows service or `start` into another console tree) is not attributed.
- **Job assignment race:** a process spawned in the first microseconds after launch, before Job assignment, could escape cleanup (portable-pty doesn't create processes suspended). Not observed in practice.
- **The installer is not code-signed** and there is no auto-update yet (see [docs/ROADMAP.md](docs/ROADMAP.md)).

</details>

<p align="center"><img src="docs/assets/readme/saber-blue.svg" width="100%" alt="" /></p>

## Contributing

Issues and pull requests are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md) for Windows dev setup, the checks
every change must pass and the rules that keep Gridkeeper fast and safe. Please follow the
[Code of Conduct](CODE_OF_CONDUCT.md), and report security problems privately as described in
[SECURITY.md](SECURITY.md).

## License

Gridkeeper is released under the [MIT License](LICENSE). Copyright (c) 2026 Raazi29 and Gridkeeper contributors.

### Third-party notices

Gridkeeper is built on open-source software. Key dependencies and their licenses (from each package's own metadata):

| Component | Used for | License |
|---|---|---|
| [Tauri](https://tauri.app) 2 (`tauri`, `@tauri-apps/api`, `@tauri-apps/cli`, plugins opener / dialog / clipboard-manager / notification / single-instance) | App host, IPC, bundling | Apache-2.0 OR MIT |
| [xterm.js](https://xtermjs.org) 6 (`@xterm/xterm` and the fit, search, unicode11, web-links, webgl addons) | Terminal emulation and rendering | MIT |
| [portable-pty](https://github.com/wez/wezterm/tree/main/pty) 0.9 | ConPTY sessions | MIT |
| [React](https://react.dev) 19, `react-dom` | UI | MIT |
| [zustand](https://github.com/pmndrs/zustand), [react-resizable-panels](https://github.com/bvaughn/react-resizable-panels) | State, split layout | MIT |
| [Vite](https://vite.dev), [Vitest](https://vitest.dev) | Build and tests (dev only) | MIT |
| `windows-sys`, `serde`, `parking_lot`, `regex`, `uuid`, `chrono` | Rust platform bindings and utilities | MIT OR Apache-2.0 |
| `sysinfo`, `tracing` | System info, logging | MIT |
| [Geist and Geist Mono](https://vercel.com/font) (via Fontsource) | UI and numeric fonts (bundled) | SIL OFL 1.1 |
| [Space Grotesk](https://fonts.google.com/specimen/Space+Grotesk) (via Fontsource) | Wordmark / display font (bundled) | SIL OFL 1.1 |
| [JetBrains Mono](https://www.jetbrains.com/lp/mono/) (via Fontsource) | Optional terminal font (bundled) | SIL OFL 1.1 |
| [IBM Plex Mono](https://www.ibm.com/plex/) (via Fontsource) | Phosphor theme / optional terminal font (bundled) | SIL OFL 1.1 |

Cascadia Mono, the default terminal font, is a Windows system font and is not shipped with Gridkeeper. Full license
texts are included in each package under `node_modules/` and in the Cargo registry sources.

### Disclaimer

Gridkeeper is an independent project. It is not affiliated with, endorsed by or sponsored by Lucasfilm Ltd. or The
Walt Disney Company; theme names and the opening-crawl and energy-blade artwork are generic homages and use no
official logos, fonts or characters. Claude, Claude Code, Codex, Windows, WebView2 and every other product name
mentioned here are trademarks of their respective owners. They are used only to identify the tools Gridkeeper can
run, and their use implies no affiliation or endorsement.

<p align="center"><sub>Built for people who run too many agents at once.</sub></p>
