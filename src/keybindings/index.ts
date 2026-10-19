// Keybinding registry.
// The terminal calls `isAppShortcut(e)` from xterm's custom key handler: when true, xterm ignores the key
// and the app's capture-phase listener runs the command. Terminal-critical keys must never be app shortcuts
// (see `forbiddenReason` in ./combo). On macOS the stored "ctrl" token matches ⌘ Command (see combo.ts),
// so the same bindings work there with the platform's primary modifier.

import { runCommand } from "../actions/commands";
import { useApp } from "../store/appStore";
import { isKeyCaptureSuspended } from "../store/uiStore";
import { eventToCombo, resolveBindings } from "./combo";

export {
  DEFAULT_BINDINGS,
  defaultBindings,
  bindingsByCommand,
  displayCombo,
  eventToCombo,
  forbiddenReason,
  isForbiddenCombo,
  normalizeCombo,
  parseCombo,
} from "./combo";

// Cache the resolved map; rebuilt only when the settings.keybindings object identity changes.
let cachedFor: Record<string, string> | undefined | null = null;
let cached = new Map<string, string>();

function bindings(): Map<string, string> {
  const overrides = useApp.getState().persisted.settings.keybindings;
  if (overrides !== cachedFor) {
    cached = resolveBindings(overrides);
    cachedFor = overrides;
  }
  return cached;
}

/** Command id bound to this event, if any. */
export function commandForEvent(e: KeyboardEvent): string | undefined {
  const combo = eventToCombo(e);
  return combo ? bindings().get(combo) : undefined;
}

/** True only for key events that match a bound app command. */
export function isAppShortcut(e: KeyboardEvent): boolean {
  if (isKeyCaptureSuspended()) return false;
  return commandForEvent(e) !== undefined;
}

let lastKeyRun: { id: string; at: number } | null = null;

/** The command a key binding ran last, and when (macOS menu de-duplication, see lib/nativeMenu.ts). */
export function lastKeyCommand(): { id: string; at: number } | null {
  return lastKeyRun;
}

/** Install the single capture-phase keydown listener. Returns an uninstall function. */
export function installKeybindings(): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    if (isKeyCaptureSuspended()) return; // modal open or the Settings recorder is listening
    const id = commandForEvent(e);
    if (!id) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat && !id.startsWith("session.next") && !id.startsWith("session.prev") && id !== "terminal.zoomIn" && id !== "terminal.zoomOut") return;
    lastKeyRun = { id, at: Date.now() };
    runCommand(id);
  };
  window.addEventListener("keydown", onKeyDown, true);
  return () => window.removeEventListener("keydown", onKeyDown, true);
}
