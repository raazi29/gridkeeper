# Contributing to Gridkeeper

Thanks for helping. Gridkeeper is a Windows-native multi-agent terminal workspace: a Tauri 2 host in Rust and a
React 19 + TypeScript + xterm.js 6 UI in WebView2. This guide covers dev setup, the checks a change has to
pass, and the rules that keep the app fast and safe.

Before you change something non-trivial, read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (what the code does) and
[docs/TECHNICAL_DECISIONS.md](docs/TECHNICAL_DECISIONS.md) (why). [docs/HANDOFF.md](docs/HANDOFF.md) is the short
version.

## Contents

- [Dev setup (Windows)](#dev-setup-windows)
- [Running a test instance next to your own Gridkeeper (sandbox)](#running-a-test-instance-next-to-your-own-gridkeeper-sandbox)
- [Run, test, typecheck](#run-test-typecheck)
- [Live end-to-end checks (CDP)](#live-end-to-end-checks-cdp)
- [Benchmarks and showcase recording](#benchmarks-and-showcase-recording)
- [Code style and invariants](#code-style-and-invariants)
- [Security rules](#security-rules)
- [The IPC contract](#the-ipc-contract)
- [Recipes: theme, agent, command + keybinding](#recipes)
- [Branches, commits and pull requests](#branches-commits-and-pull-requests)

## Dev setup (Windows)

Gridkeeper builds and runs on **Windows 10 1809+ / Windows 11** only (ConPTY, Job Objects, WebView2).

| Tool | Version | Notes |
|---|---|---|
| Node.js | 22+ | The e2e driver uses Node's built-in `WebSocket`. |
| Rust | stable ≥ 1.95 (tested with 1.99.1), MSVC toolchain | `rustup default stable-x86_64-pc-windows-msvc` |
| Visual Studio 2022 Build Tools | *Desktop development with C++* + **Windows 11 SDK** | Provides `link.exe`, the CRT and the Windows headers. |
| WebView2 Runtime | any current | Preinstalled on Windows 11. |
| Optional | PowerShell 7, Claude Code, Codex, ffmpeg | Agents are auto-detected; ffmpeg is only for the showcase recorder. |

```powershell
git clone https://github.com/raazi29/gridkeeper.git
cd gridkeeper
npm install
npm run tauri dev      # Vite on localhost:1420 + the Rust host
```

**Run `cargo` and `npm run tauri …` from PowerShell** (or a VS Developer prompt), never from Git Bash. Git Bash puts
its own `/usr/bin/link.exe` on `PATH`, which shadows the MSVC linker and breaks the build with confusing errors.

**Low-RAM machines.** The release profile uses LTO and one codegen unit. If rustc runs out of memory or overflows
its stack, limit parallelism and raise the stack size:

```powershell
$env:RUST_MIN_STACK = '16777216'
$env:CARGO_BUILD_JOBS = 2
npm run tauri build
```

`npm run tauri build` writes the NSIS installer (per-user install) to `src-tauri\target\release\bundle\nsis\`.

## Running a test instance next to your own Gridkeeper (sandbox)

If you use Gridkeeper itself while you work on it (with agents running in it), don't start a second copy plainly:
it shares the identifier `app.gridkeeper.desktop`, so it either just focuses your running window (single-instance
lock) or shares your `workspaces.json` and WebView2 profile. Run a **sandbox** instead:

```powershell
npm run sandbox                     # dev build (npm run tauri dev) as sandbox "dev", CDP on port 9333
npm run sandbox -- -DryRun          # show the checks, environment and command without starting anything
npm run sandbox:stop -- -Name dev   # stop it (only the process tree the script started)
```

`scripts/dev/sandbox.ps1` sets `GRIDKEEPER_SANDBOX=<name>`, which gives the instance its own data folder
(`%APPDATA%\app.gridkeeper.desktop\sandboxes\<name>`), its own WebView2 profile, no single-instance lock and the
title `Gridkeeper [sandbox: <name>]`. It also:

- opens the CDP port for the e2e scripts (`-CdpPort`, default 9333; 9222 is left to you);
- refuses to start a dev build with less than 4 GB of free commit (`-MinFreeCommitGB`, `-Force` to override), because
  a machine that runs out of memory kills WebView2 processes, including your running Gridkeeper's;
- builds with `CARGO_BUILD_JOBS=2` (`-Jobs`), `RUST_MIN_STACK=16777216` and below-normal priority;
- fails fast if Vite's port 1420 is taken (only one dev sandbox at a time; `-Mode release` runs
  `src-tauri\target\release\gridkeeper.exe`, `-Mode exe -Exe <path>` any build);
- `-Fresh` wipes that sandbox's data folder first (never anything outside `...\sandboxes\<name>`).

Never stop a test instance by process name (`Stop-Process -Name gridkeeper`, `taskkill /IM ...`): that also kills
the Gridkeeper you are working in. Use `sandbox:stop`, which verifies the recorded PID before touching it. Several
worktrees building at once can share one cache with `$env:CARGO_TARGET_DIR` (or `-TargetDir`).

## Run, test, typecheck

Run all of these before opening a pull request:

```powershell
npx tsc --noEmit                 # or: npm run typecheck
npx vitest run                   # frontend unit tests (or: npm test)
cd src-tauri; cargo test         # Rust unit tests + ConPTY integration tests (spawn real pwsh/cmd)
```

- CI (`.github/workflows/ci.yml`, `windows-latest`) runs the same three checks, after `npm run build`, on every
  push to `main` and every pull request.
- The ConPTY tests spawn real processes. Run them from PowerShell.
- `cargo test --test live_profiles -- --ignored --nocapture` runs optional live checks against your real Claude
  profiles. It prints no e-mail addresses. Never paste its output if you are unsure what it contains.
- Theme changes must pass `npx vitest run src/theme` (the WCAG contrast gate).

## Live end-to-end checks (CDP)

The e2e scripts drive a **running dev sandbox** over the Chrome DevTools Protocol. Nothing is mocked.

```powershell
npm run sandbox                    # see the sandbox section above; wait for "Gridkeeper [sandbox: dev]"
# in a second PowerShell:
$env:CDP_PORT = 9333
node scripts/e2e/cdp.mjs file scripts/e2e/full-verify.js     # the full suite (dedicated "Verify" workspace, PowerShell panes only)
node scripts/e2e/cdp.mjs file scripts/e2e/ps-basic.js        # prompt, echo, Unicode, 20,000 lines
node scripts/e2e/cdp.mjs file scripts/e2e/mission.js         # Mission Control task board (temp git repo, PowerShell panes only)
node scripts/e2e/cdp.mjs eval "window.__gridkeeperTerminals.list()"
node scripts/e2e/cdp.mjs shot out.png
npm run sandbox:stop -- -Name dev
```

- `cdp.mjs file` refuses to run unless the instance reports a sandbox (`ipc.appInfo().sandbox`), because the scripts
  create and close sessions and workspaces. `E2E_ALLOW_LIVE=1` overrides that for a dev instance you really mean.
  `eval` and `shot` are not guarded.

- In dev builds the page exposes stable handles for tests: `window.__gridkeeper` (`store`, `sessions`, `registry`,
  `ipc`, `mission`, `commands`), `window.__gridkeeperTerminals.list()/text(id)` and
  `window.__gridkeeperForceContextLoss(id?)`. Use these, not dynamic `import()` from a test, because Vite HMR gives a
  fresh module instance and you would be talking to a stale store.
- Scripts get their working folder as the global `E2E_CWD`, which `cdp.mjs` injects from the `E2E_CWD` environment
  variable (default: the current directory, so run them from your checkout).
- Scripts that start AI agents (`multi-agent.js`, `codex-*.js`) never send prompts. Keep it that way.
- If WebView2 fails to start with `0x8007139F`, another Gridkeeper instance holds the default WebView2 profile with
  different browser arguments. Use the sandbox script (it has its own profile), or set `WEBVIEW2_USER_DATA_FOLDER`
  to a separate folder (as `scripts/bench/run-all.ps1` does).

## Benchmarks and showcase recording

```powershell
npm run tauri build
pwsh -File scripts/bench/run-all.ps1 -Exe src-tauri/target/release/gridkeeper.exe   # writes bench-results/summary.csv
pwsh -File scripts/bench/sample.ps1 -Seconds 60 -Label idle-6 -OutDir bench-results    # sample one running instance
```

Bench mode (`GRIDKEEPER_BENCH=sessions=6;mode=sustained;...`) uses an in-memory workspace and never touches your
data; `run-all.ps1` only stops instances it started. A change that touches the output path, rendering, polling or
the registry should include before/after numbers from these scripts (see [docs/PERFORMANCE.md](docs/PERFORMANCE.md)).

The README demo is recorded from the real app:

```powershell
# dev sandbox running (npm run sandbox), ffmpeg on PATH
$env:CDP_PORT = 9333
node scripts/showcase/record.mjs docs/assets/showcase
```

It uses a dedicated "Showcase" workspace with PowerShell panes only (no accounts, no e-mails on screen).

## Code style and invariants

Match the surrounding code: naming, comment density, file layout. Keep changes focused. The rules below are not
style preferences. Each one exists because breaking it caused a real bug or a measurable regression.

**Frontend**

- **Terminal output never goes through React or zustand state.** Bytes go from the IPC channel straight to
  `term.write()` in `src/terminal/registry.ts`, the single owner of xterm instances. Panes subscribe only to coarse
  runtime state (state, pid, exit code).
- **Narrow zustand selectors, and never build new objects inside a selector.** `useApp(s => s.runtime[id]?.state)`
  is fine. `useApp(s => ({ a: s.a, b: s.b }))` or `.filter()`/`.map()` inside a selector returns a new reference on
  every store change and causes re-render loops (see commit `80b455c`). Select primitives, or derive with `useMemo`
  outside the selector.
- **No polling while idle.** Timers run only while a view that needs them is open and the window is visible
  (diagnostics poll, Mission Control rates, ports). Prefer events. A timer that runs with every panel closed is a bug.
- **Theme CSS variables only.** Colours, radii and shadows come from the tokens in `src/styles/tokens.css` (set per
  theme by `src/theme/applyTheme.ts`). No hard-coded hex values in components or CSS.
- **Effects never block input** and respect *Reduce motion*, unfocused panes and a backgrounded window.
- `src/lib/ipc.ts` is the only module that calls `invoke`. `src/actions/sessions.ts` is the only place that turns
  user intent into `session_*` calls.
- No React StrictMode: double-invoked effects would create and dispose terminals and channels twice.

**Rust**

- **Flow control never blocks the child.** The PTY reader only appends to the ring; a slow or hidden view makes the
  pump stop sending, never the reader stop reading (ADR-005).
- Commands on the main thread must be quick. Anything that launches a process or touches the disk heavily goes to
  `spawn_blocking`. Per-session threads run inside `spawn_guarded` (`catch_unwind`).
- Helper processes use `CREATE_NO_WINDOW`, closed stdin and a hard timeout (`adapters/process.rs`).
- `cargo fmt` style; no new `unwrap()` on paths that handle user or process input.

## Security rules

Gridkeeper runs next to your agents' credentials. These rules are absolute:

- **Never read credential files.** Check for existence by filename only (`.credentials.json`, auth files of any
  agent). Login state comes only from each CLI's own status command (`claude auth status --json`,
  `codex login status`). Claude transcripts are checked by directory listing only.
- **Never write inside an agent's config/home directory**, except creating an empty folder for a new account.
- **No secrets in arguments, logs or files.** Identity variables are stripped from agent environments;
  secret-looking env keys are never persisted; anything that reaches a log, an error message or a diagnostics
  bundle goes through `redact.rs`. Account e-mails go to the UI only, never to logs or disk.
- **Terminal output is untrusted.** Render it only through xterm, never as HTML.
- **Browser panes stay sandboxed.** Never add `allow-top-navigation*` or `allow-popups` to `FRAME_SANDBOX`, never
  frame the app's own origins, and keep the Tauri capability scoped to the `main` webview (ADR-019).
- No telemetry, no network calls of the app's own, no local HTTP server.
- Don't commit test output, screenshots or logs that show e-mail addresses, tokens or private paths.

Found a vulnerability? Don't open a public issue. See [SECURITY.md](SECURITY.md).

## The IPC contract

`src-tauri/src/types.rs` (serde, `camelCase`) and `src/lib/types.ts` describe the same types. **Change them in
the same commit.** A field added on one side only is a silent runtime bug, because nothing checks the boundary at
compile time.

Adding a Tauri command:

1. Implement it in `src-tauri/src/commands/{session,services,app,tools}.rs`. Slow work goes to `spawn_blocking`.
2. Register it in `tauri::generate_handler![…]` in `src-tauri/src/lib.rs`.
3. Add or extend types in `types.rs` **and** `types.ts`.
4. Add a typed wrapper in `src/lib/ipc.ts`.
5. If it needs a new plugin permission, add it to `src-tauri/capabilities/default.json` (main webview only) and say
   why in the PR.

## Recipes

### Add a theme

1. Append a `Theme` object to `THEMES` in `src/theme/themes.ts` with a unique kebab-case `id`. Define every base
   UI token and the full 16-colour terminal palette; derived tokens are computed in `tokens.css`.
2. Run `npx vitest run src/theme`. The contrast test enforces ≥ 7:1 for terminal and body text, ≥ 4.5:1 for
   secondary text and ANSI colours, and more (see the header of `src/theme/themes.test.ts`).
3. Optional structural accents go in `src/styles/signature.css` under `:root[data-theme="<id>"]`, and must honour
   `[data-reduce-motion]` and `[data-app-blurred]`.
4. It appears in Settings › Appearance, the quick switcher and the command palette automatically.

Theme names are generic homages. Don't use trademarked names, logos or official fonts.

### Add an agent CLI

Most tools need only **one catalog entry**: add a `CatalogEntry` to `CATALOG` in
`src-tauri/src/adapters/catalog.rs` (id, display name, executable names, launch / continue / pick / session flags,
optional home variable). Take flags from the tool's documentation and leave unverified resume flags as `None`; don't
guess. `agents_detect` probes it on PATH and the New Session dialog lists it automatically. Extend the test in
`catalog.rs` and cite your source in `docs/research-notes/agents-notifications-market.md`.

- **Account isolation** (several logins side by side) also needs a row in the spec table in
  `src-tauri/src/accounts.rs`, but only when the tool documents a home-directory variable and a status command
  that prints no secrets.
- **A first-class adapter** (custom discovery, resume logic, profile environment) implements the `AgentAdapter` trait;
  follow "Adding an agent" in [ARCHITECTURE §10](docs/ARCHITECTURE.md#10-agent-adapters) (new `AgentKind` on both
  sides of the IPC contract, `ADAPTERS` registration, `LAUNCH_GAP_MS`, tests in `adapters/tests.rs`).

### Add a command and a keybinding

1. Add a command (`id`, `category`, `run`) to `COMMANDS` in `src/actions/commands.ts` (or the themed
   lists in `experienceCommands.ts` / `terminalCommands.ts`) and its title as `"command.<id>"` in
   `src/i18n/locales/en.json` (and the other catalogs, see [docs/translating.md](docs/translating.md)). It shows up
   in the palette.
2. Optionally give it a default in `DEFAULT_BINDINGS` in `src/keybindings/combo.ts`. Defaults must pass
   `forbiddenReason()`: Gridkeeper never takes keys that shells, readline, TUIs and agents need. That rules out
   function keys, combos without Ctrl or Alt, Ctrl+Alt (AltGr), Win-key combos, Alt+letter, Ctrl+letter,
   Ctrl+arrows/editing keys and Ctrl+Shift+C/V. In practice new defaults are `Ctrl+Shift+<key>`.
3. `combo.test.ts` checks that defaults are allowed and unique; `commands.test.ts` checks that every bound id exists.
4. Update the keybinding table in `README.md`.

## Branches, commits and pull requests

- Branch from `main`: `feat/<topic>`, `fix/<topic>`, `docs/<topic>`, `perf/<topic>`.
- Commit subjects are short and say what changed, in the imperative or as a summary
  (`Ports poll only while a start page is on screen`). Put the reason in the body when it isn't obvious.
- One logical change per PR. Separate refactors from behaviour changes.
- Fill in the PR template: tests, `tsc`, `vitest`, `cargo test`, screenshots or a short clip for UI changes,
  benchmark numbers for performance-sensitive changes, and confirmation that no secrets are included.
- Update the docs that describe what you changed (README, ARCHITECTURE, an ADR for a real decision).
- The repo mixes CRLF and LF line endings. Keep each file's existing endings. If a merge reports a whole-file
  conflict where only a few lines differ, `scripts/dev/eol-merge.sh <branch>` re-runs the merge with endings
  normalized.

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE) and that you follow
the [Code of Conduct](CODE_OF_CONDUCT.md).
