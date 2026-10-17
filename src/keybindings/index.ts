// Keybinding registry. STUB — implemented by the shell-UI owner.
// The terminal calls `isAppShortcut(e)` from xterm's custom key handler: when true, xterm ignores the key
// and the app's capture-phase listener runs the command. Terminal-critical keys must never be app shortcuts.

export function isAppShortcut(_e: KeyboardEvent): boolean {
  return false;
}
