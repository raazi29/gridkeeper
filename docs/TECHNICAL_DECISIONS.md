# Gridkeeper — Technical Decisions

These are short architecture decision records (ADRs). Each one gives the context, the decision, the alternatives considered and the consequences, and points to the code that implements it. Evidence tags follow [RESEARCH.md](RESEARCH.md): [V] verified source, [H] hypothesis, [M] measured on the target machine.

| # | Decision |
|---|---|
| 001 | [Tauri 2 over Electron and WinUI 3](#adr-001-tauri-2-over-electron-and-winui-3) |
| 002 | [xterm.js over a native renderer](#adr-002-xtermjs-over-a-native-renderer) |
| 003 | [portable-pty on the system ConPTY (no sideloaded conpty.dll yet)](#adr-003-portable-pty-on-the-system-conpty-no-sideloaded-conptydll-yet) |
| 004 | [Raw binary Channel frames over events/JSON](#adr-004-raw-binary-channel-frames-over-eventsjson) |
| 005 | [Ring buffer + ack flow control that never blocks the child](#adr-005-ring-buffer--ack-flow-control-that-never-blocks-the-child) |
| 006 | [WebGL context budget with DOM fallback](#adr-006-webgl-context-budget-with-dom-fallback) |
| 007 | [Keep parked terminals parsing instead of serializing them](#adr-007-keep-parked-terminals-parsing-instead-of-serializing-them) |
| 008 | [Per-session OS threads instead of an async runtime](#adr-008-per-session-os-threads-instead-of-an-async-runtime) |
| 009 | [One Job Object per session](#adr-009-one-job-object-per-session) |
| 010 | [Claude profiles via CLAUDE_CONFIG_DIR + identity env stripping](#adr-010-claude-profiles-via-claude_config_dir--identity-env-stripping) |
| 011 | [Pin Claude conversations with --session-id, fall back when no transcript exists](#adr-011-pin-claude-conversations-with---session-id-fall-back-when-no-transcript-exists) |
| 012 | [Codex picker for panes sharing a folder](#adr-012-codex-picker-for-panes-sharing-a-folder) |
| 013 | [Stagger same-agent launches + no-output watchdog](#adr-013-stagger-same-agent-launches--no-output-watchdog) |
| 014 | [Keybinding policy: never bind terminal-critical keys](#adr-014-keybinding-policy-never-bind-terminal-critical-keys) |
| 015 | [Persistence format: versioned JSON, atomic, never destructive](#adr-015-persistence-format-versioned-json-atomic-never-destructive) |
| 016 | [Diagnostics via Toolhelp instead of sysinfo per-process](#adr-016-diagnostics-via-toolhelp-instead-of-sysinfo-per-process) |
| 017 | [panic = "unwind" in release](#adr-017-panic--unwind-in-release) |
| 018 | [No telemetry](#adr-018-no-telemetry) |
| 019 | [Browser panes: sandboxed iframes in a persistent layer + pop-out windows, no child webviews](#adr-019-browser-panes-sandboxed-iframes-in-a-persistent-layer--pop-out-windows-no-child-webviews) |
| 020 | [Native browser panes on Windows: one child webview per pane, iframes as the fallback](#adr-020-native-browser-panes-on-windows-one-child-webview-per-pane-iframes-as-the-fallback) |
| 020 | [Merge assistant: the first git write operation](#adr-020-merge-assistant-the-first-git-write-operation) |
| 021 | [Test runs: contained background processes, evidence pinned to a commit](#adr-021-test-runs-contained-background-processes-evidence-pinned-to-a-commit) |

---

## ADR-001: Tauri 2 over Electron and WinUI 3

**Context.** The app has to be a lightweight Windows desktop app that hosts many terminals. It needs native access to ConPTY, Job Objects and process diagnostics, and a good terminal renderer.

**Decision.** Tauri 2.12 with a Rust backend. The UI is React 19 + TypeScript in the system WebView2. The installer is NSIS with `webviewInstallMode: embedBootstrapper` and `installMode: currentUser` (`src-tauri/tauri.conf.json`).

**Alternatives.**
- **Electron:** mature node-pty, but it bundles Chromium and Node, and idle RAM on Windows is not clearly better or worse than Tauri (tauri#5889: 399 vs 318 MB for one app on Windows 10) [V/H].
- **WinUI 3/C#:** no supported terminal control (the WPF control exists only on the NuGet CI feed; `TermControl` embedding is undocumented) [V].
- **Rust-native UI:** see ADR-002.

**Consequences.**
- Small installer and no Node runtime.
- Win32 is called directly from Rust through `windows-sys`.
- The app depends on the WebView2 runtime (evergreen, preinstalled on Windows 11) and inherits Chromium's limits, notably 16 WebGL contexts per renderer process.
- Idle RAM is dominated by WebView2, as it would be with Electron's Chromium.

## ADR-002: xterm.js over a native renderer

**Context.** The renderer has to host PowerShell and two complex TUIs (Claude Code, Codex) correctly: Unicode, IME, selection, links, search, alt screen and mouse modes.

**Decision.** `@xterm/xterm` 6 with the fit, search, unicode11, web-links and webgl addons. It runs in the same WebView as the app UI (`src/terminal/registry.ts`).

**Alternatives.**
- **`alacritty_terminal` + egui/iced/gpui:** Apache-2.0 and fast, but shaping, selection, IME, accessibility, links and search would all have to be built by hand [H].
- **libghostty:** no official Windows build, and the VT library is unstable [V].
- **wezterm-term:** not published on crates.io [V].

**Consequences.**
- Proven compatibility: Claude Code and Codex document xterm.js-specific behaviour, and Codex's inline-mode issue #27644 is why the alt screen stays on.
- One frontend for UI and terminals.
- Rendering and parsing share the WebView's main thread. Heavy output in one terminal competes with UI work, which is why output is coalesced and flow-controlled (ADR-004, ADR-005).
- A native renderer remains the long-term option if WebView overhead becomes the bottleneck.

## ADR-003: portable-pty on the system ConPTY (no sideloaded conpty.dll yet)

**Context.** Agents need a real Windows pseudoconsole. Options were portable-pty, the `conpty` crate, winpty, or sideloading the newer `conpty.dll`/`OpenConsole.exe` from the ConPTY NuGet package (as node-pty's experimental `useConptyDll` does).

**Decision.** `portable-pty` 0.9 using the in-box ConPTY (`kernel32`).

**Alternatives.**
- **Sideloaded ConPTY 1.25:** newer fixes, but the NuGet redistribution terms are **unverified** [open].
- **winpty:** obsolete on ConPTY-capable Windows [H].
- **Raw `CreatePseudoConsole`:** more code for the same result.

**Consequences.**
- portable-pty always passes `PSEUDOCONSOLE_INHERIT_CURSOR`, so the host must answer `ESC[6n`. Gridkeeper answers from Rust when no view will (ADR-005).
- `kill()` only terminates the direct child, so tree cleanup is done with Job Objects (ADR-009).
- `ClosePseudoConsole` may block before Windows 11 24H2, so it is called from the waiter thread after output goes quiet, never from the reader.
- Sideloading later costs nothing: portable-pty already prefers a `conpty.dll` placed next to the exe [V].
- Measured: every tested workload ran correctly on build 26300 [M].

## ADR-004: Raw binary Channel frames over events/JSON

**Context.** Terminal output is high-volume binary data. Tauri events are "not designed for low latency or high throughput" and evaluate JSON payloads as JS. `Channel<Vec<u8>>` serializes as a JSON number array [V].

**Decision.**
- Each attachment gets its own `tauri::ipc::Channel<InvokeResponseBody>`.
- Every message is `InvokeResponseBody::Raw` (arriving as an `ArrayBuffer`), and its first byte is the frame type: `DATA = 0` followed by raw bytes, or `RESET = 1` (`types.rs::frame`).
- The pump coalesces output, flushing at ≥ `FLUSH_BYTES` (64 KiB) or `FLUSH_DELAY` (8 ms), with at most `MAX_FRAME` (64 KiB) per frame (`pty/stream.rs`).
- Low-rate state changes still use one event, `session-state`.

**Alternatives.** Per-chunk events (high overhead), base64 strings (+33% size plus encode/decode), and JSON byte arrays (≈3–4× size).

**Consequences.**
- One IPC message per ~8 ms burst per session.
- Ordering is guaranteed by the Channel.
- The frontend must check the attach generation and ignore stale channels.
- Windows binary-IPC throughput (anecdotally ~200 ms per 10 MB, #11915) has not been isolated yet [H].

## ADR-005: Ring buffer + ack flow control that never blocks the child

**Context.**
- xterm.js discards data beyond a 50 MB write buffer and recommends watermarks [V].
- Blocking the PTY reader would pause the agent, which is unacceptable for long-running AI sessions.
- Views can be hidden, detached or slow.

**Decision.**
- The reader thread appends to a bounded byte ring with absolute `u64` offsets (`pty/ring.rs`, size `buffer_kib`, default 2 MiB) and **never waits**.
- A per-attachment pump sends from the ring and counts unacknowledged DATA payload bytes. It stops at `HIGH_WATER` (1 MiB) and resumes at `LOW_WATER` (256 KiB).
- The frontend acks only after xterm has parsed the bytes, batched by `AckBatcher` (64 KiB / 30 ms).
- If a view falls behind the ring, it gets one RESET and a replay from the newer half of the ring. Cursor-position requests in bytes that won't be delivered live are answered by Rust (`ESC[1;1R`).
- Replayed bytes have terminal queries stripped (`text::filter_queries`).

**Alternatives.**
- **Blocking backpressure to the child:** pauses agents.
- **Unbounded buffering:** memory grows without limit and the 50 MB xterm discard still applies.
- **Dropping without RESET:** corrupts terminal state.

**Consequences.**
- Agents always run at full speed, and Rust memory per session is bounded.
- A view that is far behind loses intermediate output, but its screen is consistent after the RESET.
- Scrollback older than the ring can't be replayed to a newly created view.
- The CPR handling must keep its "answered exactly once" invariant; it is unit-tested in `stream.rs`.

## ADR-006: WebGL context budget with DOM fallback

**Context.** Chromium allows 16 live WebGL contexts per renderer process and silently kills the oldest beyond that [V]. Gridkeeper may show more than 16 terminals across groups.

**Decision.**
- `MAX_WEBGL = 12` (`src/terminal/webglBudget.ts`). Only shown terminals compete for slots.
- The allocation is stable: holders keep their slot, and free slots go to the focused terminal first, then the most recently shown.
- A context is kept for 400 ms after a terminal stops being shown, to absorb layout reshuffles.
- Other terminals use the DOM renderer.
- On context loss: DOM fallback, retry after 3 s, give up after 3 losses.
- Settings → Renderer offers Auto / WebGL / DOM.

**Alternatives.**
- **WebGL for every terminal:** contexts get force-lost unpredictably.
- **DOM only:** no GPU acceleration.
- **Canvas renderer:** removed in xterm 6 [V].

**Consequences.**
- GPU rendering for everything on screen in realistic layouts. Measured: 6 WebGL contexts on the RTX 3050 via ANGLE/D3D11 [M].
- The 4 spare slots leave headroom for other WebGL users in the page and for transitions.
- More than 12 simultaneously visible terminals fall back to DOM for the extra ones.

## ADR-007: Keep parked terminals parsing instead of serializing them

**Context.** Terminals in inactive groups or unmounted panes must not cost rendering time. Superset serializes background terminals for ~26% renderer-memory savings [V], but serialize/restore loses exact state (modes, alt screen, cursor) and costs CPU on every switch.

**Decision.**
- Unmounted terminals are reparented into a `display:none` parking container. xterm keeps parsing, and its IntersectionObserver pauses rendering [V].
- Their WebGL context is released after the grace period (ADR-006).
- Users can **Hide view** to free a terminal entirely: `disposeTerminal` + `session_detach`. Rust keeps the process and the bounded ring, and Show replays the ring.

**Alternatives.**
- **Serialize** (`addon-serialize`) and dispose background terminals.
- **Dispose and replay automatically** on every group switch.

**Consequences.**
- Switching groups is instant and exact.
- A parked terminal still costs its scrollback memory and parse CPU while output arrives.
- Hidden views trade exact scrollback for memory: replay starts at the ring's boundary.

## ADR-008: Per-session OS threads instead of an async runtime

**Context.** Each session needs to do blocking reads from a pipe, blocking writes, a blocking wait for process exit, and paced frame sending. portable-pty exposes blocking `Read`/`Write`.

**Decision.**
- Each session gets named OS threads: `pty-read`, `pty-write` and `pty-wait`, plus one `pty-pump` per attachment and a transient `pty-stop`.
- They communicate through `parking_lot` mutexes and condvars and an mpsc input queue.
- Idle pumps wait on a condvar with no timeout, so there are zero periodic wake-ups.
- Tauri's tokio runtime is used only for async commands and `spawn_blocking`.

**Alternatives.**
- **tokio with `spawn_blocking` around blocking I/O:** the same threads, plus complexity.
- **Overlapped I/O / IOCP:** portable-pty doesn't expose it.
- **One shared pump thread:** a slow `Channel::send` for one session would delay every other session.

**Consequences.**
- Simple, isolated and testable (`SessionCore` has no `AppHandle`).
- About 4 threads per attached session, which is fine for tens of sessions.
- A panic is contained per thread (ADR-017).

## ADR-009: One Job Object per session

**Context.** Agents spawn deep trees (node, git, MCP servers). portable-pty's `kill()` terminates only the direct child. Claude Code #101027 reports that `claude.exe` can outlive ConPTY on Windows [V]. Closing a pane, or quitting the app, must not leave orphans.

**Decision.** After spawn, the root pid is assigned to a new Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` and no breakaway flags (`pty/job.rs`).
- Force stop calls `TerminateJobObject`.
- After the root exits, leftovers get 2 s and then the job is terminated.
- When the app exits or crashes, the job handles close and the kernel kills the trees.

**Alternatives.**
- **Walking the process tree with Toolhelp and killing pids:** racy and misses re-parented processes.
- **One job for all sessions:** can't stop a single session.
- **`taskkill /T`:** an external process, and racy.

**Consequences.** Exactly one session's tree is killed, never unrelated processes. Measured: no orphaned agent processes after an app restart [M]. Known gap: there is no `CREATE_SUSPENDED`, so a grandchild spawned before the assignment could escape. This hasn't been observed.

## ADR-010: Claude profiles via CLAUDE_CONFIG_DIR + identity env stripping

**Context.** The user runs several Claude accounts at once. Claude Code officially supports one config directory per account via `CLAUDE_CONFIG_DIR` [V]. Environment credentials (`ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_PROFILE`) outrank the per-directory login [V]. When Gridkeeper itself was launched from a Claude Code session, the parent's session variables leaked into children and broke transcript saving [M].

**Decision.**
- A profile is a name plus an optional directory (`profiles.rs`). The Default profile **removes** `CLAUDE_CONFIG_DIR`; other profiles set it.
- `CLAUDE_IDENTITY_ENV` is removed for every Claude session.
- `inherited_agent_session_vars` (`CLAUDECODE`, `CLAUDE_PID`, `CLAUDE_CODE_SESSION_*`, `CLAUDE_CODE_MESSAGING_*`, …) is removed for **every** session.
- Login state is checked with `claude auth status --json`, only for existing directories. Credentials are never read or copied. Signing in uses `/login` inside Claude.

**Alternatives.**
- **Copying or swapping credential files:** dangerous and violates the no-credential-access rule.
- **API keys per profile:** secrets in Gridkeeper's config.
- **Separate Windows user accounts:** heavy.

**Consequences.**
- Each pane runs under its own account. Measured: three profiles showed three distinct accounts concurrently [M].
- Two live sessions on the same profile can race on OAuth refresh (#91708), and the UI warns about it.
- Upstream leaks that won't be fixed (#30230, #34800, #15071) may still apply.
- The user's per-session `env` can deliberately re-add a variable, but secret-looking keys are not persisted.

## ADR-011: Pin Claude conversations with --session-id, fall back when no transcript exists

**Context.**
- `claude --continue` resumes the most recent conversation in the cwd. With several Claude panes in one folder, they would all resume the same conversation.
- Claude accepts `--session-id <uuid>` for a new conversation and `--resume <id>` for an existing one [V].
- A pane may never have written a transcript, for example if it was closed before the first message, or its profile changed.

**Decision.**
- Every new Claude session gets a random UUID, launched with `--session-id <uuid>` and stored as `SessionMeta.agentSessionId`.
- On restore or restart with "Continue", the frontend sends `ResumeMode::Session{id}`. The Rust adapter checks whether `<config root>/projects/*/<id>.jsonl` exists (directory listing only), then uses `--resume <id>` if it does and `--session-id <id>` if it doesn't (`adapters/claude.rs`).
- "Restart (fresh)" generates a new id.

**Alternatives.**
- **`--continue`:** ambiguous across panes.
- **Parsing transcripts to find "the right" one:** reads private data.
- **Always `--resume <id>`:** errors when no transcript exists.

**Consequences.**
- Each pane deterministically owns its conversation. Measured: restored Claude panes resumed their pinned ids, with the `--session-id` fallback when no transcript existed [M].
- The check is per profile: a transcript under another config dir isn't found, by design.

## ADR-012: Codex picker for panes sharing a folder

**Context.** Codex can't take a conversation id up front, and `codex resume --last` is filtered by cwd [V]. Restoring several Codex panes in the same folder with `--last` would resume the **same** conversation in all of them [M: found in testing].

**Decision.**
- In `restoreSessions` (`src/actions/sessions.ts`), restored Codex panes with `resumeOnRestore: continue` are counted per cwd (case-insensitive).
- If more than one shares a cwd, each of them starts with `ResumeMode::Pick` → `codex resume`, Codex's interactive picker.
- A lone Codex pane in its folder keeps `resume --last`.

**Alternatives.**
- **Scraping Codex's session store for ids:** reads private data and the format is unstable.
- **Always starting fresh:** loses context.
- **Always the picker:** an extra step even when it is unambiguous.

**Consequences.** No silent conversation sharing. The user picks once per ambiguous pane. When Codex gains an id-pinning flag, it should be adopted the same way as ADR-011.

## ADR-013: Stagger same-agent launches + no-output watchdog

**Context.** Measured: one of six simultaneously launched Codex 0.162 instances produced no output at all. It didn't reproduce with three alone (`scripts/e2e/codex-race.js`) [M]. The likely cause is contention on shared per-user state (update checks, daemons, config files) [H].

**Decision.**
- `LAUNCH_GAP_MS` in `actions/sessions.ts` spaces out launches of the same agent kind: claude 350 ms, codex 600 ms, PowerShell and generic 0 ms. Different kinds still start in parallel.
- Workspace restore adds 120 ms between launches.
- `SilentHint` (`layout/Pane.tsx`) shows "No output for 12 s — the program may be stuck · Restart" when a running session has `bytesOut === 0` after `SILENT_MS` (12 s). The reader emits one extra `session-state` event on the first output byte, so the hint clears.

**Alternatives.** Serializing all launches (slow restores), retrying automatically (could double-start an agent that is merely slow), or ignoring the problem.

**Consequences.** Restoring 6 Codex panes takes about 3 s longer. The root cause is still unknown (RESEARCH, Unresolved #4). The watchdog is a hint, not an automatic action.

## ADR-014: Keybinding policy: never bind terminal-critical keys

**Context.** Shells, readline, TUIs and coding agents rely on Ctrl+letter, Alt+letter, function keys, arrows, Ctrl+arrows and more. App shortcuts that steal them break the agents.

**Decision.**
- Defaults use only Ctrl+Shift+…, Ctrl+Tab, Ctrl+, and Alt+digit (`DEFAULT_BINDINGS` in `src/keybindings/combo.ts`).
- `forbiddenReason` rejects:
  - function keys;
  - combos without Ctrl or Alt;
  - Ctrl+Alt (AltGr);
  - Windows-key combos;
  - Alt+letter and Alt+shell keys;
  - Ctrl+letter and Ctrl+`[ ] \ / @ ^ _ space`;
  - Ctrl+arrows, Backspace, Delete, Home, End, Enter, Escape;
  - Ctrl+Shift+C/V.
- User overrides that are forbidden are ignored. One capture-phase listener runs commands, and xterm's key handler skips exactly the bound combos.

**Alternatives.** VS Code-style bindings (Ctrl+P, Ctrl+W, …) would collide with readline and agents. A "prefix key" scheme like tmux is unfamiliar on Windows.

**Consequences.** Terminal apps receive every key they expect. Ctrl+C with a selection copies; otherwise it sends `^C`. Some commands are palette-only by default.

## ADR-015: Persistence format: versioned JSON, atomic, never destructive

**Context.** Workspace state must survive crashes, hand edits, older and newer app versions, and antivirus locking. It must never contain secrets.

**Decision.** `workspaces.json` and `profiles.json` are pretty-printed JSON with a `version` field (`STATE_VERSION = 1`) (`persistence.rs`).
- **Migrate on load.** A file written by a newer version is loaded best-effort and the store becomes **read-only**.
- **Damaged files are kept.** Unparseable files are renamed to `*.corrupt-<ts>.json`, and lossy loads keep a copy under that name.
- **Sanitize** ids, references and settings ranges, and strip secret-looking env keys.
- **Atomic write:** tmp + fsync + one `.bak` + rename, with retries on `PermissionDenied`.
- The frontend saves with a 400 ms debounce and flushes on unload.

**Alternatives.** SQLite (overkill, and not hand-editable), the Tauri store plugin (less control over atomicity and migration), and `localStorage` (lives inside the WebView profile and is easy to lose).

**Consequences.** Human-readable and diffable. Data is never silently lost, and future schema changes have a clear migration hook. The whole state is rewritten on each save, which is fine at this size.

## ADR-016: Diagnostics via Toolhelp instead of sysinfo per-process

**Context.** The status bar shows the app's own usage against the agents' usage every 2 s. sysinfo's per-process refresh walks all processes (Toolhelp) and queries each one, which doubles the cost when we also need the parent/child tree.

**Decision.**
- One `CreateToolhelp32Snapshot` pass for pid, parent pid and name. Then `OpenProcess` + `GetProcessTimes` + `GetProcessMemoryInfo` run only for the processes being reported: host, WebView2 descendants and session trees (`diagnostics.rs`).
- PID reuse is guarded by comparing creation times.
- sysinfo is kept for system memory, core count and CPU brand.
- Polling runs only while needed and while the window is visible.

**Alternatives.** sysinfo for everything (about 2× cost), WMI (slow), PDH counters (complex; used only by the external `scripts/bench/sample.ps1`).

**Consequences.**
- The code comment records ~6–7 ms per snapshot for ~400 processes in a release build.
- Attribution covers host, webview and session trees. The ConPTY `conhost.exe` falls outside all three buckets (ARCHITECTURE §13). The bench script counts it separately.

## ADR-017: panic = "unwind" in release

**Context.** A panic in one session's thread (reader, pump, waiter) must not kill the app and every other session. `panic = "abort"` would make every panic fatal.

**Decision.**
- Release profile: `panic = "unwind"` (`src-tauri/Cargo.toml`).
- Every per-session thread runs inside `catch_unwind` (`spawn_guarded`), with drop guards that mark EOF or exit so the session state stays consistent.
- The state-event listener is wrapped as well.
- Other release settings: `lto = true`, `codegen-units = 1`, `strip = true`.

**Alternatives.** `abort` (smaller binary, but one bug takes down every session), or process isolation per session (heavy).

**Consequences.** A slightly larger binary. Panics are logged with their message, and the affected session shows Exited or Failed instead of the app crashing.

## ADR-018: No telemetry

**Context.** The app hosts private source code and AI conversations for a single developer.

**Decision.**
- No analytics, crash reporting or update pings. The app makes no network requests of its own. The single, user-initiated exception is the browser-pane probe (ADR-019): opening an http(s) address in a pane fetches that same address once with `curl.exe` to check whether it may be framed.
- Logs and diagnostics bundles stay local under `%APPDATA%\app.gridkeeper.desktop`, are redacted, and are shared only if the user sends them.

**Alternatives.** Opt-in telemetry or crash reporting would add a network surface and a privacy policy for little benefit to a single-user tool.

**Consequences.** Problems are diagnosed from user-exported bundles (`Diagnostics → Export`) and log files. There is no field data on crashes.

## ADR-019: Browser panes: sandboxed iframes in a persistent layer + pop-out windows, no child webviews

**Context.** Agents start dev servers, write docs and open PRs; users want to look at the result next to the terminals. A browser pane must live in the grid like a terminal, survive layout changes, and must never give web content access to Gridkeeper's IPC (which can write into every session). Overlays (menus, palette, dialogs, toasts, Fleet, Mission Control) are DOM.

**Decision.**
- **In-pane pages are `<iframe>`s** in the main webview, sandboxed with `allow-scripts allow-same-origin allow-forms allow-modals allow-downloads allow-pointer-lock` (no `allow-top-navigation*`, no `allow-popups`), CSP `frame-src http: https:`.
- **One persistent layer** (`browser/BrowserLayer.tsx`) holds every iframe and positions it over the pane's host box; the iframe never moves in the DOM, so reordering, maximize, layout presets and group switches do not reload the page (re-inserting an iframe reloads it).
- **Embeddability probe** (`browser::probe`): `curl.exe` (in System32 since Windows 10 1803; no new crate) fetches the address once and reports CSP `frame-ancestors` / `X-Frame-Options`, reachability and the static `<title>`. A blocked cross-origin frame still fires `load`, so the frame alone cannot tell "refused" from "loaded".
- **Fallback: a pop-out `WebviewWindow`** (`browser-*` label) for sites that refuse framing and for `file:` URLs, plus "open in system browser" (opener).
- **Capabilities target the `main` webview by label** (`"webviews": ["main"]`).

**Security analysis** (verified in the tauri 2.12.4 / wry 0.57 sources) [V]:
- Tauri's IPC bootstrap, including the invoke key every IPC request must carry, is registered `for_main_frame_only: true` (`manager/webview.rs`); none of our plugins add all-frames scripts. A framed page — cross-origin, and sandboxed — never sees `__TAURI_INTERNALS__` or the key.
- `allow-scripts` + `allow-same-origin` is dangerous only for a frame that shares the parent's origin (it could remove its own sandbox). `frameMode` refuses the app's origins (`window.location.origin`, which is `http://localhost:1420` in dev and `http://tauri.localhost` in release, plus `tauri|ipc|asset.localhost`) before anything is framed; everything else keeps its own origin (e.g. `http://localhost:5173`) and cannot reach the parent document. `allow-same-origin` is kept because dev apps need their own localStorage, cookies and service workers.
- Pop-out windows *do* get the IPC script (every Tauri webview does). They are protected by two independent checks: Tauri rejects custom commands from a non-local origin unless a `remote` capability matches (`webview/mod.rs`: "remote content can never reach custom commands"), and plugin commands need a capability whose `windows` / `webviews` patterns match — none matches `browser-*` (`ipc/authority.rs resolve_access`). The only way around the first check is a URL Tauri treats as *local* — the dev URL origin or a `<protocol>.localhost` host — so `on_navigation` refuses exactly those (`navigation_allowed`), as does `open_window`. `on_new_window` always denies (http(s) links go to the system browser) so no bare WebView2 popup appears.
- Navigation is limited to http / https / file (+ `about:blank` in pop-outs); URLs are validated in Rust and TypeScript, ≤ 2048 chars, no credentials.

**Alternatives.**
- **Tauri child webviews** (`unstable` feature, `Window::add_child`, `browser_set_bounds` from a ResizeObserver): renders every site, real back / forward / title / DevTools. Rejected for now: native webviews paint *above* the DOM, so every menu, dialog, palette, toast and overlay would need a hide-all-webviews protocol or a screenshot placeholder; DPI/position syncing and focus handling could not be verified on this machine at the time; the feature is explicitly unstable. Kept as the upgrade path: the capability is already label-scoped, and the host-box registry is the geometry source such a webview would follow.
- **iframe only:** many external sites (GitHub, most SaaS) send `X-Frame-Options: DENY`; without a probe they would show a blank pane.
- **WinHTTP / an HTTP crate for the probe:** more code and binary size for the same headers.

**Consequences.**
- Dev servers, docs sites and anything that allows framing open in the grid; overlays work; layout changes keep page state.
- A cross-origin frame hides its URL, history and title: back / forward cover addresses opened through Gridkeeper (not in-page link clicks), reload re-requests the last address we opened, and the page title comes from the probe's static `<title>` (SPA titles set by script are not seen). `target=_blank` links do nothing inside a pane. App shortcuts do not fire while keyboard focus is inside a page.
- One extra request per opened http(s) address (ADR-018 updated accordingly).
- DevTools only for pop-out windows in debug builds (the release build has no `devtools` feature, so the main window never exposes them).

## ADR-020: Phone alerts through ntfy: the third network exception

**Context.** Agents run for a long time; the user walks away and wants a nudge on their phone when one needs them. ADR-018 forbids network traffic of the app's own except user-initiated requests (the browser-pane probe, ADR-019, and the Skills panel).

**Decision.**
- **Opt-in, off by default.** Nothing is sent until the user turns phone alerts on in Settings › Notifications (or presses "Send test"). One HTTPS POST per alert, to the server the user chose (https://ntfy.sh or a self-hosted one; plain http only for local-network hosts), sent by the system curl with the request on stdin. No polling, no retries, no other requests.
- **Generic text.** The frontend decides whether an event qualifies (event filter, Do not disturb, muted panes, phone quiet hours, minimum priority, only-when-away) and builds a fixed sentence; pane and workspace names only with "include names", the mission goal only with "include task names", never terminal output. Rust re-checks the switches and scrubs every field again (URLs, e-mail addresses, paths, secrets).
- **Rate limited.** One alert per pane per 2 minutes, 10 per hour; suppressed alerts are counted into the next one. A failure pauses sending for a minute (HTTP 429: ten minutes).
- **Secrets.** The topic acts as a password on a public server: it lives in `phone-alerts.json` (not in `workspaces.json` or diagnostics bundles) and is never logged. The optional access token is write-only from the UI and kept in Windows Credential Manager (a 0600 file on macOS / Linux).

**Alternatives.** A relay run by us (a server to operate and trust); e-mail or SMS (accounts, credentials in the app); the ntfy web-push API from the webview (CSP and CORS changes for the whole UI).

**Consequences.** ADR-018's "no requests of its own" now has three user-initiated exceptions. The notification text can reveal that an agent needs attention, and, with the names switches on, which pane and workspace; that is why they are separate switches.
- Superseded on Windows by ADR-021 (native views by default); this engine stays as the setting "Embedded frame (legacy)", the only engine on macOS / Linux, and the fallback when a native view cannot be created.

---

## ADR-021: Native browser panes on Windows: one child webview per pane, iframes as the fallback

**Context.** Users found the iframe panes (ADR-019) "not a browser": GitHub, Google and most sign-in pages refuse framing and pop out, there is no in-page history, `target=_blank` does nothing, page titles set by script are not seen, and app shortcuts die while focus is in a page. Research with sources: [research-notes/native-browser-panes.md](research-notes/native-browser-panes.md).

**Decision.**
- **Windows: a Tauri child webview per browser pane** (`src-tauri/src/browser_view.rs`, label `bv-<pane id>`), created with `Window::add_child` (Tauri `unstable` feature, enabled for the Windows target only) and laid over the pane's host box by `src/browser/nativeViews.ts`. Setting "Browser engine: Native (recommended) / Embedded frame (legacy)", default native where supported (`src/browser/engine.ts`); a failed creation switches to frames for the rest of the run with a toast.
- **Geometry** comes from the same host-box registry as the iframe layer (`frameHosts.ts`): CSS rect × `devicePixelRatio`, edges rounded in Rust. Views are created lazily when their pane is first on screen; off-screen panes are **parked** (hidden, WebView2 `MemoryUsageTargetLevel` Low).
- **Overlays**: a native view paints above all DOM. Each sync hit-tests a grid of points over every shown host box (`document.elementFromPoint`); anything on top hides the view (**occluded**) after a JPEG snapshot (`CapturePreview`) is put in its place. HTML drag and drop hides all views. No per-overlay protocol.
- **Page state** from WebView2 events (`SourceChanged`, `HistoryChanged`, `DocumentTitleChanged`, `NavigationStarting/Completed`) → `browser-view-state`; back / forward / stop via `ICoreWebView2`, reload / navigate via Tauri. The address follows in-page navigation and is persisted; the name follows the real title.
- **Keys**: the app's bound combos are registered with the host; WebView2 `AcceleratorKeyPressed` marks a match handled and sends it to the app, which moves focus back to its page and runs the command. Clicking a view focuses its pane; hiding a focused view returns focus to the app page.
- **New windows** are denied and opened in a new pane (default) or the same pane; **downloads** go to the Downloads folder with a toast ("Show in folder").
- **Security** as for pop-outs (ADR-019): no capability matches `bv-*`, Tauri refuses custom commands from remote origins, and `view_navigation_allowed` refuses the app's own (ACL-local) origins for every top-level navigation; channel data is per webview; events go to `main` only.
- Every view uses the main window's `additionalBrowserArgs` (one WebView2 environment per user data folder must use identical options, else 0x8007139F).

**Alternatives.**
- **Keep iframes** (ADR-019): safe and overlay-friendly, but the limits above are what users report as "the browser doesn't work".
- **Hide all views whenever any overlay is open** (a list of overlay states): simpler to reason about, but every new menu or panel would need wiring, and toasts in a corner would blank every pane. Hit-testing is generic and only hides views that are actually covered.
- **Child webviews on macOS / Linux**: Linux can't position them (GtkBox packing, tauri#10420); macOS has open input bugs, no accelerator hook and nobody to verify it. Both keep the iframe engine.
- **CEF / a separate browser process**: full control, but a large dependency and another process model; rejected.

**Consequences.**
- Every site works in a pane on Windows, with real history, titles, DevTools (debug builds), downloads and new-window handling; app shortcuts keep working from inside a page.
- `unstable` changes the main window on Windows even with the frame engine: its webview is built as an auto-resizing child, and `get_webview_window("main")` returns None while views exist (use `webview_guard::main_window` / `main_webview`). Tauri may change the API in a minor release (tauri 2.12 locks unstable crates to minor versions).
- While a menu, dialog or toast covers a pane, the pane shows a still picture of the page (or nothing if no picture could be taken in 180 ms).
- Memory per pane is roughly a renderer process per site, as with cross-origin iframes (unmeasured; see the research note).
- Must be verified live before release (research note, "What must be verified live").
## ADR-022: Merge assistant: the first git write operation

**Context.** Until now every git call was read-only (`status`, `diff`, `log`, `rev-list`) plus `worktree add`; the Changes drawer and sign-off evidence never write. The last step of a mission — getting a builder's branch into the base — still meant leaving the app, finding the right checkout and typing commands by hand while many agents share one repository. A write operation in a tool that hosts autonomous agents next to the user's own checkout has to be boring: it must never surprise, never force, never leave the repository half-merged.

**Decision.** One module (`src-tauri/src/merge.rs`) holds the only git write path; `git.rs` stays read-only. From a sign-off card, "merge…" opens a dialog (`src/components/merge/MergeDialog.tsx`):
- **Preview writes nothing.** Commits (`log base..branch`), diffstat, fast-forward check (`merge-base --is-ancestor`) and a conflict check with `git merge-tree --write-tree -z --name-only` (git ≥ 2.38; output parsed from recorded fixtures). It only adds unreferenced objects to the object store. Older git: a detached temporary worktree in the temp folder, `merge --no-commit --no-ff`, `merge --abort`, then the worktree is removed (links unlinked first, see below).
- **Refusals, never repairs.** The merge happens in the main checkout (first entry of `git worktree list`). It is refused when that checkout has another branch (or a detached HEAD) checked out, has changes to tracked files, has a merge / rebase / cherry-pick / revert / bisect in progress or an `index.lock`. The assistant never checks out, stashes, resets a branch, uses `--force`, rewrites history or deletes branches by itself; the message says what to do instead. Untracked files in the main checkout do not block: git itself refuses before touching anything when one would be overwritten.
- **Pinned commits.** The request carries the previewed base and branch SHAs; if either branch moved since the preview, the merge is refused. The command merges the branch's SHA, not its name, so exactly the previewed (and tested) commit lands.
- **Optional test gate** (default on when a test command exists): Rust accepts only a passing run (ADR-021) whose HEAD at start and end was the branch SHA and whose worktree had no uncommitted or untracked files.
- **Exact commands, one confirmation.** `merge::plan` turns the request into argv lists; the dialog shows `git -C "<main>" merge --ff-only <sha>` / `merge --no-ff --no-edit -m "<message>" <sha>` / `merge --squash <sha>` + `commit -m "<message>"` and the rollback command, and `execute` runs those same lists. Pressing "Merge" is the confirmation. The message is one line (the display is then exactly what runs).
- **Never mid-merge.** Every guard is re-checked right before writing. A failed step (conflict, hook, identity, timeout) is followed by `merge --abort` (or `reset --merge` after a squash; neither moves HEAD) and a check that HEAD is the old base, no merge is in progress and the checkout is clean; anything else is reported as "rollback incomplete". Each git write runs in a `ProcessContainer` with a 5-minute limit, so a hung hook cannot outlive it; hooks are not skipped.
- **Conflicts go back to the agent, by the user.** Conflicting files (from the preview or the failed merge) can be handed to the branch's agent with the hand-off pattern: an editable one-line message, sent only on "Send", refused while the agent is asking something.
- **Clean-up is a separate confirmed step** after a successful merge: `git worktree remove` (never `--force`; refused while the worktree has uncommitted or untracked files, and in the UI while a live session uses the folder) and `git branch -d` only when the branch is contained in the base (never `-D`; a squash-merged branch is kept and the dialog says so). **Before removal every junction / symlink inside the worktree is unlinked** (the link, never its target), because Git for Windows' `worktree remove` follows a directory junction and deletes the target's contents [M: git 2.51, scratch repo: a `node_modules` junction's target folder was emptied]. Agent worktrees in this project routinely hold a `node_modules` junction to the main checkout.
- One merge or clean-up at a time (a process-wide lock); results go to a toast and the activity log.

**Alternatives.**
- **Run `git merge` in the agent's worktree, or let agents merge.** The base branch is checked out in the main checkout; merging elsewhere means checking out the base twice (git refuses) or detaching HEADs. Agents merging on their own is exactly the unreviewed write this feature exists to avoid.
- **Auto-stash / auto-checkout the main checkout.** Convenient, but it touches the user's own work in progress; a refusal with an explanation is cheaper than an unexpected stash.
- **libgit2 (`git2` crate).** In-process merges without spawning git, but a second implementation of merge semantics, hooks and config next to the user's git, and a large C dependency. The CLI is what the user's own tools use.
- **Merging by branch name.** Simpler display, but a commit pushed between preview and merge would land untested.

**Consequences.**
- The repository's history only ever moves forward through ordinary merges, fast-forwards and squash commits the user saw; nothing is deleted without its own confirmation.
- Conflicts are resolved where they belong (on the branch, by its agent or the user), not inside the main checkout.
- `merge-tree` adds loose objects (collected by `git gc`). The old-git fallback creates and removes a temporary worktree entry.
- The user's global git config applies (identity, hooks, signing). A merge that needs an interactive signing prompt times out and is rolled back.
- Tests: pure plan / parser tests plus temp-repo integration tests (fast-forward, merge commit, squash, conflicts with rollback, refused dirty / switched main checkout, moved branch, clean-up with a junction whose target must survive).

## ADR-023: Test runs: contained background processes, evidence pinned to a commit

**Context.** Sign-off showed what an agent committed, not whether it works. "Tests pass" in an agent's last message is a claim; the user wants a result Gridkeeper observed. Test suites are heavy (this machine has 16 GB and has run out of commit before), can hang, and spawn trees (dev servers, watchers, browsers).

**Decision.** `src-tauri/src/testrun.rs`:
- **Command.** Per workspace (`Workspace.testCommand`), with an optional lane override (`Group.testCommand`); empty = auto-detect in the tested folder from its own files: `package.json` `test` script (npm / pnpm / yarn / bun by lockfile or `packageManager`), `Cargo.toml`, pytest config / `pyproject.toml`, `go.mod`, a Makefile `test:` target. The dialog previews what was found and where.
- **Runner.** `cmd.exe /d /s /c "<command>"` (Windows) or `sh -c` (Unix, own session) at below-normal priority, inside a fresh `ProcessContainer` (ADR-009), in the session's worktree. Cancel, the time limit (default 15 min) and normal completion all end the whole tree; leftovers of a finished run are ended too, and app exit ends running trees. `CI=true` unless set, agent session variables removed. stdout + stderr go to a 2 MiB ring (newest output kept). A queue caps concurrency (default 2, setting); one active run per folder.
- **Evidence.** git root, HEAD and the uncommitted / untracked count are recorded at start and checked again at the end; a run whose folder changed underneath is not evidence. The merge gate (ADR-020) uses exactly this.
- **Results.** passed / failed / could not run / cancelled / timed out, duration, exit code, the last lines, failing test names and counts from best-effort pure parsers (vitest, jest, cargo, pytest, go, mocha; several runners in one run are summed). `test-run` events update badges on agent and sign-off cards (`tests ✓ 412 · 38s`, `tests ✗ 3 failed`) and the activity log; the read-only log viewer re-reads the newest 256 KiB once a second only while it is open and the run is active.
- **Ask the agent to fix** opens the hand-off style confirmation with a prefilled one-line failure summary; nothing is ever sent automatically.

**Alternatives.** Running tests in a terminal pane (no structured result, output mixed with the agent's), a temporary clean worktree per run (exact, but a cold `node_modules` / cargo build per run on a memory-constrained machine), parsing JUnit XML (needs per-runner flags in the user's command).

**Consequences.** Results are observations, pinned to a commit. Detection is shallow (the tested folder only). Output beyond 2 MiB keeps the end, where summaries are. On Windows, a process the command starts in the microseconds before the Job assignment could escape (same known gap as ADR-009).
