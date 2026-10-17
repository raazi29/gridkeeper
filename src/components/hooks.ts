// Shared UI hooks.

import { useEffect, useMemo, useState } from "react";
import { useApp } from "../store/appStore";
import { acquireDiagnostics } from "../store/uiStore";
import { getRendererStatus, onRendererStatus, type RendererStatus } from "../terminal/registry";
import { bindingsByCommand, displayCombo } from "../keybindings/combo";

export function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(() => typeof document === "undefined" || document.visibilityState === "visible");
  useEffect(() => {
    const on = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  return visible;
}

/** Hold the shared 2 s diagnostics poll while `want` is true and the window is visible. */
export function useDiagnosticsPoll(want: boolean) {
  const visible = useDocumentVisible();
  const active = want && visible;
  useEffect(() => {
    if (!active) return;
    return acquireDiagnostics();
  }, [active]);
}

/** Renderer status from the terminal registry (event-driven, no polling). */
export function useRendererStatus(): RendererStatus {
  // Not useSyncExternalStore: getRendererStatus may return a fresh object per call.
  const [status, setStatus] = useState<RendererStatus>(() => getRendererStatus());
  useEffect(() => {
    setStatus(getRendererStatus());
    return onRendererStatus((s) => setStatus({ ...s }));
  }, []);
  return status;
}

/** Display string for a command's effective shortcut ("" when unbound). */
export function useShortcut(commandId: string): string {
  const overrides = useApp((s) => s.persisted.settings.keybindings);
  return useMemo(() => {
    const combo = bindingsByCommand(overrides)[commandId];
    return combo ? displayCombo(combo) : "";
  }, [overrides, commandId]);
}

export function useShortcutMap(): Record<string, string> {
  const overrides = useApp((s) => s.persisted.settings.keybindings);
  return useMemo(() => bindingsByCommand(overrides), [overrides]);
}

/** Tooltip text with an optional shortcut suffix. */
export function withShortcut(label: string, shortcut: string): string {
  return shortcut ? `${label} (${shortcut})` : label;
}
