# Altera — Research

This document answers the research questions in the original brief and shows the evidence for each answer. It draws on the raw notes in [`research-notes/terminal-stack.md`](research-notes/terminal-stack.md) and [`research-notes/claude-codex-cli.md`](research-notes/claude-codex-cli.md) (both dated 2026-10-17), on Altera's code, and on live tests run on the target machine.

## Evidence legend

| Tag | Meaning |
|---|---|
| **[V]** | Verified against a primary source: official docs, release notes, the library's own source, or the npm/crates.io APIs. |
| **[H]** | Hypothesis, anecdote or inference that was not checked against a primary source. |
| **[M]** | Measured or observed on the target machine (details below). |
| **[C]** | What Altera's code does (file references point into this repo). |

**Target machine [M]:** Intel i7-12650H (10C/16T), 15.7 GB RAM, Intel UHD + NVIDIA GeForce RTX 3050 Laptop 4 GB (driver 592.82), Windows 11 Home build 26300, WebView2 155.0.4283.60, Rust 1.99.1, Claude Code 2.1.302, codex-cli 0.162.0, pwsh 7.6.7.

CPU/RAM measurements of the running app are covered in `docs/PERFORMANCE.md`, which a separate step produces. This document makes no quantitative performance claims of its own.

---

## 1. What is the most appropriate architecture for a lightweight Windows app?

**Answer: Tauri 2 (Rust host + the system WebView2), with the terminal renderer and the app UI in one web frontend.**

| Option | Evidence | Verdict |
|---|---|---|
| **Tauri 2** | WebView2 is evergreen and preinstalled on Windows 11 **[V]** (v2.tauri.app/reference/webview-versions). No bundled Chromium or Node runtime. The backend is Rust, so ConPTY, Job Objects and Toolhelp are called directly through `windows-sys`. Installer modes are documented: downloadBootstrapper (0 MB), embedBootstrapper (~1.8 MB), offlineInstaller (~127 MB), fixedVersion (~180 MB) **[V]**. | **Chosen** |
| Electron | Ships its own Chromium and Node. Idle RAM against Tauri on Windows is close (both use Chromium): tauri#5889 measured Tauri 399 MB vs Electron 318 MB on Windows 10 for one app, and Ubuntu USS 125 vs 118 MB / PSS 185 vs 207 MB **[V: issue report; the numbers are one reporter's]**. Better Stack (idle 109 vs 128 MB) and levminer.com (Win11 ~80 vs 120 MB) are non-scientific **[H]**. Electron's edge is node-pty, which is mature. | Rejected. RAM is not clearly better, the installer is larger, and the app would carry a Node runtime. |
| WinUI 3 / C# | Microsoft's WPF terminal control `CI.Microsoft.Terminal.Wpf` exists only on the NuGet CI feed and is unsupported **[V]**. Embedding WinUI `TermControl` is not documented **[V]**. A C# app would have to write or adopt an unsupported VT renderer. | Rejected (no supported terminal control). |
| Rust-native UI (egui 0.37 / iced 0.14 / gpui 0.2.2 + `alacritty_terminal` 0.26) | `alacritty_terminal` is Apache-2.0. It loads `conpty.dll`/`OpenConsole.exe` next to the exe, else falls back to kernel32, and detects exit with `RegisterWaitForSingleObject` **[V: source read]**. `iced_term` uses it. A native UI still needs text shaping, selection, IME, accessibility, links and search built by hand **[H: engineering estimate]**. `wezterm-term` is not on crates.io, and wezterm's last tagged release is 20240203 **[V]**. Ghostty has no official Windows build, and libghostty-vt is unstable (ghostty discussion #12290) **[V]**. LibGhostty.Net 1.0.2 is a community wrapper **[V]**. | Rejected for v1: highest effort and risk. Kept as the long-term alternative (see TECHNICAL_DECISIONS ADR-002). |

Versions in use **[V]** (npm/crates.io, 2026-10-17): `@tauri-apps/api` 2.12.4, `@tauri-apps/cli` 2.12.3, `tauri` 2.12.4, `tauri-build` 2.7.3, `@xterm/xterm` 6.0.0, `@xterm/addon-webgl` 0.19.0, `addon-fit` 0.11.0, `addon-unicode11` 0.9.0, `addon-web-links` 0.12.0, `addon-search` 0.16.0, `portable-pty` 0.9.0 (2025-02-11, MIT), `windows-sys` 0.61.2. `addon-canvas` 0.7.0 is frozen and incompatible with xterm 6.

## 2. Which terminal engine can host PowerShell, Claude Code and Codex correctly?

**Answer: xterm.js 6, on ConPTY, with a few agent-specific adjustments.**

- xterm.js 6 removed the canvas renderer (DOM or WebGL remain) and `windowsMode`. It added DEC 2026 synchronized output, OSC 52, ESM and `onWriteParsed` **[V]** (xterm.js 6.0.0 release notes). The `windowsPty?: IWindowsPty` option still exists **[V: typings]**. Altera passes `windowsPty: { backend: "conpty", buildNumber }` using the real Windows build from `app_info` **[C: `src/terminal/registry.ts`, `src-tauri/src/commands/app.rs`]**.
- **Claude Code** probes XTVERSION, kitty keyboard (`CSI ? u`), OSC 7501, DA1 and DECRQM ?2026 **[V]**. Its fullscreen renderer (alt screen + SGR mouse) is mis-coalesced by ConPTY hosts. The documented fix is `CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT=1` (code.claude.com/docs/en/fullscreen) **[V]**. Altera sets it for every Claude session **[C: `adapters/claude.rs`]**. Recommended environment: `TERM=xterm-256color`, `COLORTERM=truecolor`, don't set `WT_SESSION`, and don't spoof `TERM_PROGRAM=windows-terminal` (#94873) **[V]**. Altera sets `TERM`/`COLORTERM`, sets `TERM_PROGRAM=Altera`, and removes `WT_SESSION`/`WT_PROFILE_ID` **[C: `adapters/mod.rs`]**. Shift+Enter is fragile on Windows without the kitty protocol, which Claude enables only for allowlisted `TERM_PROGRAM` values (#92771) **[V]**. This is a known limitation. On Windows, Claude reads `^H` as Ctrl+Backspace (`CLAUDE_CODE_BS_AS_CTRL_BACKSPACE=0` opts out) **[V]**.
- **Codex** runs natively on Windows and needs ConPTY (Win10 1809+) **[V]** (learn.chatgpt.com/docs/windows/windows-sandbox). Inline mode (`--no-alt-screen`) loses history in xterm.js (#27644), so Altera leaves the alternate screen on **[V; C: `adapters/codex.rs`]**. Other known issues: ESC[?2026 leak (#35395), xterm.js+ConPTY cursor/IME (#35438), and kitty keyboard fragments leaking after exit (#24026) **[V]**. Altera does not currently write `CSI < u` on child exit. Its exit notice only turns off mouse-reporting modes **[C: `registry.ts` `maybeWriteExitNotice`]**.
- **PowerShell:** pwsh 7 is preferred, with Windows PowerShell 5.1 as the fallback, launched with `-NoLogo` **[C: `adapters/powershell.rs`]**.
- **Measured [M]:** in the running app, the interactive pwsh prompt, echo, Unicode (`日本語 ✅ 🚀`) and 20,000 lines of output were verified (`scripts/e2e/ps-basic.js`). Six concurrent sessions (3 Claude profiles, 2 Codex, 1 pwsh) each drew its TUI (`scripts/e2e/multi-agent.js`).

## 3. What is the best Windows PTY backend?

**Answer: system ConPTY through `portable-pty` 0.9. A sideloaded `conpty.dll`/`OpenConsole.exe` is a deferred option.**

- `portable-pty` 0.9.0 (source read) **[V]**:
  - Prefers a sideloaded `conpty.dll` next to the exe, else kernel32.
  - Always calls `CreatePseudoConsole` with `PSEUDOCONSOLE_INHERIT_CURSOR | RESIZE_QUIRK | WIN32_INPUT_MODE`.
  - `kill()` calls `TerminateProcess` on the direct child only.
  - Waits with `WaitForSingleObject`.
  - Does not spawn with `CREATE_SUSPENDED`.
- With `INHERIT_CURSOR`, the host must answer the cursor position request (`ESC[6n`) asynchronously or the client may hang (learn.microsoft.com/windows/console/createpseudoconsole) **[V]**. Altera answers `ESC[1;1R` from Rust whenever no view would answer it live **[C: `pty/stream.rs`]**.
- `ClosePseudoConsole` returns immediately from Win11 24H2 (26100). Earlier versions block unless output is drained. It sends `CTRL_CLOSE_EVENT` **[V]**. Altera therefore never closes the console from the reader thread. The waiter thread closes it after output goes quiet **[C: `pty/session.rs`]**.
- node-pty 1.1.0 ships `conpty.dll` + `OpenConsole.exe` (ConPTY 1.23) behind an experimental `useConptyDll` flag **[V]**. The ConPTY NuGet package `Microsoft.Windows.Console.ConPTY` is at stable 1.25.260930003, and Windows Terminal is at v1.25.2733.0 (2026-10-02) **[V]**.
- Other crates considered: `conpty` 0.7.0 and `winpty-rs` 1.0.6 **[V: versions]**. winpty is obsolete on ConPTY-capable Windows **[H]**.
- **Why not sideload yet:** the redistribution terms of the ConPTY NuGet package were not verified (see §9). The system ConPTY on build 26300 hosted every tested workload **[M]**. portable-pty already picks up a sideloaded DLL if one is placed next to the exe, so the switch costs nothing later **[V]**.

## 4. Which renderer gives practical GPU acceleration?

**Answer: xterm.js's WebGL addon, under a context budget, with the DOM renderer as fallback.**

- `WebglAddon(preserveDrawingBuffer?)` exposes `onContextLoss` and `onChangeTextureAtlas`. The README says to dispose the addon on context loss **[V]**.
- Chromium allows at most **16 active WebGL contexts per renderer process** and forcibly loses the oldest beyond that (codereview.chromium.org/14217005) **[V]**. Altera caps itself at 12 (`MAX_WEBGL`). Only visible terminals compete for the slots, the focused terminal goes first, and visible terminals beyond the cap use DOM **[C: `src/terminal/webglBudget.ts`, `registry.ts`]**.
- xterm's `RenderService` pauses rendering through IntersectionObserver when the terminal isn't intersecting the viewport. `write()` still parses (RenderService.ts L119–137) **[V: source]**. Altera relies on this for parked terminals (`display:none`).
- **Measured [M]:** the WebGL renderer string, verbatim: `ANGLE (NVIDIA, NVIDIA GeForce RTX 3050 Laptop GPU (0x000025A2) Direct3D11 vs_5_0 ps_5_0, D3D11)`, with 6 WebGL contexts active while 6 sessions were visible.
- GPU acceleration covers terminal *drawing* only. Parsing, IPC and the agents' own CPU work run on the CPU **[C]**.

## 5. Can terminal rendering and app logic share one frontend?

**Answer: yes, in one WebView2.** All panes, dialogs and every xterm instance live in one page, so there is one renderer process and one GPU process **[C]**. The costs are the 16-context WebGL limit per renderer process (handled by the budget) and the risk that terminal output triggers UI re-renders. Altera avoids the second by keeping xterm instances in a registry outside React, so terminal bytes never enter React/zustand state **[C: `registry.ts`, `store/appStore.ts` header]**. Multiple WebViews would multiply renderer processes and give up the shared GPU process **[H]**.

## 6. What do 6+ sessions cost?

Qualitative, from the code **[C]**. Measured numbers are in `docs/PERFORMANCE.md`.

| Per session | Cost |
|---|---|
| Processes | The agent's process tree (in its own Job Object), plus one ConPTY host (`conhost.exe`, system ConPTY). |
| Rust threads | `pty-read-*`, `pty-write-*` and `pty-wait-*` for the session's lifetime. One `pty-pump-*` per attached view (parked on a condvar with no timeout while idle). A transient `pty-stop-*` during a graceful stop. |
| Rust memory | One replay ring, up to `buffer_kib` (default 2048 KiB, clamped to 256–65,536). It grows on demand, so quiet sessions never allocate the full buffer. Plus a 64 KiB read buffer. |
| Frontend | One xterm `Terminal` with `scrollback` lines (default 5,000), whether parked or shown. One WebGL context while visible, within the budget of 12. |
| IPC | Coalesced binary frames (≥64 KiB or 8 ms) and batched acks (≥64 KiB or 30 ms). Nothing when idle. |
| Polling | No per-session timers. The diagnostics poll (2 s) runs only while the status bar/inspector/diagnostics panel wants it and the window is visible. |

Superset reported a ~26% renderer-memory reduction from serializing background terminals (changelog 2026-07-19) **[V: vendor changelog]**. Altera keeps parked terminals live instead, and lets users hide views to free them (ADR-007).

## 7. Buffering, backpressure and scrollback design

Inputs **[V]** (xtermjs.org/docs/guides/flowcontrol):
- Use `write(data, cb)` with high/low watermarks (HIGH 100,000 / LOW 10,000 in the guide, HIGH kept ≤ ~500K).
- xterm has a hard 50 MB write buffer, beyond which data is **discarded**.
- Throughput is 5–35 MB/s.

Tauri says events are "not designed for low latency or high throughput", with JSON payloads evaluated as JS. Channels are "designed to be fast and deliver ordered data" (v2.tauri.app/develop/calling-frontend) **[V]**. `Channel<InvokeResponseBody>` with `InvokeResponseBody::Raw` arrives as an `ArrayBuffer`, while `Channel<Vec<u8>>` serializes as a JSON number array (docs.rs tauri::ipc::Channel) **[V]**.

Design **[C]**: see ARCHITECTURE "Terminal output data flow". In short:
- The reader thread appends to a bounded ring and never blocks, so agents are never paused by the UI.
- A per-attachment pump sends coalesced raw binary frames over a Channel.
- Acks after xterm has parsed the data give flow control at 1 MiB high / 256 KiB low unacknowledged.
- A view that falls behind the ring gets RESET plus a replay from the newer half of the ring.
- Scrollback lives in xterm (`scrollback_lines`). The Rust ring is a bounded replay/copy buffer, not the scrollback.

## 8. What causes excessive CPU/RAM in comparable apps?

From the research notes **[V/H as marked]**, with Altera's countermeasure **[C]**:

| Cause | Altera's countermeasure |
|---|---|
| Rendering hidden terminals (xterm.js #880) **[V]** | Parked terminals sit under a `display:none` parking container, so IntersectionObserver pauses them. The WebGL context is released after a 400 ms grace. |
| One IPC message per chunk, plus JSON byte arrays **[V]** | 8 ms / 64 KiB coalescing, raw `ArrayBuffer` frames, batched acks. |
| Terminal data flowing through React state **[H, common pattern]** | The registry lives outside React. Panes subscribe only to coarse runtime state. |
| No backpressure: the 50 MB buffer overflows, data is lost and Ctrl+C lags **[V]** | Ack-based flow control. Input is a separate queue, so Ctrl+C isn't stuck behind output. |
| Too many live terminals (Superset, 2026-07-19) **[V]** | "Hide view" disposes the xterm instance. Rust keeps the bounded ring and replays it on Show. |
| Cursor-blink timers, ResizeObserver/fit loops, atlas rebuilds, WebGL context thrash **[H]** | Cursor blink is off by default and only blinks while focused. Fit runs at most once per animation frame plus a 50 ms trailing fit. The WebGL allocator is stable: holders keep their slot. |
| Binary IPC on Windows ~200 ms per 10 MB vs ~5 ms on macOS (tauri discussion #11915) **[H: anecdote, measure]** | Not measured in isolation. See Unresolved. |
| Possible GDI handle growth (Zebar #264) **[H]** | Not soak-tested. See Unresolved. |

## 9. Which GPU features are supported on the target?

- WebGL2 is available through ANGLE on Direct3D 11 (`vs_5_0`/`ps_5_0`) on the RTX 3050 Laptop GPU **[M]**. `WEBGL_debug_renderer_info` exposes the unmasked renderer. Altera probes it once and frees the probe context immediately with `WEBGL_lose_context`, so the probe never occupies one of the 16 slots **[C]**.
- 6 simultaneous WebGL contexts were confirmed in the app **[M]**. The budget allows 12 **[C]**.
- On a hybrid laptop, Windows decides which GPU WebView2 uses (Settings > System > Display > Graphics). On this machine it reported the NVIDIA dGPU **[M]**. Altera does not pick a GPU itself **[C]**.
- Context loss is handled: the addon is disposed, the terminal falls back to DOM, WebGL is retried after 3 s while visible, and the terminal gives up after 3 losses. `window.__alteraForceContextLoss()` exists to exercise this path **[C]**.

## 10. Licensing and distribution

- **Licenses [V]:** Tauri Apache-2.0 OR MIT; xterm.js MIT; portable-pty MIT; windows-sys MIT/Apache-2.0; React/Vite MIT; TypeScript Apache-2.0; alacritty_terminal Apache-2.0 (not used). All are compatible with closed or open distribution, given attribution.
- **Claude Squad is AGPL-3.0:** reference only. No code was reused **[V]**.
- **WebView2:** preinstalled on Windows 11. Altera's NSIS bundle uses `webviewInstallMode: embedBootstrapper` (~1.8 MB), so machines without the runtime can install it, and `installMode: currentUser` **[C: `src-tauri/tauri.conf.json`; V: sizes]**. MSI would need WiX v3 + the VBSCRIPT feature, so NSIS is the recommended target **[V]**.
- **ConPTY NuGet (`Microsoft.Windows.Console.ConPTY`) redistribution terms: not verified.** This must be checked before sideloading `conpty.dll`/`OpenConsole.exe` **[H/open]**.

## 11. Existing multi-agent managers

| Product | Stack / license | Notes |
|---|---|---|
| Claude Squad | Go TUI, AGPL-3.0 | tmux + git worktrees. Reference only. |
| Crystal | Electron, MIT | Dormant; continued as Nimbalyst. |
| vibe-kanban | Rust + web, Apache-2.0 | Kanban-style agent orchestration. |
| Wave Terminal | Go + Electron, Apache-2.0 | General terminal with blocks. |
| Terax | Tauri 2 + portable-pty + xterm.js WebGL + CodeMirror, Apache-2.0 | The app Altera replaces (scriptbyai.com/terax-ai-dev-workspace). Same base stack. |
| Termexo | Windows | Claude + Codex manager. |
| Superset | — | Serializes background terminals (changelog 2026-07-19). |

Sources: terminal-stack research notes **[V for licenses/stacks as listed there]**.

## 12. Running several Claude accounts and Codex side by side

- **`CLAUDE_CONFIG_DIR`** overrides the configuration directory: "All settings, session history, and plugins are stored under this path ... Useful for running multiple accounts side by side" (code.claude.com/docs/en/env-vars) **[V]**. Each config dir "has its own settings, session history, and claude.ai login or API key" (code.claude.com/docs/en/authentication) **[V]**. The exception: Claude Console sign-ins without an API key are stored outside, under `%APPDATA%\Anthropic` **[V]**.
- Isolated per profile: `settings.json`, `.credentials.json`, `.claude.json` (in `%USERPROFILE%` without the variable, in `$CLAUDE_CONFIG_DIR` with it; code.claude.com/docs/en/claude-directory), `projects/<cwd>/<session>.jsonl`, `history.jsonl`, plugins, skills, file-history, sessions and daemon files **[V]**.
- Credential precedence **[V]**:
  1. `CLAUDE_CODE_USE_BEDROCK`/`VERTEX`/`FOUNDRY`
  2. `ANTHROPIC_AUTH_TOKEN`
  3. `ANTHROPIC_API_KEY`
  4. `apiKeyHelper`
  5. `CLAUDE_CODE_OAUTH_TOKEN`
  6. `ANTHROPIC_PROFILE`
  7. Subscription OAuth

  Any of 2–6 inherited by the app would make every profile authenticate as that one identity. Altera removes them for every Claude session **[C: `CLAUDE_IDENTITY_ENV`]**. The Bedrock/Vertex/Foundry switches are not removed.
- `claude auth status --json` exits 0 when logged in and 1 when not. Its fields are `loggedIn`, `authMethod`, `apiProvider`, `configDirectory`, `projectsDirectory`, `email`, `orgId`, `orgName` and `subscriptionType`, with no tokens (code.claude.com/docs/en/cli-reference) **[V]**. Side effect: on a non-existent directory it creates `.claude.json` + `backups/`, so Altera only probes existing directories **[V; C]**.
- **Measured [M]:** `~/.claude`, `~/.claude-account1` and `~/.claude-account2` each hold their own credentials. `claude auth status --json` reported all three logged in (`authMethod: claude.ai`) as three distinct accounts, and no credential file was read. In the app, each Claude profile pane showed its own account/model, and one showed Claude's "trust this folder" prompt, consistent with per-profile state.
- Claude flags (2.1.302 help) **[V]**: `-c/--continue`, `-r/--resume [id]`, `--session-id <uuid>`, `--fork-session`, `-n/--name`, `--add-dir`. There is no `--cwd` (the ConPTY cwd is used). `--resume` searches project + worktrees, then all projects, within one config dir. Using the same session in two terminals interleaves transcripts.
- Windows: the native `%USERPROFILE%\.local\bin\claude.exe` is preferred over the npm `claude.cmd` shim **[V; C: `adapters/claude.rs`]**.
- **Codex [V]:**
  - `CODEX_HOME` (default `~/.codex`) must exist if set.
  - The auth store is set by `cli_auth_credentials_store` = file|keyring|auto|ephemeral.
  - `codex login status` exits 0/1. `codex doctor --json` produces a redacted report.
  - Resume and fork: `codex resume [SESSION_ID] [--last] [--all]`, `codex fork`.
  - Other flags: `--no-alt-screen`, `--no-daemon`, `-C/--cd`.
  - `--last` is filtered by cwd.
  - Codex has no way to choose a conversation id up front **[V: flag list; consequence C]**.
- Known Claude issues **[V: issue tracker state at research time]**:
  - **#91708 (open):** the same profile in two concurrent processes races on OAuth refresh, which forces a re-login. Altera warns about this in the New Session dialog.
  - **#101027 (open, Windows):** `claude.exe` can outlive ConPTY when a pane closes, so the process tree must be killed explicitly. Altera's Job Objects cover this.
  - Closed NOT_PLANNED: #30230 (both CLAUDE.md files loaded), #34800/#4739 (IDE lock files in `~/.claude/ide`), #15071 (plugin paths), #81278.
  - `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` strips `CLAUDE_CONFIG_DIR` from child tools.
- **Found in testing [M]:** when Altera was launched from inside a Claude Code session, inherited `CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_MESSAGING_TOKEN` and similar variables leaked into children, and `claude` reported "Transcript saving is off". These variables are now stripped for **all** sessions **[C: `adapters::inherited_agent_session_vars`]**.

---

## Verified vs hypothesis

**Verified (primary source or measured):**
- Tauri: WebView2 evergreen/preinstalled; installer modes and sizes; Channel vs event semantics; raw `ArrayBuffer` delivery of `InvokeResponseBody::Raw`.
- xterm.js 6: renderer set and new features; IntersectionObserver render pause; flow-control guide numbers; 50 MB discard limit.
- Chromium: 16-context WebGL limit.
- portable-pty 0.9: creation flags, sideload preference, kill semantics, no `CREATE_SUSPENDED`.
- ConPTY: CPR requirement under `INHERIT_CURSOR`; `ClosePseudoConsole` behaviour by build; Job Object `KILL_ON_JOB_CLOSE` semantics.
- Claude: `CLAUDE_CONFIG_DIR` isolation, credential precedence, `auth status` fields and exit codes, flags, fullscreen repaint variable.
- Codex: flags, `CODEX_HOME`, ConPTY requirement, listed issues.
- Licenses of all listed dependencies and products.
- **Measured on this machine:** hardware/software versions; pwsh/Unicode/20k-line output; 6 concurrent agent sessions as separate processes; per-profile account isolation; WebGL renderer string and 6 contexts; no orphaned agent processes after restart; restore re-launching 10 sessions; Claude resume via pinned ids with `--session-id` fallback; the three issues in §12 and below.

**Hypothesis / anecdotal / not reproduced here:**
- Windows binary IPC cost of ~200 ms per 10 MB (tauri #11915).
- GDI handle growth (Zebar #264).
- Tauri-vs-Electron RAM figures from blogs (Better Stack, levminer.com). tauri#5889 is one reporter's measurement.
- The effort estimate for a Rust-native UI. "Multiple WebViews cost more" is inferred, not measured.
- winpty being obsolete here.

## Unresolved uncertainties

1. **Binary IPC throughput on Windows** (#11915). 20,000 lines rendered correctly, but a sustained 10 MB+ transfer has not been timed in isolation. Bench mode exists for this (`ALTERA_BENCH`, see README); results belong in `docs/PERFORMANCE.md`.
2. **GDI / handle growth over long runs** (Zebar #264): no multi-hour soak test yet.
3. **ConPTY NuGet redistribution terms:** unverified. This blocks sideloading `conpty.dll`/`OpenConsole.exe`.
4. **Codex 1-of-6 silent start:** one of six simultaneously launched Codex 0.162 instances produced no output at all. It did not reproduce with 3 simultaneous Codex alone (`scripts/e2e/codex-race.js`), and the root cause is unknown. It is mitigated, not fixed: same-agent launches are staggered (claude 350 ms, codex 600 ms), and a 12 s no-output hint offers Restart.
5. **Job Object pre-assignment race:** portable-pty doesn't use `CREATE_SUSPENDED`, so a child that spawns a grandchild in the first microseconds, before `AssignProcessToJobObject`, could escape the job. This hasn't been observed with shells or agent CLIs.
6. **#101027 (`claude.exe` outliving ConPTY):** the Job Object should cover it (KILL_ON_JOB_CLOSE plus explicit `TerminateJobObject`). "No orphans after restart" was observed **[M]**, but this specific issue wasn't reproduced and then checked.
7. **Claude profile leaks** that upstream won't fix (#30230 both CLAUDE.md files, #34800/#4739 IDE lock files, #15071 plugin paths) may still apply under `CLAUDE_CONFIG_DIR`. Not tested.
8. **Diagnostics attribution of the ConPTY host:** with system ConPTY, `conhost.exe` is started by `CreatePseudoConsole` in the context of `altera.exe`. It is outside the session's Job and not a descendant of the session root. The in-app snapshot counts host = `altera.exe` only, webview = `msedgewebview2.exe` descendants, sessions = root trees, so conhost appears in none of the three. `scripts/bench/sample.ps1` reports it as a separate "console" category. This is a reading of the code and has not been measured.
9. **Electron vs Tauri RAM** was not measured on this machine. Only third-party numbers exist.
10. **Shift+Enter in Claude on Windows** depends on Claude's kitty-protocol allowlist (#92771). `TERM_PROGRAM=Altera` is not on it.

---

## Sources

**Tauri**
- https://v2.tauri.app/reference/webview-versions/
- https://v2.tauri.app/distribute/windows-installer/
- https://v2.tauri.app/develop/calling-frontend/
- https://docs.rs/tauri/latest/tauri/ipc/struct.Channel.html
- https://github.com/tauri-apps/tauri/issues/5889 (Tauri vs Electron RAM)
- tauri-apps/tauri discussion #11915 (binary IPC timing on Windows; anecdotal)
- Zebar issue #264 (possible GDI growth; anecdotal)
- Better Stack and levminer.com Tauri-vs-Electron comparisons (non-scientific; cited in the notes without URLs)

**xterm.js / Chromium**
- https://github.com/xtermjs/xterm.js/releases/tag/6.0.0
- https://xtermjs.org/docs/guides/flowcontrol/
- xterm.js `src/browser/services/RenderService.ts` L119–137 (IntersectionObserver pause)
- xterm.js issue #880 (hidden terminals rendering)
- https://codereview.chromium.org/14217005/ (16 WebGL contexts per renderer)

**ConPTY / Win32**
- https://learn.microsoft.com/windows/console/createpseudoconsole
- https://learn.microsoft.com/en-us/windows/console/closepseudoconsole
- https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_limit_information
- NuGet `Microsoft.Windows.Console.ConPTY` 1.25.260930003; Windows Terminal v1.25.2733.0 (2026-10-02)
- crates.io: portable-pty 0.9.0, conpty 0.7.0, winpty-rs 1.0.6, alacritty_terminal 0.26.0, vt100 0.16.2, egui 0.37, iced 0.14, gpui 0.2.2, windows 0.62.2 / windows-sys 0.61.2
- npm: node-pty 1.1.0, electron 44.9.0

**Alternatives / ecosystem**
- https://github.com/ghostty-org/ghostty/discussions/12290
- https://www.scriptbyai.com/terax-ai-dev-workspace/ (Terax)
- Superset changelog, 2026-07-19 (background-terminal serialization)
- NuGet CI feed `CI.Microsoft.Terminal.Wpf`; LibGhostty.Net 1.0.2

**Claude Code**
- https://code.claude.com/docs/en/env-vars
- https://code.claude.com/docs/en/authentication
- https://code.claude.com/docs/en/claude-directory
- https://code.claude.com/docs/en/cli-reference
- https://code.claude.com/docs/en/fullscreen
- Claude Code issues: #30230, #34800, #4739, #15071, #81278 (closed NOT_PLANNED); #91708, #101027 (open); #92771 (Shift+Enter / kitty); #94873 (TERM_PROGRAM spoofing)

**Codex CLI**
- https://learn.chatgpt.com/docs/config-file/environment-variables (developers.openai.com/codex now 308-redirects here)
- https://learn.chatgpt.com/docs/auth
- https://learn.chatgpt.com/docs/windows/windows-sandbox
- openai/codex issues: #35395, #35438, #27644, #24026
