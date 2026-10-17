# Agent CLI / attention signals / naming / market research (2026-10-17)

Legend: VERIFIED = confirmed from the official source or this machine (URL or "local" given). HYPOTHESIS = from secondary sources or memory, not confirmed. I used about 33 tool calls.

## 0. What is installed on this machine (VERIFIED, local)
| CLI | Path | Version / state |
|---|---|---|
| claude | ~\.local\bin\claude.exe | 2.1.302 (new enough for OSC 7501, which needs 2.1.295 or later) |
| codex | %LOCALAPPDATA%\Programs\OpenAI\Codex\bin\codex.exe | codex-cli 0.163.0 |
| hermes | %LOCALAPPDATA%\hermes\hermes-agent\venv\Scripts\hermes.exe | v0.21.3 (2026.9.14), native Windows. `HERMES_HOME` and `HERMES_GIT_BASH_PATH` are set in the environment |
| opencode | %APPDATA%\npm\opencode.ps1 | v2.0.21, npm package **@opencode/cli** |
| aider | ~\.local\bin\aider.exe | 0.86.1 |
| kimi | ~\.local\bin\kimi.exe | 0.53 |
| droid | ~\bin\droid.exe | 0.65.1, native exe |
| openclaw, gemini, qwen, copilot, crush | %APPDATA%\npm\*.ps1 | **Broken (orphaned shims).** The packages are missing from the global node_modules, so the shims throw MODULE_NOT_FOUND. They need reinstalling. `npm view openclaw version` returns 2026.10.4 |
| amp, cursor-agent, goose | not found | not installed |
`npm ls -g --depth=0`: @colbymchenry/codegraph, @nanonets/graft, @opencode/cli@2.0.21, @sentropic/graphify, agent-browser, app (link), rea-agents. Node is v26.4.0.
Adapter implication: detect a broken shim. "Found on PATH" does not mean "launchable", so health-check with `--version`.

## 1. OpenClaw and Hermes Agent
**OpenClaw.** VERIFIED: https://github.com/openclaw/openclaw
- What it is: an MIT-licensed, self-hosted personal AI assistant from the OpenClaw Foundation. A local **Gateway** daemon manages sessions, tools and channels (Discord, Slack, Telegram, WhatsApp). It is not primarily a coding-agent CLI. The Gateway is reached through a Control UI, the CLI or a **TUI**.
- Former names: Clawdbot / Moltbot are HYPOTHESIS. The README I fetched does not mention them.
- Install on native Windows: `iwr -useb https://openclaw.ai/install.ps1 | iex`, or `npm install -g openclaw@latest` (add `--allow-scripts=openclaw` on npm 11.16 or later). Needs Node 24.16+ or 26.1+. WSL2 is also supported. Then run `openclaw onboard --install-daemon`.
- Interactive: `openclaw tui [target]` attaches to the Gateway. `openclaw tui --local` runs in embedded mode and needs exclusive ownership of the state dir, so it refuses to start while a Gateway holds it. VERIFIED: https://docs.openclaw.ai/cli/tui/index.html
- Isolation: `--profile <name>` puts state under `~/.openclaw-<name>` (VERIFIED: https://docs.openclaw.ai/cli). Env vars `OPENCLAW_STATE_DIR` and `OPENCLAW_CONFIG_PATH` are HYPOTHESIS (third-party mirror). `OPENCLAW_PROFILE=dev` is HYPOTHESIS (unofficial guide).
- Auth: onboarding verifies model access (provider API keys / OAuth), and DM senders are paired with `openclaw pairing approve`. A resume flag and an attention signal are not documented (HYPOTHESIS: none).
- Adapter fit: low priority. It is gateway-centric, and `tui --local` conflicts with a running gateway.

**Hermes Agent (Nous Research).** VERIFIED: https://github.com/NousResearch/hermes-agent plus local `--help`
- What it is: an MIT-licensed "self-improving" agent with memory, skills, cron, subagents, a messaging gateway, MCP, ACP server mode (`hermes acp`), worktrees, kanban, and `import-agent`, which imports a Claude Code or Codex setup.
- Install on native Windows: `iex (irm https://hermes-agent.nousresearch.com/install.ps1)` installs to `%LOCALAPPDATA%\hermes`. It is a Python venv, and the install includes a Git Bash path.
- Launch: `hermes` or `hermes chat`. `--tui` gives the modern TUI and `--cli` the classic REPL.
- Resume: `--resume/-r SESSION_ID` and `--continue/-c [SESSION_NAME]`. Also `--in DIR`, `--worktree`, `--yolo`. VERIFIED locally.
- Isolation: each profile is its own `HERMES_HOME` directory (VERIFIED: https://hermes-agent.nousresearch.com/docs/user-guide/profiles). It is managed with `hermes profile list|use|create|alias...`. **There is no `-p` flag in 0.21.3's usage** (local), so the third-party `hermes -p` claim is contradicted. Use the env var `HERMES_HOME=<dir>` per pane. `terminal.home_mode: profile` also isolates HOME for tools.
- Auth: Nous Portal OAuth (`hermes setup --portal`), `hermes model`, or provider keys in `.env`. `hermes auth` manages pooled credentials.
- Attention signal: there is no documented OSC signal. There are shell-script hooks declared in `~/.hermes/config.yaml` (`hermes hooks list|test|doctor`, with a consent allowlist). The event names are HYPOTHESIS (run `hermes hooks list`).

## 2. Other coding-agent CLIs
| Agent | Executable | Native Windows | Install | Interactive | Resume | Config-dir env var |
|---|---|---|---|---|---|---|
| Gemini CLI | `gemini` | Yes | `npm i -g @google/gemini-cli` | `gemini` | `--resume` / `/chat resume` (HYP) | `GEMINI_CLI_HOME` (creates `.gemini` inside it). Semi-verified: https://www.mintlify.com/google-gemini/gemini-cli/reference/environment-variables |
| GitHub Copilot CLI | `copilot` | Yes (PowerShell 6+ or WSL) | `npm i -g @github/copilot` (Node 22+) or WinGet | `copilot` | `--resume` (picker), `--continue` (last). VERIFIED: https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/overview | `COPILOT_HOME`? (HYP; default ~/.copilot) |
| OpenCode | `opencode` | Yes | `npm i -g @opencode/cli` (installed here) | `opencode` | `-c/--continue`, `-s/--session <id>` (VERIFIED local) | `OPENCODE_CONFIG_DIR` (HYP) |
| Aider | `aider` | Yes | `pip/uv: aider-install` | `aider` | No true resume. `--restore-chat-history` (VERIFIED local) | none. Uses `.aider.conf.yml` / `--chat-history-file` |
| Amp | `amp` | HYP yes | `npm i -g @sourcegraph/amp` (HYP) | `amp` | `amp threads continue` (HYP) | HYP |
| Cursor CLI | `cursor-agent` (newer builds also `agent`) | Yes, official PowerShell installer (beta) | `irm 'https://cursor.com/install?win32=true' \| iex`. Semi-verified: https://cursor.com/docs/cli/installation | `cursor-agent` | `--resume [chatId]` / `cursor-agent resume` (HYP) | HYP |
| Qwen Code | `qwen` | Yes (Gemini CLI fork) | `npm i -g @qwen-code/qwen-code` (HYP) | `qwen` | `--continue/--resume` (HYP) | HYP (~/.qwen) |
| Goose | `goose` | HYP (Windows fixes appear in release notes) | Block install script / download (HYP) | `goose session` | `goose session -r/--resume [--name/--session-id]`. VERIFIED: https://goose-docs.ai/docs/guides/sessions/session-management/ | `%APPDATA%\Block\goose\config` (HYP) |
| Crush | `crush` | Yes (Go) | `npm i -g @charmland/crush` / winget (HYP) | `crush` | `--continue` (HYP) | `CRUSH_GLOBAL_CONFIG` (HYP) |
| Factory Droid | `droid` | Yes (native exe here) | PowerShell installer (HYP) | `droid` | `-r/--resume [sessionId]` (VERIFIED local) | HYP (~/.factory) |
| Kimi CLI | `kimi` | Yes (uv tool here) | `uv tool install kimi-cli` (HYP) | `kimi` | `-C/--continue` (VERIFIED local) | `KIMI_SHARE_DIR` (HYP) |
| Codex | `codex` | Yes | — | `codex` | `codex resume [--last]`, `codex fork` (VERIFIED local) | `CODEX_HOME` (path refs in the config reference) |
Suggested priority for first-class adapters: Gemini, Copilot, OpenCode, Hermes, Droid, Kimi, Qwen, Cursor. Generic: Aider, Crush, Goose, Amp.

## 3. Attention signals (no reading of user content)
### Claude Code
- **OSC 7501 Program Status Protocol.** Claude reports working / waiting on you / done, with nothing to enable. It needs v2.1.295 or later. It is off inside tmux, in background sessions, or when `CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1`. VERIFIED: https://code.claude.com/docs/en/terminal-config#see-session-status-in-your-terminal
- Wire format (spec r0.4). VERIFIED: https://www.superlogical.com/rex/docs/build/program-status (mirror: https://control-codes.page/proposals/osc-7501/)
  - Report: `ESC ] 7501 ; key=value:key=value… ST`, where ST is `ESC \` or `BEL`.
  - `state` is required: `idle|working|done|blocked|error|clear`.
  - `kind` (blocked only) is `permission|question|auth`. `progress` is 0-100 (working/blocked). `app` is ≤32 bytes. `id` is a slash-separated path. `title` and `msg` are base64 UTF-8.
  - Unknown keys are ignored. A bad or missing state discards the report.
  - Limits: 4096 bytes per sequence, msg ≤2048 decoded, title ≤192 decoded.
  - Lifetime: working/blocked records are dropped when the process exits or on an OSC 133;A prompt. done/error records persist.
  - **Feature detection:** the program sends the query `ESC ] 7501 ; ? ST` and then `CSI c` (DA1). The terminal must reply `ESC ] 7501 ; ? [:states=…][:kinds=…] ST` *before* its DA1 reply, or the program decides the terminal does not support the protocol.
  - Example: `ESC]7501;state=blocked:kind=permission:app=terraform:msg=QXBwbHk…ESC\`.
- **Windows HYPOTHESES to test first (critical):**
  - (a) In xterm.js, write the 7501 reply to the PTY **synchronously** inside the OSC handler. If it goes through an async Tauri `invoke`, xterm's built-in DA1 reply (emitted via `onData`) may win the race. Best option: answer in Rust before the bytes reach xterm, by scanning the PTY output stream for `ESC]7501;?`.
  - (b) ConPTY may answer `CSI c` itself and/or swallow unknown OSC sequences. If so, Claude never sees our reply, or our handler never sees the reports. Test: `printf '\e]7501;state=working\e\\'` in a pane and log it, then run the installed `claude` 2.1.302 and check for reports. If ConPTY eats them, bundle a newer OpenConsole/conpty.dll (Microsoft.Windows.Console.ConPTY), which passes more through (HYP).
- **Notifications.** The default desktop notification goes only to Ghostty, Kitty and iTerm2. Elsewhere, set `preferredNotifChannel: "terminal_bell"` or use a Notification hook. VERIFIED: terminal-config page above. Because our host is none of those three, by default Claude emits nothing. Set `preferredNotifChannel: "terminal_bell"` per profile (BEL → xterm `onBell`), or rely on OSC 7501. Full value list `auto|terminal_bell|iterm2|iterm2_with_bell|kitty|ghostty|notifications_disabled` is HYP (blog: https://theaiarchitects.com/blog/claude-code-notifications). The mapping iterm2→OSC 9, kitty→OSC 99, ghostty→OSC 777 is HYP.
- **Hooks.** VERIFIED: https://code.claude.com/docs/en/hooks
  - `Notification` matcher values: `permission_prompt, idle_prompt, auth_success, elicitation_dialog, elicitation_url_dialog, elicitation_complete, elicitation_response, agent_needs_input, agent_completed, quota_auto_resume_*`.
  - `Stop` ("when Claude finishes responding"; has `last_assistant_message`) and `StopFailure`.
  - `UserPromptSubmit` can serve as turn start, and `PreToolUse/PostToolUse` as activity.
  - Common fields: `session_id`, `cwd`, `hook_event_name`, `prompt_id`.
  - Hook JSON output can include **`terminalSequence`**. Claude emits it for you, restricted to OSC 0/1/2/9/99/777 and BEL, in interactive sessions only. Example: `printf '\033]777;notify;%s;%s\007'`. So the host can inject a per-profile hook (via that profile's CLAUDE_CONFIG_DIR settings) that emits e.g. `ESC]777;notify;<pane-token>;<notification_type>BEL`. That gives a content-free, typed signal that does not depend on OSC 7501.
- `terminalProgressBarEnabled`: Claude shows a terminal progress bar. That it uses OSC 9;4 is HYP.

### Codex
VERIFIED: https://learn.chatgpt.com/docs/config-file/config-reference (was developers.openai.com/codex/config-reference)
- `tui.notifications` takes a bool or a list of event types (`agent-turn-complete`, `approval-requested`; the event names are HYP).
- `tui.notification_method` is `auto|osc9|bel` (default auto).
- `tui.notification_condition` is `unfocused|always` (default unfocused). **Set `always`**, because Codex inside our pane may consider itself "focused".
- `notify` is an argv array that receives a JSON payload. HYP: it fires only on agent-turn-complete.
- `tui.terminal_title` defaults to `["spinner","project"]`. That gives a **spinner glyph in the title while working**, detectable via xterm `onTitleChange` without reading content. This is the cheapest cross-agent heuristic.
- Hooks: `Stop` exists (`features.hooks`, hooks.json).
- Profiles: `$CODEX_HOME/<name>.config.toml`.

### Generic formats
| Signal | Format |
|---|---|
| OSC 9 notify (iTerm2/WT) | `ESC ] 9 ; <text> BEL` |
| OSC 9;4 progress (ConEmu/WT) | `ESC ] 9 ; 4 ; <state 0-4> ; <pct> BEL`. The handler must branch on a `4;` prefix |
| OSC 777 | `ESC ] 777 ; notify ; <title> ; <body> BEL` |
| OSC 99 (kitty) | `ESC ] 99 ; <k=v:k=v metadata> ; <payload> ST` (HYP detail: https://cdn.jsdelivr.net/npm/pi-chime@1.2.1/docs/protocols.md) |
| Title | `ESC ] 0 ; t BEL` or `ESC ] 2 ; t BEL` → xterm `onTitleChange` |
| Bell | `0x07` → xterm `onBell` |

### xterm.js 6
VERIFIED: typings for @xterm/xterm@6.0.0 (latest on npm), https://cdn.jsdelivr.net/npm/@xterm/xterm@6.0.0/typings/xterm.d.ts
- `term.parser.registerOscHandler(ident: number, cb: (data: string) => boolean | Promise<boolean>): IDisposable`. The callback runs once with the full payload (max 10 MB). Return true if handled, false to fall through. The newest handler runs first.
- `term.onBell: IEvent<void>`.
- `term.onTitleChange: IEvent<string>`.

### Tauri 2 notifications
- `tauri-plugin-notification` is **2.7.0** (crates.io max_stable) and `@tauri-apps/plugin-notification` is 2.7.0 on npm. VERIFIED via registries.
- Windows: "Only works for installed apps". In dev it "shows powershell name & icon". Actions are mobile-only. VERIFIED: https://v2.tauri.app/plugin/notification/
- AUMID: the installed MSI/NSIS creates a Start Menu shortcut with the bundle identifier as AUMID (HYP). Test toasts only from an installed build.
- Complements that need no AUMID (HYP): `window.requestUserAttention` (taskbar flash), and a taskbar overlay icon / tray badge.
- Permissions: `notification:default` (allow-notify, allow-request-permission, …).

## 4. Product name
Method: GitHub repo search (gh api), the npm registry, and the web. **I did not search USPTO/EUIPO trademarks**, so get a trademark check before committing.
| Candidate | Verdict | Evidence |
|---|---|---|
| Hivemux | Reject | Bradical247/hivemux is a "tmux-backed orchestrator for parallel AI coding agents". Muscaw/hivemux is a tmux session manager. The npm name is taken |
| Paneforge | Reject | svecosystem/paneforge (660★, Svelte panes, npm taken). robertiuoras/PaneForge is "One window for every coding agent you own" |
| Switchyard | Reject | NVIDIA-NeMo/Switchyard (3.4k★, LLM routing). npm taken |
| Orchestry | Reject | Orchestry Software is a Microsoft 365 governance SaaS listed in the Microsoft partner gallery (https://adoption.microsoft.com/partner-solution-gallery/orchestry-software/orchestry) |
| Agentry | Reject | npm taken. Several AI-agent orchestration repos (amtp-protocol/agentry, aweussom/agentry) |
| Quorum | Reject | Consensys Quorum (4.7k★, well-known blockchain) |
| Tessera | Reject | 10k repos, npm taken, overloaded |
| Conclave | Reject | conclave-team/conclave (725★), R3 Conclave SDK, npm taken |
| Corral / Flotilla / Muxa | Weak | Generic or crowded. npm taken. flotilla-os (Stitch Fix). bcongdon/corral (694★) |
| Relay Deck | Weak | npm is free, but LazyDoomSlayer/relay-deck is a "Tauri v2, Rust desktop app" (0★), and "Relay" is overloaded |
| Also collided | Reject | Panewright (avinashbn2: "tmux for Windows… built on ConPTY"), TermHive (71★ multi-agent dashboard), CrewDeck ("Run Claude Code, Codex, Gemini… side by side"), Drover, Bellwether, Agentyard, Bullpen, AgentLoom |
**Recommended (look free on GitHub and npm):**
1. **Tilewright**: npm 404, 3 unrelated zero-star repos, no product found on the web. "Crafts a grid of tiles", which evokes a GPU grid of panes.
2. **Panehouse**: npm 404, 0 repos. A house for panes or agents. Easy to say.
3. **Gridkeeper**: npm 404, 4 tiny unrelated repos. Says "keeps watch over a grid of agents", which matches the attention/notification feature.
4. **Quillpane**: npm 404, 0 repos. Fallback, with a softer brand.
(5. Relay Deck only if you accept the zero-star namesake.)

## 5. How we compare
| Product | Multi-agent on Windows | Notes / complaints (sourced) |
|---|---|---|
| Terax | Native Windows (NSIS, Tauri, about 7-8 MB). Per-tab Local/WSL | A terminal + editor + git graph with one built-in agent, not a parallel-agent grid. Not code-signed (SmartScreen warning). https://github.com/crynta/terax-ai , https://terax.app/ |
| Warp | Windows build exists. Agent features | GitHub issues: high CPU on Windows #5825; idle CPU/GPU #7561; background CPU #12472; memory leak with codex/claude spawning WSL #8822; crashes above about 83% RAM on Win11 #11744. https://github.com/warpdotdev/warp/issues/8822 , /issues/11744 , /issues/7561 |
| Wave Terminal | Cross-platform, AI widgets | No RAM-complaint issue was found. The release notes show memory-leak fixes (RPC, sysinfo) and a v0.14.5 process viewer. https://docs.waveterm.dev/releasenotes |
| Windows Terminal / Tabby | Native / Electron. Tabs and panes, no agent awareness | No sourced complaints gathered (HYP: Tabby is Electron-heavy) |
| Claude Squad | Not native. Requires tmux, so WSL only | https://smtg-ai.github.io/claude-squad/ , https://runpane.com/alternatives/claude-squad-windows (competitor-authored) |
| Crystal → Nimbalyst | Crystal was deprecated in Feb 2026. Nimbalyst runs on Windows/macOS/Linux, partly paid | https://nimbalyst.com/blog/best-conductor-alternatives-2026/ |
| vibe-kanban | Windows supported, Apache-2.0. Reportedly community-run after Bloop shut down (HYP) | https://dev.to/stravukarl/best-tools-for-managing-parallel-ai-coding-agents-in-2026-14l8 |
| Superset | macOS desktop. Linux AppImage experimental. No Windows evidence. ELv2 | https://superset.sh/compare/conductor-vs-crystal |
| Conductor | macOS only | per Nimbalyst/Superset comparisons citing Conductor docs |
Positioning (HYP; none of the sources show the opposite):
- None of these offer per-pane account isolation (CLAUDE_CONFIG_DIR / CODEX_HOME / HERMES_HOME).
- None combine a native ConPTY host with an agent status protocol (OSC 7501) on Windows.
- Our angles: native Windows without WSL or tmux, multi-account, low RAM (Tauri vs Electron), and content-free attention badges.
