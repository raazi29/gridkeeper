// Live view of one agent's tab: CDP screencast frames (JPEG over a binary Channel) drawn on a canvas.
// Streams only while mounted AND the window is visible (the host acks at most ~10 frames/s). With
// `interactive` (the user took over the tab) pointer, wheel and key events go to the page.

import { useEffect, useRef, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import { agentBrowserIpc } from "../../lib/ipc";
import type { SessionId } from "../../lib/types";
import { type FrameHeader, keyInput, mapPoint, modifiersOf, mouseButton, parseFrame } from "./frames";
import { sendInput } from "./store";

let nextWatchToken = 1;

export interface ScreencastViewProps {
  sessionId: SessionId;
  maxWidth: number;
  maxHeight: number;
  interactive?: boolean;
  className?: string;
  label: string;
}

export function ScreencastView({ sessionId, maxWidth, maxHeight, interactive = false, className, label }: ScreencastViewProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const header = useRef<FrameHeader | null>(null);
  const [hasFrame, setHasFrame] = useState(false);
  const [visible, setVisible] = useState(() => document.visibilityState === "visible");
  const lastMove = useRef(0);

  useEffect(() => {
    const onVis = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  useEffect(() => {
    if (!visible) return;
    let alive = true;
    let drawing = false;
    let pending: ArrayBuffer | null = null;
    const draw = async (buf: ArrayBuffer) => {
      const f = parseFrame(buf);
      const c = canvas.current;
      if (!f || !c) return;
      const bmp = await createImageBitmap(new Blob([f.jpeg as BlobPart], { type: "image/jpeg" }));
      if (!alive) {
        bmp.close();
        return;
      }
      if (c.width !== bmp.width || c.height !== bmp.height) {
        c.width = bmp.width;
        c.height = bmp.height;
      }
      c.getContext("2d")?.drawImage(bmp, 0, 0);
      bmp.close();
      header.current = f.header;
      setHasFrame(true);
    };
    const pump = async (buf: ArrayBuffer) => {
      // Never queue more than one frame: newer frames replace an undrawn one.
      if (drawing) {
        pending = buf;
        return;
      }
      drawing = true;
      try {
        let next: ArrayBuffer | null = buf;
        while (next && alive) {
          await draw(next).catch(() => {});
          next = pending;
          pending = null;
        }
      } finally {
        drawing = false;
      }
    };
    const token = nextWatchToken++;
    const ch = new Channel<ArrayBuffer>();
    ch.onmessage = (m) => {
      if (alive) void pump(m);
    };
    void agentBrowserIpc.watch(sessionId, ch, Math.round(maxWidth), Math.round(maxHeight), token).catch(() => {});
    return () => {
      alive = false;
      ch.onmessage = () => {};
      void agentBrowserIpc.unwatch(sessionId, token).catch(() => {});
    };
  }, [sessionId, maxWidth, maxHeight, visible]);

  const point = (e: { clientX: number; clientY: number }) => {
    const c = canvas.current;
    const h = header.current;
    if (!c || !h) return null;
    const r = c.getBoundingClientRect();
    return mapPoint(e.clientX, e.clientY, { left: r.left, top: r.top, width: r.width, height: r.height }, h);
  };

  const mouse = (action: "down" | "up" | "move", e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!interactive) return;
    const p = point(e);
    if (!p) return;
    if (action === "move") {
      const now = performance.now();
      if (now - lastMove.current < 30) return;
      lastMove.current = now;
    } else {
      e.preventDefault();
      if (action === "down") canvas.current?.focus();
    }
    void sendInput(sessionId, {
      type: "mouse",
      action,
      x: p.x,
      y: p.y,
      button: action === "move" ? "none" : mouseButton(e.button),
      clickCount: action === "move" ? undefined : Math.max(1, e.detail || 1),
      modifiers: modifiersOf(e),
    });
  };

  return (
    <div className={`ab-screen${className ? ` ${className}` : ""}${interactive ? " is-interactive" : ""}`}>
      <canvas
        ref={canvas}
        className="ab-canvas"
        tabIndex={interactive ? 0 : -1}
        aria-label={interactive ? `${label}: you control this tab (keyboard and mouse go to the page)` : `${label}: live view`}
        onPointerDown={(e) => mouse("down", e)}
        onPointerUp={(e) => mouse("up", e)}
        onPointerMove={(e) => mouse("move", e)}
        onContextMenu={(e) => interactive && e.preventDefault()}
        onWheel={(e) => {
          if (!interactive) return;
          const p = point(e);
          if (p) void sendInput(sessionId, { type: "mouse", action: "wheel", x: p.x, y: p.y, deltaX: e.deltaX, deltaY: e.deltaY, modifiers: modifiersOf(e) });
        }}
        onKeyDown={(e) => {
          if (!interactive) return;
          const ev = keyInput(e, "down");
          if (!ev) return;
          // Keys belong to the page while it is taken over (Esc and Tab included, not the dialog).
          e.preventDefault();
          e.stopPropagation();
          void sendInput(sessionId, ev);
        }}
        onKeyUp={(e) => {
          if (!interactive) return;
          const ev = keyInput(e, "up");
          if (!ev) return;
          e.preventDefault();
          e.stopPropagation();
          void sendInput(sessionId, ev);
        }}
      />
      {!hasFrame && <div className="ab-screen-empty">{visible ? "Waiting for the first frame…" : "Paused while the window is hidden"}</div>}
    </div>
  );
}
