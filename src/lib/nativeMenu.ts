// macOS app menu bridge: custom items of the native menu (src-tauri/src/app_menu.rs) arrive as
// EVT_NATIVE_MENU events and run commands from the same registry as the palette and key bindings.
// Installed on macOS only (Shell.tsx); Windows and Linux have no native menu.
//
// Clipboard and undo items are native (AppKit → WebKit → DOM copy / paste events) and never come
// through here. A custom item's accelerator (only Settings… ⌘, has one) can see the same key as the
// page's key binding when the page lets it through, so a menu command that a key binding ran within
// MENU_KEY_DEDUPE_MS is dropped: one key press, one action.

import { listen } from "@tauri-apps/api/event";
import { getCommand, runCommand } from "../actions/commands";
import { lastKeyCommand } from "../keybindings";
import { isKeyCaptureSuspended } from "../store/uiStore";
import { EVT_NATIVE_MENU, type NativeMenuCommand } from "./types";

export const MENU_KEY_DEDUPE_MS = 500;

export interface MenuRunContext {
  /** The id is a registered command. */
  known: boolean;
  /** A modal is open or the shortcut recorder listens (key bindings are paused too). */
  suspended: boolean;
  /** The command a key binding ran last, and when. */
  lastKey: { id: string; at: number } | null;
  now: number;
}

/** Whether a native menu command should run (pure). */
export function shouldRunMenuCommand(id: string, ctx: MenuRunContext): boolean {
  if (!ctx.known || ctx.suspended) return false;
  if (ctx.lastKey && ctx.lastKey.id === id && ctx.now - ctx.lastKey.at >= 0 && ctx.now - ctx.lastKey.at < MENU_KEY_DEDUPE_MS) return false;
  return true;
}

export function handleMenuCommand(id: string, now = Date.now()): boolean {
  const run = shouldRunMenuCommand(id, {
    known: getCommand(id) !== undefined,
    suspended: isKeyCaptureSuspended(),
    lastKey: lastKeyCommand(),
    now,
  });
  if (run) runCommand(id);
  return run;
}

/** Listen for native menu commands. Returns an uninstall function. */
export function installNativeMenu(): () => void {
  let disposed = false;
  let unlisten: (() => void) | null = null;
  listen<NativeMenuCommand>(EVT_NATIVE_MENU, (e) => void handleMenuCommand(e.payload.command))
    .then((un) => (disposed ? un() : (unlisten = un)))
    .catch(() => {});
  return () => {
    disposed = true;
    unlisten?.();
  };
}
