# Security Policy

Gridkeeper runs on the same machine as your AI agents and their logins, so we take reports seriously.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately through GitHub's private vulnerability reporting: on the repository page open **Security → Report
a vulnerability** (direct link: `https://github.com/raazi29/gridkeeper/security/advisories/new`). Only the
maintainers can see the report.

If that button isn't there yet (private reporting has to be switched on in the repository settings), open a public
issue titled **"Security contact request"** that contains **no details** about the problem, and a maintainer will
set up a private channel with you.

Please include:

- the Gridkeeper version (Settings or the installer name) and Windows build;
- what an attacker can do and what they need (local user, a malicious web page in a browser pane, crafted terminal
  output from a program, a crafted `workspaces.json`, …);
- steps to reproduce or a proof of concept;
- whether you saw any credential, token or e-mail address exposed.

**Redact your own secrets** before attaching logs or diagnostics bundles. Gridkeeper redacts them itself, but
check anyway.

We aim to acknowledge reports within 7 days and to agree on a disclosure date with you. Fixed issues are credited in
the release notes unless you prefer otherwise.

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x (latest release) | Yes |
| Older builds / unreleased forks | No, please update first |

Security fixes ship as a new release on the [Releases](https://github.com/raazi29/gridkeeper/releases) page. The
installer is not code-signed yet, so verify that you downloaded it from this repository.

## Security model (summary)

The full model is in [docs/ARCHITECTURE.md §12](docs/ARCHITECTURE.md#12-security-model) and
[ADR-019](docs/TECHNICAL_DECISIONS.md) (browser panes).

- **Local-first, no telemetry.** No cloud backend, no analytics and no network calls of the app's own. The only
  exception is user-initiated: when you open an http(s) address in a browser pane, `curl.exe` fetches that same
  address once to check whether it may be embedded.
- **Phone alerts are opt-in.** Off by default. When you turn them on (Settings › Notifications › Phone alerts), each
  alert is one HTTPS POST, sent with the system curl, to the ntfy server you chose (ntfy.sh or your own), rate
  limited and never retried. The text is generic ("builder-1 needs you · OAuth demo"), never terminal output, and is
  scrubbed of paths, URLs, e-mail addresses and secrets; task names only if you allow them. The topic acts as a
  password and is kept out of `workspaces.json`, logs and diagnostics bundles; the optional access token goes to
  Windows Credential Manager (a 0600 file on macOS / Linux) and never back to the UI.
- **No HTTP server.** The UI talks to the Rust host only over Tauri IPC. A strict CSP is set in
  `src-tauri/tauri.conf.json`.
- **Credentials are never read.** Agent logins are checked by file existence and by each CLI's own status command
  (`claude auth status --json`, `codex login status`). Gridkeeper never opens, copies or writes credential files,
  and never writes inside an agent's config directory (except creating an empty folder for a new account).
- **Identity isolation.** Each account is its own config directory (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`,
  `HERMES_HOME`). Inherited identity variables (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, …) are stripped from
  agent environments.
- **Redaction.** Logs, error messages shown in the UI and diagnostics bundles go through `redact.rs` (API keys,
  bearer tokens, GitHub/AWS tokens, JWTs, secret-named flags and env pairs). Account e-mails are shown in the UI only
  and never logged or persisted. Secret-looking env keys are never saved to `workspaces.json`.
- **Process containment.** Every session's process tree lives in its own Windows Job Object
  (`KILL_ON_JOB_CLOSE`), so closing a pane or quitting, even a crash, never leaves orphaned agents.
- **Sandboxed browser panes.** Web pages run in sandboxed cross-origin iframes (no top navigation, no popups) that
  never receive Tauri IPC. The app's own origins are never framed. Pop-out windows are separate webviews that the
  IPC capability, scoped to the `main` webview, does not cover.
- **Terminal output is untrusted.** It is rendered only by xterm.js (never as HTML), links open only on Ctrl+click
  and only for http/https, and replayed output has terminal queries stripped so it can't inject replies.
- **Git is read-only** apart from `git worktree add`, which you confirm first. The Changes drawer never stages,
  commits, checks out or resets. The only file Gridkeeper writes inside a project folder is the Mission Control task
  board `.gridkeeper/mission.md` (plus a `.gitignore` in that folder that keeps it out of git). Treat that file
  like any other text your agents read: anyone who can edit it can put words in front of your agents.

### Known gaps

- A process spawned in the first microseconds after launch, before Job assignment, could escape cleanup
  (portable-pty doesn't create processes suspended). Not observed in practice.
- The installer is unsigned (SmartScreen warns on first run).
