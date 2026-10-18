// Which OS the app runs on, for platform-specific keys, labels and limits.
//
// Detected synchronously from `navigator` so static maps (labels, defaults) can use it at module load.
// `app_info().os` from the Rust host reports the same thing (useful in logs and diagnostics).
// Pure helpers take an explicit `os` (defaulting to the detected one) so tests can pin a platform:
// vitest runs in Node, whose global `navigator.platform` reflects the HOST OS of the CI runner.

export type Os = "windows" | "macos" | "linux";

/** Classify a `navigator.platform` / `userAgentData.platform` / `userAgent` string. Default: windows. */
export function detectOs(platform?: string | null, userAgent?: string | null): Os {
  const probe = (s: string): Os | null => {
    if (/mac|iphone|ipad|ipod|darwin/i.test(s)) return "macos";
    if (/win/i.test(s)) return "windows";
    if (/linux|x11|cros|freebsd|openbsd/i.test(s)) return "linux";
    return null;
  };
  return (platform ? probe(platform) : null) ?? (userAgent ? probe(userAgent) : null) ?? "windows";
}

interface NavigatorLike {
  platform?: string;
  userAgent?: string;
  userAgentData?: { platform?: string };
}

function fromNavigator(): Os {
  if (typeof navigator === "undefined") return "windows";
  const n = navigator as unknown as NavigatorLike;
  return detectOs(n.userAgentData?.platform || n.platform, n.userAgent);
}

/** The OS this frontend runs on (detected once at load). */
export const OS: Os = fromNavigator();
export const isMac = OS === "macos";
export const isLinux = OS === "linux";
export const isWindows = OS === "windows";

/** Label of the `powershell` agent kind: the platform's default terminal. */
export function shellLabel(os: Os = OS): string {
  return os === "windows" ? "PowerShell" : "Shell";
}

/** Name of the web engine the UI runs in (diagnostics' "webview" bucket). */
export function webviewLabel(os: Os = OS): string {
  return os === "windows" ? "WebView2" : "WebKit";
}

/** Tooltip for the webview bucket: on Unix the attribution is best effort. */
export function webviewHint(os: Os = OS): string {
  if (os === "windows") return "msedgewebview2.exe processes started by this app";
  if (os === "macos") return "WebKit web content processes (com.apple.WebKit.*), attributed best effort";
  return "WebKitGTK web processes (WebKitWebProcess, WebKitNetworkProcess), attributed best effort";
}

/** How CPU figures are explained (the app reports a share of all logical cores everywhere). */
export function cpuShareLabel(os: Os = OS): string {
  return os === "windows" ? "CPU as in Task Manager" : "CPU";
}

/** Example project folder for path inputs (absolute: `~` is not expanded). */
export function folderPlaceholder(os: Os = OS): string {
  if (os === "macos") return "/Users/you/code/project";
  if (os === "linux") return "/home/you/code/project";
  return "D:\\code\\project";
}

/** Example executable for a custom command. */
export function executablePlaceholder(os: Os = OS): string {
  return os === "windows" ? "C:\\tools\\bin\\tool.exe" : "/usr/local/bin/tool";
}

/** "Click to reveal in …" target: the system file manager. */
export function fileManagerName(os: Os = OS): string {
  if (os === "macos") return "Finder";
  if (os === "linux") return "the file manager";
  return "Explorer";
}

/** Name of the OS notification system in settings copy. */
export function osNotificationName(os: Os = OS): string {
  if (os === "macos") return "macOS";
  if (os === "linux") return "Desktop";
  return "Windows";
}
