# Gridkeeper: Handoff

Working notes for the next session's agents (and humans). Read this first, then
[ARCHITECTURE.md](ARCHITECTURE.md) for depth and [TECHNICAL_DECISIONS.md](TECHNICAL_DECISIONS.md) for the why.
Ideas for what to build next are in [ROADMAP.md](ROADMAP.md).

**State as of 2026-10-18:** the repo is **public** (github.com/raazi29/gridkeeper, MIT). v0.2.0 adds the mission
board, lead control (off / advisor / autopilot, `team.md` + `outbox/`), Mission Control drag and drop, sign-off
evidence with committed branch diffs, Mission Replay (MP4/WebM/GIF), the Skills panel, the Claude cost & context
meter, macOS/Linux support (preview) and sandbox instances for testing next to a live app. At v0.2.0: 252 Rust
lib tests and 714 frontend tests on Windows; installers are built by CI from the `v0.2.0` tag (never locally on a
machine that is running agents). CI runs on every push to `main` and every PR (`.github/workflows/ci.yml`), on Windows, Ubuntu 22.04 and macOS
(macOS / Linux support: [section 10](#10-platforms-windows-macos-linux); Windows stays the reference platform and the
only one verified by hand so far). Main checkout: `D:\AlteraAI`. Agents work
in `D:\AlteraAI\.claude\worktrees\agent-*`, usually **while the developer runs the installed Gridkeeper with those
very agents inside it**: read [section 6](#6-testing-next-to-a-live-gridkeeper) before you start, build or test
anything.

## 1. Project map

### Rust host: `src-tauri/src/`

| Path | What lives there |
|---|---|
| `lib.rs` | App setup: plugins (single-instance, opener, dialog, clipboard, notification), `generate_handler![…]` (every IPC command), the `Exit` handler (`shutdown_all`). Sandbox mode (`GRIDKEEPER_SANDBOX`) skips the single-instance lock and uses its own data and WebView2 folders. |
| `main.rs` | Entry point: `--gk-statusline` (meter helper) and `--gk-self-test` are handled before Tauri starts; otherwise `gridkeeper_lib::run()`. |
| `selftest.rs` | `--gk-self-test` (headless: env fix-up + login-shell PATH, data folder probe, default shell in a PTY answering a typed command, forced-stop containment of a tree with an orphaned grandchild; one line per check, exit 0/1) and `--gk-self-test-gui` (real window as sandbox `self-test`; passes when the frontend's boot calls `state_load`). Run by CI on the built binary (section 10). |
| `app_menu.rs` | The native macOS menu (App, Edit, View, Window, Help) as plain data + a macOS-only builder. Edit items are native; custom items emit `native-menu` → `src/lib/nativeMenu.ts`. |
| `state.rs` | `AppCtx`, the context shared by all commands (session manager, stores, paths). |
| `types.rs` | **The IPC contract** (serde `camelCase`). Mirrored by `src/lib/types.ts`. |
| `commands/session.rs` | `session_*`: start, attach/detach, write (text/binary), resize, ack, stop, list, output text/tail, clear buffer, remove. |
| `commands/services.rs` | Persistence (`state_load/save`), profiles and accounts, `agents_detect`, path/git info, `git_worktree_add`, diagnostics, `log_frontend`. |
| `commands/app.rs` | `app_info` (version, Windows build). |
| `commands/tools.rs` | Changes drawer (`git_changes`, `git_diff`), ports, browser probe and pop-out windows. |
| `pty/session.rs` | `SessionManager` / `SessionCore` / `Session`: PTY launch (ConPTY / Unix pty), stop sequences, exit detection. |
| `pty/stream.rs` | Output attachment, pump threads, frames, ack flow control (`HIGH_WATER` 1 MiB / `LOW_WATER` 256 KiB), CPR invariant. |
| `pty/ring.rs` | Bounded replay ring with absolute offsets. |
| `pty/job.rs` | `ProcessContainer`: one Job Object per session (`KILL_ON_JOB_CLOSE`) on Windows; the POSIX session / process groups (`killpg`, SIGHUP, SIGKILL) on macOS / Linux. |
| `pty/text.rs` | Escape-sequence tools: query filtering, ANSI stripping, CPR scanner. |
| `pty/attention.rs` | BEL / OSC 9/777/99 / OSC 7501 scanner and activity monitor → `session-attention` events (works with no view attached). |
| `pty/tests.rs`, `pty/tests_unix.rs` | PTY integration tests: ConPTY with real pwsh/cmd (Windows), Unix pty with `sh`/`sleep` (macOS / Linux). |
| `adapters/mod.rs` | `AgentAdapter` trait, `ADAPTERS`, `resolve_launch` (env plan, identity stripping), `detect`. |
| `adapters/{powershell,claude,codex,generic}.rs` | First-class adapters. `powershell` is the platform's default terminal: PowerShell on Windows, the login shell (`$SHELL`) elsewhere. |
| `adapters/catalog.rs` | Catalog of extra agent CLIs (Hermes, OpenCode, Gemini, Copilot, Aider, Droid, Kimi, Qwen, Cursor, Goose, Crush, Amp, OpenClaw). **Adding a tool = one entry.** |
| `adapters/discovery.rs` | Executable discovery, npm `.cmd` shim → real `.exe`. |
| `adapters/process.rs` | Helper processes: `run_with_timeout`, `run_capped`, `CREATE_NO_WINDOW`. |
| `accounts.rs` | Accounts for every agent with an isolated home (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `HERMES_HOME`): discovery, status commands, launch env. Existence checks only. |
| `profiles.rs` | `profiles.json` store and `claude auth status --json`. |
| `persistence.rs` | Versioned, atomic, lenient `workspaces.json` (sanitize, migrate, read-only on newer versions). |
| `git.rs` | Repo info, `git worktree add`, read-only status/diff for the Changes drawer, branch summaries for sign-off (`git_branch_summary`). |
| *(mission file)* | `mission_read` / `mission_write` (atomic, conflict check) / `mission_watch` (filesystem watch, no polling → `mission-changed`) for `<projectDir>/.gridkeeper/mission.md`. |
| `ports.rs` | Listening TCP ports attributed to session trees: `GetExtendedTcpTable` (Windows), `/proc/net/tcp{,6}` + `/proc/<pid>/fd` (Linux), `lsof` (macOS). |
| `browser.rs` | URL validation, `curl.exe` embed probe (`frame_verdict`, `html_title`), pop-out `WebviewWindow`s. |
| `diagnostics.rs` | CPU/RAM attribution via one Toolhelp snapshot (host / WebView2 / session trees), export bundle. macOS / Linux: one sysinfo walk (`procs.rs`); the webview bucket is the WebKit helper processes, best effort. |
| `gpu.rs` | GPU telemetry from PDH counters (engine utilization, GPU memory), opened lazily. Windows only ("unavailable" elsewhere). |
| `platform.rs` | Per-OS bits: `os()` for `app_info`; `init_process_env` for macOS / Linux GUI launches (PATH from the login shell when `TERM` is unset, 5 s cap; tool folders appended; macOS `LANG`; Linux `WEBKIT_DISABLE_DMABUF_RENDERER=1` with the NVIDIA proprietary driver or in an AppImage); Unix termination guards (SIGTERM/SIGINT/SIGHUP → normal exit; main-thread panic → kill sessions). |
| `procs.rs` | Unix process table (one shared `sysinfo::System`): session membership for containment, trees and CPU/RAM for diagnostics. |
| `webview_guard.rs` | WebView2 crash recovery (Windows only). |
| `logging.rs`, `redact.rs` | JSON-lines logs with daily rotation; secret redaction at every sink. |
| `src-tauri/tests/live_profiles.rs` | Optional live checks against real Claude profiles (`--ignored`). |
| `src-tauri/capabilities/default.json` | IPC permissions, **scoped to webview `main`**. `macos.json` adds the Dock badge permission on macOS only (`"platforms": ["macOS"]`). |
| `src-tauri/tauri.conf.json` | CSP, window `main`, NSIS per-user bundle, identifier `app.gridkeeper.desktop`. |
| `src-tauri/tauri.macos.conf.json`, `tauri.linux.conf.json` | Platform overrides (merged by Tauri): bundle targets `app` + `dmg` (macOS 11+, ad-hoc signed; CI builds it `--target universal-apple-darwin`) and `appimage` + `deb`. The Windows config is untouched. |

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
| `terminal/webglBudget.ts` | `MAX_WEBGL` per platform (`maxWebglFor`: Windows 12, macOS 12, Linux 8) and the stable allocation algorithm. |
| `terminal/terminalKeys.ts` | Terminal copy / paste keys and link modifier per platform (Ctrl on Windows / Linux, ⌘ on macOS; ⌃C always reaches the program on a Mac). |
| `lib/platform.ts` | `OS` / `isMac` / `isLinux` / `isWindows` from `navigator`, `shellLabel()`, `webviewLabel()`. Platform-dependent helpers take an explicit `os` so tests are host-independent. |
| `lib/nativeMenu.ts` | macOS only: runs the native menu's custom items (`native-menu` events) through the command registry; drops a menu command a key binding ran within 500 ms. |
| `terminal/ackBatcher.ts`, `writeChunks.ts`, `pasteGuard.ts`, `zoom.ts`, `findState.ts`, `menuBridge.ts`, `theme.ts` | Terminal plumbing. |
| `layout/GroupGrid.tsx`, `Pane.tsx`, `PaneHeader.tsx`, `BrowserPane.tsx`, `gridGeometry.ts`, `paneDrag.ts` | Grid, panes, headers, drag and drop. |
| `browser/BrowserLayer.tsx`, `frameHosts.ts`, `nav.ts`, `OpenUrlDialog.tsx`, `PortsList.tsx` | Browser panes: one persistent iframe layer positioned over host boxes. |
| `components/*` | Shell, sidebar, dialogs, palette, Fleet, Broadcast, Comms, Inspector, Diagnostics, ChangesDrawer, settings, welcome, theme switcher, menus. |
| `components/mission/*` | Mission Control (mission board from `mission.md`, lanes, sign-off with branch evidence, "brief team…" / "hand off…"), Formations UI, activity river, session log. |
| `keybindings/combo.ts`, `index.ts` | `DEFAULT_BINDINGS` (+ `MAC_DEFAULT_OVERRIDES`), `forbiddenReason(combo, os)`, capture-phase listener. On macOS the stored `ctrl` token means ⌘ and `meta` means ⌃ (saved bindings keep working; display `⇧⌘P`). |
| `theme/themes.ts`, `applyTheme.ts`, `saber.ts`, `effectPrefs.ts` | 12 themes (pure data), CSS variable application, saber colours, effect prefs. |
| `styles/*.css` | `tokens.css` (derived tokens), `signature.css` (theme-specific accents), feature CSS. |
| `audio/sounds.ts` | Synthesized notification sounds (no audio files). |
| `bench.ts` | Bench mode (in-memory workspace from `GRIDKEEPER_BENCH`). |

### Everything else

| Path | What |
|---|---|
| `scripts/e2e/` | `cdp.mjs` (CDP driver; `file` mode refuses non-sandbox instances and injects `E2E_CWD`) + live test scripts (`full-verify.js`, `ps-basic.js`, `multi-agent.js`, `formation.js`, `mission.js`, `browser-ports.js`, `reliability.js`, `codex-*.js`). |
| `scripts/bench/` | `flood.ps1` (output generator), `sample.ps1` (CPU/RAM/GPU sampler), `run-all.ps1` (standard scenarios). |
| `scripts/showcase/record.mjs` | Scripted CDP tour → MP4/GIF/screenshots in `docs/assets/showcase/`. |
| `scripts/dev/sandbox.ps1`, `sandbox-stop.ps1` | Run / stop an isolated test instance next to the live app (section 6). `npm run sandbox`, `npm run sandbox:stop`. |
| `scripts/dev/eol-merge.sh` | Re-run a conflicted merge with CRLF/LF normalized. |
| `scripts/dev/unix-check.ps1` | Type-check the Rust crate for Linux and macOS from Windows (fake pkg-config / cc shims, nothing linked; section 10). |
| `.github/workflows/ci.yml` | CI matrix `windows-latest` / `ubuntu-22.04` / `macos-latest`: `tsc`, `vitest`, `npm run build`, `cargo test`, the debug binary's self-tests, `cargo clippy` (non-fatal); on `v*` tags (or a manual run with `installers: true`) also `tauri build` per OS → NSIS / universal dmg / AppImage + deb as workflow artifacts after the release binary's self-tests (no release is created). |
| `appveyor.yml`, `scripts/ci/appveyor.{sh,ps1}` | The CI that runs while GitHub Actions is unavailable (AppVeyor free plan: one job at a time, 60 min each; images Visual Studio 2022, Ubuntu2204, macos-sonoma). Same steps as the workflow. |
| `scripts/ci/self-test.sh` | Runs a built binary's `--gk-self-test`, then `--gk-self-test-gui` (Linux under Xvfb: required; macOS: optional; Windows: skipped; `GK_GUI_SELF_TEST` overrides). `dev` mode serves `dist/` with `vite preview` on the dev URL for debug builds. |
| `<project>/.gridkeeper/mission.md` | Not in this repo: the shared task board Mission Control reads and writes in each project folder (`# Mission: <goal>`, `## Tasks`, `- [ ] text @owner`; `[~]` doing, `[x]` done, `[!]` blocked). Created with a self-ignoring `.gitignore`. |
| `docs/assets/` | Hero banner, social preview, showcase media, `logo/` (brand guide + tools), `readme/` (animated crawl + saber dividers + `tools/gen-readme-art.mjs`). |
| `docs/research-notes/` | Raw verified findings (CLI flags, terminal stack, market/agents). |

## 2. Architecture in 17 bullets

1. One Tauri 2 host process (`gridkeeper.exe`) plus WebView2; `tauri-plugin-single-instance` focuses the existing window on a second launch (except in sandbox mode, bullet 16).
2. Every session is a real ConPTY (`portable-pty` 0.9 on the system `conpty`) whose root process is assigned to its own Job Object right after spawn. On macOS / Linux it is a Unix pty whose root leads its own POSIX session (portable-pty calls `setsid`); the session is the container (section 10).
3. Per session there are OS threads, not async tasks: `pty-read`, `pty-write`, `pty-wait`, one `pty-pump` per attachment, all inside `spawn_guarded` (`catch_unwind`); release builds use `panic = "unwind"`.
4. The reader appends to a bounded ring (`Settings.buffer_kib`, default 2 MiB) and never waits on anything.
5. The pump coalesces output into raw binary frames (`[DATA|RESET][≤ 64 KiB]`, flush at 64 KiB or 8 ms) sent over a Tauri `Channel` as ArrayBuffers, never JSON.
6. Flow control is ack-based: the frontend acks bytes after xterm *parsed* them; the pump pauses at 1 MiB unacked and resumes at 256 KiB. A view that falls behind gets RESET plus a replay, never backpressure on the child.
7. Every `ESC[6n` (CPR) is answered exactly once, by xterm when delivered live or by Rust otherwise; replayed bytes have terminal queries stripped so a new view never answers stale requests.
8. The frontend's `terminal/registry.ts` owns all xterm instances outside React; unmounted terminals are parked (`display:none`) and keep parsing.
9. At most 12 WebGL contexts (`MAX_WEBGL`; Chromium force-loses beyond 16 per renderer; 8 on Linux / WebKitGTK, unmeasured), allocated stably by visibility and focus; the rest render with DOM; context loss falls back to DOM and retries.
10. State: `persisted` (workspaces → groups → `SessionMeta`, settings) saved atomically to `workspaces.json`; `runtime` (`SessionInfo`) comes from Rust `session-state` events.
11. Restore = layout always, processes never, conversations per session (Claude pins `--session-id`/`--resume`, Codex `resume --last` or picker).
12. Agents come from adapters (`AgentAdapter` trait) plus a data-only catalog; env plan: base TERM vars → strip parent-agent vars → adapter config → user args → user env.
13. Accounts are isolated home directories selected with each CLI's documented variable; status comes from the CLI's own status command; credentials are never read.
14. Attention is detected in Rust from BEL/OSC signals and output activity (`pty/attention.rs`) and reduced in `store/attention.ts`; notifications, Comms, Fleet and Mission Control consume it.
15. Built-in tools are read-only or sandboxed: Changes drawer (`git status`/`diff` only), ports (TCP table), browser panes (sandboxed iframes in one persistent layer, pop-outs as separate webviews without IPC).
16. `GRIDKEEPER_SANDBOX=<name>` (`[a-z0-9-]{1,32}`) runs an isolated instance: data in `%APPDATA%\app.gridkeeper.desktop\sandboxes\<name>`, its own WebView2 profile, no single-instance lock, title `Gridkeeper [sandbox: <name>]`, `ipc.appInfo().sandbox`. That is how tests run next to the live app (section 6).
17. Team coordination is a plain file: `<projectDir>/.gridkeeper/mission.md`, which every agent CLI can edit. Rust reads/writes it atomically (conflict check on modified time) and watches it with filesystem notifications (`mission-changed`); Mission Control renders it as a board and sign-off shows each builder's branch evidence (`git_branch_summary`).

## 3. The IPC contract

- `src-tauri/src/types.rs` ↔ `src/lib/types.ts`: same types, serde `camelCase`. **Change both in the same commit.**
  Nothing verifies the boundary at compile time.
- Commands are registered in `lib.rs` `generate_handler![…]` and wrapped one-to-one in `src/lib/ipc.ts`. Nothing
  else calls `invoke`.
- Output goes over a `tauri::ipc::Channel` passed to `session_attach` (binary frames, generation-tagged); state goes
  over events (`session-state` with `SessionInfo`, `session-attention`, `mission-changed`).
- Sync commands run on the main thread and must be quick; slow work uses `spawn_blocking`.
- Errors are `AppError` and redacted before they reach the UI.
- Contract-first worked well for parallel agents: land the `types.rs`/`types.ts`/`ipc.ts` change first (or agree on
  it in the brief), then build backend and frontend in parallel.

## 4. Key invariants (don't break these)

- **Flow control never blocks the child.** Readers only append; slow views cost a RESET + replay (ADR-005).
- **Terminal bytes never enter React/zustand state.** Narrow selectors; never construct objects/arrays inside a
  selector (render loops, see commit `80b455c`).
- **No polling while idle.** Every timer is tied to an open view and a visible window.
- **WebGL budget is 12** (Chromium silently kills the oldest context beyond 16 per renderer; the spare slots are headroom for other WebGL users in the page and for transitions, ADR-006). Per platform in `maxWebglFor`: macOS 12, Linux 8 (WebKitGTK; both unmeasured).
- **Capability scoped to webview `main`** (`"webviews": ["main"]`, not `"windows"`), so pop-out browser windows and
  future child webviews never get IPC.
- **Browser iframes are sandboxed** (`FRAME_SANDBOX`: no top navigation, no popups) and `frameMode` refuses the
  app's own origins *before* framing; that's what makes `allow-same-origin` safe. `file:` URLs go to pop-outs.
- **Job Objects** (`KILL_ON_JOB_CLOSE`, no breakaway) contain every session tree; app exit runs `shutdown_all(1500 ms)`
  and a crash still kills the trees. **macOS / Linux:** the POSIX session is the container; app exit, SIGTERM / SIGINT
  / SIGHUP and a main-thread panic stop the sessions, but a hard crash of the host can orphan agents (section 10).
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

All `cargo`/`tauri` commands from **PowerShell**. On the developer's machine, start the app only through the
sandbox script (section 6), never with a bare `npm run tauri dev`.

```powershell
npm install
npm run sandbox                           # dev build as sandbox "dev" (CDP 9333), see section 6
npx tsc --noEmit; npx vitest run          # frontend checks
cd src-tauri; cargo test; cd ..           # Rust unit + ConPTY tests
npm run tauri build                       # release + NSIS installer → src-tauri\target\release\bundle\nsis\
```

**CI** (`.github/workflows/ci.yml`, matrix `windows-latest`, `ubuntu-22.04`, `macos-latest`, `fail-fast: false`) runs
`npm ci`, `tsc --noEmit`, `vitest run`, `npm run build` (`generate_context!` needs `dist/`), `cargo test` (Windows:
ConPTY tests with pwsh/cmd; macOS / Linux: `pty/tests_unix.rs` and the `pty/job.rs` containment tests with `sh`) and
a non-fatal `cargo clippy` on every push to `main` and every PR, then builds the debug app binary and runs
`scripts/ci/self-test.sh` on it (`--gk-self-test` on all three OSes; `--gk-self-test-gui` under Xvfb on Ubuntu,
informational on macOS; section 10). AppVeyor (`appveyor.yml`, `scripts/ci/appveyor.{sh,ps1}`) runs the same steps
while GitHub Actions is unavailable. Ubuntu first installs `libwebkit2gtk-4.1-dev
libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev libssl-dev patchelf build-essential`. A `v*` tag, or a manual
run (`workflow_dispatch` with `installers: true`, e.g. `gh workflow run ci.yml --ref <branch> -f installers=true`),
additionally runs `tauri build` on each OS (macOS: `--target universal-apple-darwin`, one dmg for Apple Silicon and
Intel), runs the same self-tests against the release binary, and uploads the NSIS installer, the dmg, and the
AppImage + deb as workflow artifacts; it does **not** create a GitHub release. Live CDP e2e stays local (it needs a
desktop session).

**Live verification (always do this for UI or lifecycle changes), in a sandbox:**

```powershell
npm run sandbox                                              # wait for the window "Gridkeeper [sandbox: dev]"
$env:CDP_PORT = 9333
node scripts/e2e/cdp.mjs file scripts/e2e/full-verify.js
node scripts/e2e/cdp.mjs file scripts/e2e/mission.js        # Mission Control board, FS watch, sign-off evidence
node scripts/e2e/cdp.mjs shot shot.png                       # then look at the PNG
npm run sandbox:stop -- -Name dev
```

`formation.js` still needs its `__REPO__` placeholder replaced with a throwaway repo path before running.

**Benchmarks:** `pwsh -File scripts/bench/run-all.ps1 -Exe src-tauri/target/release/gridkeeper.exe` → `bench-results/summary.csv`;
compare with [PERFORMANCE.md](PERFORMANCE.md) (idle 6 sessions: host 0.06 %, WebView2 0.42 % CPU).

**Showcase:** `node scripts/showcase/record.mjs docs/assets/showcase` (dev app with CDP, ffmpeg on PATH).

**README art:** `node docs/assets/readme/tools/gen-readme-art.mjs docs/assets/readme`. SVG animations must be 2D CSS
(Chromium flattens 3D transforms on SVG elements); verify in a real `<img>` in real time, since headless
`--virtual-time-budget` doesn't drive SVG-image animation clocks reliably.

**Release:**

```powershell
# bump version in package.json, src-tauri/Cargo.toml and src-tauri/tauri.conf.json,
# and the static release badge + the installer file names in the README Install table
npm run tauri build                       # or push the tag and take the installer from the CI run's artifact
gh release create v0.1.2 "src-tauri\target\release\bundle\nsis\Gridkeeper_0.1.2_x64-setup.exe" `
  -R raazi29/gridkeeper --title "Gridkeeper v0.1.2" --notes-file notes.md
```

v0.1.2 is the pending one: the commit and version bump exist, the release was never published.

**Package manifests** (after the release is published with all installers attached; the README one-liners point at
them):

```powershell
node scripts/release/update-manifests.mjs             # version from package.json; add --dry-run to preview
# before the release is public, hash the downloaded CI artifacts instead: ... --dir <folder with the installers>
winget validate --manifest packaging/winget/manifests/r/raazi29/Gridkeeper/<version>
git add bucket Casks packaging/winget                 # commit + push to main
```

This rewrites `bucket/gridkeeper.json` (Scoop), `Casks/gridkeeper.rb` (Homebrew; follows whichever dmg was built:
universal, both arches or one) and adds `packaging/winget/manifests/r/raazi29/Gridkeeper/<version>/`, with SHA-256s
from the release's asset digests (or by downloading the assets). Scoop and Homebrew users get the new version from
`main` on their next `scoop update` / `brew update`; winget needs a pull request to microsoft/winget-pkgs, see
[packaging/winget/README.md](../packaging/winget/README.md). Exit code 2 means an installer was missing and its
manifest was left unchanged. Tests: `npx vitest run scripts/release`.

## 6. Testing next to a live Gridkeeper

The developer builds Gridkeeper **while running the installed Gridkeeper** (`D:\Gridkeeper\gridkeeper.exe`) with
many live agents inside it, including the agents working on this repo. Nothing you do may disturb that instance.
What goes wrong otherwise:

- A dev/test build has the same identifier (`app.gridkeeper.desktop`). Started plainly, it either hits the
  single-instance lock (it just focuses the live window and exits) or shares
  `%APPDATA%\app.gridkeeper.desktop\workspaces.json` and the WebView2 profile with the live app.
- Heavy cargo builds can exhaust commit on this 16 GB box; Windows then kills WebView2 processes, including the
  live app's (black window, crash; see the `0x8007139F` quirk below).
- e2e scripts create and close sessions and workspaces in whatever instance they connect to.

**Use the sandbox script:**

```powershell
npm run sandbox                                   # = pwsh -NoProfile -File scripts/dev/sandbox.ps1 (dev mode, name "dev")
npm run sandbox -- -DryRun                        # print checks, env and command; change nothing
pwsh -NoProfile -File scripts/dev/sandbox.ps1 -Mode release -Name rel -CdpPort 9334   # target\release\gridkeeper.exe
pwsh -NoProfile -File scripts/dev/sandbox.ps1 -Mode exe -Exe C:\path\gridkeeper.exe -Fresh
npm run sandbox:stop -- -Name dev                 # stops only what sandbox.ps1 started
```

- It sets `GRIDKEEPER_SANDBOX=<name>` (own data folder `...\sandboxes\<name>`, own WebView2 profile, no
  single-instance lock, title `Gridkeeper [sandbox: <name>]`),
  `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<port>`,
  `WEBVIEW2_USER_DATA_FOLDER=<sandbox>\EBWebView`, `CARGO_BUILD_JOBS` (`-Jobs`,
  default 2), `RUST_MIN_STACK=16777216` and `CDP_PORT`, for the child process only, and starts it at below-normal
  priority. Dev mode logs to `<sandbox>\sandbox-logs\sandbox.log`.
- **CDP port 9333** by default. 9222 is refused: the developer may use it for their own instance.
- **Memory guard:** it reads free commit (`Win32_OperatingSystem.FreeVirtualMemory`) and free RAM and refuses to
  start a dev build below 4 GB of free commit (`-MinFreeCommitGB`; 1.5 GB for `release`/`exe`). `-Force` overrides.
- Dev mode fails fast when Vite's port 1420 is taken (another `tauri dev`, maybe from another worktree): only one
  dev sandbox at a time; use `-Mode release`/`exe` for a second instance.
- `-Fresh` deletes that sandbox's data folder first, only ever `...\sandboxes\<name>` (no junctions, not while the
  sandbox runs).
- The PID it started is recorded with its creation time and command line in `<sandbox>\sandbox-launch.json`.
  `sandbox-stop.ps1` re-verifies both before it touches anything, closes the app window politely, then stops the
  remaining tree. **Never** `Stop-Process -Name gridkeeper`, `taskkill /IM gridkeeper.exe` or kill `msedgewebview2`
  by name: that kills the live app and every agent in it.
- Started from an agent's pane, the sandbox lives inside that pane's Job Object: closing the pane stops it too.
- `cdp.mjs file` (and `record.mjs`) refuse to run unless `ipc.appInfo().sandbox` is set; `E2E_ALLOW_LIVE=1`
  overrides for a dev instance you really mean. `eval` and `shot` are not guarded. e2e scripts need a dev build
  (`window.__gridkeeper` exists only there) and get their working folder from `E2E_CWD` (default: the current
  directory).

**Parallel agents and builds:** every worktree has its own `src-tauri\target` (several GB each, and a full rebuild).
Agents that build share one cache with `$env:CARGO_TARGET_DIR = 'D:\AlteraAI\src-tauri\target'` (or
`sandbox.ps1 -TargetDir ...`) and keep `CARGO_BUILD_JOBS` at 2. Cargo's lock on a shared target folder makes
concurrent builds wait for each other, which is what you want on this machine. Don't run `cargo build`/`tauri build`
from an agent at all when the memory guard would refuse.

## 7. Environment quirks

- **Run cargo only from PowerShell.** Git Bash's `/usr/bin/link.exe` shadows the MSVC linker.
- **Low RAM / rustc stack overflow:** `$env:RUST_MIN_STACK='16777216'; $env:CARGO_BUILD_JOBS=2`.
- **WebView2 `0x8007139F` flooding the log mid-session:** the WebView2 browser process died, usually because the
  machine ran out of commit (System log event 2004). Before 0.1.2 this left a black window; `webview_guard` now
  rebuilds the window. Look for `WebView2 process failed` in the log.
- **WebView2 `0x8007139F` at startup:** another instance holds the default WebView2 user-data folder with different
  browser arguments (for example a normal instance while you start one with `--remote-debugging-port`). Use the
  sandbox script (its own profile), or set `WEBVIEW2_USER_DATA_FOLDER` to a separate folder
  (`scripts/bench/run-all.ps1` does this per scenario). Don't "fix" it by closing the live app.
- **Vite HMR vs e2e:** a dynamic `import()` from a CDP script gets a fresh module instance after HMR. Use the dev
  handles `window.__gridkeeper` (`store`, `sessions`, `registry`, `ipc`, `mission`, `commands`),
  `window.__gridkeeperTerminals.list()/text(id)` and `window.__gridkeeperForceContextLoss(id?)`.
- **Vite watcher** ignores agent worktrees and bench results (`vite.config.ts`). Keep it that way, or every
  worktree write reloads the dev app.
- **Mixed CRLF/LF.** `core.autocrlf=false`. Keep each file's existing endings (Git Bash `sed -i` silently converts
  CRLF to LF, so use `perl -pi` or the Edit tool). For whole-file merge conflicts caused by endings:
  `scripts/dev/eol-merge.sh <branch>` during the conflicted merge.
- **Headless Edge on this machine reports `prefers-reduced-motion: reduce`.** Pass `--force-prefers-no-reduced-motion` when screenshotting animations.
- e2e scripts take their working folder from the `E2E_CWD` global that `cdp.mjs file` injects (env `E2E_CWD`,
  default: the current directory).
- Windows notifications show the right name and icon only from the installed app; dev builds appear under PowerShell.

## 8. Known issues and limitations

- macOS / Linux: not live-verified yet, orphaned agents after a hard host crash, no GPU telemetry; full list in
  [section 10](#10-platforms-windows-macos-linux).
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
- Private vulnerability reporting is **disabled** in the repo settings
  (`gh api repos/raazi29/gridkeeper/private-vulnerability-reporting` → `{"enabled":false}`), so the link in
  SECURITY.md doesn't work yet. Enable it under Settings › Code security (or
  `gh api -X PUT repos/raazi29/gridkeeper/private-vulnerability-reporting`), then drop the fallback note in SECURITY.md.
- The v0.1.2 GitHub release is still unpublished (see section 5).

## 9. The multi-agent workflow that worked

- **One worktree per agent** (`.claude/worktrees/agent-*`, branch `worktree-agent-*`). Never share a checkout.
- **Disjoint file ownership.** Each brief lists exactly which files the agent may touch. Shared hot spots
  (`types.rs`/`types.ts`, `commands.ts`, `combo.ts`, `README.md`) belong to one agent per round or go through the
  integrator.
- **Contract first.** Agree on IPC types and command names in the brief before parallel work starts.
- **Integrator merges.** One session merges branches into `main` in order, resolves conflicts (`eol-merge.sh` for
  CRLF noise), runs `tsc` + `vitest` + `cargo test`, then the live suite.
- **Live CDP verification** of every feature in a sandbox instance (`npm run sandbox`, `full-verify.js`,
  `mission.js`, screenshots that are actually looked at), not only unit tests. Never against the live app.
- **Builds are shared and throttled.** One `CARGO_TARGET_DIR`, `CARGO_BUILD_JOBS=2`, the sandbox memory guard; a
  machine that runs out of commit takes the developer's live agents down with it (section 6).
- **Coordinate through the mission file.** `<projectDir>/.gridkeeper/mission.md` is the team's task board; agents
  update their own task lines (`[~]`, `[x]`, `[!]`) and Mission Control shows it live.
- **Evidence over assumption.** Research notes mark findings VERIFIED vs hypothesis; performance claims come from
  `scripts/bench`; agent CLI flags come from each tool's docs or `--help`.
- **Never send prompts to real agents in tests**, and never show account e-mails in screenshots or logs.

## 10. Platforms: Windows, macOS, Linux

Windows is the reference platform: everything in sections 1–9 was built and verified there. macOS and Linux build,
run the unit and PTY tests, and start the built binary in CI (section 5 and "What CI proves" below), but **nobody
has driven the app on a Mac or a Linux desktop yet**: treat every Unix behaviour below as "implemented, CI-tested,
not live-verified" until someone does. Research behind this section, with sources and a prioritized checklist:
[research-notes/macos-linux-readiness.md](research-notes/macos-linux-readiness.md).

| Area | Windows | macOS | Linux |
|---|---|---|---|
| Terminal | ConPTY (system `conpty`) | Unix pty (portable-pty) | Unix pty (portable-pty) |
| Process containment (`pty/job.rs`) | Job Object, `KILL_ON_JOB_CLOSE` | POSIX session of the root (`setsid` by portable-pty): `killpg` + every process with that session id + their live descendants | same as macOS |
| Graceful stop | Ctrl+C → close console (`CTRL_CLOSE_EVENT`) → `TerminateJobObject` | `^C` → SIGHUP (+ SIGCONT) to the session → SIGKILL | same as macOS |
| Host crash | kernel kills the trees | agents can be orphaned (see below) | same as macOS |
| Default terminal (`powershell` kind) | pwsh 7 → Windows PowerShell 5.1, `-NoLogo` | `$SHELL` → passwd → zsh → sh, started as a login shell (`-l`) | `$SHELL` → passwd → bash → zsh → sh, non-login |
| PowerShell | built-in default | catalog preset `pwsh` when on PATH | catalog preset `pwsh` when on PATH |
| Executable discovery | PATH + npm `.cmd` shim → `.exe`, `cmd.exe /d /c` fallback | PATH (`which`); at startup a GUI launch (no `TERM`) takes PATH from `$SHELL -i -l -c` (5 s cap), then Homebrew / `~/.local/bin` / npm / bun / volta / cargo / deno / asdf / mise / fnm / pnpm / nvm-default folders are appended | same as macOS (no Homebrew paths; Linuxbrew instead) |
| App menu | none | native menu (`app_menu.rs`); ⌘W / close button hide the main window (Dock icon, Window › Main Window or a second launch show it), ⌘Q quits | none |
| Unread count | title | title + Dock badge | title |
| CPU / RAM diagnostics | Toolhelp + `GetProcessTimes` | sysinfo walk (`procs.rs`) | sysinfo walk |
| WebView bucket | `msedgewebview2.exe` children | `com.apple.WebKit.*` XPC services attributed via `responsibility_get_pid_responsible_for_pid` (private API, looked up at runtime), best effort | `WebKitWebProcess` / `WebKitNetworkProcess` children, best effort |
| GPU telemetry | PDH counters | unavailable (UI says so) | unavailable |
| Ports | `GetExtendedTcpTable` | `lsof -nP -a -p <pids> -iTCP -sTCP:LISTEN` | `/proc/net/tcp{,6}` + `/proc/<pid>/fd` |
| Renderer crash recovery | `webview_guard` (reload / rebuild) | none | none |
| WebGL budget (`maxWebglFor`) | 12 | 12 (unmeasured) | 8 (unmeasured) |
| Primary shortcut modifier | Ctrl | ⌘ (stored as `ctrl`; ⌃ is `meta`) | Ctrl |
| Sandbox (`GRIDKEEPER_SANDBOX`) | own data + own WebView2 profile | own data, shared WebKit profile | own data, shared WebKit profile |
| Bundle (`tauri build`) | NSIS per-user | `app` + universal `dmg` (arm64 + x86_64), macOS 11+, ad-hoc signed | AppImage + deb |
| WebKit workarounds | — | — | `WEBKIT_DISABLE_DMABUF_RENDERER=1` set at startup with the NVIDIA proprietary driver or in an AppImage, unless already set |

**Known Unix limitations (document them to users, fix them later):**

- **A hard crash of Gridkeeper can orphan agents.** There is no kernel object like a kill-on-close Job. A normal quit
  runs `shutdown_all`; SIGTERM / SIGINT / SIGHUP to the host go through the normal exit path (`platform.rs`, with a 5 s
  fallback that SIGKILLs every registered session); a main-thread panic kills the sessions from the panic hook. A
  SIGKILL, segfault, abort or power loss leaves the shells and agents running (re-parented to init / launchd). Linux
  `PR_SET_PDEATHSIG` was rejected: it is not inherited across `fork` and fires when the *spawning thread* exits.
  A real fix is a tiny supervisor process or Linux cgroups (ROADMAP item 12).
- Processes that call `setsid()` themselves *and* outlive their parent (daemons, `nohup … &` + `disown` of a new
  session) escape the container, like a Job breakaway would.
- No GPU telemetry; WebView figures are best effort (macOS relies on a private libsystem function; when it is missing
  the WebView row is just 0).
- WebKit is not Chromium: the WebGL budget (`maxWebglFor`; WebKit itself force-loses beyond 16 active contexts, like
  Chromium), the iframe sandbox / CSP behaviour of browser panes, IME and clipboard paths, and xterm's WebGL renderer
  under WebKitGTK must be re-measured on real machines.
- macOS notifications go through the plugin's deprecated NSUserNotification path; whether they show for the ad-hoc
  signed release on macOS 14 / 15 is unknown (in-app toasts, the title count and the Dock badge don't depend on it).
- ⌘Q quits without asking even while agents run (Terminal.app asks); tao exposes no `applicationShouldTerminate`.
- Linux AppImage: the AppImage's GTK variables (`GTK_PATH`, `GIO_MODULE_DIR`, `XDG_DATA_DIRS` prefix …) are inherited
  by the shells in panes; the `.deb` is the recommended package. On Ubuntu 24.04 the AppImage needs `libfuse2t64`.
- No renderer-crash recovery (a dead web process means reloading the page by hand).
- The sandbox scripts (`scripts/dev/sandbox*.ps1`) and benchmarks are PowerShell/Windows tools; on Unix set
  `GRIDKEEPER_SANDBOX=<name>` yourself. A sandbox shares the WebKit profile (localStorage, so saved formations) with
  a normal instance.
- macOS builds are ad-hoc signed, not notarized: Gatekeeper blocks the first launch. macOS 15: open once, then System
  Settings › Privacy & Security › **Open Anyway** (offered for about an hour) + password; right-click › Open no longer
  bypasses Gatekeeper on 15 (it still does on 14). Or `xattr -dr com.apple.quarantine /Applications/Gridkeeper.app`.
- Hermes' Unix default home is assumed to be `~/.hermes` (unverified on a real install).

**Type-checking Unix code on this Windows box (no WSL):** `pwsh -NoProfile -File scripts/dev/unix-check.ps1`
(once: `rustup target add x86_64-unknown-linux-gnu aarch64-apple-darwin`). It runs `cargo check --lib --tests` for
Linux and macOS without linking anything: the `*-sys` build scripts get a fake `pkg-config` that "finds" every library
(`PKG_CONFIG` + `PKG_CONFIG_ALLOW_CROSS=1`), and the few crates that compile C for macOS get a fake `cc` / `ar`. The
first run takes ~15–20 minutes per target with 2 jobs (shared target folder, memory guard like the sandbox script) and
catches cfg / API mistakes in `#[cfg(unix)]` code. It runs nothing; the CI matrix is still the real test.

**What CI proves (every push to `main` / PR, and again on the release binary of a `v*` tag):**

- `--gk-self-test`, all three OSes, fatal: the binary starts (on Linux the dynamic loader resolved WebKitGTK / GTK),
  `init_process_env` runs, the login shell answers the PATH lookup (macOS / Linux), the data folder is writable, the
  default terminal starts through `resolve_launch` in a real PTY and runs a typed command (its marker output is
  checked), and a forced stop leaves no process of a tree with a background child and an orphaned grandchild.
  On a Universal binary built on an Apple Silicon host with Rosetta, the Intel slice is checked too (not fatal).
- `--gk-self-test-gui`, Ubuntu under Xvfb, fatal: GTK and WebKitGTK start, the main window and webview exist, the
  frontend bundle loads (from `vite preview` for the debug binary, embedded for the release binary), `app_info`
  returns to JS and `state_load` reaches Rust. The same step runs on macOS but only reports (it needs a GUI session
  on the build machine; when it passes it also proves the native menu builds). `GK_GUI_SELF_TEST=required|optional|off`.
- Run it locally: `gridkeeper --gk-self-test` (Windows release exe: `gridkeeper.exe --gk-self-test | Out-String`, it
  is a GUI-subsystem binary). On this Windows box the run takes about 1.3 s.

**What still needs a person with a Mac / a Linux desktop:** the first launch of the downloaded dmg (Gatekeeper,
Open Anyway on 15), ⌘C / ⌘V / ⌘A / ⌘Z in text fields and terminals (exactly one paste), ⌘W → hidden → Dock click
restores, ⌘Q stops the agents, the Dock badge, notifications, retina sharpness (`window.devicePixelRatio` should be 2)
and WebGL with many terminals, the login-shell PATH with real dotfiles (nvm / fnm / asdf, Claude Code in
`~/.local/bin`), IME input, App Nap while hidden, full screen; on Linux: NVIDIA (X11 and Wayland), the AppImage on
Ubuntu 24.04, the `.deb` desktop entry and dock icon on GNOME / KDE, notifications.

## 11. Agent browser

Agents drive one shared browser (a tab each) through MCP tools; the user watches every tab in the *Agent browser*
view and can take over. Research and the option comparison (Playwright MCP, chrome-devtools-mcp, built-in):
[research-notes/agent-browser.md](research-notes/agent-browser.md).

| Path | What lives there |
|---|---|
| `src-tauri/src/agent_browser/mod.rs` | Overview, constants (`gk-browser` server name, `--gk-mcp-browser`, `GK_AGENT_BROWSER_TOKEN`). |
| `agent_browser/mcp.rs` | Helper mode (dispatched from `main.rs` before Tauri): dual-era MCP over stdio (`initialize` and `server/discover`), each `tools/call` forwarded to the host on its own thread and connection. |
| `agent_browser/ipc.rs` | Helper ⇄ host transport: per-user named pipe (DACL user + SYSTEM, `FILE_FLAG_FIRST_PIPE_INSTANCE`, `PIPE_REJECT_REMOTE_CLIENTS`) / Unix socket in a 0700 folder; one JSON line each way; peer pid. |
| `agent_browser/launch.rs` | Injection: Claude `--mcp-config=<data>\agent-browser\mcp-<session>.json` (skipped when `managed-mcp.json` exists), Codex `-c mcp_servers.gk-browser.*` (TOML literal strings, `tool_timeout_sec = 600`). Called from the two adapters. |
| `agent_browser/chrome.rs` | Find Edge / Chrome / Chromium; launch headless with `--remote-debugging-pipe` (Windows: inherited pipe handles via `--remote-debugging-io-pipes` + CRT fds 3/4, suspended start, own Job Object; Unix: fds 3/4, `setsid`, session container). |
| `agent_browser/cdp.rs` | CDP client: NUL-delimited JSON, flat sessions, blocking calls with timeouts, `call_until` (gives up when a JS dialog opens). |
| `agent_browser/hub.rs` | State: browser lifecycle, a browser context + page per session, auth (token + session process tree), take-over, confirmations, screencast watch, janitor (`plan_janitor`). |
| `agent_browser/events.rs`, `actions.rs`, `page.rs` + `page.js` | CDP events (console / network rings, dialogs, popups, downloads, crashes, frames); tool implementations; the in-page helper evaluated in an isolated world (snapshot with refs, hit-test, focus, select). |
| `agent_browser/config.rs`, `policy.rs`, `model.rs` | `<data>\agent-browser\config.json` (opt-ins, allowlist, idle minutes); URL / allowlist policy; IPC types (mirrored at the end of `src/lib/types.ts`). |
| `commands/agent_browser.rs` | `agent_browser_*` commands; events `agent-browser-state`, `agent-browser-activity`. |
| `src/components/agentBrowser/*` | View (grid of live tabs, focus with take-over, action log, allowlist), confirmation prompts, store, frame / input helpers. |

**Invariants:**
- One browser per Gridkeeper instance, never a DevTools port. Started on the first tool call; stopped after `idleMinutes`
  (default 10) with no tool call and no viewer, 60 s after the last tab closed, from the view, and on app exit. Windows:
  its own kill-on-close Job Object (a crash of the host kills it). macOS / Linux: its own POSIX session, killed on exit /
  by the exit guards; a hard crash can orphan it like agents.
- A tool call reaches only its own session's page. Requests carry the session id and a per-launch token (rotated on every
  start, sent through the MCP config's `env`); the host also checks that the connecting pid is in that session's tree.
- The opt-in lives in `config.json`, not in `workspaces.json` / `SessionMeta` (the shared IPC contract stays untouched);
  sessions that no longer exist are pruned at startup. It applies at launch, so the UI says "restart to apply".
- Confirmation (the tool call waits up to 2 minutes, then counts as no): form submission (submit button, Enter in a form,
  `submit: true`) or `browser_evaluate` when the page or form target is outside loopback / the allowlist / this machine's
  private addresses on a session's dev-server port; every upload; every download (it lands in
  `<data>\agent-browser\downloads\<session>\<guid>` and is deleted unless allowed). Navigation is http(s) / about:blank only.
- Each agent gets its own browser context (separate cookies and storage), discarded with the tab. Popups are closed and
  reported. Password values never appear in snapshots or logs; queries are dropped from logged URLs.
- Screencast only while the view shows a tab and the window is visible; acks at most every 100 ms.

**Memory (estimates, not measured on this machine yet):** headless Edge with one about:blank tab ≈ 150-250 MB (browser,
GPU / utility and one renderer); each further agent tab ≈ 30-100 MB depending on the app; the helper per agent ≈ 5-10 MB
(the Gridkeeper binary without a window). Compare: one Playwright MCP / chrome-devtools-mcp per agent = a Node process
(~50-80 MB) plus, unless attached to a shared browser, a whole browser per agent.

**Live checks still to do (integrator):** a Claude Code pane and a Codex pane with the box ticked list the `gk-browser`
tools and keep the user's own MCP servers; `browser_navigate http://localhost:<dev port>` → snapshot → click → console;
take over / hand back while a call waits; a form on an external site prompts; a download prompts; closing the pane closes
the tab within ~75 s and the browser ~60 s later; app exit leaves no `msedge.exe` with `agent-browser\profile` in its
command line; Edge on a managed PC (policy `RemoteDebuggingAllowed`) shows the error in the view; the `--mcp-config=`
form is accepted by the installed Claude Code; Codex accepts the `-c` overrides through the npm shim. `cargo test --lib
agent_browser::tests::live_ -- --ignored` runs the browser path headless without the app.

**Follow-ups:** manual setup for other agent CLIs needs a token they can read (today only launched Claude / Codex
sessions authenticate); iframes are not in snapshots; no `browser_tabs` (one tab per agent by design); the take-over
view has no clipboard bridge (use the "type text" box).
