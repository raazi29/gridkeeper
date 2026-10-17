# Research notes — terminal stack (raw findings, 2026-10-17)

Source: research subagent. VERIFIED = primary source checked; HYPOTHESIS = inferred.

## Versions (VERIFIED via npm/crates.io APIs)
npm: @tauri-apps/api 2.12.4, @tauri-apps/cli 2.12.3, plugin-dialog 2.8.3, plugin-clipboard-manager 2.5.0, plugin-opener 2.7.2, @xterm/xterm 6.0.0 (2025-12-22), addon-webgl 0.19.0, addon-fit 0.11.0, addon-unicode11 0.9.0, addon-web-links 0.12.0, addon-search 0.16.0, addon-serialize 0.14.0; addon-canvas 0.7.0 is frozen and incompatible with v6. node-pty 1.1.0, electron 44.9.0 (reference).
crates: tauri 2.12.4, tauri-build 2.7.3, portable-pty 0.9.0 (2025-02-11, MIT), windows 0.62.2 / windows-sys 0.61.2, conpty 0.7.0, winpty-rs 1.0.6, alacritty_terminal 0.26.0 (Apache-2.0), vt100 0.16.2, egui 0.37 / iced 0.14 / gpui 0.2.2. wezterm-term is NOT published on crates.io.
ConPTY NuGet `Microsoft.Windows.Console.ConPTY` stable 1.25.260930003. Windows Terminal latest v1.25.2733.0 (2026-10-02).

## Tauri 2
- WebView2 is evergreen and preinstalled on Windows 11 (https://v2.tauri.app/reference/webview-versions/). Installer modes: downloadBootstrapper (default, 0 MB), embedBootstrapper (~1.8 MB), offlineInstaller (~127 MB), fixedVersion (~180 MB) (https://v2.tauri.app/distribute/windows-installer/). MSI needs WiX v3 + VBSCRIPT feature; NSIS recommended.
- Events "not designed for low latency or high throughput"; JSON payloads evaluated as JS. Channels "designed to be fast and deliver ordered data" (https://v2.tauri.app/develop/calling-frontend/).
- `Channel<InvokeResponseBody>` + `InvokeResponseBody::Raw` arrives as ArrayBuffer; `Channel<Vec<u8>>` serializes as JSON number array (https://docs.rs/tauri/latest/tauri/ipc/struct.Channel.html).
- Anecdotal: binary IPC ~200 ms / 10 MB on Windows vs ~5 ms on macOS (tauri discussion #11915) — HYPOTHESIS, measure.
- Possible GDI growth report (Zebar #264) — watch handles in soak tests.

## Electron vs Tauri RAM
- tauri#5889: on Windows 10 reporter measured Tauri 399 MB vs Electron 318 MB for one app; Ubuntu USS 125 vs 118 MB, PSS 185 vs 207 MB (https://github.com/tauri-apps/tauri/issues/5889).
- Better Stack idle 109 vs 128 MB; levminer.com Win11 ~80 vs 120 MB (non-scientific).
- Conclusion: idle RAM delta on Windows modest (both Chromium); Tauri wins installer size, no Node runtime, Rust backend.

## Alternatives
- Microsoft WPF terminal control `CI.Microsoft.Terminal.Wpf` exists on NuGet CI feed (unsupported); WinUI TermControl embedding not documented.
- LibGhostty.Net 1.0.2 community wrapper; Ghostty has no official Windows build; libghostty-vt unstable (https://github.com/ghostty-org/ghostty/discussions/12290).
- alacritty_terminal 0.26: loads conpty.dll/OpenConsole.exe next to exe else kernel32; exit via RegisterWaitForSingleObject (read from source). iced_term uses it. Native UI would need shaping/selection/IME/a11y built by hand.
- wezterm last tagged release 20240203; repo active.

## xterm.js 6
- Canvas renderer removed; DOM or WebGL. Viewport from VS Code. windowsMode removed. Added DEC 2026 synchronized output, OSC 52, ESM, onWriteParsed (https://github.com/xtermjs/xterm.js/releases/tag/6.0.0).
- `windowsPty?: IWindowsPty` option still exists (typings).
- WebglAddon(preserveDrawingBuffer?), events onContextLoss / onChangeTextureAtlas; README: dispose on context loss.
- Chromium: max 16 active WebGL contexts per renderer process; oldest forcibly lost (https://codereview.chromium.org/14217005/).
- RenderService pauses rendering via IntersectionObserver when not intersecting; write() still parses (src/browser/services/RenderService.ts L119-137).
- Flow control guide: write(data, cb); HIGH 100000 / LOW 10000; keep HIGH <= ~500K; hard 50 MB write buffer then data DISCARDED; throughput 5–35 MB/s (https://xtermjs.org/docs/guides/flowcontrol/).

## portable-pty 0.9.0 (source read)
- Prefers sideloaded conpty.dll next to exe, else kernel32.
- Always CreatePseudoConsole with PSEUDOCONSOLE_INHERIT_CURSOR | RESIZE_QUIRK | WIN32_INPUT_MODE.
- kill() = TerminateProcess on direct child only. wait via WaitForSingleObject.
- INHERIT_CURSOR: host must answer cursor position request (ESC[6n) asynchronously or the app may hang (https://learn.microsoft.com/windows/console/createpseudoconsole). Mitigation: Rust replies ESC[1;1R when no view attached.
- ClosePseudoConsole: from Win11 24H2 (26100) returns immediately; earlier blocks unless output drained; sends CTRL_CLOSE_EVENT (https://learn.microsoft.com/en-us/windows/console/closepseudoconsole).
- Job Objects: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE via JOBOBJECT_EXTENDED_LIMIT_INFORMATION; avoid BREAKAWAY_OK (https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_limit_information). Race: no CREATE_SUSPENDED in portable-pty.
- node-pty 1.1.0 ships conpty.dll + OpenConsole.exe (ConPTY 1.23) with `useConptyDll` experimental.

## High CPU root causes in comparable apps
- Rendering hidden terminals (xterm.js #880). Use display:none so IntersectionObserver pauses.
- Per-chunk IPC + JSON byte arrays. Coalesce + raw frames.
- Terminal data through React state. Keep Terminal in a ref.
- No backpressure: 50 MB buffer overflow → data loss, Ctrl+C lag.
- Too many live terminals: Superset changelog 2026-07-19, ~26% renderer memory reduction by serializing background terminals.
- Cursor blink timers, ResizeObserver/fit loops, atlas rebuilds, WebGL context thrash.

## Licensing
Tauri Apache-2.0 OR MIT; xterm.js MIT; portable-pty MIT; windows-sys MIT/Apache; React/Vite MIT; TypeScript Apache-2.0. Claude Squad is AGPL-3.0 — reference only, no code reuse.

## Existing multi-agent managers
Claude Squad (Go TUI, AGPL, tmux+worktrees); Crystal (MIT, Electron, dormant → Nimbalyst); vibe-kanban (Rust + web, Apache-2.0); Wave Terminal (Go + Electron, Apache-2.0); Terax (Tauri 2 + portable-pty + xterm.js WebGL + CodeMirror, Apache-2.0; https://www.scriptbyai.com/terax-ai-dev-workspace/); Termexo (Windows, Claude+Codex); Superset.
