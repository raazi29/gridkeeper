# Research notes: agent browser (agents drive a real browser, the user watches and takes over), 2026-10-19

Docs, source code and `--help` output only. Nothing was installed, no prompts were sent to an agent. VERIFIED = an official page, the
project's source code or local `--help` output says it (link or command given); UNVERIFIED = inferred, or the docs are silent.

Constraints from the brief and HANDOFF: local-first, no telemetry, **no local HTTP server** (a per-user named pipe is fine),
credentials never read, nothing written into agent homes or user config, and on this 16 GB machine **one browser shared by all
agents** (per-pane browser MCP servers that each launch a browser exhausted memory before).

## 1. Options compared

| | (a) Playwright MCP `@playwright/mcp` | (b) chrome-devtools-mcp | (c) built into Gridkeeper (`--gk-mcp-browser`) |
|---|---|---|---|
| Runtime | Node >= 18 (npm package) | Node `^20.19 \|\| ^22.12 \|\| >=23` | none: a helper mode of the Gridkeeper binary |
| Works with Claude Code's native installer (no Node) | only if the user installs Node | only if the user installs Node | yes |
| Attach to a browser someone else owns | `--cdp-endpoint` (http/ws URL only) | `--browser-url` / `--ws-endpoint` (http/ws only) | Gridkeeper owns the browser on a **pipe** |
| Needs a DevTools port | yes (any local process can then drive the browser) | yes | no (`--remote-debugging-pipe`) |
| One shared browser, a tab per agent | not enforced: reuses the first existing page of the default context, sees every page of that context; `--isolated` gives a new context per server | not enforced: lists and selects every page target of the browser (all contexts) | enforced by the host: each session has its own browser context + page; a tool call can only reach its own |
| Memory per agent | Node process (~50-80 MB, UNVERIFIED) + shared browser tab | Node process (~50-80 MB, UNVERIFIED) + shared browser tab | helper ~5-10 MB (UNVERIFIED, same binary as the meter helper) + shared browser tab |
| Tool quality | best: accessibility snapshot with refs, mature auto-waiting | strong DevTools coverage (performance traces, Lighthouse, network detail) | snapshot with refs modelled on Playwright's names; simpler waits (load events + settle), no iframes in snapshots |
| User watch / take over inside Gridkeeper | not provided | not provided | screencast to a canvas + input forwarding, built in |
| Confirm prompts / allowlist owned by the user | `--allowed-origins` (documented as not a security boundary) | `--allowedUrlPattern` (Chrome 149+) | per-action confirmation in Gridkeeper (forms, scripts, uploads, downloads) |
| Cross-platform | yes | yes | yes (pipe on Windows via inherited handles, fds 3/4 elsewhere) |

**Choice: (c).** Fewer moving parts (no Node, no npm download at first use, no port), the only option that enforces
"one tab per agent" against a shared browser, and the watch / take-over / confirmation features need a host-side broker
anyway. The cost is tool quality: Playwright's auto-waiting and selector engine are not reproduced; v1 has load-event
waits, a click hit-test ("covered by ...") and a page snapshot that covers the main frame only.

## 2. Findings

### (a) Playwright MCP
- VERIFIED, Node 18+: https://raw.githubusercontent.com/microsoft/playwright-mcp/main/README.md ("Node.js 18 or newer"), package.json `"engines": {"node": ">=18"}`.
- VERIFIED flags (README): `--cdp-endpoint <endpoint>` "CDP endpoint to connect to.", `--isolated` "keep the browser profile in memory, do not save it to disk.", `--browser` chrome|firefox|webkit|msedge, `--headless`, `--user-data-dir`, `--extension`, `--allowed-origins` / `--blocked-origins`, `--caps vision,pdf,devtools`, `--output-dir`, `--shared-browser-context` ("reuse the same browser context between all connected HTTP clients"), `--device`, `--port` (SSE).
- VERIFIED tools: `browser_navigate`, `browser_snapshot` ("Capture accessibility snapshot of the current page, this is better than screenshot"), `browser_click`, `browser_type`, `browser_press_key`, `browser_select_option`, `browser_hover`, `browser_wait_for`, `browser_console_messages`, `browser_network_requests`, `browser_take_screenshot`, `browser_evaluate`, `browser_file_upload`, `browser_handle_dialog`, `browser_tabs`, ... Actions take "Exact target element reference from the page snapshot".
- VERIFIED attach semantics (source): `connectOverCDP(cdpEndpoint, ...)` in https://github.com/microsoft/playwright/blob/main/packages/playwright-core/src/tools/mcp/browserFactory.ts; context choice `config.browser.isolated ? browser.newContext() : browser.contexts()[0] ?? newContext()` (program.ts); the first page seen becomes the current tab and new pages of the context are adopted (backend/context.ts). So without `--isolated` two agents share one tab.
- VERIFIED: the endpoint is "A CDP websocket endpoint or http url" (https://github.com/microsoft/playwright/blob/main/docs/src/api/class-browsertype.md); the MCP CLI passes only a string (no pipe).
- UNVERIFIED: that disconnecting never closes a browser it attached to (traced, not tested).

### (b) chrome-devtools-mcp
- VERIFIED Node range: https://raw.githubusercontent.com/ChromeDevTools/chrome-devtools-mcp/main/package.json.
- VERIFIED flags: https://raw.githubusercontent.com/ChromeDevTools/chrome-devtools-mcp/main/docs/configuration.md (`--browserUrl`, `--wsEndpoint`, `--wsHeaders`, `--autoConnect`, `--headless`, `--executablePath`, `--isolated`, `--userDataDir`, `--channel`, `--viewport`, `--pageIdRouting` "Requires a pageId on page-scoped tools for routing across concurrent sessions", URL patterns). No pipe flag.
- VERIFIED: it sees every page target of the browser: `list_pages` "Get a list of pages ... open in the browser"; `#fetchPageTargets()` returns `this.browser.targets().filter(...)` and auto-discovers contexts it did not create (https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/src/McpContext.ts).
- VERIFIED disclaimer (README): "exposes content of the browser instance to the MCP clients allowing them to inspect, debug, and modify any data in the browser or DevTools."
- VERIFIED: when it launches its own browser it uses `puppeteer.launch({... pipe: true})` (src/BrowserManager.ts).

### (c) MCP over stdio
- VERIFIED: the current revision is 2026-07-28 and moves version / client info into each request's `_meta`; servers MUST implement `server/discover`; dual-era servers MAY also answer `initialize` (https://modelcontextprotocol.io/specification/versioning, https://modelcontextprotocol.io/specification/2026-07-28/server/discover, https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio). Unsupported version: error `-32022` with `data.supported` / `data.requested`.
- VERIFIED legacy handshake (2025-11-25): `initialize` → `{protocolVersion, capabilities, serverInfo, instructions?}`, echo the requested version when supported; `notifications/initialized`; `ping` → `{}` (https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle, .../utilities/ping).
- VERIFIED framing: newline-delimited JSON-RPC, no embedded newlines, nothing else on stdout, exit when stdin closes (both revisions).
- VERIFIED tools: `tools/list` items `{name, title?, description, inputSchema, annotations?}`; `tools/call` result `content[]` with `{"type":"text"}` / `{"type":"image","data":<base64>,"mimeType"}`; execution failures as `isError: true`, unknown tools / bad params as JSON-RPC errors (`-32602`) (https://modelcontextprotocol.io/specification/latest/server/tools).
- UNVERIFIED: which revision Claude Code and Codex send today; the helper answers both.

### Claude Code: per-process MCP server
- VERIFIED (`claude --help`, local): `--mcp-config <configs...>  Load MCP servers from JSON files or strings (space-separated)`; `--strict-mcp-config  Only use MCP servers from --mcp-config, ignoring all other MCP configurations`. The option is variadic, so a positional prompt after it could be read as a second config. Gridkeeper passes the single-token form `--mcp-config=<file>` (UNVERIFIED that the `=` form ends the list in Claude Code's parser; it does in commander, which Claude Code's CLI uses).
- VERIFIED, additive: "A server a user passes with `--mcp-config` under the same name replaces the provided one for that run"; "`--strict-mcp-config` leaves provided servers out along with every other configured server" (https://code.claude.com/docs/en/managed-mcp); with strict, "Claude Code then uses only the MCP servers you pass with `--mcp-config`" (https://code.claude.com/docs/en/mcp). So without strict the user's servers stay; a unique name (`gk-browser`) avoids replacing one of theirs.
- VERIFIED blocker: with an enterprise `managed-mcp.json` the CLI exits ("You cannot dynamically configure MCP servers when an enterprise MCP config is present", managed-mcp page). Gridkeeper skips the injection when that file exists and says why.
- VERIFIED schema: `{"mcpServers":{"name":{"type":"stdio","command":...,"args":[...],"env":{...}}}}` (managed-mcp / mcp pages).
- VERIFIED tool names `mcp__<server>__<tool>`; "MCP tools require explicit permission before Claude can use them"; `mcp__gk-browser__*` in `--allowedTools` would pre-approve (https://code.claude.com/docs/en/permissions). Gridkeeper does not pre-approve.
- VERIFIED timeouts (https://code.claude.com/docs/en/env-vars): `MCP_TIMEOUT` startup 30000 ms; `MCP_TOOL_TIMEOUT` default 100000000 (~28 h, "Stdio ... servers have no per-request timer"); `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` 30 min for stdio; `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS` 120000 (a long call moves to a background task). Gridkeeper's waits (2 min confirmation, 9 min take-over) stay inside them.
- UNVERIFIED: whether `--mcp-config` servers need the approval prompt that project `.mcp.json` servers get (docs describe it only for `.mcp.json`).

### Codex: per-run overrides
- VERIFIED (`codex --help`, local): "`-c, --config <key=value>` Override a configuration value ... Use a dotted path ... The `value` portion is parsed as TOML. If it fails to parse as TOML, the raw string is used as a literal."
- VERIFIED (source, codex-rs `config/src/overrides.rs`, `loader/mod.rs`, `merge.rs`): the overrides form a "SessionFlags" layer merged table by table over `config.toml`, so other `[mcp_servers.*]` stay; "Managed config wins over CLI config".
- VERIFIED keys (https://learn.chatgpt.com/docs/config-file/config-reference): `command`, `args`, `env`, `env_vars`, `cwd`, `startup_timeout_sec` (default 10 s), `tool_timeout_sec` ("default 60s"), `enabled`, `enabled_tools`, `disabled_tools`, approval modes. Gridkeeper sets `tool_timeout_sec = 600`, `startup_timeout_sec = 20`.
- VERIFIED approvals (source `config/src/mcp_types.rs`, `core/src/mcp_tool_call.rs`): default `Auto` prompts unless the tool is annotated `readOnlyHint: true`. Gridkeeper marks only snapshot / console / network / screenshot / wait as read-only.

### Other agent CLIs (manual setup; Gridkeeper injects only for Claude Code and Codex)
VERIFIED unless marked: Gemini CLI `mcpServers` in `~/.gemini/settings.json` (https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/tools/mcp-server.md); GitHub Copilot CLI `--additional-mcp-config` "Add an MCP server for this session only" (https://docs.github.com/en/copilot/reference/cli-command-reference); OpenCode `"mcp": {"x": {"type":"local","command":[...]}}`, per run `OPENCODE_CONFIG_CONTENT` (https://opencode.ai/docs/mcp-servers/); Amp `amp.mcpServers` / `--mcp-config` (https://ampcode.com/docs/customize/mcp); Qwen Code `mcpServers` (Gemini style); Kimi CLI `--mcp-config` / `--mcp-config-file` (local `kimi --help`); Droid `.factory/mcp.json` (local `droid mcp add --help`); Crush `crushrc` (README); Cursor CLI `mcp.json` (https://cursor.com/docs/cli/mcp); Goose `--with-extension`; Hermes `mcp_servers:` in `~/.hermes/config.yaml` (UNVERIFIED); Aider: no MCP client found (UNVERIFIED). A per-session token is generated at launch, so manual setups cannot authenticate today (see HANDOFF follow-ups).

### Browser and transport
- VERIFIED pipe switch (https://github.com/chromium/chromium/blob/main/content/public/common/content_switches.cc): "Enables remote debug over stdio pipes [in=3, out=4] or over the remote pipes specified in the 'remote-debugging-io-pipes' switch."
- VERIFIED Windows handles: default is CRT fds 3/4 via `_get_osfhandle`; `--remote-debugging-io-pipes=<in>,<out>` adopts inherited HANDLE values ("inherited handles in the child process have the same value"), used by ChromeDriver (https://github.com/chromium/chromium/blob/main/content/browser/devtools/devtools_agent_host_impl.cc, .../chrome/test/chromedriver/net/pipe_builder.cc). Node / libuv pass fds 3/4 through `STARTUPINFO.lpReserved2` (https://github.com/libuv/libuv/blob/v1.x/src/win/process-stdio.c). Gridkeeper does both.
- VERIFIED framing: NUL-terminated messages; receive buffer 100 MiB (https://chromium.googlesource.com/chromium/src/+/main/content/browser/devtools/devtools_pipe_handler.cc).
- VERIFIED: Playwright always launches Chromium with `--remote-debugging-pipe`, Windows included (https://github.com/microsoft/playwright/blob/main/packages/playwright-core/src/server/chromium/chromium.ts); its `msedge` channel uses the same launcher, so Edge supports the pipe (inferred).
- VERIFIED Chrome 136 (https://developer.chrome.com/blog/remote-debugging-port): `--remote-debugging-port` / `--remote-debugging-pipe` "will no longer be respected if attempting to debug the default Chrome data directory"; must be "accompanied by the `--user-data-dir` switch". Reason: infostealers reading cookies over the port. UNVERIFIED for Edge.
- VERIFIED: "Any application on your machine can connect to this port and control the browser" (chrome-devtools-mcp docs/advanced-usage.md). This is why (a)/(b) were not attached to a port: a random 127.0.0.1 port plus an isolated profile limits the damage but any local process (including other agents' tools) could still drive every tab. The pipe has no such exposure.
- VERIFIED quiet-profile switches: Playwright `chromiumSwitches.ts` and Puppeteer `ChromeLauncher.ts` default args (`--no-first-run`, `--disable-sync`, `--disable-background-networking`, `--disable-component-update`, `--password-store=basic`, `--use-mock-keychain`, `--edge-skip-compat-layer-relaunch`, `--disable-edgeupdater`, `--disable-features=...msForceBrowserSignIn...`).
- VERIFIED CDP (https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/json/browser_protocol.json): `Page.startScreencast {format, quality, maxWidth, maxHeight, everyNthFrame}` (experimental), `Page.screencastFrame {data, metadata, sessionId}` acked with `Page.screencastFrameAck {sessionId}`; `Input.dispatchMouseEvent` (CSS pixels of the main-frame viewport), `Input.dispatchKeyEvent`, `Input.insertText`; `Target.createBrowserContext`, `Target.createTarget {url, browserContextId, newWindow}` ("not supported by headless shell"; full headless is fine), `Target.attachToTarget {flatten: true}`.
- Browser paths on this machine (VERIFIED, Test-Path): Edge `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`, Chrome `C:\Program Files\Google\Chrome\Application\chrome.exe`.

### Rust crates
- VERIFIED: `chromiumoxide` 0.9.1 is tokio-only, WebSocket transport (async-tungstenite, reqwest), no pipe support found (https://crates.io/api/v1/crates/chromiumoxide/0.9.1/dependencies, README). `headless_chrome` 1.0.22: threads + tungstenite, no pipe. Neither fits the pipe; the pipe protocol is small (NUL-delimited JSON), so Gridkeeper has its own ~200-line client and no new crate.

## 3. Design that follows

- One headless Edge / Chrome / Chromium per Gridkeeper instance, profile `<data>\agent-browser\profile`, `--remote-debugging-pipe`, its own kill-on-close Job Object (Windows) / POSIX session (Unix), started on the first tool call, stopped after `idleMinutes` (default 10) without a tool call and without a viewer, 60 s after the last tab closed, and on app exit.
- Per session: `Target.createBrowserContext` + one page (separate cookies / storage per agent; the context dies with the tab). Popups are closed and reported to the agent.
- Helper ↔ host: per-user named pipe (DACL: this user + SYSTEM; `FILE_FLAG_FIRST_PIPE_INSTANCE`; `PIPE_REJECT_REMOTE_CLIENTS`) or a 0700-folder Unix socket. Each request carries the session id and a per-launch token; the host also checks that the client pid is inside the session's process tree.
- Measured / estimated memory: see HANDOFF (section "Agent browser").
