// Minimal in-app confirmation modal (no browser confirm()). Rendered into its own body-level root so it
// works regardless of which component asks.

import { useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import "./layout.css";

export interface ConfirmOptions {
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Red confirm button for destructive actions. Default true. */
  danger?: boolean;
}

function ConfirmDialog({
  message,
  opts,
  done,
}: {
  message: string;
  opts: ConfirmOptions;
  done: (ok: boolean) => void;
}) {
  const okRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    okRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      // Enter/Space activate the focused button natively (confirm is focused by default).
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        done(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      prev?.focus?.();
    };
  }, [done]);

  return (
    <div className="confirm-backdrop" onMouseDown={() => done(false)}>
      <div
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-message"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div id="confirm-title" className="confirm-title">
          {opts.title ?? "Are you sure?"}
        </div>
        <div id="confirm-message" className="confirm-message">
          {message}
        </div>
        <div className="confirm-actions">
          <button type="button" className="lay-btn lay-btn--ghost" onClick={() => done(false)}>
            {opts.cancelLabel ?? "Cancel"}
          </button>
          <button
            ref={okRef}
            type="button"
            className={`lay-btn ${opts.danger === false ? "lay-btn--primary" : "lay-btn--danger"}`}
            onClick={() => done(true)}
          >
            {opts.confirmLabel ?? "Confirm"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Ask the user to confirm; resolves true on confirm, false on cancel/Escape/backdrop click. */
export function confirmAction(message: string, opts: ConfirmOptions = {}): Promise<boolean> {
  return new Promise((resolve) => {
    const host = document.createElement("div");
    host.setAttribute("data-confirm-root", "");
    document.body.appendChild(host);
    const root = createRoot(host);
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
      // Unmount after the current event finishes dispatching.
      window.setTimeout(() => {
        root.unmount();
        host.remove();
      }, 0);
    };
    root.render(<ConfirmDialog message={message} opts={opts} done={done} />);
  });
}
