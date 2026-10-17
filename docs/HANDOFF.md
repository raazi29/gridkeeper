# Gridkeeper: Handoff

Working notes for the next session's agents (and humans). Read this first, then
[ARCHITECTURE.md](ARCHITECTURE.md) for depth and [TECHNICAL_DECISIONS.md](TECHNICAL_DECISIONS.md) for the why.
Ideas for what to build next are in [ROADMAP.md](ROADMAP.md).

**State as of 2026-10-17:** v0.1.0 released (`gh release view v0.1.0 -R raazi29/gridkeeper`, private repo,
installer `Gridkeeper_0.1.1_x64-setup.exe`, ≈6 MB). 164 Rust and 400 frontend tests, 22/22 live e2e checks at
release. License MIT. Main checkout: `D:\AlteraAI`. Agents work in `D:\AlteraAI\.claude\worktrees\agent-*`.

## 1. Project map

### Rust host: `src-tauri/src/`

| Path | What lives there |
|---|---|
| `lib.rs` | App setup: plugins (single-instance, opener, dialog, clipboard, notification), `generate_handler![…]` (every IPC command), the `Exit` handler (`shutdown_all`). |
| `main.rs` | Entry point; calls `gridkeeper_lib::run()`. |
| `state.rs` | `AppCtx`, the context shared by all commands (session manager, stores, paths). |
| `types.rs` | **The IPC contract** (serde `camelCase`). Mirrored by `src/lib/types.ts`. |
| `commands/session.rs` | `session_*`: start, attach/detach, write (text/binary), resize, ack, stop, list, output text/tail, clear buffer, remove. |
| `commands/services.rs` | Persistence (`state_load/save`), profiles and accounts, `agents_detect`, path/git info, `git_worktree_add`, diagnostics, `log_frontend`. |
| `commands/app.rs` | `app_info` (version, Windows build). |
| `commands/tools.rs` | Changes drawer (`git_changes`, `git_diff`), ports, browser probe and pop-out windows. |
| `pty/session.rs` | `SessionManager` / `SessionCore` / `Session`: ConPTY launch, stop sequences, exit detection. |
| `pty/stream.rs` | Output attachment, pump threads, frames, ack flow control (`HIGH_WATER` 1 MiB / `LOW_WATER` 256 KiB), CPR invariant. |
| `pty/ring.rs` | Bounded replay ring with absolute offsets. |
| `pty/job.rs` | One Job Object per session (`KILL_ON_JOB_CLOSE`). |
| `pty/text.rs` | Escape-sequence tools: query filtering, ANSI stripping, CPR scanner. |
| `pty/attention.rs` | BEL / OSC 9/777/99 / OSC 7501 scanner and activity monitor → `session-attention` events (works with no view attached). |
| `pty/tests.rs` | ConPTY integration tests (spawn real pwsh/cmd). |
| `adapters/mod.rs` | `AgentAdapter` trait, `ADAPTERS`, `resolve_launch` (env plan, identity stripping), `detect`. |
| `adapters/{powershell,claude,codex,generic}.rs` | First-class adapters. |
| `adapters/catalog.rs` | Catalog of extra agent CLIs (Hermes, OpenCode, Gemini, Copilot, Aider, Droid, Kimi, Qwen, Cursor, Goose, Crush, Amp, OpenClaw). **Adding a tool = one entry.** |
| `adapters/discovery.rs` | Executable discovery, npm `.cmd` shim → real `.exe`. |
| `adapters/process.rs` | Helper processes: `run_with_timeout`, `run_capped`, `CREATE_NO_WINDOW`. |
| `accounts.rs` | Accounts for every agent with an isolated home (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `HERMES_HOME`): discovery, status commands, launch env. Existence checks only. |
| `profiles.rs` | `profiles.json` store and `claude auth status --json`. |
| `persistence.rs` | Versioned, atomic, lenient `workspaces.json` (sanitize, migrate, read-only on newer versions). |
| `git.rs` | Repo info, `git worktree add`, read-only status/diff for the Changes drawer. |
| `ports.rs` | Listening TCP ports (`GetExtendedTcpTable`) attributed to session trees. |
| `browser.rs` | URL validation, `curl.exe` embed probe (`frame_verdict`, `html_title`), pop-out `WebviewWindow`s. |
| `diagnostics.rs` | CPU/RAM attribution via one Toolhelp snapshot (host / WebView2 / session trees), export bundle. |
| `gpu.rs` | GPU telemetry from PDH counters (engine utilization, GPU memory), opened lazily. |
| `logging.rs`, `redact.rs` | JSON-lines logs with daily rotation; secret redaction at every sink. |
| `src-tauri/tests/live_profiles.rs` | Optional live checks against real Claude profiles (`--ignored`). |
| `src-tauri/capabilities/default.json` | IPC permissions, **scoped to webview `main`**. |
| `src-tauri/tauri.conf.json` | CSP, window `main`, NSIS per-user bundle, identifier `app.gridkeeper.desktop`. |

### Frontend: `src/`

| Path | What lives there |
|---|---|
| `main.tsx`, `App.tsx` | Boot (no StrictMode), dev-only `window.__gridkeeper` e2e handles. |
| `lib/ipc.ts` | **The only caller of `invoke`.** Typed wrapper per command. |
| `lib/types.ts` | IPC contract mirror of `types.rs`. |
| `lib/url.ts` | URL normalization/validation, `FRAME_SANDBOX`, `frameMode` (refuses the app's own origins). |
| `lib/accounts.ts`, `lib/roles.ts`, `lib/browserPanes.ts`, `lib/pressure.ts`, `lib/brand.ts` | Pure helpers. |
| `store/appStore.ts` | zustand: `persisted` (saved, debounced 400 ms) + `runtime` (live `SessionInfo` by id). |
| `store/uiStore.ts` | Dialogs, palette, toasts, shared diagnostics poll. |
| `store/attention.ts` | Attention state machine per session (working / waiting / done / error / idle, unread). |
| `store/activity.ts`, `store/rates.ts`, `store/mission.ts` | Mission Control: activity ring (500), output rates (polled only while open), mission UI state. |
| `store/ports.ts` | Ports, polled only while a view shows them. |
| `actions/sessions.ts` | **The only place that turns intent into `session_*` calls**: start/stop/restart/close, restore, `LAUNCH_GAP_MS`. |
| `actions/commands.ts` (+ `experienceCommands.ts`, `terminalCommands.ts`) | Command registry for palette, keybindings and menus. |
| `actions/formationPlan.ts`, `formations.ts`, `starterPrompt.ts` | Formations: pure planner, executor, held starter prompts. |
| `actions/broadcast.ts`, `attentionNotify.ts`, `notify*.ts`, `accounts.ts`, `browser.ts`, `resume.ts`, `groupActions.ts` | Feature actions. |
| `terminal/registry.ts` | **Single owner of xterm.js instances**, outside React: attach generations, parking, WebGL budget, context-loss recovery. |
| `terminal/webglBudget.ts` | `MAX_WEBGL = 12` and the stable allocation algorithm. |
| `terminal/ackBatcher.ts`, `writeChunks.ts`, `pasteGuard.ts`, `zoom.ts`, `findState.ts`, `menuBridge.ts`, `theme.ts` | Terminal plumbing. |
| `layout/GroupGrid.tsx`, `Pane.tsx`, `PaneHeader.tsx`, `BrowserPane.tsx`, `gridGeometry.ts`, `paneDrag.ts` | Grid, panes, headers, drag and drop. |
| `browser/BrowserLayer.tsx`, `frameHosts.ts`, `nav.ts`, `OpenUrlDialog.tsx`, `PortsList.tsx` | Browser panes: one persistent iframe layer positioned over host boxes. |
| `components/*` | Shell, sidebar, dialogs, palette, Fleet, Broadcast, Comms, Inspector, Diagnostics, ChangesDrawer, settings, welcome, theme switcher, menus. |
| `components/mission/*` | Mission Control, Formations UI, activity river, session log. |
| `keybindings/combo.ts`, `index.ts` | `DEFAULT_BINDINGS`, `forbiddenReason()`, capture-phase listener. |
| `theme/themes.ts`, `applyTheme.ts`, `saber.ts`, `effectPrefs.ts` | 12 themes (pure data), CSS variable application, saber colours, effect prefs. |
| `styles/*.css` | `tokens.css` (derived tokens), `signature.css` (theme-specific accents), feature CSS. |
| `audio/sounds.ts` | Synthesized notification sounds (no audio files). |
| `bench.ts` | Bench mode (in-memory workspace from `GRIDKEEPER_BENCH`). |

### Everything else

| Path | What |
|---|---|
| `scripts/e2e/` | `cdp.mjs` (CDP driver) + live test scripts (`full-verify.js`, `ps-basic.js`, `multi-agent.js`, `formation.js`, `browser-ports.js`, `reliability.js`, `codex-*.js`). |
| `scripts/bench/` | `flood.ps1` (output generator), `sample.ps1` (CPU/RAM/GPU sampler), `run-all.ps1` (standard scenarios). |
| `scripts/showcase/record.mjs` | Scripted CDP tour → MP4/GIF/screenshots in `docs/assets/showcase/`. |
| `scripts/dev/eol-merge.sh` | Re-run a conflicted merge with CRLF/LF normalized. |
| `docs/assets/` | Hero banner, social preview, showcase media, `logo/` (brand guide + tools), `readme/` (animated crawl + saber dividers + `tools/gen-readme-art.mjs`). |
| `docs/research-notes/` | Raw verified findings (CLI flags, terminal stack, market/agents). |

## 2. Architecture in 15 bullets

1. One Tauri 2 host process (`gridkeeper.exe`) plus WebView2; `tauri-plugin-single-instance` focuses the existing window on a second launch.
2. Every session is a real ConPTY (`portable-pty` 0.9 on the system `conpty`) whose root process is assigned to its own Job Object right after spawn.
3. Per session there are OS threads, not async tasks: `pty-read`, `pty-write`, `pty-wait`, one `pty-pump` per attachment, all inside `spawn_guarded` (`catch_unwind`); release builds use `panic = "unwind"`.
4. The reader appends to a bounded ring (`Settings.buffer_kib`, default 2 MiB) and never waits on anything.
5. The pump coalesces output into raw binary frames (`[DATA|RESET][≤ 64 KiB]`, flush at 64 KiB or 8 ms) sent over a Tauri `Channel` as ArrayBuffers, never JSON.
6. Flow control is ack-based: the frontend acks bytes after xterm *parsed* them; the pump pauses at 1 MiB unacked and resumes at 256 KiB. A view that falls behind gets RESET plus a replay, never backpressure on the child.
7. Every `ESC[6n` (CPR) is answered exactly once, by xterm when delivered live or by Rust otherwise; replayed bytes have terminal queries stripped so a new view never answers stale requests.
8. The frontend's `terminal/registry.ts` owns all xterm instances outside React; unmounted terminals are parked (`display:none`) and keep parsing.
9. At most 12 WebGL contexts (`MAX_WEBGL`; Chromium force-loses beyond 16 per renderer), allocated stably by visibility and focus; the rest render with DOM; context loss falls back to DOM and retries.
10. State: `persisted` (workspaces → groups → `SessionMeta`, settings) saved atomically to `workspaces.json`; `runtime` (`SessionInfo`) comes from Rust `session-state` events.
11. Restore = layout always, processes never, conversations per session (Claude pins `--session-id`/`--resume`, Codex `resume --last` or picker).
12. Agents come from adapters (`AgentAdapter` trait) plus a data-only catalog; env plan: base TERM vars → strip parent-agent vars → adapter config → user args → user env.
13. Accounts are isolated home directories selected with each CLI's documented variable; status comes from the CLI's own status command; credentials are never read.
14. Attention is detected in Rust from BEL/OSC signals and output activity (`pty/attention.rs`) and reduced in `store/attention.ts`; notifications, Comms, Fleet and Mission Control consume it.
15. Built-in tools are read-only or sandboxed: Changes drawer (`git status`/`diff` only), ports (TCP table), browser panes (sandboxed iframes in one persistent layer, pop-outs as separate webviews without IPC).

## 3. The IPC contract

- `src-tauri/src/types.rs` ↔ `src/lib/types.ts`: same types, serde `camelCase`. **Change both in the same commit.**
  Nothing verifies the boundary at compile time.
- Commands are registered in `lib.rs` `generate_handler![…]` and wrapped one-to-one in `src/lib/ipc.ts`. Nothing
  else calls `invoke`.
- Output goes over a `tauri::ipc::Channel` passed to `session_attach` (binary frames, generation-tagged); state goes
  over events (`session-state` with `SessionInfo`, `session-attention`).
- Sync commands run on the main thread and must be quick; slow work uses `spawn_blocking`.
- Errors are `AppError` and redacted before they reach the UI.
- Contract-first worked well for parallel agents: land the `types.rs`/`types.ts`/`ipc.ts` change first (or agree on
  it in the brief), then build backend and frontend in parallel.

## 4. Key invariants (don't break these)

- **Flow control never blocks the child.** Readers only append; slow views cost a RESET + replay (ADR-005).
- **Terminal bytes never enter React/zustand state.** Narrow selectors; never construct objects/arrays inside a
  selector (render loops, see commit `80b455c`).
- **No polling while idle.** Every timer is tied to an open view and a visible window.
- **WebGL budget is 12** (Chromium silently kills the oldest context beyond 16 per renderer; the spare slots are headroom for other WebGL users in the page and for transitions, ADR-006).
- **Capability scoped to webview `main`** (`"webviews": ["main"]`, not `"windows"`), so pop-out browser windows and
  future child webviews never get IPC.
- **Browser iframes are sandboxed** (`FRAME_SANDBOX`: no top navigation, no popups) and `frameMode` refuses the
  app's own origins *before* framing; that's what makes `allow-same-origin` safe. `file:` URLs go to pop-outs.
- **Job Objects** (`KILL_ON_JOB_CLOSE`, no breakaway) contain every session tree; app exit runs `shutdown_all(1500 ms)`
  and a crash still kills the trees.
- **Accounts never read credentials**: filename existence checks and official status commands only; never write
  into agent homes (except creating an empty folder for a new account); e-mails to UI only.
- **Restore semantics**: layout always, processes never, conversation per session. A browser pane has no process
  (excluded from running counts, broadcast, Fleet, Mission members, auto-start).
- **Keybindings never take terminal-critical keys** (`forbiddenReason()` in `combo.ts`).
- **Persistence is never destructive**: newer-version files make the store read-only; damaged files are preserved as
  `workspaces.corrupt-<timestamp>.json`.
- **Same-agent launch gaps** (Claude 350 ms, Codex 600 ms) and the 12 s no-output watchdog stay unless the Codex
  startup hang is proven fixed.

## 5. Build, test, verify, benchmark, record, release

All `cargo`/`tauri` commands from **PowerShell**.

```powershell
npm install
npm run tauri dev                         # dev
npx tsc --noEmit; npx vitest run          # frontend checks
cd src-tauri; cargo test; cd ..           # Rust unit + ConPTY tests
npm run tauri build                       # release + NSIS installer → src-tauri\target\release\bundle\nsis\
```

**Live verification (always do this for UI or lifecycle changes):**

```powershell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"
npm run tauri dev
node scripts/e2e/cdp.mjs file scripts/e2e/full-verify.js
node scripts/e2e/cdp.mjs shot shot.png     # then look at the PNG
```

**Benchmarks:** `pwsh -File scripts/bench/run-all.ps1 -Exe src-tauri/target/release/gridkeeper.exe` → `bench-results/summary.csv`;
compare with [PERFORMANCE.md](PERFORMANCE.md) (idle 6 sessions: host 0.06 %, WebView2 0.42 % CPU).

**Showcase:** `node scripts/showcase/record.mjs docs/assets/showcase` (dev app with CDP, ffmpeg on PATH).

**README art:** `node docs/assets/readme/tools/gen-readme-art.mjs docs/assets/readme`. SVG animations must be 2D CSS
(Chromium flattens 3D transforms on SVG elements); verify in a real `<img>` in real time, since headless
`--virtual-time-budget` doesn't drive SVG-image animation clocks reliably.

**Release:**

```powershell
# bump version in package.json, src-tauri/Cargo.toml and src-tauri/tauri.conf.json,
# and the static release badge + installer name in README.md
npm run tauri build
gh release create v0.1.1 "src-tauri\target\release\bundle\nsis\Gridkeeper_0.1.1_x64-setup.exe" `
  -R raazi29/gridkeeper --title "Gridkeeper v0.1.1" --notes-file notes.md
```

## 6. Environment quirks

- **Run cargo only from PowerShell.** Git Bash's `/usr/bin/link.exe` shadows the MSVC linker.
- **Low RAM / rustc stack overflow:** `$env:RUST_MIN_STACK='16777216'; $env:CARGO_BUILD_JOBS=2`.
- **WebView2 `0x8007139F` flooding the log mid-session:** the WebView2 browser process died, usually because the
  machine ran out of commit (System log event 2004). Before 0.1.2 this left a black window; `webview_guard` now
  rebuilds the window. Look for `WebView2 process failed` in the log.
- **WebView2 `0x8007139F` at startup:** another instance holds the default WebView2 user-data folder with different
  browser arguments (for example a normal instance while you start one with `--remote-debugging-port`). Close it or
  set `WEBVIEW2_USER_DATA_FOLDER` to a separate folder (`scripts/bench/run-all.ps1` does this per scenario).
- **Vite HMR vs e2e:** a dynamic `import()` from a CDP script gets a fresh module instance after HMR. Use the dev
  handles `window.__gridkeeper` (`store`, `sessions`, `registry`, `ipc`, `mission`, `commands`),
  `window.__gridkeeperTerminals.list()/text(id)` and `window.__gridkeeperForceContextLoss(id?)`.
- **Vite watcher** ignores agent worktrees and bench results (`vite.config.ts`). Keep it that way, or every
  worktree write reloads the dev app.
- **Mixed CRLF/LF.** `core.autocrlf=false`. Keep each file's existing endings (Git Bash `sed -i` silently converts
  CRLF to LF, so use `perl -pi` or the Edit tool). For whole-file merge conflicts caused by endings:
  `scripts/dev/eol-merge.sh <branch>` during the conflicted merge.
- **Headless Edge on this machine reports `prefers-reduced-motion: reduce`.** Pass `--force-prefers-no-reduced-motion` when screenshotting animations.
- e2e scripts hard-code `D:\AlteraAI` as the working folder.
- Windows notifications show the right name and icon only from the installed app; dev builds appear under PowerShell.

## 7. Known issues and limitations

- Processes don't survive app exit (no daemon); conversations resume, processes don't.
- Codex can't pin conversation ids; panes sharing a folder get the picker. Codex occasionally fails at startup on its
  side (auto-retried once).
- Shift+Enter in Claude Code on Windows is unreliable (kitty keyboard protocol allowlist, Claude Code #92771).
- System ConPTY swallows some sequences (OSC 7501 / DA1 pass-through needs a newer sideloaded ConPTY; see ROADMAP).
- More than 12 visible terminals → DOM renderer for the rest.
- Browser panes: iframe limits (no in-page history, static `<title>` only, `target=_blank` does nothing, app shortcuts
  don't fire while focus is in the page); sites that refuse framing open in pop-outs.
- Port detection: TCP listeners inside the session tree only.
- Job assignment race (process spawned before `AssignProcessToJobObject`): theoretical, never observed.
- `conhost.exe` is not attributed in in-app diagnostics (`sample.ps1` reports it).
- Installer unsigned (SmartScreen), no auto-update.
- `@fontsource-variable/inter` is in `package.json` but not imported anywhere (candidate for removal).
- Private vulnerability reporting may need enabling in the repo settings (it is a private repo).

## 8. The multi-agent workflow that worked

- **One worktree per agent** (`.claude/worktrees/agent-*`, branch `worktree-agent-*`). Never share a checkout.
- **Disjoint file ownership.** Each brief lists exactly which files the agent may touch. Shared hot spots
  (`types.rs`/`types.ts`, `commands.ts`, `combo.ts`, `README.md`) belong to one agent per round or go through the
  integrator.
- **Contract first.** Agree on IPC types and command names in the brief before parallel work starts.
- **Integrator merges.** One session merges branches into `main` in order, resolves conflicts (`eol-merge.sh` for
  CRLF noise), runs `tsc` + `vitest` + `cargo test`, then the live suite.
- **Live CDP verification** of every feature in the running app (`full-verify.js`, screenshots that are actually
  looked at), not only unit tests.
- **Evidence over assumption.** Research notes mark findings VERIFIED vs hypothesis; performance claims come from
  `scripts/bench`; agent CLI flags come from each tool's docs or `--help`.
- **Never send prompts to real agents in tests**, and never show account e-mails in screenshots or logs.
