# Research notes — cost / token meter sources for Claude Code, Codex CLI, Gemini CLI (raw findings, 2026-10-18)

Docs only. Nothing was run, and no credential files, transcripts or session logs were read. "VERIFIED" means an official doc page states it (quote or field names given). "UNVERIFIED" means it is inferred or the docs are silent. Test each recommendation against the installed versions before shipping.

Hard rules applied: no credential files, no transcripts or session logs, no edits to the agent's own config in its home, no local HTTP/TCP server (named pipe or a file in Gridkeeper's data folder is OK), no polling while idle.

## Claude Code

### Status line stdin JSON — VERIFIED, best source
- https://code.claude.com/docs/en/statusline "Available data". Cost and token fields:
  - `cost.total_cost_usd`: "Estimated session cost in USD, computed client-side at list price unless a `modelPricing` table is in effect. May differ from your actual bill. Resets to $0 when `/clear` starts a new session."
  - `cost.total_duration_ms`, `cost.total_api_duration_ms`, `cost.total_lines_added`, `cost.total_lines_removed`.
  - `context_window.total_input_tokens`, `context_window.total_output_tokens`: "Token counts currently in the context window, from the most recent API response. Input includes cache reads and writes". These describe the **current context**, not cumulative session spend.
  - `context_window.context_window_size` (200000, or 1000000 for extended context), `context_window.used_percentage`, `context_window.remaining_percentage` (both may be `null` early).
  - `context_window.current_usage.{input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens}` from the last API call (`null` before the first call and right after `/compact`).
  - `exceeds_200k_tokens`; `rate_limits.five_hour.used_percentage|resets_at`, `rate_limits.seven_day.*`; `rate_limits.spend_limit.used_usd|limit_usd|period` (gateway only).
  - `prompt_cache.*` (hit_ratio, misses, cache_write_tokens …; main conversation only, "doesn't count subagent requests").
  - Identity: `session_id`, `session_name`, `prompt_id`, `model.id`, `model.display_name`, `version`, `workspace.*`.
  - Also present: `transcript_path`. **The helper must ignore it** (hard rule).
- No cumulative session token total exists in the status line JSON. Cumulative spend = `cost.total_cost_usd` only. Tokens shown = context occupancy.
- Update triggers (VERIFIED, "When the status line updates"): on session start/resume, on each new assistant message, after `/compact`, on permission-mode change, on vim toggle, on a `statusLine.command` change, and on rate-limit or cache expiry times. "Claude Code debounces updates at 300ms … If a new update triggers while your script is still running, Claude Code cancels the in-flight script." `refreshInterval` is optional. Leave it unset, which gives no timer (satisfies the no-idle-polling rule).
- Gates (VERIFIED): it stays blank until workspace trust is accepted. `disableAllHooks: true` (non-managed) disables it. `allowManagedHooksOnly` in managed settings hides it. `--safe-mode` doesn't load it.
- UNVERIFIED: whether `cost.total_cost_usd` includes subagent spend (the Agent SDK `total_cost_usd` does, per https://code.claude.com/docs/en/agent-sdk/cost-tracking), and whether the status line child process inherits the claude process env. Put the pane token in argv to avoid relying on env.

### `--settings` per process — VERIFIED
- https://code.claude.com/docs/en/cli-reference `--settings`: "Path to a settings JSON file or an inline JSON string. Values you set here override the same keys in your `settings.json` files for this session. Keys you omit keep their file-based values."
- https://code.claude.com/docs/en/settings: precedence is Managed > Command line (`claude --settings`) > project local > shared project > user. "A key you set there overrides the same key in your project and user settings files, and a key you leave out keeps its value from those files." "`--settings` lasts one session and doesn't write to any file." Lists (e.g. `permissions.allow`) merge across scopes. `statusLine` is an object key, so it **replaces** the user's status line for that session (UNVERIFIED that objects aren't deep-merged, but `type`/`command` would be overwritten either way).
- So injecting `statusLine` hides the user's own status line in that pane, unless the Gridkeeper helper chains to it (see recommendation).
- A managed `statusLine` wins over `--settings`. In that case Gridkeeper gets nothing. Detect this and show "unavailable".

### Hooks — VERIFIED, no usable cumulative data
- https://code.claude.com/docs/en/hooks. Common fields: `session_id, prompt_id, transcript_path, cwd, scratchpad_dir, permission_mode, effort, hook_event_name` (+ `agent_id`, `agent_type`). No usage or cost in them.
- Exceptions: `SessionStart` on resume/fork has `context_tokens` and `estimated_cache_write_usd` (v2.1.251+). `PostToolUse` for the `Agent` tool has `tool_response.totalTokens` and `tool_response.usage.{input_tokens,output_tokens,cache_creation_input_tokens,cache_read_input_tokens}`, which cover the subagent's final request only. `Stop`/`SubagentStop` have no usage. Not a meter source.

### OpenTelemetry — VERIFIED, but violates the rules for interactive panes
- https://code.claude.com/docs/en/monitoring-usage. Enable with `CLAUDE_CODE_ENABLE_TELEMETRY=1`. `OTEL_METRICS_EXPORTER` = `console | otlp | prometheus | none`. `OTEL_LOGS_EXPORTER` = `console | otlp | none`. `OTEL_EXPORTER_OTLP_PROTOCOL` = `grpc | http/json | http/protobuf` ("no default protocol"). `OTEL_METRIC_EXPORT_INTERVAL` default 60000 ms, `OTEL_LOGS_EXPORT_INTERVAL` default 5000 ms.
- Metrics: `claude_code.cost.usage` (USD, "Incremented after each API request") and `claude_code.token.usage` (`type` = `input | output | cacheRead | cacheCreation`; "input" excludes cache), plus `claude_code.session.count`. Attribute `session.id` (`OTEL_METRICS_INCLUDE_SESSION_ID`, default true).
- Event `claude_code.api_request`: `model, cost_usd, cost_usd_micros, duration_ms, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, request_id`.
- No file exporter is documented. `console` writes to the process stdout, which is the ConPTY and would corrupt the TUI. `otlp` needs a gRPC/HTTP receiver, i.e. a local TCP server (forbidden), and `prometheus` is itself an HTTP endpoint. **Rejected** for interactive panes. Env-only, so it would be per-process if a remote collector were ever acceptable.

### Non-interactive `-p --output-format json|stream-json` — VERIFIED (Mission/headless runs only)
- https://code.claude.com/docs/en/agent-sdk/cost-tracking: the result message has `total_cost_usd` (includes subagents), `usage` (top-level loop only, `input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens`), and `modelUsage` per model (`inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, costUSD, costBasis` = `list|managed|unknown`). The docs say: "client-side estimates, not authoritative billing data … computed locally from a price table bundled at build time". Per-step `output_tokens` on assistant messages "is a placeholder"; read output from the result. `--max-budget-usd` exists (print mode).

## Codex CLI (docs at learn.chatgpt.com; developers.openai.com/codex redirects there)

### Status line / title — VERIFIED that they exist; no machine-readable output
- https://learn.chatgpt.com/docs/developer-commands.md?surface=cli: `/statusline` "Configure TUI status-line fields interactively", which persists to `tui.status_line`. Items listed in prose: "model, model+reasoning, context stats, rate limits, git branch, token counters, session id, current directory/project root, and Codex version". `/status` shows "current token usage" and "remaining context capacity". `/usage` shows account token activity (daily/weekly/cumulative).
- https://learn.chatgpt.com/docs/config-file/config-reference.md: `tui.status_line` (`array<string> | null`). `tui.terminal_title` (`array<string> | null`, default `["spinner","project"]`). Title items are "app name, project, spinner, status, thread, git branch, model, and task progress". **No token item in the title**, so OSC 0/2 can't carry tokens.
- The footer is rendered pixels only, with no command hook like Claude's `statusLine`. The exact item identifier strings are UNDOCUMENTED. Read them from `/statusline` on the installed version.

### `-c key=value` — VERIFIED
- https://learn.chatgpt.com/docs/config-file/config-advanced.md: "Use `-c` / `--config` when you need to override an arbitrary key." Values are parsed as TOML (quote strings), and dotted keys set nested keys. The developer-commands page says overrides "take precedence for that invocation". `--profile name` overlays `~/.codex/name.config.toml`. Nothing is written to disk by `-c` (UNVERIFIED but implied by "for that invocation").

### OpenTelemetry — VERIFIED; OTLP only
- config-reference: `otel.exporter` = `none | otlp-http | otlp-grpc`, `otel.trace_exporter` the same, `otel.metrics_exporter` = `none | statsig | otlp-http | otlp-grpc` (default `statsig`). `otel.exporter.<id>.endpoint|protocol (binary|json)|headers|tls.*`. `analytics.enabled = false` "also disables custom OTLP metrics exporters". **No file or console exporter.**
- config-advanced: `otel` is ignored in project `.codex/config.toml` (user level only). Whether `-c otel.…` works is not stated (UNVERIFIED). Events: `codex.sse_event` ("token counts on `response.completed`"), `codex.api_request`, etc. Metric `turn.token_usage` histogram with `token_type` = `total | input | cached_input | output | reasoning_output`. No cost metric.
- Needs a local OTLP receiver, so it is **rejected** under the rules.

### Hooks / notify — VERIFIED, no usage
- https://learn.chatgpt.com/docs/hooks.md. Common fields: `session_id, transcript_path, cwd, hook_event_name, model`. The events (SessionStart, SessionEnd, SubagentStart/Stop, PreToolUse, PermissionRequest, PostToolUse, Pre/PostCompact, UserPromptSubmit, Stop, Interrupt) carry no token, cost or context fields.
- `notify` payload (config-advanced): `type, thread-id, turn-id, cwd, input-messages, last-assistant-message`. No usage, and it carries message content, so don't use it.

### `codex exec --json` — VERIFIED (headless runs only)
- https://learn.chatgpt.com/docs/non-interactive-mode.md: JSONL events `thread.started, turn.started, turn.completed, turn.failed, item.*, error`. `turn.completed.usage` = `input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens`. **No cost field.**

### App server — VERIFIED exists, UNVERIFIED fields
- https://learn.chatgpt.com/docs/app-server.md: transports are stdio (default JSONL), `unix://` socket, and ws (experimental). Notification `thread/tokenUsage/updated` ("usage updates for the active thread"), whose fields are not documented, and `account/rateLimits/updated` (`usedPercent`, `resetsAt` …). This only helps if Gridkeeper drives Codex as a JSON-RPC client instead of hosting the TUI. Out of scope for the pane meter.

## Gemini CLI

### Status — VERIFIED
- https://geminicli.com/docs/cli/telemetry/ banner: Gemini CLI was replaced by Antigravity CLI on 2026-06-18. https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/ says individual tiers stopped and paid API-key/enterprise access remains. Antigravity CLI is closed-source and its telemetry is not researched here. **Low priority.**

### Telemetry — VERIFIED (settings + env); a file target exists
- https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/telemetry.md and geminicli.com/docs/cli/telemetry/: `telemetry.enabled`, `target` (`local|gcp`, default `local`), `outfile` ("overrides `otlpEndpoint`"), `otlpEndpoint` (default `http://localhost:4317`), `otlpProtocol` (`grpc|http`), `logPrompts` (**default true**), `useCollector`. Env overrides: `GEMINI_TELEMETRY_ENABLED`, `GEMINI_TELEMETRY_TARGET`, `GEMINI_TELEMETRY_OUTFILE`, `GEMINI_TELEMETRY_OTLP_ENDPOINT`, `GEMINI_TELEMETRY_OTLP_PROTOCOL`, `GEMINI_TELEMETRY_LOG_PROMPTS`, `GEMINI_TELEMETRY_USE_COLLECTOR` ("Environment variables can override these settings"; `true`/`1`).
- https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/reference/configuration.md precedence: defaults < system defaults < user < project < system settings < env vars < CLI args. **No `--telemetry-*` CLI flags are documented on current pages** (`--telemetry-outfile` is UNVERIFIED and may be from an older release). Env vars are the per-process path.
- Metric `gemini_cli.token.usage` (`type` = `input|output|thought|cache|tool`), `gemini_cli.api.request.count`, `gemini_cli.api.request.latency`. Event `gemini_cli.api_response` fields: `model, status_code, duration_ms, input_token_count, output_token_count, cached_content_token_count, thoughts_token_count, tool_token_count, total_token_count, prompt_id, auth_type, finish_reasons, response_text` (optional). `gemini_cli.api_request` has optional `request_text`. **No cost.**
- Caveat: `logPrompts=false` is documented to drop only `gemini_cli.user_prompt.prompt`. Whether `request_text`/`response_text` still land in the outfile is UNVERIFIED. If they do, the outfile is effectively a transcript, which conflicts with the "no transcripts" rule. The outfile format and flush timing are undocumented.
- Avoid `GEMINI_CLI_SYSTEM_SETTINGS_PATH`: it replaces the system/admin settings layer.

### Headless — VERIFIED (thin)
- https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/headless.md: `--output-format json` has `stats` ("Token usage and API latency metrics"). The stream-json `result` event has "aggregated statistics and per-model token usage breakdowns". The field names are not on the page. No cost.
- TUI footer: `ui.footer.hideContextPercentage` (default true), `ui.footer.hideModelInfo`. `/stats` exists in the TUI (UNVERIFIED on these pages).

## Recommendations (least invasive, rule-compliant)

### Claude Code — status line injection via `--settings`, with a chaining helper. Opt-in per workspace.
- Launch: `claude … --settings '{"statusLine":{"type":"command","command":"\"<gridkeeper-dir>\\gk-meter.exe\" --pane <token>"}}'`. Use a file in Gridkeeper's data folder if quoting is awkward. Nothing in `~/.claude` is touched.
- `gk-meter.exe`: a short-lived process per update (event-driven, 300 ms debounce, no timer). It reads stdin JSON, keeps only `session_id, model.id, cost.*, context_window.*, rate_limits.*`, drops `transcript_path`, writes one line to `\\.\pipe\gridkeeper-meter` with a short connect timeout, then exits.
- Preserve the user's status line: at launch Gridkeeper reads (read-only) the effective `statusLine.command` from user, project and local settings. These are not credentials or transcripts. It passes that to the helper, which runs it with the same stdin and prints its stdout. If the user had none, the helper prints a compact line or nothing. If a managed `statusLine` exists, show "meter unavailable (managed status line)".
- What the user sees: their own status line unchanged, or Gridkeeper's compact line. The Gridkeeper pane header shows "est. $0.42 · ctx 37% (74k/200k)". The workspace total is the sum of the latest `total_cost_usd` per `session_id` (handle `/clear` resets: a new session_id means a new bucket). Nothing appears until the folder is trusted.
- Cost is Claude's own estimate at list price: label it **"estimated"**. On a claude.ai subscription it is API-equivalent value, not money spent. Say so in a tooltip, and show `rate_limits.five_hour/seven_day` instead or as well.
- Headless/Mission runs: read `total_cost_usd` + `modelUsage` from the `-p --output-format stream-json` result. Same "estimated" label.

### Codex CLI — no compliant live source for interactive panes. Tokens only for headless.
- Interactive: OTEL is OTLP-only (needs a local receiver), hooks and notify carry no usage, the title can't carry tokens, and session logs are off-limits. Best compliant option: offer to add footer token/context items for that pane via `-c 'tui.status_line=[…]'` (identifiers must be read off `/statusline` on the installed version). The user sees tokens inside the Codex footer, and Gridkeeper's meter shows "n/a — see pane" for Codex.
- Headless (`codex exec --json`): sum `turn.completed.usage` per run. Tokens only, so cost = **estimated** from a Gridkeeper price table keyed by model (`input − cached` at the input rate, `cached` at the cached rate, `output + reasoning_output` at the output rate; verify on the pricing page whether reasoning is already inside output_tokens).
- Future option: drive Codex through the app server (`thread/tokenUsage/updated` over stdio). This is a bigger architecture change.

### Gemini CLI — telemetry outfile via env, gated on a local check. Low priority (product retired for individuals).
- Per process env: `GEMINI_TELEMETRY_ENABLED=true`, `GEMINI_TELEMETRY_TARGET=local`, `GEMINI_TELEMETRY_LOG_PROMPTS=false`, `GEMINI_TELEMETRY_OUTFILE=<gridkeeper-data>\meter\<pane>.log`. Watch the file with ReadDirectoryChangesW (event-driven) and parse only `gemini_cli.api_response` token counts or `gemini_cli.token.usage`.
- Before shipping, test whether `response_text`/`request_text` appear in the outfile with `logPrompts=false`. If they do, drop this path (it would be a transcript), or truncate/delete the file after each parse and treat it as sensitive.
- Tokens only. Cost = **estimated** from a price table (input, cached, thoughts at the output rate, output).
- What the user sees: nothing changes in the Gemini UI. The pane header shows "est. $… · 12.3k tok".

### Summary table
| CLI | Live interactive source | Tokens | Cost | Label |
| --- | --- | --- | --- | --- |
| Claude Code | `statusLine` via `--settings` → named pipe | context occupancy (+ per-call breakdown) | yes (Claude's estimate) | estimated |
| Codex CLI | none compliant (footer items only, visible in the pane) | headless only (`exec --json`) | price table | estimated |
| Gemini CLI | telemetry outfile in Gridkeeper's folder (env) | yes | price table | estimated |
