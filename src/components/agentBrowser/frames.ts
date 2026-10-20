// Agent browser view helpers (pure): screencast frame parsing, pointer mapping and keyboard
// translation for a taken-over tab. See src-tauri/src/agent_browser/events.rs (encode_frame) and
// hub.rs (input).

import type { AgentBrowserInput } from "../../lib/types";

/** Page viewport of a frame, in CSS pixels. */
export interface FrameHeader {
  w: number;
  h: number;
  top: number;
  scale: number;
  ts: number;
}

/** `[u32 LE header length][header JSON][JPEG]` → parts, or null when malformed. */
export function parseFrame(buf: ArrayBuffer): { header: FrameHeader; jpeg: Uint8Array } | null {
  if (buf.byteLength < 4) return null;
  const n = new DataView(buf).getUint32(0, true);
  if (n === 0 || n > 4096 || 4 + n > buf.byteLength) return null;
  try {
    const raw = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, n))) as Partial<FrameHeader>;
    const header: FrameHeader = { w: Number(raw.w) || 0, h: Number(raw.h) || 0, top: Number(raw.top) || 0, scale: Number(raw.scale) || 1, ts: Number(raw.ts) || 0 };
    return { header, jpeg: new Uint8Array(buf, 4 + n) };
  } catch {
    return null;
  }
}

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * A pointer position over the drawn frame → page CSS pixels. The frame is drawn "contain"-fitted
 * into `box` keeping the viewport's aspect ratio; positions in the letterbox return null.
 */
export function mapPoint(clientX: number, clientY: number, box: Box, header: FrameHeader): { x: number; y: number } | null {
  if (header.w <= 0 || header.h <= 0 || box.width <= 0 || box.height <= 0) return null;
  const s = Math.min(box.width / header.w, box.height / header.h);
  const dw = header.w * s;
  const dh = header.h * s;
  const ox = box.left + (box.width - dw) / 2;
  const oy = box.top + (box.height - dh) / 2;
  const x = (clientX - ox) / s;
  const y = (clientY - oy) / s;
  if (x < 0 || y < 0 || x > header.w || y > header.h) return null;
  return { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 };
}

/** CDP modifier bits: Alt 1, Ctrl 2, Meta 4, Shift 8. */
export function modifiersOf(e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): number {
  return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
}

export function mouseButton(button: number): "left" | "middle" | "right" | "none" {
  return button === 0 ? "left" : button === 1 ? "middle" : button === 2 ? "right" : "none";
}

/** A DOM key event → CDP key input. Printable keys carry their text (not with Ctrl / Alt / Meta held). */
export function keyInput(
  e: { key: string; code: string; keyCode: number; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; isComposing?: boolean },
  action: "down" | "up",
): AgentBrowserInput | null {
  if (e.isComposing || e.key === "Process" || e.key === "Unidentified") return null;
  const modifiers = modifiersOf(e);
  const printable = e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey;
  const text = action === "down" ? (e.key === "Enter" ? "\r" : printable ? e.key : undefined) : undefined;
  return { type: "key", action, key: e.key, code: e.code, keyCode: e.keyCode, ...(text !== undefined ? { text } : {}), modifiers };
}

/** "localhost:5173/x" style label for a URL (no scheme for http(s), no query). */
export function shortUrl(url: string | null | undefined): string {
  if (!url) return "";
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return url;
    const path = u.pathname === "/" ? "" : u.pathname;
    return `${u.host}${path}`;
  } catch {
    return url;
  }
}
