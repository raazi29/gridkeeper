# Research notes: macOS / Linux readiness (2026-10-19)

What Mac and Linux users will run into with Gridkeeper 0.2 (Tauri 2.12.4, wry 0.57, tao 0.37, muda 0.20,
xterm.js 6 + addon-webgl). Sources: Tauri / tao / muda / wry sources in the cargo registry (read directly), official
docs, WebKit source, GitHub issues. **VERIFIED** = primary source read (link given). **UNVERIFIED** = best
understanding or secondary source; needs a real machine.

## Prioritized checklist

Status: **fixed** (code in this branch) · **documented** (README / HANDOFF tell users) · **deferred** (known, not
done) · **needs hardware** (only a person on a real Mac / Linux desktop can confirm).

| # | Pri | Item | OS | Status |
|---|---|---|---|---|
| 1 | P0 | ⌘W (Tauri's default File / Window › Close Window) closed the only window, so the app exited and stopped every agent | macOS | **fixed**: the main window hides on close; the Dock icon / Window › Main Window bring it back; ⌘Q quits |
| 2 | P0 | Edit menu so ⌘C / ⌘V / ⌘X / ⌘A / ⌘Z work in WKWebView text fields, plus App / Window / Help menus (⌘Q, ⌘H, ⌘M, Settings ⌘,) | macOS | **fixed**: `app_menu.rs` (Tauri's default menu already had Edit; replaced with a fuller one, edit items stay native) |
| 3 | P0 | No double copy / paste between the native Edit items and the terminal's own ⌘C / ⌘V | macOS | **fixed / verified by design** (WebKit source + existing `preventDefault` + paste guard); unit-tested menu rules; **needs hardware** for a final check |
| 4 | P0 | GUI launch PATH: nvm / fnm / asdf / mise / pnpm / bun / volta CLIs and Claude Code's `~/.local/bin` not found from Finder / Dock (or a Linux desktop launcher) | macOS, Linux | **fixed**: login-shell PATH lookup (5 s cap) + longer folder list |
| 5 | P0 | Gatekeeper text: right-click › Open no longer works on macOS 15 | macOS | **documented** (README rewritten) |
| 6 | P0 | Apple Silicon: the dmg was built for the CI host's architecture only (AppVeyor macOS is most likely Intel) | macOS | **fixed**: tag builds produce one universal dmg |
| 7 | P0 | Nothing proved the built app starts on macOS / Linux | all | **fixed**: `--gk-self-test` (all OSes, CI) + `--gk-self-test-gui` (Linux Xvfb required, macOS informational) |
| 8 | P1 | WebKitGTK DMA-BUF renderer: blank window with the NVIDIA proprietary driver, and with the AppImage's bundled WebKitGTK on other distros | Linux | **fixed** (auto `WEBKIT_DISABLE_DMABUF_RENDERER=1` with the NVIDIA proprietary driver or inside an AppImage, unless the user set it) + **documented**; **needs hardware** |
| 9 | P1 | AppImage on Ubuntu 24.04 needs libfuse2 (`libfuse2t64`) | Linux | **documented** |
| 9a | P1 | AppImage's GTK environment variables leak into the shells of panes | Linux | **deferred** (documented: prefer the `.deb`) |
| 9b | P2 | Ubuntu 24.04 user-namespace restriction vs WebKit's bubblewrap sandbox | Linux | **verified, not affected** (sandbox off in WebKitGTK 4.1 / wry) |
| 9c | P2 | Notifications closing at once on GNOME 46+ | Linux | **verified fixed** by tauri-plugin-notification 2.7.0 (in `Cargo.lock`) |
| 10 | P1 | Dock badge for the unread count | macOS | **fixed** (`setBadgeCount`, macOS-only capability) |
| 11 | P1 | OS notifications for an ad-hoc signed app (plugin uses the deprecated NSUserNotification API) | macOS | **needs hardware**; documented as preview |
| 12 | P1 | WebGL context limit in WebKit | macOS, Linux | **verified, no change**: WebKit caps 16 active contexts; `maxWebglFor` is 12 (macOS) / 8 (Linux) |
| 13 | P2 | Retina: `devicePixelRatio` in WKWebView on the `tauri://` scheme; xterm WebGL sharpness | macOS | **needs hardware** |
| 14 | P2 | Wayland vs X11, GNOME dock icon / `StartupWMClass` | Linux | see Linux section; **needs hardware** |
| 15 | P2 | ⌘Q quits without asking while agents run (Terminal.app asks) | macOS | **deferred** (tao has no `applicationShouldTerminate` hook; same as closing the window on Windows) |
| 16 | P2 | App Nap / WebKit throttling while the window is hidden after ⌘W | macOS | **needs hardware** (PTY readers are Rust threads and keep running; UI timers may slow down) |
| 17 | P2 | Hiding a full-screen window | macOS | **fixed** by leaving full screen first; **needs hardware** |

## 1. macOS app menu and ⌘ keys

- **VERIFIED** Tauri installs a default menu on macOS when the app sets none: `Builder::enable_macos_default_menu`
  defaults to `true` and `Menu::default` builds App (About, Services, Hide, Hide Others, Quit), File (Close Window),
  Edit (Undo, Redo, Cut, Copy, Paste, Select All), View (Fullscreen), Window (Minimize, Maximize, Close Window), Help.
  Source: `tauri-2.12.4/src/app.rs` (field `enable_macos_default_menu: true`) and `src/menu/menu.rs` `Menu::default`;
  https://github.com/tauri-apps/tauri/blob/dev/crates/tauri/src/menu/menu.rs. So Gridkeeper 0.2 already had a working
  Edit menu; the v1-era problem "no menu → ⌘C/⌘V dead in inputs" (https://github.com/tauri-apps/tauri/issues/2397,
  maintainer: "You can fix this by adding a menu") does not apply to Tauri 2 apps that keep the default.
- **VERIFIED** The default menu was dangerous for us: muda maps Close Window to `performClose:` (ships with ⌘W;
  `muda-0.20.0/src/items/predefined.rs`, `platform_impl/macos/mod.rs`), tao turns `windowShouldClose:` into
  `WindowEvent::CloseRequested`, and Tauri exits when the last window is destroyed (feature request to change that:
  https://github.com/tauri-apps/tauri/issues/13511). One ⌘W in the main window therefore quit Gridkeeper and stopped
  every agent. Fix: `CloseRequested` on the main window → `prevent_close()` + `hide()` (full screen is left first),
  `RunEvent::Reopen` ("Emitted when the NSApplicationDelegate's applicationShouldHandleReopen gets called",
  `app.rs`) shows it again, as in https://github.com/tauri-apps/tauri/discussions/2684.
- **VERIFIED** ⌘Q still stops the sessions: the predefined Quit item sends `terminate:`; tao's
  `applicationWillTerminate:` calls `AppState::exit()`, which emits `Event::LoopDestroyed`; tauri-runtime-wry maps
  that to `RunEvent::Exit`, where `AppCtx::shutdown` runs `shutdown_all` (`tao-0.37.1/src/platform_impl/macos/
  app_delegate.rs`, `app_state.rs`; `tauri-runtime-wry-2.12.2/src/lib.rs`). `ExitRequested` is not emitted on this
  path, which is fine for us.
- **VERIFIED** Who sees a ⌘ key first. WebKit `WebViewImpl::performKeyEquivalent`: when the WKWebView is first
  responder it sends the event to the page and returns YES ("lets webpages have a crack at intercepting
  key-modified keypresses"); in `doneWithKeyEvent` a handled event stops there, an unhandled one is re-sent with
  `[NSApp sendEvent:]` so the menu gets it
  (https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/mac/WebViewImpl.mm). AppKit tries the
  window's views before the menu bar
  (https://developer.apple.com/library/archive/documentation/Cocoa/Conceptual/EventOverview/HandlingKeyEvents/HandlingKeyEvents.html).
  wry 0.57 returns NO from `performKeyEquivalent:` only for *child* webviews (tauri#9426); Gridkeeper's main window
  and pop-outs are top-level webview windows, so the WebKit path above applies.
- Consequence for the design (`src-tauri/src/app_menu.rs`):
  - Edit items stay **predefined** (native selectors → WebKit runs the editing command → DOM `copy` / `paste`
    events). The terminal's ⌘V handler (`registry.ts` via `terminalKeys.ts`) calls `preventDefault()` on the keydown,
    so WebKit reports the key handled and Edit › Paste does not run as well; `registry.ts` additionally swallows a
    native paste event within 1 s of its own paste. ⌘C with a selection: same; ⌘C without a selection passes to
    xterm, which ignores ⌘ letters (no `preventDefault`), so the menu's `copy:` runs with nothing selected: no-op.
  - Custom items run frontend commands via the `native-menu` event and carry **no accelerators** except Settings… ⌘,.
    `src/lib/nativeMenu.ts` drops a menu command that a key binding ran within 500 ms, so a key never acts twice
    even if WebKit behaved differently than its source says.
  - Unit tests (`app_menu.rs`): Edit items are native; custom accelerators are allowlisted and never ⌘C/V/X/A/Z/Q/H/M/W
    or ⌃ combos; ids are unique and round-trip; every command id exists in `src/actions`. Frontend test:
    `src/lib/nativeMenu.test.ts`.
  - **UNVERIFIED** Edit › Undo (⌘Z) inside xterm's helper textarea could in theory re-insert typed text; xterm empties
    the textarea itself and ⌘Z is not an app binding. Check on a Mac: ⌘Z in a focused terminal must do nothing.

## 2. Apple Silicon and Intel: universal dmg

- **VERIFIED** `tauri build --target universal-apple-darwin` compiles `aarch64-apple-darwin` and `x86_64-apple-darwin`
  separately and merges them with `lipo`; a missing rustup target fails with "Target … is not installed"
  (https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-cli/src/interface/rust/desktop.rs). The frontend
  (`beforeBuildCommand`) runs once (`crates/tauri-cli/src/build.rs`). The dmg lands in
  `src-tauri/target/universal-apple-darwin/release/bundle/dmg/<Product>_<version>_universal.dmg` (bundler
  `dmg/mod.rs`, `Arch::Universal => "universal"`). Tauri's own pipeline docs install both targets
  (https://v2.tauri.app/distribute/pipelines/github/).
- **VERIFIED** AppVeyor's macOS images list macOS 14.2.1 Sonoma, Xcode 15.2 among others, Node 18/20/21 and Homebrew,
  but no Rust (the script installs rustup) and no CPU architecture
  (https://www.appveyor.com/docs/macos-images-software/).
- **UNVERIFIED** The `macos-sonoma` image is Intel x86_64 (a 2023 AppVeyor forum answer: arm runners "in a few
  months", no later announcement: https://help.appveyor.com/discussions/questions/62356-support-of-building-on-macos-arm-cpu).
  `appveyor.sh` now prints `uname -sm`. A per-arch build on that host would ship x86_64 only, which Apple Silicon
  users could run only through Rosetta 2.
- Cost: two release compiles (lto, codegen-units = 1) instead of one. **UNVERIFIED** estimate 20–35 min for the tag
  job on AppVeyor, inside the 60-minute limit; the branch builds (debug, one arch) are unchanged. If a tag build
  times out, the fallback is two macOS matrix jobs (`--target aarch64-apple-darwin` / `x86_64-apple-darwin`), each
  with its own 60 minutes, and two dmgs.
- The release self-test runs the slice of the host; on an Apple Silicon host with Rosetta it also runs the Intel
  slice (`arch -x86_64`, informational).

## 3. Gatekeeper for an ad-hoc signed, non-notarized app (macOS 14 / 15)

- **VERIFIED** "In macOS Sequoia, users will no longer be able to Control-click to override Gatekeeper when opening
  software that isn't signed correctly or notarized. They'll need to visit System Settings > Privacy & Security…"
  (Apple Developer News, 2024-08-06, https://developer.apple.com/news/?id=saqachfa).
- **VERIFIED** macOS 15 steps (https://support.apple.com/guide/mac-help/open-a-mac-app-from-an-unknown-developer-mh40616/15.0/mac/15.0):
  try to open the app → System Settings › Privacy & Security › Security › **Open Anyway** ("available for about an
  hour after you try to open the app") → enter the login password. macOS 14's version of the page still offers
  Control-click › Open (…/14.0/mac/14.0).
- **VERIFIED** Apple silicon requires at least an ad-hoc signature ("all code on Apple silicon must be at least ad hoc
  signed", https://developer.apple.com/forums/thread/740680); Tauri: ad-hoc signing "can avoid macOS treating Apple
  Silicon builds downloaded from GitHub releases as damaged", but "does not prevent MacOS from requiring users to
  whitelist the installation in their Privacy & Security settings" (https://v2.tauri.app/distribute/pipelines/github/,
  https://v2.tauri.app/distribute/sign/macos/).
- **VERIFIED** Removing the quarantine attribute skips the check ("The xattr command is just removing quarantine on the
  app, which prevents Gatekeeper from checking it", https://developer.apple.com/forums/thread/692774); the Sequoia
  rules apply only to quarantined apps (https://eclecticlight.co/2024/08/10/gatekeeper-and-notarization-in-sequoia/).
- **UNVERIFIED** An app copied out of a quarantined dmg inherits the quarantine flag; "is damaged and can't be opened"
  appears for a missing or broken signature (e.g. files changed after signing), not for a valid ad-hoc signature.
- Result: README now gives the macOS 15 steps, the macOS 14 shortcut and the `xattr` command.

## 4. GUI-app PATH

- **VERIFIED** VS Code resolves a GUI launch's environment by running `$SHELL -i -l -c` with a marker, a 10 s default
  timeout and `VSCODE_RESOLVING_ENVIRONMENT=1`; csh/tcsh get `-ic`, pwsh `-Login -Command`
  (https://github.com/microsoft/vscode/blob/main/src/vs/platform/shell/node/shellEnv.ts). Tauri's fix-path-env-rs
  runs `$SHELL -ilc '…env…'` with `DISABLE_AUTO_UPDATE=true` and no timeout
  (https://github.com/tauri-apps/fix-path-env-rs/blob/dev/src/lib.rs); sindresorhus/shell-env also sets
  `ZSH_TMUX_AUTOSTART=false`.
- Gridkeeper (`platform.rs`): only when `TERM` is unset (not started from a terminal), `$SHELL -i -l -c` prints PATH
  between markers; own session via `setsid` (no controlling tty, one process group to kill), stdin `/dev/null`,
  `GRIDKEEPER_RESOLVING_ENVIRONMENT=1`, `DISABLE_AUTO_UPDATE=true`, `ZSH_TMUX_AUTOSTART=false`, 5 s cap, read with
  `poll` on the main thread (`init_process_env` changes the environment and must stay single-threaded). The shell's
  entries come first, then the inherited ones, then existing tool folders. Supported: bash, zsh, sh, dash, ksh,
  fish, pwsh; others fall back to the folder list. `GRIDKEEPER_SHELL_PATH=0` off, `=1` forced. Logged at startup and
  reported by `--gk-self-test`.
- **VERIFIED** folder list sources: Claude Code native installer "manages the launcher at `~/.local/bin/claude`"
  (https://code.claude.com/docs/en/setup); nvm `~/.nvm/versions/node/vX/bin` (https://github.com/nvm-sh/nvm); fnm
  base `~/.local/share/fnm`, `~/.fnm` or `~/Library/Application Support/fnm` (fnm `src/directories.rs`); asdf
  `~/.asdf/shims` (https://asdf-vm.com/guide/getting-started.html); mise `~/.local/share/mise/shims`
  (https://mise.jdx.dev/dev-tools/shims.html); volta `~/.volta/bin` (https://docs.volta.sh/advanced/installers); pnpm
  `~/Library/pnpm/bin` on macOS (https://pnpm.io/settings/other); bun `~/.bun/bin` (https://bun.sh/docs/installation).
  nvm's default alias is resolved to an installed version (`pick_nvm_version`, unit-tested).
- **UNVERIFIED** Typical lookup time with oh-my-zsh + nvm is well under the 5 s cap; a slower shell falls back to
  the folder list and logs a warning.

## 5. Notifications, Dock badge, rendering

- **VERIFIED** tauri-plugin-notification on desktop uses notify-rust → mac-notification-sys → `NSUserNotificationCenter`
  (deprecated since macOS 11). `request_permission` always resolves "granted" on desktop without prompting; dev builds
  post as `com.apple.Terminal`; the bundle id is used only if LaunchServices knows it
  (https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/notification/src/desktop.rs). Open report of
  notifications silently not shown: https://github.com/tauri-apps/plugins-workspace/issues/2143 (maintainer: macOS
  notifications are "generally quite wonky (in a tauri context)").
- **UNVERIFIED** Whether notifications appear for the ad-hoc signed release on macOS 14 / 15 (community reports say
  NSUserNotificationCenter can be inert on recent releases). In-app toasts, the title count and the new Dock badge do
  not depend on it. Needs a Mac.
- **VERIFIED** `set_badge_count` exists since Tauri 2.2.0 (Linux, macOS, iOS; Windows unsupported); tao sets
  `NSApp.dockTile().setBadgeLabel(...)`, with no notification-permission check. Gridkeeper calls it on macOS only
  (`attentionNotify.ts`, permission `core:window:allow-set-badge-count` in `capabilities/macos.json` with
  `"platforms": ["macOS"]`).
- **VERIFIED** WebKit allows 16 active WebGL contexts per web process thread and force-loses the oldest
  (`static constexpr size_t maxActiveContexts = 16;`, "There are too many active WebGL contexts on this page, the
  oldest context will be lost",
  https://github.com/WebKit/WebKit/blob/main/Source/WebCore/html/canvas/WebGLRenderingContextBase.cpp). The lost
  context is synthetic and cannot be restored by `preventDefault()`. `maxWebglFor` keeps 12 on macOS (4 spare, like
  Chromium's 16) and 8 on Linux; the registry already falls back to DOM on context loss.
- **VERIFIED** addon-webgl refuses Safari < 16 only when the user agent contains "Safari"; WKWebView's default UA does
  not. **UNVERIFIED** retina sharpness: a Wails report says WKWebView returned `devicePixelRatio = 1` for content on a
  custom URL scheme (wails#5111); not confirmed for Tauri. On a Retina Mac check `window.devicePixelRatio` (expect 2)
  and that terminal text is crisp at 100 % and after zooming (xterm#2662: blur after zoom changes).
- **VERIFIED** open xterm WebGL issues on WKWebView: row ghosting with transparent backgrounds (xterm#5847), atlas
  corruption fixed for 7.0 (PR #5883), broken rendering on a macOS 26.5 beta (xterm#5816). Gridkeeper themes use
  opaque terminal backgrounds; watch these when upgrading xterm.

## 6. Linux

**WebKitGTK DMA-BUF renderer (blank / white window).**
- **VERIFIED** Tauri's "Linux Graphics Issues" page lists blank or white windows, flicker or crashes on resize,
  `AcceleratedSurfaceDMABuf` framebuffer errors and `Error 71 (Protocol error)`, and gives, in order: kernel mode
  setting (`nvidia_drm.modeset=1`), `__NV_DISABLE_EXPLICIT_SYNC=1` (Error 71 on NVIDIA + Wayland, no performance
  cost), `WEBKIT_DISABLE_DMABUF_RENDERER=1` ("at the cost of the faster rendering path"),
  `WEBKIT_DISABLE_COMPOSITING_MODE=1` as a last resort. It shows setting the variable in `main()` before the builder
  and warns "Only ship an unconditional override like this if you have verified your app is affected"
  (https://v2.tauri.app/develop/debug/linux-graphics/).
- **VERIFIED** Affected: mostly the NVIDIA proprietary driver (https://github.com/tauri-apps/tauri/issues/9394, where
  an AppImage built on Ubuntu 22.04 was blank on EndeavourOS GNOME Wayland while a native build worked), also VMs
  (VirtualBox VMSVGA, https://bugs.webkit.org/show_bug.cgi?id=261874) and Mesa / GBM mismatches
  (https://github.com/tauri-apps/tauri/issues/8254, https://github.com/tauri-apps/tauri/issues/13493).
- **VERIFIED** Upstream WebKit declined to auto-disable on NVIDIA (https://bugs.webkit.org/show_bug.cgi?id=262607,
  WONTFIX), but Debian / Ubuntu carry `disable-nvidia-dmabuf.patch` (checks `GL_VENDOR`; Ubuntu 22.04's webkit2gtk
  has it, https://changelogs.ubuntu.com/changelogs/pool/main/w/webkit2gtk/webkit2gtk_2.50.4-0ubuntu0.22.04.1/changelog);
  it has regressed once (https://bugs.webkit.org/show_bug.cgi?id=294967).
- **VERIFIED** What other Tauri apps ship: block/buzz sets the variable when an NVIDIA GPU is found or `APPIMAGE` is
  set, and leaves it alone when the user set any rendering variable (https://github.com/block/buzz/pull/3271); others
  set it unconditionally on Linux (commits listed on tauri#9394).
- Gridkeeper (`platform.rs`): sets `WEBKIT_DISABLE_DMABUF_RENDERER=1` when `/proc/driver/nvidia/version` exists
  (proprietary driver only) or the process is an AppImage (`APPIMAGE`), unless the variable is already set. Logged at
  startup and shown by `--gk-self-test`. **UNVERIFIED** on a real NVIDIA desktop; the cost is shared-memory
  compositing (more CPU with many WebGL terminals). Users can still set the variable themselves, switch the terminal
  renderer to DOM in Settings, or try `__NV_DISABLE_EXPLICIT_SYNC=1` / `WEBKIT_DISABLE_COMPOSITING_MODE=1`. Child
  shells inherit the variable (harmless on the same machine).

**Wayland vs X11.**
- **VERIFIED** Older Tauri AppImages forced X11 (`export GDK_BACKEND=x11` in the linuxdeploy GTK hook, tauri#8541);
  tauri-bundler 2.10.0 (shipped with tauri-cli 2.12.0) stopped that: "AppImages no longer force `GDK_BACKEND=x11` and
  now use the native Wayland backend on Wayland sessions", and an explicit `GDK_BACKEND` is respected
  (https://v2.tauri.app/release/tauri-bundler/v2.10.0/, https://github.com/tauri-apps/tauri/pull/16062). Gridkeeper
  uses CLI ^2.12.3, so its AppImage runs native Wayland, and is exposed to the NVIDIA + Wayland issues the forced X11
  used to hide (the DMA-BUF workaround above covers the AppImage case). `GDK_BACKEND=x11` remains a user-side
  workaround. **Needs hardware.**
- **VERIFIED** tao 0.30.3 fixed Error 71 on maximize and header-bar drag / resize on Wayland
  (https://v2.tauri.app/release/tao/v0.30.3/); Gridkeeper uses tao 0.37.

**AppImage on Ubuntu 24.04.**
- **VERIFIED** "In Ubuntu 24.04, the libfuse2 package was renamed to libfuse2t64"; without it the AppImage prints
  "AppImages require FUSE to run…"; `--appimage-extract-and-run` / `APPIMAGE_EXTRACT_AND_RUN=1` work without FUSE
  (https://docs.appimage.org/user-guide/troubleshooting/fuse.html); install with `sudo apt install libfuse2t64`, and
  never the `fuse` package (https://github.com/AppImage/AppImageKit/wiki/FUSE). Open Tauri issue:
  https://github.com/tauri-apps/tauri/issues/7155. **UNVERIFIED** whether bundler 2.10's AppImage already uses the
  static type2 runtime (which removes the libfuse2 requirement). README tells users; the `.deb` avoids FUSE.
- **VERIFIED** Ubuntu 24.04's restriction of unprivileged user namespaces breaks bubblewrap sandboxes
  (https://bugs.launchpad.net/ubuntu/+source/apparmor/+bug/2046844), but the WebKitGTK 4.1 web-process sandbox is
  opt-in and wry 0.57 never enables it
  (https://webkitgtk.org/reference/webkitgtk/stable/migrating-to-webkitgtk-6.0.html,
  https://raw.githubusercontent.com/tauri-apps/wry/wry-v0.57.0/src/webkitgtk/mod.rs), so Gridkeeper is not affected.
- **UNVERIFIED** The AppImage's GTK hook exports variables such as `GTK_PATH`, `GIO_MODULE_DIR`,
  `GDK_PIXBUF_MODULE_FILE` and a prefixed `XDG_DATA_DIRS` pointing into the mounted image
  (https://raw.githubusercontent.com/tauri-apps/linuxdeploy-plugin-gtk/master/linuxdeploy-plugin-gtk.sh). Shells
  in Gridkeeper panes inherit them, so GTK programs started from an AppImage Gridkeeper's terminal might load the
  bundled modules. **Deferred**: strip `$APPDIR` entries from the session environment; until then the `.deb` is the
  recommended Linux package for daily use.

**Packages, desktop entry, dock icon.**
- **VERIFIED** The `.deb` depends on `libwebkit2gtk-4.1-0` and `libgtk-3-0`; "Ubuntu 22.04 and Debian 12 are suitable
  baseline examples" (https://v2.tauri.app/distribute/debian/). On 24.04, `libgtk-3-0t64` provides `libgtk-3-0`
  (https://launchpad.net/ubuntu/noble/amd64/libgtk-3-0t64/3.24.41-4ubuntu1.3) and `libwebkit2gtk-4.1-0` exists
  (https://packages.ubuntu.com/noble/libwebkit2gtk-4.1-0).
- **VERIFIED** The generated desktop entry has `Exec`, `Icon` and `StartupWMClass` set to the binary name
  (`gridkeeper`), added by https://github.com/tauri-apps/tauri/pull/13581 ("Fix app icon not showing on
  Gnome+Wayland"); icons go to `hicolor/<size>/apps/gridkeeper.png`
  (https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-bundler/src/bundle/linux/freedesktop/mod.rs). Keep
  `app.enableGTKAppId` off (it is): turning it on changes the Wayland app_id to the identifier, which then no longer
  matches `StartupWMClass` (https://github.com/esoltys/luminous/issues/1037). **Needs hardware** for the GNOME / KDE
  dock icon.

**Notifications.**
- **VERIFIED** The plugin uses notify-rust over zbus (pure Rust D-Bus, fine inside an AppImage); permission is always
  granted on Linux. GNOME 46+ (Ubuntu 24.04, Fedora 41) closed notifications at once because the plugin dropped the
  handle (https://github.com/tauri-apps/plugins-workspace/issues/2566); fixed in plugin 2.7.0
  (https://github.com/tauri-apps/plugins-workspace/pull/3588), which is what `Cargo.lock` has. Still open: Cinnamon
  (plugins-workspace#1089). **UNVERIFIED** the notification icon inside a non-integrated AppImage (the icon name is
  the binary name, not in the host theme).

**WebGL on WebKitGTK.**
- **VERIFIED** wry 0.57 calls `set_enable_webgl(true)`; WebKitGTK's default hardware acceleration policy is ALWAYS
  (https://webkitgtk.org/reference/webkit2gtk/stable/property.Settings.hardware-acceleration-policy.html). The 16
  active-context cap is the same WebCore code as on macOS; Gridkeeper's Linux budget is 8. Tauri's docs warn WebGL2
  can silently run on a slow path and suggest a non-WebGL fallback plus a user setting: Gridkeeper already has
  Settings › terminal renderer (auto / WebGL / DOM) and falls back to DOM on context loss. Open WebKit bug on green
  artifacts with transparent xterm canvases: https://bugs.webkit.org/show_bug.cgi?id=264268. **Needs hardware** to
  measure (and maybe raise) the Linux budget.

## 7. What CI proves now, and what still needs a person

`--gk-self-test` (all OSes, branch and tag builds): the binary loads (on Linux this means libwebkit2gtk / GTK
resolved by the dynamic loader), the environment fix-up runs, the login shell answers the PATH lookup within 15 s,
the data folder is writable, the default terminal starts through the real launch planner in a real PTY and runs a
typed command, and a forced stop leaves no process of a tree that includes an orphaned grandchild.

`--gk-self-test-gui` (Linux under Xvfb, required; macOS informational): GTK / AppKit start, the main window and its
webview are created (on macOS also the native menu), the frontend bundle loads and runs, `app_info` returns to JS
and `state_load` reaches Rust. Branch builds load the bundle from `vite preview` (debug builds use the dev URL); tag
builds use the embedded assets of the release binary.

Not proven by CI, needs a person on real hardware: keyboard and IME behaviour (⌘ / ⌃ / ⌥ keys, the menu vs terminal
copy / paste, ⌘Z in a terminal), Gatekeeper and first launch of the downloaded dmg, notifications, the Dock badge,
⌘W → hide → Dock click, full-screen behaviour, retina sharpness and WebGL performance with many terminals, the
login-shell PATH with a real user's dotfiles, Wayland sessions and NVIDIA drivers, AppImage on 24.04, the
desktop entry and dock icon on GNOME / KDE.
