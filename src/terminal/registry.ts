// Terminal registry. STUB — implemented by the terminal owner.
// Owns one xterm.js Terminal per session (created lazily), its output channel, WebGL budget, and flow control.

import type { SessionId } from "../lib/types";

export interface RendererStatus {
  /** Number of terminals currently using the WebGL renderer. */
  webglActive: number;
  /** Number of terminals using the DOM renderer. */
  domActive: number;
  /** UNMASKED_RENDERER_WEBGL string as reported by the browser, or null if WebGL unavailable. */
  gpuRenderer: string | null;
  webglSupported: boolean;
  contextLosses: number;
}

export function getTerminalSize(_id: SessionId): { cols: number; rows: number } | null {
  return null;
}
export function clearTerminal(_id: SessionId): void {}
export function focusTerminal(_id: SessionId): void {}
export function getSelection(_id: SessionId): string {
  return "";
}
export function getRendererStatus(): RendererStatus {
  return { webglActive: 0, domActive: 0, gpuRenderer: null, webglSupported: false, contextLosses: 0 };
}
/** Subscribe to renderer status changes; returns unsubscribe. */
export function onRendererStatus(_cb: (s: RendererStatus) => void): () => void {
  return () => {};
}
/** Dispose a session's terminal entirely (view hidden or session closed). */
export function disposeTerminal(_id: SessionId): void {}
