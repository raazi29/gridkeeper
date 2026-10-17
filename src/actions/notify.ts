// Tiny toast bus. The UI (Toasts component) subscribes; anything may publish.

import { create } from "zustand";

export type ToastKind = "info" | "warn" | "error";
export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

interface ToastStore {
  toasts: Toast[];
  dismiss: (id: number) => void;
}

let next = 1;
export const useToasts = create<ToastStore>()((set) => ({
  toasts: [],
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

export function notify(kind: ToastKind, message: string, ttlMs = kind === "error" ? 8000 : 3500) {
  const id = next++;
  useToasts.setState((s) => ({ toasts: [...s.toasts.slice(-4), { id, kind, message }] }));
  window.setTimeout(() => useToasts.getState().dismiss(id), ttlMs);
}
