# Performance

All numbers below were **measured on the target machine** with a **release build**, using
`scripts/bench/run-all.ps1` + `scripts/bench/sample.ps1`. Raw CSVs are written to `bench-results/`
(git-ignored). Re-run them yourself after any change; do not trust numbers you did not reproduce.

## Test machine (inspected, not assumed)

| Item | Value |
|---|---|
| CPU | Intel Core i7-12650H — 10 cores / 16 logical processors |
| RAM | 15.7 GB |
| GPUs | Intel UHD Graphics (driver 32.0.101.5542) + NVIDIA GeForce RTX 3050 Laptop GPU 4 GB (driver 592.82) |
| OS | Windows 11 Home, build 26300 |
| WebView2 Runtime | 155.0.4283.60 |
| Toolchain | Rust 1.99.1, Node 26.4.0 |
| Agent CLIs | Claude Code 2.1.302, codex-cli 0.162.0, PowerShell 7.6.7 |
| WebGL renderer reported by the app | `ANGLE (NVIDIA, NVIDIA GeForce RTX 3050 Laptop GPU (0x000025A2) Direct3D11 vs_5_0 ps_5_0, D3D11)` — Windows assigned the discrete GPU |

Disk: 22.7 GB free on C:, 207 GB on D:. Build artefacts: installer `*_x64-setup.exe` **5.2 MB**, app binary **13.8 MB**.

## Final build results (2026-10-17, commit c04b899, all features)

Re-measured on the finished app (notifications/attention monitor, GPU telemetry, accounts, Mission Control, browser panes,
ports, themes) with the same scripts. **These supersede the earlier tables below**, which were taken before most features
existed and are kept for comparison.

| Scenario | Host CPU | Host private | WebView2 CPU | WebView2 private | GPU engine | GPU mem |
|---|---|---|---|---|---|---|
| Idle, 1 session | 0.10 % | 17 MB | 0.13 % | 288 MB | 0.27 % | 72 MB |
| Idle, 6 sessions | 0.06 % | 19 MB | 0.42 % | 329 MB | 0.42 % | 86 MB |
| 6 × 2,000 lines/s (WebGL) | 1.07 % | 33 MB | 6.42 % | 419 MB | 27 % avg / 32 % peak | 67 MB |

Takeaways: idle cost is still a fraction of one percent of the machine; the finished feature set added roughly
30–45 MB of WebView2 memory; under heavy output the GPU now carries ~27 % of rendering work while WebView2 CPU dropped
to ~6.4 % (vs 12.5 % in the earlier build). The in-app status bar and Diagnostics show the same GPU counters live.

## Methodology

- `GRIDKEEPER_BENCH` bench mode creates an in-memory workspace of N PowerShell sessions (user data untouched),
  optionally running `scripts/bench/flood.ps1` (`sustained`: N lines/s per session; `lines`: a fixed burst).
- Each scenario: launch → 20 s warm-up → 30–40 s of 1 Hz samples → graceful close (WM_CLOSE).
- Processes are attributed by walking the app's process tree:
  - **host** — the Rust/Tauri process (`gridkeeper.exe`): PTY readers, flow control, IPC, persistence.
  - **webview** — `msedgewebview2.exe` descendants: UI, xterm.js parsing, rendering, compositing.
  - **console** — `OpenConsole.exe`/`conhost.exe` (ConPTY hosts, one per session).
  - **agents** — everything else (pwsh, claude, codex, node, git…). **Not the app's cost.**
- **CPU %** is Task-Manager style: percent of the *whole machine* (16 logical processors). 6.25 % = one full core.
- **WS** = working set (sums double-count pages shared between WebView2 processes). **Private** = private bytes
  (the honest "how much RAM does this cost" number).
- **GPU %** = sum of the Windows "GPU Engine" utilisation counters for the category's processes (same source as
  Task Manager); **GPU mem** = dedicated GPU memory.

## Results (release build)

### Idle (sessions at a prompt, window visible)

| Scenario | Host CPU | Host private | WebView2 CPU | WebView2 private | GPU engine | GPU mem |
|---|---|---|---|---|---|---|
| 1 session | 0.05 % | 11 MB | 0.08 % | 257 MB | 0.14 % | 61 MB |
| 6 sessions | 0.07 % | 14 MB | 0.18 % | 283 MB | 0.78 % | 64 MB |
| 12 sessions | 0.09 % | 38 MB WS¹ | 0.37 % | 472 MB WS¹ | 0.20 % | 87 MB |

¹ 12-session row comes from the first run, before private bytes were recorded, so it shows working set (WS), which over-counts shared pages. Private bytes for this scenario were not measured.

**Takeaway:** an idle workspace costs ≈0.1–0.4 % of the machine regardless of session count — no polling loops,
hidden panes stop rendering, idle pumps block on a condition variable. Each additional idle session adds
≈2–5 MB to the app (plus ~12 MB for its ConPTY host and whatever the agent itself uses).

### Sustained output: 6 sessions × 2,000 coloured lines/s (12,000 lines/s total)

| Renderer | Host CPU | WebView2 CPU | WebView2 private | GPU engine | GPU mem |
|---|---|---|---|---|---|
| WebGL | 2.6 % | 12.5 % | 450 MB | 31 % | 69 MB |
| DOM (software path, GPU-composited) | 1.3 % | 9.0 % | 423 MB | 32 % | 48 MB |

Burst: 6 × 200,000 lines (`flood-6-webgl`): WebView2 12.4 % avg / 16.7 % peak, host 4.4 %, GPU 18 % avg / 30 % peak.

**Honest reading:** at this throughput the WebGL renderer did *not* use less CPU than the DOM renderer. The
dominant cost is xterm.js *parsing* (identical for both renderers) and Chromium already composites the DOM
renderer on the GPU. The WebGL run also processed more output in the same window (its agent CPU was higher), so the
comparison is not perfectly controlled. WebGL's advantages are in large/dense panes, fast scrolling and smooth frame
pacing, which this benchmark does not isolate. Both renderers stay responsive; flow control kept memory bounded and
never paused the producing processes.

### End-to-end checks in the running app (dev build, via CDP)

| Check | Result |
|---|---|
| 20,000-line PowerShell output | complete in 3.3 s (debug build, includes pwsh's own time) |
| Keystroke→echo round trip (`Write-Output`) | ~205 ms including PowerShell command execution |
| 50,000 lines produced while view hidden, then reopened | replayed tail correct, still interactive |
| Malformed/garbage escape sequences | terminal still usable afterwards |
| GPU context loss (forced) | DOM fallback, WebGL restored, session unaffected |
| Agent killed externally | exit detected, sibling session unaffected, restart OK |
| 60 rapid workspace switches | ~24 ms per switch, no terminal/listener leak |
| App restart with 10 live agents | no orphaned agent processes (Job Objects) |

## What uses RAM, and how to reduce it

- **WebView2 (~250–300 MB private idle)** is the largest fixed cost: Chromium browser, GPU, network/utility and
  renderer processes. It is shared by *all* panes — opening more sessions barely moves it. A Tauri app avoids
  shipping its own Chromium; Electron apps carry a comparable runtime (see docs/RESEARCH.md for sources).
- **xterm.js buffers** grow with `scrollbackLines` × columns × open terminals (≈12 bytes per cell). Lower the
  scrollback in Settings if you keep many large panes open. Terminals are created lazily — never-opened sessions
  cost nothing in the UI.
- **Rust ring buffer** per session = `bufferKib` (default 2 MiB), bounded.
- **The agents themselves** (Claude Code ≈ 80–200 MB each, Codex similar) dominate total RAM with many sessions.
  GPU acceleration cannot reduce that.
- `tauri.conf.json` passes lean WebView2 flags (no background networking, component updates, sync, crash uploads;
  GPU rasterization on). Measure before/after with `run-all.ps1` when changing them.

## GPU usage: what it does and does not do

- **Does:** terminal glyph rendering (WebGL texture atlas), compositing of the whole UI, scrolling.
- **Does not:** reduce CPU used by Claude Code / Codex / Node / git / builds, or by xterm.js parsing. Agent CPU is
  attributed separately in the status bar ("Agents CPU") and Diagnostics so it is never mistaken for app overhead.
- **Hybrid GPUs:** Windows decides which GPU WebView2 uses. On this laptop it chose the NVIDIA RTX 3050. To force
  either GPU: *Settings → System → Display → Graphics → add the app → Options*. The status bar shows the verbatim
  renderer string; it never guesses.
- **Limits:** Chromium allows ~16 live WebGL contexts per page, so the app uses WebGL for up to 12 visible panes and
  the DOM renderer for the rest, and recovers from context loss automatically. Diagnostics warns when a group shows
  more than 12 panes.

### In-app GPU telemetry

The status bar ("GPU: WebGL ×6 · GPU 4%") and *Diagnostics › GPU* show live figures read from the same Windows
performance counters Task Manager uses, through one long-lived PDH query (`src-tauri/src/gpu.rs`):

- `\GPU Engine(*)\Utilization Percentage`: per engine instance (`pid_…_luid_…_phys_…_eng_…_engtype_3D`), attributed
  to the host process, the app's WebView2 processes and the session process trees (the PID sets Diagnostics already
  computes). A group's figure is its busiest engine (Task Manager's per-process "GPU" column); "WebView2 3D" is the
  busiest 3D engine. Whole-adapter load is shown per engine class (3D, Copy, Video, Compute, Other).
- `\GPU Process Memory(*)\Dedicated Usage` / `Shared Usage` for WebView2, `\GPU Adapter Memory(*)\Dedicated Usage`
  per adapter.
- Adapters are identified by LUID (no DXGI dependency). The adapter holding WebView2's GPU allocations is marked
  "Draws the UI" and shown next to the verbatim WebGL renderer string; with no WebView2 signal nothing is marked.
- Utilization is a rate: the first sample after opening the query shows "measuring", values follow on the next
  2 s refresh. If the counters are unavailable (e.g. some VMs) the UI says so; no figure is ever estimated.
- Cost, measured on the test machine (debug build, 381 engine instances, 3 adapters): ~5–6 ms per snapshot
  (collect ≈1 ms, format ≈2–3 ms, rest attribution); opening the query once costs ≈0.4 s on the blocking pool. It
  runs only inside `diagnostics_snapshot`, i.e. only while the status-bar resources or Diagnostics are visible.

What the figures show: the GPU draws terminal text and composites the UI. Typical idle load is a few percent of the
3D engine; it does not reduce agent CPU.

## Reproduce

```powershell
npm run tauri build                     # release build (use CARGO_BUILD_JOBS=4 on 16 GB machines)
pwsh -File scripts/bench/run-all.ps1     # all scenarios -> bench-results/summary.csv
pwsh -File scripts/bench/run-all.ps1 -Only "idle-6-webgl,sustained-6-dom"
```
Each run uses its own WebView2 profile folder, so it can run beside a normal instance.

## Known measurement caveats

- Other processes (including concurrent builds during this session) share the CPU; numbers are per-process
  attribution, not isolated-machine benchmarks.
- `sample.ps1` uses `Get-Process` + performance counters at 1 Hz; sub-second spikes are averaged out.
- Multi-hour soak tests were not run in this session. Sleep/resume: session processes survive on their own; when the
  window returns after more than 60 s away (hidden or unfocused), the UI refits visible terminals, re-sends PTY
  sizes and re-syncs session state from the backend (event-driven, no timers). Network-bound agents may need to retry
  their own requests after resume. A full sleep/resume cycle was not exercised in this session.
