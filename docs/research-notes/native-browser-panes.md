# Research notes: native browser panes (child webviews) (2026-10-19)

Question: can browser panes be real browser views (Tauri 2 child webviews, one per pane, laid over the pane)
instead of sandboxed iframes, so that every site works (GitHub, Google, sign-in pages), with real history,
`target=_blank`, page titles, downloads and app shortcuts? Stack: tauri 2.12.4, tauri-runtime-wry 2.12.2,
wry 0.57.0, webview2-com 0.39.1. Sources: the crate sources in the cargo registry (read directly; paths below),
Microsoft WebView2 docs, Tauri / wry issues. **VERIFIED** = primary source read. **UNVERIFIED** = not tried on a
running app yet (this note was written without starting one; see "What must be verified live").

## Verdict

| Platform | Verdict | Why |
|---|---|---|
| Windows (WebView2) | **workable; implemented, default** | `Window::add_child` + `set_bounds` / `hide` / `show` / `set_focus` work on WebView2 child HWNDs; new children go on top of the z-order; WebView2 exposes everything a pane needs (history, title, focus, accelerator keys, snapshots, memory level). Needs live verification (below). |
| Linux (WebKitGTK) | **not workable with Tauri 2.12** | tauri-runtime-wry packs child webviews into the window's `GtkBox`; `set_bounds` only moves views in a `GtkFixed` or on X11, so children stack / split the window and cannot follow a pane. Iframes stay. |
| macOS (WKWebView) | **not enabled** | The API works in principle (NSView subviews, flipped-coordinate fix merged), but the `unstable` feature changes how the main webview is built, several open input bugs exist, there is no accelerator-key hook for app shortcuts, and nobody can verify it here. Iframes stay; revisit with a Mac. |

Implementation: `src-tauri/src/browser_view.rs`, `src/browser/nativeViews.ts` (+ `nativeSync.ts`, `engine.ts`),
setting "Browser engine: Native (recommended) / Embedded frame (legacy)". The `unstable` feature is enabled for the
Windows target only (`Cargo.toml`), so macOS / Linux builds are unchanged.

## Tauri 2.12 multi-webview API (VERIFIED in source)

- `Window::add_child(WebviewBuilder, position, size)` is gated on `all(desktop, feature = "unstable")`
  (`tauri-2.12.4/src/window/mod.rs` ~L1224). It runs the build on the main thread and waits on a channel, so it
  must not be called from the main thread: "On Windows, this function deadlocks when used in a synchronous command"
  (same doc; wry#583, tauri#10010). `browser_view_create` is an async command and builds in `spawn_blocking`.
- Position / size are relative to the window's client area (doc of `add_child`). The main webview fills the client
  area, so a pane's CSS rect times `devicePixelRatio` is the child's physical rect.
- **With `unstable`, every window's webview is built as a child** (`tauri-runtime-wry-2.12.2/src/lib.rs` ~L4596:
  `WebviewKind::WindowChild` when the feature is on), with bounds = the whole window and auto-resize rates
  (0, 0, 1, 1) applied on `Resized` (~L4273). That changes the main window too, even with the iframe engine.
- **`get_webview_window("main")` returns None as soon as the window hosts a second webview**: it requires
  `window.is_webview_window()` = every webview of the window has the window's label (`src/lib.rs` ~L603,
  `src/window/mod.rs` ~L1257). The `WebviewWindow` command extractor fails the same way. Gridkeeper's
  `webview_guard::main_window` / `main_webview` look the window / webview up by label instead (`get_window`,
  `get_webview`, both `unstable`-gated). No plugin we use takes a `WebviewWindow` command argument (checked
  dialog 2.8.3, opener 2.7.2, clipboard-manager 2.5.0, notification 2.7.0, single-instance 2.5.4).
- Child bounds: `Webview::set_bounds` (`src/webview/mod.rs` ~L1650) → wry `set_bounds_inner`: `controller.SetBounds`
  + `SetWindowPos(SWP_ASYNCWINDOWPOS | SWP_NOZORDER)` on the child's container HWND (`wry-0.57.0/src/webview2/mod.rs`
  ~L1526). Children created without `auto_resize` keep their bounds on window resize (no rate recalculation,
  `tauri-runtime-wry` ~L3722), which is what a pane that follows a DOM rect wants. tauri wry#1875 (OPEN): with
  auto-resize a wrong `set_bounds` sticks; not used here.
- `hide` / `show` → `ShowWindow(SW_HIDE/SW_SHOW)` + `controller.SetIsVisible` (wry ~L1567). Hidden WebView2s are
  throttled (CPU / memory benefits per the WebView2 performance docs).
- Z-order: the container HWND of a new webview is placed `HWND_TOP` (wry ~L273, fix for tauri#9798, wry#1271), so
  every child is above the main webview. There is no API to reorder children (tauri#11124, OPEN) and DOM content
  can never be drawn over a child (tauri#15682 comment; "a full compositor would be required").
- Navigation hooks: `on_navigation` (every top-level navigation incl. redirects; wry `NavigationStarting`),
  `on_new_window` (`NewWindowRequested`; `Deny` / `Allow` / `Create`), `on_download` (`DownloadStarting` +
  `StateChanged`; the suggested `ResultFilePath` is passed in and can be replaced; returning true marks it handled
  so no WebView2 download UI appears, wry ~L859), `on_document_title_changed`, `on_page_load`.
- `Webview::navigate`, `reload`, `url`, `set_focus`, `close`, `open_devtools` (debug / `devtools` feature only).
  Back / forward / stop are not exposed by Tauri; wry has them; Gridkeeper calls `ICoreWebView2::GoBack` /
  `GoForward` / `Stop` through `with_webview`.
- `with_webview` gives the `ICoreWebView2Controller` on Windows (already used by `webview_guard.rs`). Every
  WebView2 event Gridkeeper needs is reachable from it: `NavigationStarting/Completed`, `SourceChanged`
  (also same-document navigations), `HistoryChanged` (`CanGoBack/CanGoForward`), `DocumentTitleChanged`,
  controller `GotFocus/LostFocus`, `AcceleratorKeyPressed`, `CapturePreview`, `ICoreWebView2_19::MemoryUsageTargetLevel`.
- Focus: wry only installs its focus-restoring subclass for non-child webviews, and with `unstable` the main
  webview is a child; Alt+Tab back used to leave no keyboard focus (tauri#15624), fixed in tauri-runtime-wry 2.12.0
  (we have 2.12.2). `Window::is_focused` in multi-webview mode fixed in 2.12.0 (#15950). Older duplicate tauri#13466
  still open.

## Platform status (issues; dates are creation dates)

- **Windows**: DPI sizing fixed (tauri#9264, wry#1202, 2024). Custom-titlebar windows can't be resized with
  `unstable` (tauri#12207, tauri#9634, OPEN) — Gridkeeper's window is decorated, not affected. "Webviews load mostly
  white" on Windows 10 (tauri#10011, OPEN). Closing panics fixed (tauri#8888); 0x8007139F after `window.close`
  from JS (tauri#13331, OPEN).
- **Linux**: children are packed into the vertical `GtkBox`; `set_bounds` / `set_position` / `set_size` do
  nothing (tauri#10420 OPEN, canonical; tauri#16132 dup, 2026-09). Wayland: wry's bounds code is X11-only.
  Maintainer: "The example only works on x11 but even there the `unstable` flag's name checks out" (tauri#13071).
  Unmerged fix: wry#1745. Also tauri#15656 (Wayland bounds), wry#1808 (panic on unexpected parent chain).
  Verified in `tauri-runtime-wry` ~L5171 (`build_gtk(vbox)` for `WindowChild`) and `wry-0.57.0/src/webkitgtk/mod.rs`
  ~L683 / ~L963 (`set_bounds` only for `GtkFixed` / X11).
- **macOS**: flipped coordinates fixed (wry#1538); traffic lights stuck at (0,0) with `unstable` (tauri#14072, OPEN);
  keyboard issues in child webviews: double characters (tauri#8705), arrow keys (tauri#10194), editing shortcuts
  (tauri#9257), undo / redo (tauri#10148), all OPEN; cursor flicker over the host (wry#1763); only the last child
  renders (tauri#11376, OPEN, macOS 14).
- Tauri's own status: "**unstable**: Enables unstable features. Be careful, it might introduce breaking changes in
  future minor releases" (`src/lib.rs`); the v2 beta announcement keeps multiwebview "behind an unstable Cargo feature
  flag while the API design is reviewed"; tauri 2.12.0 locks unstable tauri crates to minor versions (#15887).
  Example: `examples/multiwebview` in the tauri repo.
- Prior art: Laymux evaluated Tauri multiwebview and moved to CEF (kochul2000/laymux#26, citing #9798, #11376,
  #10420, #13466). Canopy IDE ships a child-webview preview and shows a host-taken "freeze-frame" image while DOM
  panels cover it (FluidWorksApp/canopy-ide#210) — the same placeholder approach as here.

## Security (VERIFIED in source)

- Views are labelled `bv-<pane id>` (UUID). `capabilities/default.json` and `macos.json` target `"webviews": ["main"]`
  (unchanged), so a view matches no capability: no plugin command (`ipc/authority.rs resolve_access`).
- App (custom) commands: `Webview::on_message` checks the ACL when the request comes from a non-local origin
  (`src/webview/mod.rs` ~L2080: "remote content can never reach custom commands unless an explicit `remote`
  capability"). Local = Tauri's protocol hosts or the dev URL (`is_local_url` ~L1961; `file:` and `about:blank` are
  not local). `view_navigation_allowed` refuses the app's origins for every top-level navigation and redirect (and
  `blob:` URLs created by them), exactly like pop-out windows. Every Tauri webview still gets the IPC bootstrap and
  invoke key; the two checks above are what protect it (same model as ADR-019's pop-outs).
- Channel data: `ChannelDataIpcQueue` is scoped per webview label in 2.12.4 (`src/ipc/channel.rs` ~L44), so a view
  cannot fetch terminal output frames meant for the main webview.
- New windows are always denied; the URL (http / https, not the app) goes to the main webview, which opens it in a
  new pane or the same pane (setting). Events are emitted to the `main` webview only; JS listeners exist only where
  `plugin:event|listen` is allowed, i.e. the main webview.
- Downloads go to the user's Downloads folder (WebView2's suggested path when it is already there, else the file
  name there, numbered when taken).

## Memory (process model)

- WebView2 environments on one user data folder share one browser process, GPU process and utility processes;
  renderer processes are per site (site isolation), "a given renderer process is not associated with a single
  CoreWebView2 instance" (learn.microsoft.com/microsoft-edge/webview2/concepts/process-model).
- A cross-origin iframe already runs in its own renderer process with site isolation, so the per-page renderer cost
  is about the same as with iframes; a child view adds a controller and a compositor surface. **UNVERIFIED (no
  figure measured)**: measure with Diagnostics (WebView bucket) with 1 / 4 panes on GitHub and a Vite app, iframe vs
  native.
- Environments sharing a user data folder must use identical options, else creation fails with
  `HRESULT_FROM_WIN32(ERROR_INVALID_STATE)` = 0x8007139F (WebView2 IDL reference; tauri#11144; tauri PR #15771
  documents separate `data_directory` for differing args). wry creates one environment per webview from its options
  (`create_environment`, wry ~L289), so each view is built with the main window's `additionalBrowserArgs` from
  `tauri.conf.json`.
- Performance guidance followed: one environment for all controls; `MemoryUsageTargetLevel = Low` while a pane is off
  screen ("parked"), Normal when shown; `IsVisible = false` whenever hidden. Not done: `TrySuspendAsync`, hiding views
  while the window is minimized (child webviews get no minimize messages; follow-up).

## Overlays above a native view

A native view always paints above the main webview, so menus, dialogs, the palette, Mission Control and toasts cannot
be drawn over it. Approach (`nativeViews.ts`):
- **Detection is generic**: hit-test a grid of points (≤ 80 px apart, inset 4 px, ≤ 400 points) over each shown
  pane's host box with `document.elementFromPoint`; anything other than the host on top → hide that view
  ("occluded"). No list of overlays to maintain; `pointer-events: none` decorations (blades, effect layers) are
  ignored by hit testing. Re-checked on host / layout / store changes, portal children added to `<body>` or the shell
  (shallow MutationObserver), clicks, pointer-ups, transition / animation ends, visibility and DPI changes (one rAF
  per burst; no timers).
- **Placeholder**: before hiding, a JPEG of the view (`CapturePreview`, ≤ 180 ms wait) is put into the host box; a
  snapshot taken less than 1.5 s earlier is reused (snapshots are refreshed when the pointer comes back into the app
  from a view). CapturePreview fails before the first `ContentLoading`; then the pane is simply empty while covered.
- **Drags**: HTML drag and drop (pane reorder) hides every view (with placeholder) until `dragend` / `drop`, since a
  view is an OLE drop target of its own.
- **Toasts** (a live region: `[aria-live]`, `role=status/alert`) hide a view like any overlay, except the view that
  has keyboard focus: blanking the page someone types in (and taking its focus) for a passing notification is worse
  than the toast being drawn behind that one pane.

## Keyboard

- `AcceleratorKeyPressed` fires while a view is focused for keys pressed with Ctrl or Alt held or keys that don't map
  to a character (F-keys, Escape …), also on auto-repeat; `Handled(TRUE)` keeps the key from the page and from
  WebView2's own browser accelerators (ICoreWebView2Controller docs). Gridkeeper registers the app's bound combos
  (`browser_view_set_shortcuts`, refreshed when bindings change); a match is marked handled and sent to the app
  (`browser-view-shortcut`), which moves keyboard focus back to the page (`browser_view_blur`) and runs the command.
  Keys are encoded like `combo.ts` (`ctrl+alt+shift+meta+key`; punctuation by scan code, matching `KeyboardEvent.code`).
- Everything else stays with the page, including WebView2's browser keys (Ctrl+F, Ctrl+P, F5, Alt+←/→, Ctrl+wheel
  zoom). Editing keys (Ctrl+C/V/X/A/Z) can't be app bindings (`forbiddenReason`), so they always reach the page.
- Clicking into a view focuses it (`GotFocus` → the pane becomes the focused pane); hiding a focused view moves focus
  back to the app page so shortcuts keep working.

## What must be verified live (sandbox, Windows)

1. Startup and window behaviour with `unstable` (main webview now an auto-resizing child): resize, maximize /
   restore, snap, move between monitors with different scale, full screen, Alt+Tab focus, minimise / restore,
   `webview_guard` reload / rebuild (`npm run sandbox`, then kill only the sandbox's WebView2 browser process).
2. Sites that refused framing: github.com (sign in), accounts.google.com, a Vite dev server (HMR keeps working),
   a `file:` page, a site with `target=_blank` links (both new-window settings), a download (lands in Downloads, toast
   with "Show in folder").
3. Position and size at 100 / 125 / 150 %: no gap or overlap at pane edges, separator drags, maximize, layout presets,
   group / workspace switches, Changes drawer / Inspector open and close, focus mode, presentation mode.
4. Overlays over a browser pane: pane header menu, context menus, command palette (Ctrl+Shift+P from inside the page),
   Settings and other dialogs, Mission Control, Fleet, Comms, toasts (download toast over the pane), pane drag and
   drop onto / across a browser pane. Expect the snapshot in place of the page while covered.
5. Shortcuts with focus inside a page: Ctrl+Shift+P, Ctrl+Tab / Ctrl+Shift+Tab, Alt+1..9, Ctrl+Shift+W (closes the
   pane and its view), Ctrl+, ; plain typing, Ctrl+C / V / A, Ctrl+F and F5 still go to the page.
6. Memory (Diagnostics, WebView bucket) with 1 and 4 native panes vs iframe panes; parked panes drop after a group switch.
7. Switching the engine in Settings back and forth with pages open; a failed creation falls back to frames with a toast.
