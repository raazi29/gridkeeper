// Modal with focus trap, Esc-to-close (top-most only) and focus restore.
// While any modal is open, global app shortcuts are suspended (see uiStore.isKeyCaptureSuspended).

import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useApp } from "../../store/appStore";
import { isTopModal, popModal, pushModal } from "../../store/uiStore";
import { focusTerminal } from "../../terminal/registry";
import { IconClose } from "../icons";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null || el === document.activeElement);
}

export interface ModalProps {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  /** "center" dialog (default) or "top" (palette-like placement). */
  placement?: "center" | "top";
  className?: string;
  /** Hide the title bar entirely (palette). */
  bare?: boolean;
  /** Extra controls rendered at the right of the title bar. */
  headerExtra?: ReactNode;
  ariaLabel?: string;
}

export function Modal({ title, onClose, children, footer, width = 520, placement = "center", className, bare, headerExtra, ariaLabel }: ModalProps) {
  const panel = useRef<HTMLDivElement>(null);
  const idRef = useRef(0);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useLayoutEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    idRef.current = pushModal();
    const el = panel.current;
    if (el) {
      const auto = el.querySelector<HTMLElement>("[data-autofocus]") ?? focusables(el).find((x) => x.matches("input, select, textarea")) ?? focusables(el)[0];
      (auto ?? el).focus();
    }
    const id = idRef.current;
    return () => {
      popModal(id);
      // Restore focus to whatever had it (often the terminal's textarea).
      requestAnimationFrame(() => {
        if (document.activeElement && document.activeElement !== document.body) return;
        const usable = prev && prev !== document.body && prev.isConnected;
        const f = useApp.getState().focusedSessionId;
        if (usable && prev.closest(".modal")) prev.focus(); // back to the dialog underneath
        else if (f) focusTerminal(f); // back to the (possibly newly) focused terminal
        else if (usable) prev.focus();
      });
    };
  }, []);

  // Keep focus inside the top-most modal when something outside grabs it.
  useEffect(() => {
    const onFocusIn = (e: FocusEvent) => {
      const el = panel.current;
      if (!el || !isTopModal(idRef.current)) return;
      const t = e.target as Node | null;
      if (t && !el.contains(t) && !(t as HTMLElement).closest?.(".menu")) el.focus();
    };
    document.addEventListener("focusin", onFocusIn);
    return () => document.removeEventListener("focusin", onFocusIn);
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!isTopModal(idRef.current)) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onCloseRef.current();
      return;
    }
    if (e.key === "Tab" && panel.current) {
      const items = focusables(panel.current);
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  return createPortal(
    <div
      className={`modal-backdrop is-${placement}`}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCloseRef.current();
      }}
    >
      <div
        ref={panel}
        className={`modal${className ? ` ${className}` : ""}`}
        style={{ width }}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel ?? (typeof title === "string" ? title : undefined)}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        {!bare && (
          <div className="modal-header">
            <div className="modal-title">{title}</div>
            {headerExtra}
            <button type="button" className="icon-btn icon-btn-sm" aria-label="Close" title="Close (Esc)" onClick={() => onCloseRef.current()}>
              <IconClose size={14} />
            </button>
          </div>
        )}
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
