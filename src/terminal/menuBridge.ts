// Terminal right-click -> app context menu, without importing React into the terminal registry.
// registry.ts decides what a right-click means (`rightClickDecision`) and, for "menu", emits a DOM
// CustomEvent; the React ContextMenuHost listens and renders the menu (buildSessionMenu).

import type { RightClickAction, SessionId } from "../lib/types";

export type { RightClickAction };

export const TERMINAL_MENU_EVENT = "gridkeeper:terminal-menu";

export interface TerminalMenuRequest {
  sessionId: SessionId;
  x: number;
  y: number;
  hasSelection: boolean;
}

export type RightClickDecision = "program" | "menu" | "copy" | "paste";

/**
 * What a right-click in a terminal does.
 *  - The program enabled mouse tracking (vim, htop, TUIs): a plain right-click belongs to the program;
 *    Shift+right-click is ours.
 *  - "menu" (default): open the context menu.
 *  - "paste" (Windows Terminal style): copy the selection, else paste. Shift+right-click still opens the
 *    menu when the program does not track the mouse, so the menu stays reachable.
 */
export function rightClickDecision(o: { mode: RightClickAction | string | undefined; mouseTracking: boolean; shift: boolean; hasSelection: boolean }): RightClickDecision {
  if (o.mouseTracking && !o.shift) return "program";
  if (o.mode === "paste") {
    if (o.shift && !o.mouseTracking) return "menu";
    return o.hasSelection ? "copy" : "paste";
  }
  return "menu";
}

export function emitTerminalMenu(req: TerminalMenuRequest): void {
  window.dispatchEvent(new CustomEvent<TerminalMenuRequest>(TERMINAL_MENU_EVENT, { detail: req }));
}

export function onTerminalMenu(cb: (req: TerminalMenuRequest) => void): () => void {
  const h = (e: Event) => {
    const d = (e as CustomEvent<TerminalMenuRequest>).detail;
    if (d?.sessionId) cb(d);
  };
  window.addEventListener(TERMINAL_MENU_EVENT, h);
  return () => window.removeEventListener(TERMINAL_MENU_EVENT, h);
}
