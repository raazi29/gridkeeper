# Research notes: exact Claude Code status from hooks (raw findings, 2026-10-19)

Docs only. Nothing was run (no `claude` process), and no credential files, transcripts or session logs were read.
"VERIFIED" = an official doc page says so (quoted or field names given). "OBSERVED" = a public bug report shows the
behaviour on a real install. "UNVERIFIED" = inferred, or the docs are silent. Implementation: `src-tauri/src/meter/hooks.rs`
(helper, state machine), `src-tauri/src/meter/launch.rs` (settings file), `src/store/attention.ts` (precedence).

Hard rules applied: no credentials, no transcripts, never write inside agent homes or the project, no local HTTP
server, no polling while idle. A file in Gridkeeper's data folder plus the existing `<data>\meter` folder watch is OK.

## 1. Verdict: hooks from `--settings` merge with the user's hooks (they are not replaced)

- VERIFIED, https://code.claude.com/docs/en/settings-reference#hooks: "Hooks merge across files rather than replacing
  each other, and hooks from managed settings can't be removed from other files."
- VERIFIED, https://code.claude.com/docs/en/hooks ("Hook locations"): "Hook entries merge across settings levels rather
  than replacing each other: user, project, and local settings add their own hooks without removing managed ones."
  And: "If you define the same handler in more than one settings file, it runs once."
- VERIFIED, https://code.claude.com/docs/en/settings: `--settings` is level 2 of the same stack (Managed > Command line >
  Project local > Shared project > User). "A key you set there overrides the same key in your project and user
  settings files" is the rule for ordinary keys; the hooks reference above is the exception for `hooks`. "Lists merge
  instead of overriding."
- OBSERVED, https://github.com/anthropics/claude-code/issues/11392 (v2.0.37, closed, "has repro"): a `--settings` file
  with an empty `Stop` list did not stop the user's `~/.claude/settings.json` Stop hook: "Hooks from
  `~/.claude/settings.json` are still executed even when providing `--settings custom.json`". A community reply calls it
  "a design decision to always merge hooks". https://claudeissues.com/issue/5933 reports the same ("Both the original
  hooks ... and the override hooks run simultaneously").
- UNVERIFIED: none of the pages names `--settings` explicitly in the merge sentence; the conclusion rests on the
  settings-reference wording, the stack, and the two bug reports.

**Design consequence.** Gridkeeper puts only its own hooks into the per-pane `--settings` file and never reads, copies
or rewrites the user's hooks: the user's hooks keep running exactly as before, once (not twice, which copying would
risk), and a project's hooks keep their folder-trust gate (copying them into a command-line file could have bypassed
it). Our handler commands contain the pane's own state-file path, so the "same handler runs once" dedup can never
fold one of ours into one of the user's. What the integrator checks with one real pane: `/hooks` lists both the
user's hooks and Gridkeeper's (section 7).

`disableAllHooks: true` (any non-managed file) turns hooks and status lines off: the pane is then neither metered nor
hooked (launch says so). Managed `allowManagedHooksOnly` / `disableAllHooks`: nothing is injected. A managed
`statusLine` blocks only the meter; hooks are still injected.

## 2. Events, payloads, what is kept

Source: https://code.claude.com/docs/en/hooks (all VERIFIED unless marked).

Common stdin fields: `session_id`, `prompt_id`, `transcript_path`, `cwd`, `scratchpad_dir`, `permission_mode`,
`effort` (`{level}`), `hook_event_name`; `agent_id` / `agent_type` inside a subagent.

| Event | When (docs) | Extra fields (docs) | Gridkeeper keeps |
|---|---|---|---|
| SessionStart | session begins or resumes | `source` (startup / resume / clear / compact / fork), `model`, `session_title`, ... | `source` token |
| SessionEnd | session terminates | `reason` (clear / resume / logout / prompt_input_exit / other) | `reason` token |
| UserPromptSubmit | prompt submitted, before Claude processes it | `prompt` | nothing extra (prompt dropped) |
| PreToolUse | "after Claude creates tool parameters and before processing the tool call" (before the permission check) | `tool_name`, `tool_input`, `tool_use_id` | `tool_name` |
| PermissionRequest | "when Claude Code is about to ask you for permission to use a tool"; "the moment Claude asks" | `tool_name`, `tool_input`, `permission_suggestions` | `tool_name` |
| PermissionDenied | auto mode denies a tool call | `tool_name`, `tool_input`, `tool_use_id`, `reason` (free text) | `tool_name` (reason dropped) |
| PostToolUse | tool call succeeded | `tool_name`, `tool_input`, `tool_response`, `tool_use_id`, `duration_ms` | `tool_name` |
| PostToolUseFailure | a tool that started failed | `tool_name`, `tool_input`, `error` (text), `is_interrupt`, `duration_ms` | `tool_name`, `is_interrupt` (error text dropped) |
| Notification | Claude Code sends a notification | `message`, `title`, `notification_type` | `notification_type` token (message / title dropped) |
| Stop | main agent finished responding; "Does not run if the stoppage occurred due to a user interrupt" | `stop_hook_active`, `last_assistant_message`, `background_tasks`, `session_crons` | nothing extra |
| StopFailure | turn ends due to an API error | `error` (type: rate_limit, overloaded, authentication_failed, billing_error, ...), `error_details`, `last_assistant_message` | `error` type token |
| SubagentStop | a subagent finished | `agent_id`, `agent_type`, `agent_transcript_path`, `last_assistant_message` | "in a subagent" flag |

Always dropped (never parsed into anything stored): `transcript_path`, `agent_transcript_path`, `cwd`,
`scratchpad_dir`, `prompt`, `tool_input`, `tool_response`, `message`, `title`, `last_assistant_message`, error text,
`permission_suggestions`, background tasks, crons. Also kept: `session_id` (validated `[A-Za-z0-9_-]{1,128}`), the
event name, a helper timestamp. Tool names are validated `[A-Za-z0-9_.:-]{1,96}` (MCP tools are `mcp__server__tool`),
tokens `[A-Za-z0-9_-]{1,40}`; anything else is dropped.

Notification types (VERIFIED, matcher table): `permission_prompt`, `idle_prompt`, `auth_success`, `elicitation_dialog`,
`elicitation_url_dialog`, `elicitation_complete`, `elicitation_response`, `agent_needs_input`, `agent_completed`,
`quota_auto_resume_*`. Timing (VERIFIED): `permission_prompt` "only after the prompt has waited about six seconds",
"each keystroke defers it"; `idle_prompt` "about 60 seconds after Claude finishes responding, and only if you haven't
typed since". So **PermissionRequest is the immediate permission signal**; the notification only confirms it.

Other facts that shaped the state machine (VERIFIED):
- Permission denials fire PreToolUse but not PostToolUseFailure. "Cancelling a running tool does not fire this hook."
- Stop doesn't fire on a user interrupt; nothing reports an interrupt or an answer to a prompt. Gridkeeper therefore
  watches the keys the user types into the pane (`session_write`): while a prompt waits, Enter / a digit / y / n end
  it (Esc / Ctrl+C decline and stop the turn); while Claude works, Esc / Ctrl+C mean "interrupted". Arrow keys and
  focus reports don't count.
- `AskUserQuestion` and `ExitPlanMode` are tools: their PreToolUse means "waiting for the user" (question / plan).
- `async: true`: "runs in the background without blocking"; `timeout` is not enforced on async hooks; output JSON is
  delivered on the next turn (Gridkeeper prints nothing). "All matching hooks run in parallel."
- Exit codes: 2 blocks PreToolUse / UserPromptSubmit, and on Stop "prevents Claude from stopping". The helper always
  exits 0 (even on bad arguments). Plain stdout of UserPromptSubmit / SessionStart becomes Claude's context: the helper
  prints nothing.
- Windows shell (VERIFIED): "A command hook with `shell` unset uses `sh -c` on macOS/Linux, Git Bash on Windows, or
  PowerShell when Git Bash isn't installed": the same as status lines, so the meter's quoting (`meter/shell.rs`) is reused.
- Exec form (`command` + `args`, no shell) exists, but a version that doesn't know `args` would run the bare
  `gridkeeper.exe` (= start the GUI). A third-party post dates it to v2.1.139 (UNVERIFIED). Shell form is used, like the
  status line that already works with the user's installed version.
- Hooks and status lines are off until the folder is trusted (the meter note already says so).

## 3. What Gridkeeper injects

One file per pane, `<data>\meter\settings-<pane>.json`, passed with `--settings` (only while the cost meter is on and
the pane doesn't pass its own `--settings`). Example (Git Bash, paths shortened):

```json
{
  "hooks": {
    "Notification":       [{ "matcher": "*", "hooks": [{ "type": "command", "command": "D:/Gridkeeper/gridkeeper.exe --gk-hook Notification --state-file C:/Users/u/AppData/Roaming/app.gridkeeper.desktop/meter/<pane>.hooks.json", "async": true, "timeout": 10 }] }],
    "PermissionDenied":   [{ "matcher": "*", "hooks": [{ "type": "command", "command": "... --gk-hook PermissionDenied --state-file .../<pane>.hooks.json", "async": true, "timeout": 10 }] }],
    "PermissionRequest":  [{ "matcher": "*", "hooks": [ ... ] }],
    "PostToolUse":        [{ "matcher": "*", "hooks": [ ... ] }],
    "PostToolUseFailure": [{ "matcher": "*", "hooks": [ ... ] }],
    "PreToolUse":         [{ "matcher": "*", "hooks": [ ... ] }],
    "SessionEnd":         [{ "matcher": "*", "hooks": [ ... ] }],
    "SessionStart":       [{ "matcher": "*", "hooks": [ ... ] }],
    "Stop":               [{ "hooks": [ ... ] }],
    "StopFailure":        [{ "matcher": "*", "hooks": [ ... ] }],
    "SubagentStop":       [{ "hooks": [ ... ] }],
    "UserPromptSubmit":   [{ "hooks": [ ... ] }]
  },
  "statusLine": { "type": "command", "command": "D:/Gridkeeper/gridkeeper.exe --gk-statusline --meter-file C:/Users/u/AppData/Roaming/app.gridkeeper.desktop/meter/<pane>.json", "padding": 0 }
}
```

Paths use forward slashes (Git Bash eats backslashes); a path with a space is single-quoted (and gets `& ` in
PowerShell); a quote or control character in a path makes the pane unmetered with a note.

## 4. Helper (`gridkeeper.exe --gk-hook <event> --state-file <file>`)

Dispatched in `main.rs` before Tauri (no window, no logging). Takes a µs timestamp first, streams stdin through a
parser that keeps only the fields above (tool inputs of many MB are skipped, not buffered; 64 MiB cap), validates the
state file (`<%APPDATA%\app.gridkeeper.desktop>\...\meter\<pane>.hooks.json`, canonical folder inside the data folder,
regular file), and writes atomically unless the file already holds a record from a helper that started later (async
hooks run concurrently and finish in any order). Drains stdin, prints nothing, exit 0.

## 5. Host state machine (`PaneHooks`) and attention

Per pane run (reset at launch; files of panes launched without hooks are ignored). States emitted as
`session-attention` with `kind: "hook"`, `status`, `tool`, `reason`, `activeMs`:

| State | From |
|---|---|
| `permission` (+ tool) | PermissionRequest; Notification `permission_prompt` (tool = the waiting call, else the tool seen in the last 10 s) |
| `input` (+ tool) | PreToolUse of AskUserQuestion / ExitPlanMode; Notification `elicitation_dialog` / `elicitation_url_dialog` |
| `tool` (+ tool) | PreToolUse; a prompt answered with Enter / digit / y / n |
| `working` | UserPromptSubmit, PostToolUse(Failure), PermissionDenied, SubagentStop, elicitation complete |
| `stopped` | Stop (`activeMs` = since the prompt); StopFailure (`reason` = error type); interrupt (`reason: interrupt`) from `is_interrupt` or Esc / Ctrl+C |
| `idle-prompt` | Notification `idle_prompt` (ignored while a prompt waits) |
| `ready` / `ended` | SessionStart / SessionEnd (`reason` = source / reason) |

Rules: records older than the newest applied one are stale; a PreToolUse of the waiting tool, or within 1.5 s of the
prompt (same batch), doesn't end the wait; a PostToolUse of another call of the batch doesn't either; repeats of the
same state are not re-emitted.

Frontend precedence (`store/attention.ts`): once a run has sent a hook event, hook states rule; `active` / `idle`
heuristics only fill gaps (a waiting prompt is never hidden; a hook `working` / `tool` younger than 2 minutes isn't
turned idle by quiet output; output within 5 s of a turn end is a repaint; the heuristic never raises a second "done");
Claude's own bells / OSC notifications are not alerted twice. Autopilot, hand-off and brief never type into a pane
whose hook state is `permission` or `input`.

## 6. Setting

"Exact status for Claude panes (hooks)", Settings › Agents, `claudeHooks`, **default on, but only effective while the
cost meter is on**: one opt-in (the meter) decides whether Gridkeeper adds a `--settings` layer to Claude panes at all,
so with the meter off nothing about the Claude invocation changes. The switch lets meter users turn hooks off. Applies
to newly started panes.

## 7. What a person must verify with one real Claude pane

1. Meter + hooks on, a user hook in `~/.claude/settings.json` (e.g. a Stop hook that appends to a file): start a pane,
   run `/hooks`: both the user's hook and Gridkeeper's `--gk-hook` handlers are listed; after a turn the user's hook ran
   once.
2. Ask for something that needs permission (e.g. a Bash command not allowed yet): within a second the pane header shows
   "needs permission · Bash", the card says "Needs permission · Bash", one notification; approve with Enter: "running ·
   Bash", then the lamp goes to done after the Stop hook.
3. Press Esc during a long tool: the state goes to idle ("Interrupted"), no "done".
4. `<data>\meter\<pane>.hooks.json` contains only `event`, `t`, `claudeSessionId`, `tool`, `notification`, `detail`,
   `interrupt`, `subagent`; no prompt, no path.
5. No console windows flash on Windows (Git Bash / PowerShell runs `gridkeeper.exe`, a GUI-subsystem exe, as for the
   status line), and turns don't get slower (hooks are async).
6. `claude --debug` shows `Hooks: ... finished with status 0` lines for `--gk-hook` and no errors.
