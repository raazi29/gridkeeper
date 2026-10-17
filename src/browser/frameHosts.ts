// Browser pane "hosts": the empty box in each browser pane that its iframe is laid over.
// The iframes themselves live in one persistent layer (BrowserLayer) so a React remount of the pane
// (reorder, maximize / restore, layout preset change, group switch) never moves an iframe in the DOM —
// moving or re-inserting an iframe reloads its page and loses dev-server state.

import type { SessionId } from "../lib/types";

const hosts = new Map<SessionId, HTMLElement>();
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

/** Register the pane's host element; returns the unregister function. */
export function registerHost(id: SessionId, el: HTMLElement): () => void {
  hosts.set(id, el);
  emit();
  return () => {
    if (hosts.get(id) === el) {
      hosts.delete(id);
      emit();
    }
  };
}

export function getHost(id: SessionId): HTMLElement | undefined {
  return hosts.get(id);
}

export function hostIds(): SessionId[] {
  return [...hosts.keys()];
}

export function subscribeHosts(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Where a frame goes, relative to the layer; null = hide (host absent, detached or collapsed). */
export function frameBox(
  host: { getBoundingClientRect(): { left: number; top: number; width: number; height: number }; isConnected: boolean } | undefined,
  layer: { left: number; top: number },
): { left: number; top: number; width: number; height: number } | null {
  if (!host || !host.isConnected) return null;
  const r = host.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return null;
  return { left: Math.round(r.left - layer.left), top: Math.round(r.top - layer.top), width: Math.round(r.width), height: Math.round(r.height) };
}
