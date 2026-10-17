# Research notes — Claude Code 2.1.302 & Codex CLI 0.162.0 (raw findings, 2026-10-17)

No credential contents were read. Account checks used `claude auth status --json` field names only.

## CLAUDE_CONFIG_DIR — VERIFIED, official
- https://code.claude.com/docs/en/env-vars: "Override the configuration directory (default: ~/.claude). All settings, session history, and plugins are stored under this path ... Useful for running multiple accounts side by side".
- https://code.claude.com/docs/en/authentication "Log in with multiple accounts": each config dir "has its own settings, session history, and claude.ai login or API key". Exception: Claude Console sign-ins without API key are stored outside (in %APPDATA%\Anthropic).
- Windows credentials: `%USERPROFILE%\.claude\.credentials.json`, or under CLAUDE_CONFIG_DIR when set.
- On this machine: ~/.claude, ~/.claude-account1, ~/.claude-account2 each have own .credentials.json; `auth status` reports three distinct accounts, all loggedIn, authMethod claude.ai. Isolation works on Windows 2.1.302.
- `.claude.json` lives in %USERPROFILE% without the var, in $CLAUDE_CONFIG_DIR with it (https://code.claude.com/docs/en/claude-directory).
- Isolated per profile: settings.json, .credentials.json, .claude.json, projects/<cwd>/<session>.jsonl, history.jsonl, plugins, skills, file-history, sessions, daemon files.
- Known gaps (closed NOT_PLANNED issues, may persist): #30230 both CLAUDE.md loaded; #34800/#4739 IDE lock files in ~/.claude/ide; #15071 plugin paths; #81278.
- OPEN #91708: same profile in two concurrent processes races on OAuth refresh in .credentials.json → forced re-login. Warn when two live sessions share a profile.
- OPEN #101027 (Windows): deleting CLAUDE_CONFIG_DIR under a running session pins a core; claude.exe can outlive ConPTY when pane closes → kill process tree explicitly.
- `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` strips CLAUDE_CONFIG_DIR from child tools.

## Auth status without secrets — VERIFIED
- `claude auth status [--json|--text]`; exit 0 logged in, 1 not (https://code.claude.com/docs/en/cli-reference). JSON fields: loggedIn, authMethod (none|claude.ai|oauth_token|api_key|api_key_helper|third_party), apiProvider, configDirectory, projectsDirectory, email, orgId, orgName, subscriptionType. No tokens. Email/org are personal data → UI only, never log.
- Side effect: on a non-existent dir it creates .claude.json + backups/. Only probe existing dirs.

## Credential precedence — VERIFIED
1 CLAUDE_CODE_USE_BEDROCK/VERTEX/FOUNDRY, 2 ANTHROPIC_AUTH_TOKEN, 3 ANTHROPIC_API_KEY, 4 apiKeyHelper, 5 CLAUDE_CODE_OAUTH_TOKEN, 6 ANTHROPIC_PROFILE, 7 subscription OAuth. → Strip these for profile sessions or every profile authenticates as the same identity. The app process may inherit CLAUDE_CONFIG_DIR → always set or remove explicitly.

## Claude flags — VERIFIED (2.1.302 help)
`-c/--continue` (most recent in cwd), `-r/--resume [id]`, `--session-id <uuid>`, `--fork-session`, `-n/--name <name>`, `--add-dir`. No --cwd flag: set ConPTY cwd. `--resume` searches project + worktrees then all projects, within one config dir. Same session in two terminals interleaves transcripts.
- Windows: native binary %USERPROFILE%\.local\bin\claude.exe preferred over npm claude.cmd shim. Git Bash optional (CLAUDE_CODE_GIT_BASH_PATH).
- TERM=xterm-256color recommended, COLORTERM=truecolor; don't set WT_SESSION.

## Codex — VERIFIED
- CODEX_HOME (default ~/.codex) must exist if set (https://learn.chatgpt.com/docs/config-file/environment-variables; developers.openai.com/codex now 308-redirects there).
- Auth store: cli_auth_credentials_store file|keyring|auto|ephemeral (https://learn.chatgpt.com/docs/auth). `codex login status` exit 0/1. `codex doctor --json` redacted report.
- `codex resume [SESSION_ID] [--last] [--all]`, `codex fork`, `--no-alt-screen`, `--no-daemon`, `-C/--cd`. --last is cwd-filtered.
- Windows native, needs ConPTY (Win10 1809+) (https://learn.chatgpt.com/docs/windows/windows-sandbox).
- Issues: #35395 ESC[?2026 leak; #35438 xterm.js+ConPTY cursor/IME; #27644 inline mode (--no-alt-screen) loses history in xterm.js → keep alt screen ON; #24026 kitty keyboard fragments leak after exit → write CSI < u on child exit.

## Terminal capabilities
- Claude probes XTVERSION, kitty keyboard (CSI ? u), OSC 7501, DA1, DECRQM ?2026. Kitty protocol enabled for allowlisted TERM_PROGRAM; Shift+Enter fragile on Windows without it (#92771). Don't spoof TERM_PROGRAM=windows-terminal (#94873).
- Fullscreen renderer (alt screen + SGR mouse) default for many users; ConPTY hosts mis-coalesce → `CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT=1` (https://code.claude.com/docs/en/fullscreen). Opt-outs CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1, CLAUDE_CODE_DISABLE_MOUSE=1.
- OSC 8 auto-detected (FORCE_HYPERLINK). OSC 7501 status protocol (v2.1.295+). Bracketed paste used. Backspace: ^H read as Ctrl+Backspace on Windows (CLAUDE_CODE_BS_AS_CTRL_BACKSPACE=0).
