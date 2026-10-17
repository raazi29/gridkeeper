# Gridkeeper

Gridkeeper is a GPU-accelerated multi-agent terminal workspace for Windows. It runs many Claude Code sessions (several accounts at once), Codex sessions and PowerShell terminals side by side in one window. Each session is a real ConPTY process tree, and its output is rendered by xterm.js with WebGL.

It is built with Tauri 2.12 (Rust backend, `portable-pty`/ConPTY, Windows Job Objects) and React 19 + TypeScript + xterm.js 6 in the system WebView2. It replaces "Terax" for this workflow.

Documentation:

- [docs/RESEARCH.md](docs/RESEARCH.md): research questions, evidence and sources
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): process model, data flow, state, security
- [docs/TECHNICAL_DECISIONS.md](docs/TECHNICAL_DECISIONS.md): ADRs
- [docs/PERFORMANCE.md](docs/PERFORMANCE.md): measured CPU/RAM/GPU on the target machine

## Why Gridkeeper

Built because the tools available on Windows kept failing this workflow: high CPU, freezes and crashes, flaky
cloud agent sessions, no clean way to run several Claude Code accounts at once, and wasted memory.

- **Native Windows, no WSL or tmux.** Real ConPTY sessions; every agent's whole process tree is contained in a
  Job Object, so quitting never leaves orphans.
- **Many accounts, truly separate.** One `CLAUDE_CONFIG_DIR` per profile, identity variables stripped per pane,
  login verified with `claude auth status` without reading credentials.
- **Built not to burn CPU.** Idle workspaces measured at ≈0.1–0.4 % of the machine (see PERFORMANCE.md); no polling
  loops; hidden panes stop rendering but keep their state; output flow control never pauses an agent.
- **GPU where it helps.** WebGL glyph rendering and GPU compositing, with automatic recovery and a software fallback.
  Agent CPU is always shown separately, so the app's own cost is visible.
- **Knows when an agent needs you.** Attention lamps, unread badges, Windows notifications, a Comms feed and a
  Fleet overview — detected from terminal signals and output activity, never by reading your content.
- **One window for every agent CLI.** Claude Code, Codex, PowerShell, plus Hermes, OpenCode, Gemini CLI, Copilot CLI,
  Aider, Factory Droid, Kimi, Qwen Code, Cursor Agent, Goose, Crush, Amp and OpenClaw when installed.
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
| Footprint | Tauri, 5 MB installer | Tauri, ~7–8 MB | ? | Electron (reported) | native | Go TUI | ? |
| License | (yours) | Apache-2.0 | proprietary | Apache-2.0 | MIT | AGPL-3.0 | ELv2 / closed |

Known public complaints about alternatives that motivated this design include Warp issues on Windows for high
idle CPU/GPU and memory growth with Codex/Claude (#5825, #7561, #12472, #8822, #11744), and Claude Squad's tmux
dependency (WSL-only on Windows).

---

## Features

- **Workspaces → groups → sessions.** A workspace has a project folder and holds groups (tabs). A group lays out its sessions as panes in a grid, columns or rows. Splits are resizable, panes can be reordered by drag and drop, and any pane can be maximized.
- **Agents:**
  - PowerShell (pwsh 7, with Windows PowerShell 5.1 as fallback)
  - Claude Code
  - Codex
  - any other command-line program
- **Claude account profiles.** Each profile is its own `CLAUDE_CONFIG_DIR`, so several accounts can run at the same time. Inherited credential variables are stripped so the profiles don't collapse into one identity. Login state is checked with `claude auth status --json`, and credentials are never read.
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
- **Fleet (Ctrl+Shift+O):** every session in every workspace as live tiles — state, account, CPU/RAM, last lines of
  output; filter to *Needs me*, *Working* or *Errors*; Enter jumps to it.
- **Broadcast (Ctrl+Shift+K):** type once, send to several selected sessions (confirmation for more than 3 targets or
  other workspaces; never sends on its own).
- **Next alert (Ctrl+Shift+J):** jump to the next session that needs you.
- **Quick launch:** *+ New* in the header and one-click agent cards in empty groups start a session in the
  workspace folder; the full dialog handles worktrees, arguments and launching several at once.
- **Agent catalog:** Hermes, OpenCode, Gemini CLI, Copilot CLI, Aider, Factory Droid, Kimi, Qwen Code, Cursor Agent,
  Goose, Crush, Amp and OpenClaw are detected on PATH (broken installs are reported, not listed) with their own
  continue/resume flags where documented.
- **Inspector** for the focused session: PID, state, exit code, times, bytes, CPU/RAM of its tree, the command line (redacted), and restore options.
- **Diagnostics:** CPU/RAM split between the app host, WebView2 and each session's tree, plus GPU renderer status and a redacted export bundle.
- **Command palette** over commands, sessions in all workspaces, and workspaces.
- **Persistence:** a versioned, atomically written workspace file with a backup. A damaged file is preserved, never silently overwritten.
- **No telemetry.**

## Requirements

- Windows 10 1809+ (ConPTY). Developed and tested on **Windows 11 build 26300**.
- WebView2 runtime. It is preinstalled on Windows 11, and the installer embeds the bootstrapper for machines without it.
- To build:
  - Rust stable (tested with 1.99.1) with the MSVC toolchain
  - Visual Studio Build Tools (C++ workload, Windows SDK)
  - Node.js 22+ (the e2e driver uses Node's built-in `WebSocket`)
  - npm
- Optional agents, auto-detected, or set explicit paths in Settings → Agents:
  - Claude Code: native `%USERPROFILE%\.local\bin\claude.exe` preferred over the npm shim
  - Codex CLI
  - PowerShell 7

Tested versions: Claude Code 2.1.302, codex-cli 0.162.0, pwsh 7.6.7, WebView2 155.0.4283.60.

## Build and run

Run these from **PowerShell** (or a VS Developer prompt), not Git Bash. Git Bash's environment can shadow MSVC tools; for example, Git's `/usr/bin/link.exe` can be picked up instead of the MSVC linker.

```powershell
npm install
npm run tauri dev      # dev build: Vite on localhost:1420 + Rust host
npm run tauri build    # release build + NSIS installer (per-user install)
```

The installer is written to `src-tauri\target\release\bundle\nsis\`.

## Usage

### Workspaces, groups, sessions

- **New workspace** (sidebar `+` or `Ctrl+Shift+N`): give it a name and an optional project folder. The header shows the folder (click to reveal it in Explorer) and the git branch, with a dot when there are uncommitted changes.
- **Groups** are the tabs above the panes. Use `+` or `Ctrl+Shift+G` to add one, and double-click a tab to rename it. Deleting a group stops its sessions first, after confirmation. A workspace always keeps at least one group.
- **New session** (`Ctrl+Shift+T`):
  1. Pick the agent, folder and optional name, arguments and git worktree.
  2. For Claude, pick an account.
  3. Set a count of 1–8 identical sessions and a target group.

  `Ctrl+Shift+D` / `Ctrl+Shift+E` open the same dialog and switch the layout to columns / rows.
- **Layouts:** grid, columns or rows (header buttons or the palette). Drag split handles to resize, and the sizes are remembered per layout and pane count. `Ctrl+Shift+M` maximizes the focused pane.
- **Pane header:**
  - Status, agent, account, worktree and cwd chips.
  - Start/Stop (Shift+click to force stop) and Restart.
  - Menu: Rename, Copy output, Clear, Hide view, Restart fresh.
  - Double-click the name to rename the pane.
- **Hide view:** frees the terminal view while the process keeps running. Show view replays the session's buffered output (the last `Output buffer` KiB).
- **Closing a pane** stops its process (after confirmation if it is running) and removes the session.

### Claude profiles

Open **Profiles** in the sidebar footer, or "Claude account profiles" in the palette.

- On first run, Gridkeeper seeds a **Default** profile (Claude's default `%USERPROFILE%\.claude`). It also adds every existing `%USERPROFILE%\.claude-<name>` folder that looks like a Claude config directory.
- **To add an account:**
  1. Click Add, then give a name and a config folder (for example `C:\Users\you\.claude-work`). A missing folder is created empty.
  2. Start a Claude Code session with that profile.
  3. Run **`/login`** inside Claude.
  4. Use **Check status** to confirm. It runs `claude auth status --json` and shows the login state and account e-mail; the e-mail is shown in the UI only and never logged.
- Removing a profile removes only Gridkeeper's entry. The folder is never touched.
- Gridkeeper warns when two live sessions share one profile: concurrent token refreshes can force a re-login (Claude Code #91708). Use separate profiles for concurrent work.

### Codex

Codex is detected on PATH or at `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin\codex.exe`. "Continue" maps to `codex resume --last`. Codex can't pin a conversation id up front, so when several restored Codex panes share a folder, each opens Codex's resume picker instead of resuming the same conversation.

### Restore behaviour

- The layout always comes back.
- Processes never survive an app exit. Each restored pane starts a **new** process if its *Auto-start process* option is on (Inspector).
- *Conversation: Continue / New* (Inspector) decides whether the agent resumes its conversation.
- Claude resumes the pane's pinned conversation. If no transcript exists yet, it starts a new conversation under the same id.

### Worktrees

In the New Session dialog, *Git worktree* has three options:

- *Use folder as is*
- *Existing worktree*
- *Create new worktree*: enter a branch (new or existing) and a folder.

You see and confirm the exact `git worktree add` command before anything is created.

### Inspector, diagnostics, palette

- **Inspector** (`Ctrl+Shift+I`): details and actions for the focused session, plus its restore options.
- **Diagnostics** (``Ctrl+Shift+` ``): a per-process resource table (host / WebView2 / sessions), the GPU renderer string, WebGL/DOM counts and context losses. **Export** writes a redacted JSON bundle.
- **Status bar:** the breadcrumb, running count, app vs agent CPU/RAM (polled every 2 s while the window is visible; can be turned off) and renderer status.
- **Command palette** (`Ctrl+Shift+P`): fuzzy search over all commands, all sessions and all workspaces.

## Keybindings

Defaults (`src/keybindings/combo.ts`). Change them in Settings → Keybindings; an empty value unbinds a command.

| Shortcut | Command |
|---|---|
| `Ctrl+Shift+P` | Command palette |
| `Ctrl+Shift+T` | New session… |
| `Ctrl+Shift+N` | New workspace… |
| `Ctrl+Shift+W` | Close session |
| `Ctrl+Tab` | Focus next session |
| `Ctrl+Shift+Tab` | Focus previous session |
| `Alt+1` … `Alt+9` | Focus pane 1 … 9 |
| `Ctrl+Shift+PgDn` | Next workspace |
| `Ctrl+Shift+PgUp` | Previous workspace |
| `Ctrl+Shift+D` | Split: new session in columns |
| `Ctrl+Shift+E` | Split: new session in rows |
| `Ctrl+Shift+M` | Toggle maximize pane |
| `Ctrl+Shift+B` | Toggle sidebar |
| `Ctrl+Shift+I` | Toggle inspector |
| ``Ctrl+Shift+` `` | Toggle diagnostics |
| `Ctrl+,` | Settings |
| `Ctrl+Shift+G` | New group |

These commands have no default shortcut and run from the palette (they can be bound):

- Session: restart (resume), restart (fresh conversation), stop, force stop, copy output, clear terminal
- Layout: grid / columns / rows
- Switch workspace…, go to session…, Claude account profiles

**Inside a terminal** (fixed, not configurable):

| Input | Action |
|---|---|
| `Ctrl+C` | Copies (and clears) the selection if there is one; otherwise sends `^C` |
| `Ctrl+Shift+C` | Copy the selection |
| `Ctrl+V` / `Ctrl+Shift+V` | Paste (bracketed paste when the program enabled it) |
| Right-click | Copy the selection, or paste. Goes to the program when it uses the mouse (hold Shift to override) |
| `Ctrl+click` | Open an http(s) link |

**Policy:** Gridkeeper never binds keys that terminals and agents need. Settings refuses these:

- function keys;
- combos without Ctrl or Alt;
- Ctrl+Alt (AltGr);
- Win-key combos;
- Alt+letter;
- Ctrl+letter;
- Ctrl+arrows and Ctrl+editing keys;
- Ctrl+Shift+C/V.

## Settings

Settings (`Ctrl+,`) has four sections, and everything is saved in `workspaces.json`.

| Section | Settings |
|---|---|
| Terminal | Renderer: Auto (WebGL) / WebGL / DOM. Font family (default Cascadia Mono), size 8–32, line height 1–2. Scrollback lines per view (default 5,000; 100–200,000). Output buffer KiB per session in the backend (default 2,048; 256–65,536), used for replay and Copy output. Default layout. Cursor blink. |
| Agents | Executable paths for Claude Code, Codex and PowerShell, with detected path and version. |
| Keybindings | Rebind with a key recorder. Forbidden combos are rejected. |
| Interface | Resource usage in the status bar, sidebar as a rail, inspector panel. |

## Data locations

Everything lives under `%APPDATA%\app.gridkeeper.desktop\`:

| Path | Contents |
|---|---|
| `workspaces.json` | Settings, workspaces, groups, layouts, session definitions (no secrets). `.bak` is the previous good version and `.tmp` is the in-flight write. `workspaces.corrupt-<timestamp>.json` holds preserved damaged files. |
| `profiles.json` | Claude profile entries (name, folder, colour). |
| `logs\gridkeeper.YYYY-MM-DD.log` | JSON-lines logs, redacted, daily rotation, 7 files kept. The level is set with the `GRIDKEEPER_LOG` env var (e.g. `GRIDKEEPER_LOG=debug,gridkeeper_lib::pty=trace`). |
| `diagnostics\gridkeeper-diagnostics-<timestamp>.json` | Exported diagnostics bundles (redacted, home directory shown as `~`). |

Gridkeeper never writes inside Claude or Codex config directories. The one exception is creating an empty folder when you add a new profile.

## Bench mode and e2e scripts

**Bench mode** opens an in-memory "Bench" workspace with N PowerShell sessions running `scripts/bench/flood.ps1`. Nothing is persisted in bench mode.

```powershell
$env:GRIDKEEPER_BENCH = "sessions=6;mode=sustained;seconds=60;rate=2000;layout=grid"
npm run tauri dev
```

Keys:

| Key | Values |
|---|---|
| `sessions` | 1–32 (default 6) |
| `mode` | `idle` (shells only), `lines` (print `count` lines once), `sustained` (`rate` lines/s for `seconds`), `unicode`, `garbage` (malformed escapes) |
| `count`, `rate`, `seconds` | Passed to `flood.ps1` |
| `layout` | `grid` / `columns` / `rows` |

`GRIDKEEPER_BENCH_SCRIPTS` overrides the scripts folder. `scripts/bench/sample.ps1` samples CPU/RAM/GPU of a running instance by category (host, webview, console, agents):

```powershell
pwsh -File scripts/bench/sample.ps1 -Seconds 60 -Label idle-6-sessions -OutDir bench-results
```

**E2E scripts** drive the running dev app over the Chrome DevTools Protocol:

```powershell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"
npm run tauri dev
# in another shell:
node scripts/e2e/cdp.mjs file scripts/e2e/ps-basic.js     # pwsh prompt, echo, Unicode, 20,000 lines
node scripts/e2e/cdp.mjs file scripts/e2e/multi-agent.js  # 3 Claude profiles + 2 Codex + 1 pwsh (sends no prompts)
node scripts/e2e/cdp.mjs file scripts/e2e/codex-race.js   # 3 Codex started in the same tick
node scripts/e2e/cdp.mjs eval "window.__gridkeeperTerminals.list()"
node scripts/e2e/cdp.mjs shot out.png
```

The scripts use hard-coded `D:\AlteraAI` as the working folder; edit them for other locations. Debug hooks are `window.__gridkeeperTerminals.list()/text(id)` and `window.__gridkeeperForceContextLoss(id?)` (simulates a GPU context loss).

## Testing

```powershell
cd src-tauri; cargo test                                              # Rust unit + ConPTY integration tests
cargo test --test live_profiles -- --ignored --nocapture              # live checks against real Claude profiles (prints no e-mails)
cd ..; npx vitest run                                                 # frontend unit tests (same as: npm test)
npm run typecheck
```

The ConPTY tests spawn real `pwsh`/`cmd` processes. Run them from PowerShell.

## Known limitations

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
- **Job assignment race:** a process spawned in the first microseconds after launch, before Job assignment, could escape cleanup (portable-pty doesn't create processes suspended). Not observed in practice.
