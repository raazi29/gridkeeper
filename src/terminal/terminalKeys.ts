// Terminal clipboard keys and link modifiers per platform (pure, unit-tested).
//
// Windows / Linux (unchanged Windows Terminal behaviour): Ctrl+Shift+C copies, Ctrl+C copies and clears
// a selection (otherwise ^C goes to the program), Ctrl+V / Ctrl+Shift+V paste. Ctrl+click opens links.
// macOS: ⌘C copies a selection (keeping it, like Terminal.app), ⌘V / ⇧⌘V paste, and ⌃C ALWAYS reaches
// the program as ^C (⌃V likewise stays a terminal key). ⌘-click opens links.

import { OS, type Os } from "../lib/platform";

export interface TermKeyLike {
  key: string;
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

/** What the custom key handler does with a key event. "pass" = xterm handles it as usual. */
export type ClipboardKeyAction = "copy" | "copy-clear" | "paste" | "pass";

/** Letter of the key, falling back to the physical key on non-Latin layouts. */
export function keyLetter(ev: Pick<TermKeyLike, "key" | "code">): string {
  const k = ev.key.length === 1 ? ev.key.toLowerCase() : "";
  if (k >= "a" && k <= "z") return k;
  // Non-Latin layouts: fall back to the physical key.
  if (ev.code.startsWith("Key") && ev.code.length === 4) return ev.code.slice(3).toLowerCase();
  return k;
}

export function clipboardKeyAction(ev: TermKeyLike, hasSelection: boolean, os: Os = OS): ClipboardKeyAction {
  if (os === "macos") {
    // Only plain ⌘(+⇧) combos are ours; ⌃ and ⌥ combos go to xterm.
    if (!ev.metaKey || ev.ctrlKey || ev.altKey) return "pass";
    const k = keyLetter(ev);
    if (k === "c") return ev.shiftKey || hasSelection ? "copy" : "pass";
    if (k === "v") return "paste";
    return "pass";
  }
  // Only plain Ctrl(+Shift) combos are ours; AltGr (Ctrl+Alt) and everything else go to xterm.
  if (!ev.ctrlKey || ev.altKey || ev.metaKey) return "pass";
  const k = keyLetter(ev);
  if (k === "c") {
    if (ev.shiftKey) return "copy";
    return hasSelection ? "copy-clear" : "pass"; // no selection: xterm sends ^C
  }
  if (k === "v") return "paste";
  return "pass";
}

/** Whether a click on a terminal link should open it (Ctrl+click; ⌘-click on macOS). */
export function linkModifierHeld(ev: { ctrlKey: boolean; metaKey: boolean }, os: Os = OS): boolean {
  return os === "macos" ? ev.metaKey : ev.ctrlKey;
}

/** Menu hints for the terminal's Copy / Paste items. */
export function copyHint(os: Os = OS): string {
  return os === "macos" ? "⌘C" : "Ctrl+Shift+C";
}
export function pasteHint(os: Os = OS): string {
  return os === "macos" ? "⌘V" : "Ctrl+V";
}

/** Hover hint on terminal links. */
export function linkHint(os: Os = OS): string {
  return os === "macos"
    ? "⌘-click: open in browser · ⇧⌘-click: open in a Gridkeeper browser pane"
    : "Ctrl+click: open in browser · Ctrl+Shift+click: open in a Gridkeeper browser pane";
}
