// Which engine browser panes use: "native" (one WebView2 child webview per pane, laid over the pane;
// src/browser/nativeViews.ts + src-tauri/src/browser_view.rs) or "frame" (sandboxed iframe in the
// persistent layer, BrowserLayer). Native is the default where it exists (Windows); the iframe engine
// is used everywhere else, when the user picks it, and for the rest of the run after a native view
// could not be created.

import { create } from "zustand";
import { notify } from "../actions/notify";
import { t } from "../i18n";
import { OS, type Os } from "../lib/platform";
import type { BrowserEngineSetting } from "../lib/types";
import { useApp } from "../store/appStore";

export type BrowserEngine = "native" | "frame";

/** Native browser panes exist on Windows only (Linux cannot position child webviews; macOS unverified). */
export function nativeSupported(os: Os = OS, tauri = hasTauri()): boolean {
  return os === "windows" && tauri;
}

function hasTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function resolveEngine(setting: BrowserEngineSetting | string | undefined, supported: boolean, failed: boolean): BrowserEngine {
  return setting !== "frame" && supported && !failed ? "native" : "frame";
}

interface EngineState {
  /** Why native views failed this run (then every pane uses iframes until restart). */
  failed: string | null;
}

export const useEngineState = create<EngineState>()(() => ({ failed: null }));

/** The engine in use now (non-React callers). */
export function currentEngine(): BrowserEngine {
  return resolveEngine(useApp.getState().persisted.settings.browserEngine, nativeSupported(), !!useEngineState.getState().failed);
}

/** The engine in use now (React). */
export function useBrowserEngine(): BrowserEngine {
  const setting = useApp((s) => s.persisted.settings.browserEngine);
  const failed = useEngineState((s) => !!s.failed);
  return resolveEngine(setting, nativeSupported(), failed);
}

/** A native view could not be created: fall back to iframes for the rest of the run. */
export function markNativeFailed(reason: string) {
  if (useEngineState.getState().failed) return;
  useEngineState.setState({ failed: reason });
  notify("error", t("browser.engine.nativeFailed", { reason }));
}
