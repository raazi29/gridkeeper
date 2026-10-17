// Ephemeral UI state (not persisted to workspaces.json): dialogs, palette, confirm prompts,
// visited workspaces, the shared diagnostics poller and a few localStorage conveniences.

import { create } from "zustand";
import { errorMessage, ipc } from "../lib/ipc";
import type { AgentKind, Diagnostics, LayoutPreset } from "../lib/types";

// ---- dialogs -----------------------------------------------------------------

export type DialogState =
  | { kind: "newSession"; groupId?: string; preset?: LayoutPreset }
  | { kind: "newWorkspace" }
  | { kind: "settings"; section?: string }
  | { kind: "profiles" }
  | { kind: "diagnostics" }
  | { kind: "welcome" };

export type PaletteMode = "all" | "workspaces" | "sessions";

export interface ConfirmOptions {
  title: string;
  message?: string;
  /** Extra detail rendered in a monospace block (e.g. a command line). */
  detail?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

interface ConfirmRequest extends ConfirmOptions {
  id: number;
  resolve: (ok: boolean) => void;
}

export interface ActionToast {
  id: number;
  kind: "info" | "warn" | "error";
  message: string;
  detail?: string;
  action?: { label: string; run: () => void };
}

interface LastSessionPrefs {
  agent: AgentKind;
  profileId: string | null;
}

export interface UiStore {
  dialog: DialogState | null;
  palette: { open: boolean; mode: PaletteMode };
  confirms: ConfirmRequest[];
  /** Workspaces opened at least once this run: their groups' grids stay mounted. */
  visited: Record<string, true>;
  /** Last focused session per group, so switching back restores focus. */
  lastFocusByGroup: Record<string, string>;
  diag: Diagnostics | null;
  diagError: string | null;
  actionToasts: ActionToast[];
  lastSession: LastSessionPrefs;
  /** Focus mode: sidebar, tabs and status bar hidden to maximise terminal area (this run only). */
  focusMode: boolean;
  /** Presentation mode: larger terminal font and UI scale (this run only). */
  presentation: boolean;
  /** CRT scanline overlay for themes that offer it (per-machine preference). */
  scanlines: boolean;

  openDialog: (d: DialogState) => void;
  closeDialog: () => void;
  openPalette: (mode?: PaletteMode) => void;
  closePalette: () => void;
  markVisited: (workspaceId: string) => void;
  rememberFocus: (groupId: string, sessionId: string) => void;
  setLastSession: (p: LastSessionPrefs) => void;
  dismissActionToast: (id: number) => void;
  setFocusMode: (on: boolean) => void;
  setPresentation: (on: boolean) => void;
  setScanlines: (on: boolean) => void;
}

const LS_LAST = "gridkeeper.ui.lastSession";
const LS_SCANLINES = "gridkeeper.ui.scanlines";

function readScanlines(): boolean {
  try {
    return globalThis.localStorage?.getItem(LS_SCANLINES) !== "0";
  } catch {
    return true;
  }
}

function readLast(): LastSessionPrefs {
  try {
    const raw = globalThis.localStorage?.getItem(LS_LAST);
    if (raw) {
      const v = JSON.parse(raw) as Partial<LastSessionPrefs>;
      const agents: AgentKind[] = ["powershell", "claude", "codex", "generic"];
      return {
        agent: agents.includes(v.agent as AgentKind) ? (v.agent as AgentKind) : "powershell",
        profileId: typeof v.profileId === "string" ? v.profileId : null,
      };
    }
  } catch {
    /* storage unavailable */
  }
  return { agent: "powershell", profileId: null };
}

export const useUi = create<UiStore>()((set) => ({
  dialog: null,
  palette: { open: false, mode: "all" },
  confirms: [],
  visited: {},
  lastFocusByGroup: {},
  diag: null,
  diagError: null,
  actionToasts: [],
  lastSession: readLast(),
  focusMode: false,
  presentation: false,
  scanlines: readScanlines(),

  openDialog: (dialog) => set({ dialog, palette: { open: false, mode: "all" } }),
  closeDialog: () => set({ dialog: null }),
  openPalette: (mode = "all") => set({ palette: { open: true, mode } }),
  closePalette: () => set({ palette: { open: false, mode: "all" } }),
  markVisited: (id) => set((s) => (s.visited[id] ? s : { visited: { ...s.visited, [id]: true } })),
  rememberFocus: (groupId, sessionId) =>
    set((s) => (s.lastFocusByGroup[groupId] === sessionId ? s : { lastFocusByGroup: { ...s.lastFocusByGroup, [groupId]: sessionId } })),
  setLastSession: (p) => {
    try {
      globalThis.localStorage?.setItem(LS_LAST, JSON.stringify(p));
    } catch {
      /* ignore */
    }
    set({ lastSession: p });
  },
  dismissActionToast: (id) => set((s) => ({ actionToasts: s.actionToasts.filter((t) => t.id !== id) })),
  setFocusMode: (focusMode) => set({ focusMode }),
  setPresentation: (presentation) => set({ presentation }),
  setScanlines: (scanlines) => {
    try {
      globalThis.localStorage?.setItem(LS_SCANLINES, scanlines ? "1" : "0");
    } catch {
      /* ignore */
    }
    set({ scanlines });
  },
}));

// ---- confirm() ---------------------------------------------------------------

let confirmSeq = 1;

/** In-app replacement for window.confirm. Resolves true on confirm, false on cancel / Esc. */
export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const id = confirmSeq++;
    useUi.setState((s) => ({ confirms: [...s.confirms, { ...opts, id, resolve }] }));
  });
}
export { confirmDialog as confirm };

export function resolveConfirm(id: number, ok: boolean) {
  const req = useUi.getState().confirms.find((c) => c.id === id);
  useUi.setState((s) => ({ confirms: s.confirms.filter((c) => c.id !== id) }));
  req?.resolve(ok);
}

// ---- toasts with an action button (notify() has no action slot) --------------

let toastSeq = 1;
export function actionToast(t: Omit<ActionToast, "id">, ttlMs = 10000) {
  const id = toastSeq++;
  useUi.setState((s) => ({ actionToasts: [...s.actionToasts.slice(-3), { ...t, id }] }));
  window.setTimeout(() => useUi.getState().dismissActionToast(id), ttlMs);
}

// ---- modal stack / key-capture suspension -------------------------------------
// Non-reactive: read synchronously by the keybinding listener.

const modalStack: number[] = [];
let recording = 0;
let modalSeq = 1;

export function pushModal(): number {
  const id = modalSeq++;
  modalStack.push(id);
  return id;
}
export function popModal(id: number) {
  const i = modalStack.indexOf(id);
  if (i >= 0) modalStack.splice(i, 1);
}
export function isTopModal(id: number): boolean {
  return modalStack[modalStack.length - 1] === id;
}
/** Settings' shortcut recorder suspends global shortcuts while listening. */
export function setKeyRecording(on: boolean) {
  recording = Math.max(0, recording + (on ? 1 : -1));
}
export function isKeyCaptureSuspended(): boolean {
  return modalStack.length > 0 || recording > 0;
}

// ---- shared diagnostics poller (the only timer in the UI) ----------------------
// Consumers acquire/release; one 2 s interval runs while at least one consumer holds it.

let holders = 0;
let timer: number | undefined;
let inflight = false;

async function pollOnce() {
  if (inflight) return;
  inflight = true;
  try {
    const diag = await ipc.diagnosticsSnapshot();
    useUi.setState({ diag, diagError: null });
  } catch (e) {
    useUi.setState({ diagError: errorMessage(e) });
  } finally {
    inflight = false;
  }
}

export function acquireDiagnostics(): () => void {
  holders++;
  if (holders === 1) {
    void pollOnce();
    timer = window.setInterval(() => void pollOnce(), 2000);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holders--;
    if (holders === 0) {
      window.clearInterval(timer);
      timer = undefined;
    }
  };
}
