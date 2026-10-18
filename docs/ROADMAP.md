# Gridkeeper: Roadmap

A prioritized idea backlog for future sessions. Nothing here is a promise. Each item gives the **why**, a sketch
of the **how**, and a rough **effort** (S ≈ a day or less, M ≈ a few days, L ≈ one to two weeks, XL ≈ more) for one
focused agent or developer, including tests and live verification. Before picking an item, read
[HANDOFF.md](HANDOFF.md) and check that the invariants it lists still hold after your design.

Principles every item must respect: local-first and no telemetry, credentials never read, no polling while idle,
flow control never blocks the child, never bind terminal-critical keys.

## P0: Trust and distribution

### 1. Code signing for the installer and binaries (S–M)
- **Why:** SmartScreen's "Windows protected your PC" is the first thing a new user sees, and it costs installs and
  trust. Signed binaries also make notifications and the taskbar identity more reliable.
- **How:** an Authenticode certificate (OV/EV, or Azure Trusted Signing) used through Tauri's
  `bundle.windows.signCommand` / `certificateThumbprint`; sign `gridkeeper.exe` and the NSIS installer; document the
  release steps in HANDOFF. Keep secrets out of the repo (CI secret store or local cert store only).

### 2. Auto-update via `tauri-plugin-updater` (M)
- **Why:** there's no update channel today; users have to watch the Releases page.
- **How:** `tauri-plugin-updater` with a signed update manifest (`latest.json`) published as a release asset
  (requires the updater key pair; the public key goes in `tauri.conf.json`). The check is **user-visible and
  opt-out**: once at startup and from the palette, never on a timer in the background. Release notes go in a toast;
  install on next restart so running agents aren't killed by surprise. Needs a public download URL: the repo is
  public now, so GitHub Releases can host `latest.json` and the installers. Depends on item 1.

### 3. CI on GitHub Actions (S–M), mostly done
- **Status:** `.github/workflows/ci.yml` runs `npm ci`, `tsc --noEmit`, `vitest run`, `npm run build` and
  `cargo test` (PTY tests included) on `windows-latest`, `ubuntu-22.04` and `macos-latest` for every push to `main`
  and every PR, with npm and cargo caches, plus a non-fatal `cargo clippy`; `v*` tags (or a manual run with
  `installers: true`) also run `tauri build` per OS and keep the NSIS / dmg / AppImage + deb as workflow artifacts.
- **Remaining:** live CDP e2e on a self-hosted Windows runner (`full-verify.js`, `mission.js` in a sandbox
  instance); publishing releases from CI once signing (item 1) exists; making `cargo clippy` / `cargo fmt --check`
  fatal gates.

## P1: Terminal fidelity and continuity

### 4. Sideloaded ConPTY (OpenConsole 1.25+) for OSC 7501 / DA1 pass-through (M–L)
- **Why:** the inbox ConPTY swallows or rewrites some sequences. Claude's OSC 7501 status and DA1 responses don't
  pass through reliably, which limits attention detection and terminal capability negotiation (ADR-003 deferred
  this).
- **How:** ship `conpty.dll` + `OpenConsole.exe` from the Windows Terminal release (MIT) next to the app and load
  `CreatePseudoConsole` from it when present (fallback to the system one). portable-pty doesn't expose this, so
  either patch it or call `CreatePseudoConsole` directly. Verify Job Object containment of `OpenConsole.exe`,
  the CPR invariant and the attention scanner against the new host, and re-run benchmarks.

### 5. Process survival across app restarts via a background daemon (XL)
- **Why:** the #1 known limitation: quitting or updating Gridkeeper stops every agent. Conversations resume, but
  long-running agent work is lost mid-task.
- **How:** split the PTY/session manager into a per-user daemon (`gridkeeper-sessiond.exe`) that owns ConPTYs and
  Job Objects; the UI host connects over a named pipe with an ACL for the current user only (still no TCP/HTTP
  server). Reattach = replay from the ring. Hard parts: daemon lifetime and upgrade, crash semantics (Jobs must
  still kill trees when the daemon dies), auth on the pipe, and keeping flow control non-blocking across the pipe.
  Write an ADR first. Pairs naturally with auto-update (update the UI without killing agents).

### 6. Per-pane split tree layouts (L)
- **Why:** grid / columns / rows presets can't express "one big lead pane plus a column of three helpers" layouts
  that power users want.
- **How:** replace `Group.layout.preset` with an optional binary split tree (`{dir, ratio, a, b}` / leaf session id)
  persisted in `workspaces.json` (bump `STATE_VERSION`, migrate presets to trees). `react-resizable-panels` already
  supports nesting. Keep keyboard splitting (`Ctrl+Shift+D/E`) splitting the focused pane. The WebGL budget and
  parking logic are unaffected.

### 7. Session recording and replay (M)
- **Why:** reviewing what an agent did ("what happened while I was away?"), sharing a bug repro, demos.
- **How:** opt-in per session; tee the PTY output stream (already raw bytes with timestamps at the pump) to an
  asciicast v2 file under `%APPDATA%\...\recordings\`, with resize events. A replay pane renders it through a
  read-only xterm with a scrubber. Warn that recordings can contain secrets printed by tools; never record by
  default; redact nothing silently (it would corrupt the stream), but show the warning.

## P1: Multi-agent coordination

### 8. Agent-to-agent handoff and a shared task board for Formations (L), v1 shipped: mission.md board
- **Why:** Formations launch a team, but coordination is manual. A shared, visible task list is the missing piece
  for lead/builder/reviewer flows.
- **Shipped (v1):** `<projectDir>/.gridkeeper/mission.md`, a plain Markdown file every agent CLI can edit
  (`# Mission: <goal>`, `## Tasks`, `- [ ] text @owner`, `[~]` doing, `[x]` done, `[!]` blocked). Rust reads and
  writes it atomically with a conflict check and watches it with filesystem notifications (no polling); Mission
  Control renders it as a live board with clickable task states, sign-off cards with branch evidence
  (`git_branch_summary`), and "brief team…" / "hand off…" actions.
  Live check: `scripts/e2e/mission.js`.
- **Remaining ideas:** link tasks to worktrees, branches and PRs explicitly (not only via `@owner`); task history
  and "who changed what" from git; a board that spans several project folders; agent status hooks (item 9) updating
  task states automatically; templates per formation (a starter `mission.md` for "Plan · Build · Verify").

### 9. MCP / agent status hooks integration (M)
- **Why:** attention detection relies on terminal signals and output activity. Claude Code hooks and MCP can
  report precise states (waiting for permission, tool running, done) without parsing anything.
- **How:** a tiny local hook command (`gridkeeper-hook.exe`, or a named-pipe client) that agent hooks call with a
  state word and the session id from an env var Gridkeeper sets (`GRIDKEEPER_SESSION_ID`). Opt-in per account,
  installed only with the user's confirmation and never by editing an agent's config silently (we never write
  inside agent homes). Feeds the existing attention reducer as a new `source`.

### 10. Cost / token meters, if the CLIs expose them (M)
- **Why:** running five agents at once makes spend invisible.
- **How:** only from documented, non-secret sources: status lines or hook payloads that report tokens/cost, or
  the CLI's own usage command. Never read transcripts or credential files to compute it. Show per pane and per
  workspace in Fleet and Mission Control, clearly labelled as reported by the agent. Research first (which CLIs
  expose what, in which version) in `docs/research-notes/`.

## P2: Extensibility and reach

### 11. Plugin API for adapters and themes (L)
- **Why:** the catalog and theme list grow by PR today; users want their own agents and themes.
- **How:** start declarative. A user folder with `agents/*.json` (the `CatalogEntry` fields) and `themes/*.json`
  (the `Theme` shape), validated with the same rules (contrast gate for themes, flag validation for agents) and
  loaded at startup. Executable plugins (JS/WASM) only later, with a written security model, since they would run
  next to credentials.

### 12. Linux and macOS ports (XL), first port done: builds and tests in CI, not live-verified
- **Why:** the multi-agent workflow isn't Windows-only, and Tauri, xterm.js and portable-pty are cross-platform.
- **Shipped (v1):** `ProcessContainer` (Job Object / POSIX session with `killpg` + SIGHUP / SIGKILL), Unix
  termination guards, sysinfo diagnostics with best-effort WebKit attribution, ports from `/proc/net/tcp` (Linux) and
  `lsof` (macOS), login shell as the default terminal, ⌘ as the primary shortcut modifier on macOS, per-platform
  WebGL budget, `tauri.macos.conf.json` / `tauri.linux.conf.json` bundles, CI matrix on all three OSes. Details and
  the limitation list: [HANDOFF section 10](HANDOFF.md#10-platforms-windows-macos-linux).
- **Remaining:** live verification on a Mac and a Linux desktop (an e2e runner: `cdp.mjs` needs a WebKit inspector
  equivalent, or a manual checklist); a supervisor process or cgroup v2 (Linux) so a hard host crash can't orphan
  agents; renderer-crash recovery for WKWebView / WebKitGTK; measuring the WebGL budget, CSP and iframe sandbox
  behaviour per engine; GPU telemetry (Metal / DRM fdinfo) if worth it; signing + notarization for macOS; a
  `sandbox.sh` equivalent of the PowerShell sandbox scripts and an isolated WebKit profile for sandboxes.

### 13. Accessibility audit (M)
- **Why:** contrast is tested, but keyboard-only navigation, screen-reader labels and focus order haven't been
  audited end to end.
- **How:** axe-core run over every dialog and overlay via the CDP e2e harness; manual NVDA/Narrator pass; xterm's
  screen-reader mode as a setting; visible focus rings in every theme; reduced-motion coverage tests for every
  effect.

### 14. Internationalization (M–L)
- **Why:** UI strings are English-only and inline.
- **How:** extract strings to message catalogs (a small ICU-style helper, no heavy runtime), start with the shell,
  dialogs and notifications; keep command ids and keybinding names stable; right-to-left layout check. Terminal
  content is unaffected.

## Smaller ideas (S each)

- Remove the unused `@fontsource-variable/inter` dependency.
- `THIRD_PARTY_NOTICES` generated from `cargo about` / `license-checker` at release time.
- Per-workspace default account per agent.
- Export / import a workspace definition (no processes, no env secrets) to share team layouts.
- Optional "pin" for a pane so Broadcast never targets it.
- Windows jump list entries for recent workspaces.
